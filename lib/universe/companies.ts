/**
 * Company Universe management
 *
 * Handles seeding, CIK resolution, confidence scoring, and status derivation
 * for the persistent company registry.
 */

import type { CompanyRecord, CompanyConfidenceStatus, SeedCompany } from './types';
import { PARSER_VERSION } from './types';
import type { NormalizedFiling } from '../ingestion/types';
import { companiesDb } from '../db';

// ─── Confidence scoring ───────────────────────────────────────────────────────

/**
 * Form types that the current parser can extract structured data from.
 * Foreign-filer forms (6-K, 20-F), proxy statements, and administrative forms
 * are not parsed and do not constitute coverage evidence.
 */
export const PARSEABLE_FORMS = new Set([
  '10-K', '10-K/A', '10-Q', '10-Q/A',
  '8-K',  '8-K/A',
  'S-1',  'S-1/A',  'S-3',  'S-3/A',  'S-8',
  '1-A',  '1-A/A',
]);

/**
 * Derives a company-level confidence status from all its parsed filings.
 * Requires positive coverage evidence — at least one annual (10-K/10-K/A) or
 * two quarterly (10-Q/10-Q/A) parseable filings — before assigning high_confidence.
 * Companies whose filing set consists entirely of foreign-filer or non-extractable
 * forms (6-K, 20-F, Form 3/4, etc.) receive insufficient_data regardless of count.
 */
export function deriveConfidenceStatus(filings: NormalizedFiling[]): CompanyConfidenceStatus {
  if (filings.length === 0) return 'insufficient_data';

  // Only forms the parser can extract from count as coverage
  const parseableFilings = filings.filter(f => PARSEABLE_FORMS.has(f.formType));
  if (parseableFilings.length === 0) return 'insufficient_data';

  const annuals     = parseableFilings.filter(f => f.formType === '10-K' || f.formType === '10-K/A');
  const quarterlies = parseableFilings.filter(f => f.formType === '10-Q' || f.formType === '10-Q/A');

  // Require at least one annual OR two quarterly reports for meaningful coverage
  if (annuals.length === 0 && quarterlies.length < 2) return 'insufficient_data';

  const notes      = parseableFilings.flatMap(f => f.financingReport?.convertibleDebt ?? []);
  const warnings   = notes.reduce((s, n) => s + (n._validationWarnings?.length ?? 0), 0);
  const rejected   = notes.reduce((s, n) => s + (n._rejectedCandidates?.length ?? 0), 0);
  const parseErrors = parseableFilings.reduce((s, f) => s + f.parseErrors.length, 0);

  if (warnings === 0 && rejected === 0 && parseErrors === 0) return 'high_confidence';
  if (warnings <= 2 && parseErrors <= 1) return 'usable_with_warnings';
  if (warnings > 5 || parseErrors > 3) return 'needs_review';
  return 'usable_with_warnings';
}

/**
 * Counts validation warnings and rejected contamination candidates across all
 * parsed notes in all filings for a ticker.
 */
export function countWarnings(filings: NormalizedFiling[]): { warnings: number; rejected: number } {
  const notes = filings.flatMap(f => f.financingReport?.convertibleDebt ?? []);
  return {
    warnings: notes.reduce((s, n) => s + (n._validationWarnings?.length ?? 0), 0),
    rejected: notes.reduce((s, n) => s + (n._rejectedCandidates?.length ?? 0), 0),
  };
}

// ─── Seed helpers ─────────────────────────────────────────────────────────────

/**
 * Convert a SeedCompany (from seed.json) into a pending CompanyRecord.
 * CIK is not known at seed time — it will be resolved during ingestion.
 * Uses ticker as a temporary placeholder CIK until resolution succeeds.
 */
export function seedToRecord(seed: SeedCompany, cik: string, resolvedName?: string): CompanyRecord {
  const now = new Date().toISOString();
  return {
    cik,
    ticker:              seed.ticker.toUpperCase(),
    companyName:         resolvedName ?? seed.companyName,
    active:              true,
    ingestionStatus:     'pending',
    filingsDiscovered:   0,
    filingsParsed:       0,
    warningsCount:       0,
    rejectedCandidatesCount: 0,
    createdAt:           now,
    updatedAt:           now,
  };
}

/**
 * Update a CompanyRecord after a successful ingestion run.
 */
export function applyIngestionResult(
  company: CompanyRecord,
  filings: NormalizedFiling[],
  discovered: number,
): CompanyRecord {
  const { warnings, rejected } = countWarnings(filings);
  const confidence = deriveConfidenceStatus(filings);
  const latestFiling = filings[0]?.filedAt;
  const now = new Date().toISOString();

  const hasParseErrors = filings.some(f => f.parseErrors.length > 0);
  const ingestionStatus = filings.length === 0
    ? 'partial'
    : hasParseErrors
      ? 'partial'
      : 'parsed';

  return {
    ...company,
    ingestionStatus,
    confidenceStatus:        confidence,
    filingsDiscovered:       discovered,
    filingsParsed:           filings.length,
    warningsCount:           warnings,
    rejectedCandidatesCount: rejected,
    latestFilingDate:        latestFiling,
    lastIngestionTime:       now,
    lastSuccessfulParseTime: filings.length > 0 ? now : company.lastSuccessfulParseTime,
    errorMessage:            undefined,
    updatedAt:               now,
  };
}

// ─── Parser version staleness ─────────────────────────────────────────────────

/**
 * Returns the subset of filings whose parserVersion differs from the current
 * PARSER_VERSION. These filings have already been downloaded but need to be
 * re-parsed with the updated extractor.
 *
 * Used by batchIngestor to exclude stale accession numbers from the skip set,
 * so the pipeline re-fetches and re-parses them without re-downloading the
 * raw SEC document if the source text is still available.
 */
export function getStaleFilings(filings: NormalizedFiling[]): NormalizedFiling[] {
  return filings.filter(f => f.parserVersion !== PARSER_VERSION);
}

/**
 * Returns true if any stored filing for this company was created by an older
 * parser version than the current PARSER_VERSION.
 */
export function hasStaleFilings(filings: NormalizedFiling[]): boolean {
  return filings.some(f => f.parserVersion !== PARSER_VERSION);
}

// ─── Company accessors ────────────────────────────────────────────────────────

export function getCompaniesNeedingIngestion(): CompanyRecord[] {
  return companiesDb.getAll().filter(c =>
    c.ingestionStatus === 'pending' ||
    c.ingestionStatus === 'failed' ||
    c.ingestionStatus === 'stale',
  );
}

export function getCompaniesByStatus(status: CompanyRecord['ingestionStatus']): CompanyRecord[] {
  return companiesDb.getAll().filter(c => c.ingestionStatus === status);
}
