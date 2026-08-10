/**
 * GET /api/admin/universe/audit
 *
 * Comprehensive snapshot of the company universe — used for:
 *   1. Pre/post restart persistence testing (Part 1)
 *   2. Per-company quality report sorted weakest first (Part 5)
 *
 * Returns per-company:
 *   - Filing counts and form-type breakdown
 *   - Convertible note / facility / warrant / relatedParty counts
 *   - Warning and rejected-candidate counts
 *   - Completeness percentage (fields present vs expected)
 *   - Confidence status and review reason
 *   - Parser version stamped on filings
 *   - Intelligence summary (if persisted)
 *   - List of stored accession numbers (for restart diff)
 *
 * Sorted weakest first by a quality score derived from warnings,
 * rejected candidates, completeness, and confidence.
 */

import { NextRequest, NextResponse } from 'next/server';
import { companiesDb, filingsDb, intelligenceDb, runsDb } from '@/lib/db';
import { PARSEABLE_FORMS } from '@/lib/universe/companies';
import { requireAdminAuth } from '@/lib/api/adminAuth';
import type { NormalizedFiling } from '@/lib/ingestion/types';
import type { CompanyRecord } from '@/lib/universe/types';

// Fields we expect a well-extracted ConvertibleNote to have
const EXPECTED_NOTE_FIELDS = [
  'principalAmount', 'interestRate', 'maturityDate', 'fixedConversionPrice',
  'discountRate', 'hasFloorPrice', 'hasResetProvisions',
] as const;

type ConvertibleNote = NonNullable<NormalizedFiling['financingReport']>['convertibleDebt'][number];

function noteCompleteness(notes: ConvertibleNote[]): number {
  if (notes.length === 0) return 1; // no notes is fine — not incomplete
  let total = 0;
  let present = 0;
  for (const note of notes) {
    for (const field of EXPECTED_NOTE_FIELDS) {
      total++;
      if (note[field] !== undefined && note[field] !== null) present++;
    }
  }
  return total === 0 ? 1 : present / total;
}

function qualityScore(
  company: CompanyRecord,
  warnings: number,
  rejected: number,
  completeness: number,
  noteCount: number,
): number {
  // Lower = worse quality (sorted ascending for "weakest first")
  let score = 100;
  score -= warnings * 8;
  score -= rejected * 5;
  score -= (1 - completeness) * 30;
  if (company.confidenceStatus === 'insufficient_data') score -= 25;
  if (company.confidenceStatus === 'needs_review')       score -= 15;
  if (company.confidenceStatus === 'usable_with_warnings') score -= 5;
  if (company.ingestionStatus === 'failed')    score -= 30;
  if (company.ingestionStatus === 'partial')   score -= 10;
  // Bonus for meaningful data
  if (noteCount > 0) score += 5;
  return score;
}

