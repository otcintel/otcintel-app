/**
 * GET /api/debug/cn-test/[ticker]
 *
 * Runs convertible-note extraction on every filing for a ticker and prints a
 * structured report:
 *   - notes detected per filing (count, principal, investor, confidence)
 *   - per-field confidence values for each note
 *   - validation warnings emitted by validateConvertibleNote
 *   - company-level summary (unique notes after dedup, field coverage %)
 *
 * Designed for manual QA against AITX, MULN, HMBL, CYBL, GTII.
 *
 * Example:
 *   GET /api/debug/cn-test/MULN
 *   GET /api/debug/cn-test/AITX?ingest=false   (skip re-ingest if cached)
 */

import { NextRequest, NextResponse } from 'next/server';
import { normalizedFilingStore } from '@/lib/ingestion/store';
import { ingestTicker } from '@/lib/ingestion';
import type { ConvertibleNote } from '@/lib/ingestion/types';
import { noteCompleteness } from '@/lib/ingestion/parsers/noteEnrichment';

const ECONOMICS_FIELDS: (keyof ConvertibleNote)[] = [
  'principalAmount', 'purchasePrice', 'originalIssueDiscount', 'netProceeds',
  'legalFees', 'placementFees', 'outstandingBalance', 'interestRate',
  'defaultInterestRate', 'maturityDate', 'executionDate', 'prepaymentPremium',
  'redemptionPremium',
];

const CONVERSION_FIELDS: (keyof ConvertibleNote)[] = [
  'conversionFormula', 'fixedConversionPrice', 'discountRate', 'lookbackDays',
  'floorPrice', 'hasFloorPrice', 'ceilingPrice', 'exchangeCap',
  'beneficialOwnershipBlocker', 'hasResetProvisions', 'antiDilutionProvisions',
];

const DEFAULT_FIELDS: (keyof ConvertibleNote)[] = [
  'hasAccelerationClause', 'penaltyRate',
];

const STATUS_FIELDS: (keyof ConvertibleNote)[] = [
  'status', 'amountConverted', 'amountRepaid',
];

const IDENTITY_FIELDS: (keyof ConvertibleNote)[] = [
  'instrumentType', 'instrumentName', 'isAmendment', 'investorName',
];

function fieldCoverage(note: ConvertibleNote, fields: (keyof ConvertibleNote)[]): number {
  const present = fields.filter(f => note[f] != null).length;
  return Math.round((present / fields.length) * 100);
}

