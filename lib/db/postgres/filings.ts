/**
 * OTCIntel — PostgreSQL filings repository
 *
 * Implements IFilingsRepository against the `filings` + `convertible_notes` tables.
 *
 * Design: The full NormalizedFiling is reconstructed from JSONB raw-payload columns
 * on read, ensuring perfect round-trip fidelity including all provenance fields.
 * Normalized SQL columns are written alongside raw payloads to support analytics
 * queries without JSON parsing.
 */

import type { NormalizedFiling, ExtractedFinancingTerms, ExtractedShareStructure } from '../../ingestion/types';
import type { IFilingsRepository } from '../types';
import { getClient, assertNoError } from './client';

// ─── Row type ─────────────────────────────────────────────────────────────────

interface FilingRow {
  id: string;
  accession_number: string;
  company_id: string;
  cik: string;
  ticker: string;
  form_type: string;
  filed_at: string;
  period_of_report: string | null;
  document_url: string;
  full_text_url: string | null;
  source: string;
  parser_version: string;
  parse_errors: unknown[];
  summary: string | null;
  event_summary: string | null;
  event_type: string | null;
  terms: unknown | null;
  tags: unknown | null;
  financing_raw: unknown | null;
  share_structure_raw: unknown | null;
  financing_report_raw: unknown | null;
  // Normalized financing columns (write-only — reads use raw payload)
  financing_type: string | null;
  financing_principal_amount: number | null;
  financing_discount_rate: number | null;
  financing_lookback_days: number | null;
  financing_has_floor_price: boolean | null;
  financing_floor_price: number | null;
  financing_has_reset_provisions: boolean | null;
  financing_warrant_shares: number | null;
  financing_warrant_exercise_price: number | null;
  financing_maturity_date: string | null;
  financing_investor_name: string | null;
  financing_confidence: string | null;
  shares_authorized: number | null;
  shares_outstanding: number | null;
  shares_float: number | null;
  preferred_shares_outstanding: number | null;
  share_structure_confidence: string | null;
  ingested_at: string;
  created_at: string;
  updated_at: string;
}

// ─── ConvertibleNote row ──────────────────────────────────────────────────────

interface ConvertibleNoteUpsertRow {
  filing_id: string;
  company_id: string;
  note_index: number;
  instrument_type: string | null;
  instrument_name: string | null;
  is_amendment: boolean | null;
  investor_name: string | null;
  principal_amount: number | null;
  purchase_price: number | null;
  original_issue_discount: number | null;
  net_proceeds: number | null;
  outstanding_balance: number | null;
  interest_rate: number | null;
  default_interest_rate: number | null;
  maturity_date: string | null;
  execution_date: string | null;
  prepayment_premium: number | null;
  redemption_premium: number | null;
  conversion_formula: string | null;
  fixed_conversion_price: number | null;
  discount_rate: number | null;
  lookback_days: number | null;
  floor_price: number | null;
  has_floor_price: boolean | null;
  ceiling_price: number | null;
  exchange_cap: number | null;
  beneficial_ownership_blocker: number | null;
  has_reset_provisions: boolean | null;
  anti_dilution_provisions: boolean | null;
  has_acceleration_clause: boolean | null;
  penalty_rate: number | null;
  status: string | null;
  amount_converted: number | null;
  amount_repaid: number | null;
  raw_payload: unknown;
}

// ─── Mapping: FilingRow → NormalizedFiling ────────────────────────────────────

function rowToFiling(row: FilingRow): NormalizedFiling {
  return {
    accessionNumber:  row.accession_number,
    ticker:           row.ticker,
    cik:              row.cik,
    formType:         row.form_type as NormalizedFiling['formType'],
    filedAt:          row.filed_at,
    periodOfReport:   row.period_of_report ?? '',
    documentUrl:      row.document_url,
    ingestedAt:       row.ingested_at,
    source:           row.source as 'edgar' | 'mock' | 'third-party',
    parserVersion:    row.parser_version || undefined,
    parseErrors:      (row.parse_errors ?? []) as string[],
    summary:          row.summary ?? undefined,
    eventSummary:     row.event_summary ?? undefined,
    eventType:        row.event_type as NormalizedFiling['eventType'] ?? undefined,
    terms:            row.terms as NormalizedFiling['terms'] ?? undefined,
    tags:             row.tags as string[] ?? undefined,
    // Authoritative reads come from raw JSONB payloads to preserve all provenance
    financing:        row.financing_raw as ExtractedFinancingTerms ?? undefined,
    shareStructure:   row.share_structure_raw as ExtractedShareStructure ?? undefined,
    financingReport:  row.financing_report_raw as NormalizedFiling['financingReport'] ?? undefined,
  };
}