function reviewReason(
  company: CompanyRecord,
  warnings: number,
  rejected: number,
  parseErrors: number,
  parseableFilingCount: number,
): string | undefined {
  const reasons: string[] = [];
  if (company.ingestionStatus === 'failed')       reasons.push('ingestion failed');
  if (company.ingestionStatus === 'partial')      reasons.push('partial ingestion');
  if (parseableFilingCount === 0)                 reasons.push('no parseable form types in filing set');
  if (parseErrors > 0)                            reasons.push(`${parseErrors} parse error${parseErrors > 1 ? 's' : ''}`);
  if (warnings > 5)                               reasons.push(`${warnings} extraction warnings`);
  if (rejected > 0)                               reasons.push(`${rejected} contamination rejection${rejected > 1 ? 's' : ''}`);
  if (company.confidenceStatus === 'needs_review') reasons.push('confidence: needs_review');
  return reasons.length > 0 ? reasons.join('; ') : undefined;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  const sp = request.nextUrl.searchParams;
  const includeAccessions = sp.get('accessions') === 'true';

  const companies = companiesDb.getAll();
  const runs = runsDb.getAll();

  const rows: object[] = [];

  for (const company of companies) {
    const filings = filingsDb.getByTicker(company.ticker);

    // Form-type breakdown
    const formTypeCounts: Record<string, number> = {};
    for (const f of filings) {
      formTypeCounts[f.formType] = (formTypeCounts[f.formType] ?? 0) + 1;
    }

    const parseableFilings = filings.filter(f => PARSEABLE_FORMS.has(f.formType));
    const annualCount    = filings.filter(f => f.formType === '10-K' || f.formType === '10-K/A').length;
    const quarterlyCount = filings.filter(f => f.formType === '10-Q' || f.formType === '10-Q/A').length;
    const eightKCount    = filings.filter(f => f.formType === '8-K'  || f.formType === '8-K/A').length;

    // Financing data aggregated across all filings
    const allNotes      = filings.flatMap(f => f.financingReport?.convertibleDebt ?? []);
    const allFacilities = filings.flatMap(f => f.financingReport?.equityFacilities ?? []);
    const allWarrants   = filings.flatMap(f => f.financingReport?.warrants ?? []);
    const allRP         = filings.flatMap(f => f.financingReport?.relatedPartyTransactions ?? []);

    const warnings    = allNotes.reduce((s, n) => s + (n._validationWarnings?.length ?? 0), 0);
    const rejected    = allNotes.reduce((s, n) => s + (n._rejectedCandidates?.length ?? 0), 0);
    const parseErrors = filings.reduce((s, f) => s + f.parseErrors.length, 0);

    const completeness = noteCompleteness(allNotes);

    // Parser versions seen
    const parserVersions = [...new Set(filings.map(f => f.parserVersion).filter(Boolean))];

    // Accessions (for restart diff comparison)
    const accessions = includeAccessions
      ? filings.map(f => f.accessionNumber).sort()
      : undefined;

    // Intelligence summary
    const intel = intelligenceDb.getByTicker(company.ticker);

    const score = qualityScore(company, warnings, rejected, completeness, allNotes.length);
    const reason = reviewReason(company, warnings, rejected, parseErrors, parseableFilings.length);

    rows.push({
      ticker:              company.ticker,
      companyName:         company.companyName,
      cik:                 company.cik,
      ingestionStatus:     company.ingestionStatus,
      confidenceStatus:    company.confidenceStatus,
      qualityScore:        Math.round(score),
      reviewReason:        reason,

      // Filing coverage
      filingsTotal:        filings.length,
      filingsAnnual:       annualCount,
      filingsQuarterly:    quarterlyCount,
      filings8K:           eightKCount,
      filingsParseable:    parseableFilings.length,
      formTypes:           formTypeCounts,

      // Financing counts
      noteCount:           allNotes.length,
      facilityCount:       allFacilities.length,
      warrantCount:        allWarrants.length,
      relatedPartyCount:   allRP.length,

      // Quality metrics
      warningsCount:       warnings,
      rejectedCount:       rejected,
      parseErrors,
      noteCompletenessAvg: parseFloat(completeness.toFixed(3)),

      // Infrastructure
      parserVersions,
      latestFilingDate:    company.latestFilingDate,
      lastIngestionTime:   company.lastIngestionTime,

      // Intelligence snapshot
      intelligence: intel ? {
        generatedAt:             intel.generatedAt,
        dilutionRisk:            intel.overview.dilutionRisk,
        financingProfile:        intel.overview.financingProfile,
        latestSharesOutstanding: intel.overview.latestSharesOutstanding,
        riskCount:               intel.keyRisks.length,
        signalCount:             intel.positiveSignals.length,
      } : null,

      ...(includeAccessions ? { accessions } : {}),
    });
  }

  // Sort weakest first
  rows.sort((a, b) => (a as { qualityScore: number }).qualityScore - (b as { qualityScore: number }).qualityScore);

  // Summary stats
  const byConfidence: Record<string, number> = {};
  const byIngestion: Record<string, number> = {};
  for (const c of companies) {
    const conf = c.confidenceStatus ?? 'unknown';
    const ing  = c.ingestionStatus;
    byConfidence[conf] = (byConfidence[conf] ?? 0) + 1;
    byIngestion[ing]   = (byIngestion[ing]   ?? 0) + 1;
  }

  return NextResponse.json({
    snapshotAt:     new Date().toISOString(),
    totalCompanies: companies.length,
    totalFilings:   filingsDb.totalCount(),
    totalRuns:      runs.length,
    byConfidence,
    byIngestion,
    companies: rows,
  });
}