function summariseNote(note: ConvertibleNote, idx: number, showSentences = false) {
  const principal  = note.principalAmount != null
    ? `$${(note.principalAmount / 1_000_000).toFixed(3)}M`
    : 'no principal';
  const investor   = note.investorName ?? 'unknown investor';
  const rate       = note.discountRate != null
    ? `${(note.discountRate * 100).toFixed(0)}% of market`
    : note.interestRate != null
      ? `${(note.interestRate * 100).toFixed(1)}% interest`
      : 'no rate';
  const maturity   = note.maturityDate ?? 'no maturity';
  const status     = note.status ?? 'unknown';
  const econPct    = fieldCoverage(note, ECONOMICS_FIELDS);
  const convPct    = fieldCoverage(note, CONVERSION_FIELDS);
  const defPct     = fieldCoverage(note, DEFAULT_FIELDS);
  const statPct    = fieldCoverage(note, STATUS_FIELDS);
  const idPct      = fieldCoverage(note, IDENTITY_FIELDS);
  const warns      = note._validationWarnings ?? [];

  return {
    noteIndex: idx,
    label: `[${principal}] ${investor} | ${rate} | due ${maturity} | ${status}`,
    identity: {
      instrumentType: note.instrumentType,
      instrumentName: note.instrumentName,
      isAmendment:    note.isAmendment,
      investorName:   note.investorName,
      coverage: `${idPct}%`,
    },
    economics: {
      principalAmount:       note.principalAmount,
      purchasePrice:         note.purchasePrice,
      originalIssueDiscount: note.originalIssueDiscount,
      netProceeds:           note.netProceeds,
      outstandingBalance:    note.outstandingBalance,
      interestRate:          note.interestRate,
      defaultInterestRate:   note.defaultInterestRate,
      maturityDate:          note.maturityDate,
      executionDate:         note.executionDate,
      prepaymentPremium:     note.prepaymentPremium,
      redemptionPremium:     note.redemptionPremium,
      coverage: `${econPct}%`,
    },
    conversion: {
      discountRate:              note.discountRate,
      lookbackDays:              note.lookbackDays,
      fixedConversionPrice:      note.fixedConversionPrice,
      floorPrice:                note.floorPrice,
      hasFloorPrice:             note.hasFloorPrice,
      ceilingPrice:              note.ceilingPrice,
      exchangeCap:               note.exchangeCap,
      beneficialOwnershipBlocker: note.beneficialOwnershipBlocker,
      hasResetProvisions:        note.hasResetProvisions,
      antiDilutionProvisions:    note.antiDilutionProvisions,
      conversionFormula:         note.conversionFormula
        ? note.conversionFormula.slice(0, 120) + (note.conversionFormula.length > 120 ? '…' : '')
        : undefined,
      coverage: `${convPct}%`,
    },
    defaults: {
      hasAccelerationClause: note.hasAccelerationClause,
      penaltyRate:           note.penaltyRate,
      coverage: `${defPct}%`,
    },
    status: {
      status:          note.status,
      amountConverted: note.amountConverted,
      amountRepaid:    note.amountRepaid,
      coverage: `${statPct}%`,
    },
    completeness:  noteCompleteness(note),
    provenance: {
      section:         note._section,
      noteNumber:      note._noteNumber,
      sourceSentences: (note._sourceSentences ?? []).length,
      topFieldConf:    Object.entries(note._fieldConfidence ?? {})
        .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
        .slice(0, 8)
        .map(([k, v]) => `${k}=${(v ?? 0).toFixed(2)}`),
    },
    validationWarnings: warns,
    contamination: {
      anchorPrincipal:     note._anchorPrincipalAmount,
      anchorSentenceIndex: note._anchorSentenceIndex,
      rejectedCandidates:  (note._rejectedCandidates ?? []).map(r => ({
        field:         r.field,
        rejectedValue: r.value,
        reason:        r.reason,
        sentence:      r.sourceText ? r.sourceText.slice(0, 120) + (r.sourceText.length > 120 ? '…' : '') : undefined,
      })),
    },
    ...(showSentences ? {
      sourceSentences: note._sourceSentenceTexts ?? [],
      fieldProvenance: Object.fromEntries(
        Object.entries(note._fieldProvenance ?? {}).map(([k, v]) => [k, {
          anchorDistance: v.anchorDistance,
          method:         v.method,
          sentence:       v.sourceText.slice(0, 100) + (v.sourceText.length > 100 ? '…' : ''),
        }]),
      ),
    } : {}),
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> },
): Promise<NextResponse> {
  const { ticker } = await params;
  const symbol = ticker.toUpperCase();
  const skipIngest    = request.nextUrl.searchParams.get('ingest') === 'false';
  const showSentences = request.nextUrl.searchParams.get('sentences') === 'true';

  let ingested = false;
  let ingestError: string | undefined;

  if (!skipIngest || normalizedFilingStore.getByTicker(symbol).length === 0) {
    try {
      const result = await ingestTicker(symbol);
      normalizedFilingStore.upsertAll(result.normalized);
      ingested = true;
    } catch (err) {
      ingestError = err instanceof Error ? err.message : String(err);
    }
  }

  const filings = normalizedFilingStore.getByTicker(symbol);
  if (filings.length === 0) {
    return NextResponse.json({ error: `No filings found for ${symbol}`, ingestError }, { status: 404 });
  }

  const filingReports = filings
    .filter(f => (f.financingReport?.convertibleDebt?.length ?? 0) > 0)
    .sort((a, b) => b.filedAt.localeCompare(a.filedAt));

  const perFiling = filingReports.map(f => {
    const notes = f.financingReport!.convertibleDebt!;
    return {
      filedAt:   f.filedAt,
      formType:  f.formType,
      accession: f.accessionNumber,
      noteCount: notes.length,
      notes:     notes.map((n, i) => summariseNote(n, i, showSentences)),
    };
  });

  // All notes across all filings (for unique-investor coverage stats)
  const allNotes = filingReports.flatMap(f => f.financingReport!.convertibleDebt!);
  const allInvestors = [...new Set(allNotes.map(n => n.investorName).filter(Boolean))];

  const fieldHitRate = (fields: (keyof ConvertibleNote)[]) => {
    if (allNotes.length === 0) return '0%';
    const hits = allNotes.filter(n => fields.some(f => n[f] != null)).length;
    return `${Math.round((hits / allNotes.length) * 100)}%`;
  };

  const summary = {
    totalFilingsWithNotes: filingReports.length,
    totalFilings:          filings.length,
    totalNoteInstances:    allNotes.length,
    uniqueInvestors:       allInvestors,
    anyValidationWarning:  allNotes.some(n => (n._validationWarnings?.length ?? 0) > 0),
    fieldHitRates: {
      principalAmount:           fieldHitRate(['principalAmount']),
      interestRate:              fieldHitRate(['interestRate']),
      maturityDate:              fieldHitRate(['maturityDate']),
      discountOrFixed:           fieldHitRate(['discountRate', 'fixedConversionPrice']),
      floorPrice:                fieldHitRate(['floorPrice', 'hasFloorPrice']),
      beneficialOwnershipBlocker: fieldHitRate(['beneficialOwnershipBlocker']),
      status:                    fieldHitRate(['status']),
      investorName:              fieldHitRate(['investorName']),
    },
  };

  return NextResponse.json({
    ticker: symbol,
    ingested,
    ...(ingestError ? { ingestError } : {}),
    summary,
    filings: perFiling,
  });
}