// ─── Mapping: NormalizedFiling → upsert row ───────────────────────────────────

function filingToUpsertRow(
  f: NormalizedFiling,
  companyId: string,
): Omit<FilingRow, 'id' | 'ingested_at' | 'created_at' | 'updated_at'> & { created_at: string } {
  const ft = f.financing;
  const ss = f.shareStructure;

  return {
    accession_number:             f.accessionNumber,
    company_id:                   companyId,
    cik:                          f.cik,
    ticker:                       f.ticker.toUpperCase(),
    form_type:                    f.formType,
    filed_at:                     f.filedAt,
    period_of_report:             f.periodOfReport?.trim() || null,
    document_url:                 f.documentUrl,
    full_text_url:                null,
    source:                       f.source,
    parser_version:               f.parserVersion ?? '',
    parse_errors:                 f.parseErrors,
    summary:                      f.summary ?? null,
    event_summary:                f.eventSummary ?? null,
    event_type:                   f.eventType ?? null,
    terms:                        f.terms ?? null,
    tags:                         f.tags ?? null,

    // Normalized financing columns (for SQL analytics)
    financing_type:               ft?.financingType ?? null,
    financing_principal_amount:   ft?.principalAmount ?? null,
    financing_discount_rate:      ft?.discountRate ?? null,
    financing_lookback_days:      ft?.lookbackDays ?? null,
    financing_has_floor_price:    ft?.hasFloorPrice ?? null,
    financing_floor_price:        ft?.floorPrice ?? null,
    financing_has_reset_provisions: ft?.hasResetProvisions ?? null,
    financing_warrant_shares:     ft?.warrantShares ?? null,
    financing_warrant_exercise_price: ft?.warrantExercisePrice ?? null,
    financing_maturity_date:      ft?.maturityDate ?? null,
    financing_investor_name:      ft?.investorName ?? null,
    financing_confidence:         ft?.confidence ?? null,

    // Normalized share structure columns
    shares_authorized:            ss?.sharesAuthorized ?? null,
    shares_outstanding:           ss?.sharesOutstanding ?? null,
    shares_float:                 ss?.sharesFloat ?? null,
    preferred_shares_outstanding: ss?.preferredSharesOutstanding ?? null,
    share_structure_confidence:   ss?.confidence ?? null,

    // Raw JSONB payloads — authoritative for reads
    financing_raw:                f.financing ?? null,
    share_structure_raw:          f.shareStructure ?? null,
    financing_report_raw:         f.financingReport ?? null,

    created_at:                   new Date().toISOString(),
  };
}

// ─── ConvertibleNote helper ───────────────────────────────────────────────────

function buildConvertibleNoteRow(
  note: Record<string, unknown>,
  noteIndex: number,
  filingId: string,
  companyId: string,
): ConvertibleNoteUpsertRow {
  return {
    filing_id:                    filingId,
    company_id:                   companyId,
    note_index:                   noteIndex,
    instrument_type:              (note.instrumentType as string) ?? null,
    instrument_name:              (note.instrumentName as string) ?? null,
    is_amendment:                 (note.isAmendment as boolean) ?? null,
    investor_name:                (note.investorName as string) ?? null,
    principal_amount:             (note.principalAmount as number) ?? null,
    purchase_price:               (note.purchasePrice as number) ?? null,
    original_issue_discount:      (note.originalIssueDiscount as number) ?? null,
    net_proceeds:                 (note.netProceeds as number) ?? null,
    outstanding_balance:          (note.outstandingBalance as number) ?? null,
    interest_rate:                (note.interestRate as number) ?? null,
    default_interest_rate:        (note.defaultInterestRate as number) ?? null,
    maturity_date:                (note.maturityDate as string) ?? null,
    execution_date:               (note.executionDate as string) ?? null,
    prepayment_premium:           (note.prepaymentPremium as number) ?? null,
    redemption_premium:           (note.redemptionPremium as number) ?? null,
    conversion_formula:           (note.conversionFormula as string) ?? null,
    fixed_conversion_price:       (note.fixedConversionPrice as number) ?? null,
    discount_rate:                (note.discountRate as number) ?? null,
    lookback_days:                (note.lookbackDays as number) ?? null,
    floor_price:                  (note.floorPrice as number) ?? null,
    has_floor_price:              (note.hasFloorPrice as boolean) ?? null,
    ceiling_price:                (note.ceilingPrice as number) ?? null,
    exchange_cap:                 (note.exchangeCap as number) ?? null,
    beneficial_ownership_blocker: (note.beneficialOwnershipBlocker as number) ?? null,
    has_reset_provisions:         (note.hasResetProvisions as boolean) ?? null,
    anti_dilution_provisions:     (note.antiDilutionProvisions as boolean) ?? null,
    has_acceleration_clause:      (note.hasAccelerationClause as boolean) ?? null,
    penalty_rate:                 (note.penaltyRate as number) ?? null,
    status:                       (note.status as string) ?? null,
    amount_converted:             (note.amountConverted as number) ?? null,
    amount_repaid:                (note.amountRepaid as number) ?? null,
    raw_payload:                  note,  // Full ConvertibleNote object with all _ provenance
  };
}

