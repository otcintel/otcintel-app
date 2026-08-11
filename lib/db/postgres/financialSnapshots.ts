/**
 * OTCIntel — PostgreSQL financial snapshots repository
 *
 * Implements IFinancialSnapshotsRepository against `financial_snapshots`.
 * Stores the full FinancialSnapshot as raw_payload (JSONB) for perfect
 * round-trip fidelity, with key fields denormalized into SQL columns
 * for analytics queries.
 *
 * Uniqueness: (company_id, accession_number) when accession_number is not null.
 * PostgreSQL's UNIQUE constraint allows multiple NULLs, so snapshots without
 * a known accession number are always inserted as new rows.
 */

import type { FinancialSnapshot } from '../../ingestion/parsers/financials/snapshot';
import type { IFinancialSnapshotsRepository } from '../types';
import { getClient, assertNoError } from './client';

// ─── Row type ─────────────────────────────────────────────────────────────────

interface SnapshotRow {
  id: string;
  company_id: string;
  ticker: string;
  cik: string;
  accession_number: string | null;
  form_type: string;
  fiscal_period: string | null;
  fiscal_year: number | null;
  period_end_date: string | null;
  filed_at: string | null;
  cash_and_equivalents: number | null;
  current_liabilities: number | null;
  accumulated_deficit: number | null;
  total_debt: number | null;
  total_debt_components: string[];
  operating_cash_flow: number | null;
  operating_cash_flow_months: number | null;
  monthly_burn_rate: number | null;
  cash_runway_months: number | null;
  going_concern_flag: boolean;
  going_concern_sentence: string | null;
  xbrl_available: boolean;
  missing_concepts: string[];
  data_source: 'xbrl' | 'text' | 'xbrl+text';
  extracted_at: string;
  raw_payload: unknown;
  created_at: string;
  updated_at: string;
}

// ─── Mapping ──────────────────────────────────────────────────────────────────

function rowToSnapshot(row: SnapshotRow): FinancialSnapshot {
  return row.raw_payload as FinancialSnapshot;
}

async function getCompanyId(
  db: ReturnType<typeof getClient>,
  ticker: string,
): Promise<string | null> {
  const { data } = await db
    .from('companies')
    .select('id')
    .eq('ticker', ticker.toUpperCase())
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

function snapshotToRow(
  snapshot: FinancialSnapshot,
  companyId: string,
): Record<string, unknown> {
  return {
    company_id:                companyId,
    ticker:                    snapshot.ticker.toUpperCase(),
    cik:                       snapshot.cik,
    accession_number:          snapshot.accessionNumber ?? null,
    form_type:                 snapshot.formType,
    fiscal_period:             snapshot.fiscalPeriod ?? null,
    fiscal_year:               snapshot.fiscalYear ?? null,
    period_end_date:           snapshot.periodEndDate ?? null,
    filed_at:                  snapshot.filedAt ?? null,
    cash_and_equivalents:      snapshot.cashAndEquivalents ?? null,
    current_liabilities:       snapshot.currentLiabilities ?? null,
    accumulated_deficit:       snapshot.accumulatedDeficit ?? null,
    total_debt:                snapshot.totalDebt ?? null,
    total_debt_components:     snapshot.totalDebtComponents,
    operating_cash_flow:       snapshot.operatingCashFlow ?? null,
    operating_cash_flow_months:snapshot.operatingCashFlowMonths ?? null,
    monthly_burn_rate:         snapshot.monthlyBurnRate ?? null,
    cash_runway_months:        snapshot.cashRunwayMonths ?? null,
    going_concern_flag:        snapshot.goingConcernFlag,
    going_concern_sentence:    snapshot.goingConcernSentence ?? null,
    xbrl_available:            snapshot.xbrlAvailable,
    missing_concepts:          snapshot.missingConcepts,
    data_source:               snapshot.dataSource,
    extracted_at:              snapshot.extractedAt,
    raw_payload:               snapshot,
  };
}

// ─── Repository ───────────────────────────────────────────────────────────────

export const postgresFinancialSnapshotsDb: IFinancialSnapshotsRepository = {
  async getLatestByCompany(ticker: string): Promise<FinancialSnapshot | undefined> {
    const db = getClient();
    const { data, error } = await db
      .from('financial_snapshots')
      .select('*')
      .eq('ticker', ticker.toUpperCase())
      .order('filed_at', { ascending: false, nullsFirst: false })
      .order('extracted_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    assertNoError(error, `financialSnapshots.getLatestByCompany(${ticker})`);
    return data ? rowToSnapshot(data as SnapshotRow) : undefined;
  },

  async getByCompany(ticker: string): Promise<FinancialSnapshot[]> {
    const db = getClient();
    const { data, error } = await db
      .from('financial_snapshots')
      .select('*')
      .eq('ticker', ticker.toUpperCase())
      .order('filed_at', { ascending: false, nullsFirst: false });
    assertNoError(error, `financialSnapshots.getByCompany(${ticker})`);
    return (data as SnapshotRow[]).map(rowToSnapshot);
  },

  async getByAccession(accessionNumber: string): Promise<FinancialSnapshot | undefined> {
    const db = getClient();
    const { data, error } = await db
      .from('financial_snapshots')
      .select('*')
      .eq('accession_number', accessionNumber)
      .maybeSingle();
    assertNoError(error, `financialSnapshots.getByAccession(${accessionNumber})`);
    return data ? rowToSnapshot(data as SnapshotRow) : undefined;
  },

  async upsert(snapshot: FinancialSnapshot): Promise<void> {
    const db = getClient();
    const companyId = await getCompanyId(db, snapshot.ticker);
    if (!companyId) {
      throw new Error(
        `[OTCIntel/postgres] financialSnapshots.upsert: company ${snapshot.ticker} not found.`,
      );
    }

    const row = snapshotToRow(snapshot, companyId);

    if (snapshot.accessionNumber) {
      // Conflict on (company_id, accession_number) — update existing row
      const { error } = await db
        .from('financial_snapshots')
        .upsert(row, { onConflict: 'company_id,accession_number' });
      assertNoError(error, `financialSnapshots.upsert(${snapshot.ticker}/${snapshot.accessionNumber})`);
    } else {
      // No accession number — always insert a new row
      const { error } = await db
        .from('financial_snapshots')
        .insert(row);
      assertNoError(error, `financialSnapshots.insert(${snapshot.ticker}/no-accession)`);
    }
  },
};