// ─── Company ID lookup helper ─────────────────────────────────────────────────

async function getCompanyId(db: ReturnType<typeof getClient>, cik: string): Promise<string | null> {
  const { data } = await db
    .from('companies')
    .select('id')
    .eq('cik', cik)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

// ─── Repository ───────────────────────────────────────────────────────────────

export const postgresFilingsDb: IFilingsRepository = {
  async getByTicker(ticker: string): Promise<NormalizedFiling[]> {
    const db = getClient();
    const { data, error } = await db
      .from('filings')
      .select('*')
      .eq('ticker', ticker.toUpperCase())
      .order('filed_at', { ascending: false });
    assertNoError(error, `filings.getByTicker(${ticker})`);
    return (data as FilingRow[]).map(rowToFiling);
  },

  async hasAccession(ticker: string, accessionNumber: string): Promise<boolean> {
    const db = getClient();
    const { count, error } = await db
      .from('filings')
      .select('*', { count: 'exact', head: true })
      .eq('ticker', ticker.toUpperCase())
      .eq('accession_number', accessionNumber);
    assertNoError(error, `filings.hasAccession(${ticker}, ${accessionNumber})`);
    return (count ?? 0) > 0;
  },

  async knownAccessions(ticker: string): Promise<Set<string>> {
    const db = getClient();
    const { data, error } = await db
      .from('filings')
      .select('accession_number')
      .eq('ticker', ticker.toUpperCase());
    assertNoError(error, `filings.knownAccessions(${ticker})`);
    return new Set((data as { accession_number: string }[]).map(r => r.accession_number));
  },

  async upsertAll(ticker: string, incoming: NormalizedFiling[]): Promise<void> {
    if (incoming.length === 0) return;
    const db = getClient();

    // Look up company_id for the first filing's CIK (all share the same company)
    const cik = incoming[0].cik;
    const companyId = await getCompanyId(db, cik);
    if (!companyId) {
      throw new Error(
        `[OTCIntel/postgres] filings.upsertAll: company with CIK ${cik} not found. ` +
        'Upsert the company record before its filings.',
      );
    }

    const rows = incoming.map(f => filingToUpsertRow(f, companyId));

    const { data: upsertedFilings, error } = await db
      .from('filings')
      .upsert(rows, { onConflict: 'accession_number' })
      .select('id, accession_number');
    assertNoError(error, `filings.upsertAll(${ticker})`);

    // Upsert convertible notes for filings that have a financingReport
    if (!upsertedFilings) return;
    const filingIdByAccession = new Map(
      (upsertedFilings as { id: string; accession_number: string }[]).map(r => [r.accession_number, r.id]),
    );

    const noteRows: ConvertibleNoteUpsertRow[] = [];
    for (const f of incoming) {
      const notes = f.financingReport?.convertibleDebt;
      if (!notes || notes.length === 0) continue;
      const filingId = filingIdByAccession.get(f.accessionNumber);
      if (!filingId) continue;
      notes.forEach((note, idx) => {
        noteRows.push(buildConvertibleNoteRow(
          note as unknown as Record<string, unknown>,
          idx,
          filingId,
          companyId,
        ));
      });
    }

    if (noteRows.length > 0) {
      const { error: noteError } = await db
        .from('convertible_notes')
        .upsert(noteRows, { onConflict: 'filing_id,note_index' });
      assertNoError(noteError, `convertible_notes.upsertAll(${ticker})`);
    }
  },

  async getAllTickers(): Promise<string[]> {
    const db = getClient();
    const { data, error } = await db
      .from('filings')
      .select('ticker')
      .order('ticker', { ascending: true });
    assertNoError(error, 'filings.getAllTickers');
    const unique = [...new Set((data as { ticker: string }[]).map(r => r.ticker))];
    return unique;
  },

  async totalCount(): Promise<number> {
    const db = getClient();
    const { count, error } = await db
      .from('filings')
      .select('*', { count: 'exact', head: true });
    assertNoError(error, 'filings.totalCount');
    return count ?? 0;
  },
};
