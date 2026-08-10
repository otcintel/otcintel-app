/**
 * Company Universe types
 *
 * Models for the persistent company registry, ingestion runs, and per-company
 * run results. These live in data/*.json and data/runs/*.json and survive
 * server restarts.
 */

// ─── Parser version ───────────────────────────────────────────────────────────

/** Bump this when extractors change significantly to trigger controlled reprocessing. */
export const PARSER_VERSION = '1.0.0';

// ─── Company record ───────────────────────────────────────────────────────────

export type CompanyIngestionStatus =
  | 'pending'
  | 'ingesting'
  | 'parsed'
  | 'partial'
  | 'failed'
  | 'stale'
  | 'needs_review';

export type CompanyConfidenceStatus =
  | 'high_confidence'
  | 'usable_with_warnings'
  | 'needs_review'
  | 'insufficient_data';

export interface CompanyRecord {
  /** SEC CIK zero-padded to 10 digits — primary SEC identity */
  cik: string;
  ticker: string;
  companyName: string;
  exchange?: string;
  secReportingStatus?: string;
  active: boolean;
  latestFilingDate?: string;
  lastIngestionTime?: string;
  lastSuccessfulParseTime?: string;
  ingestionStatus: CompanyIngestionStatus;
  parsingStatus?: string;
  confidenceStatus?: CompanyConfidenceStatus;
  errorMessage?: string;
  filingsDiscovered: number;
  filingsParsed: number;
  warningsCount: number;
  rejectedCandidatesCount: number;
  createdAt: string;
  updatedAt: string;
}

// ─── Ingestion run ────────────────────────────────────────────────────────────

export type IngestionRunStatus = 'running' | 'completed' | 'failed' | 'partial';

export interface IngestionRun {
  runId: string;
  startedAt: string;
  endedAt?: string;
  parserVersion: string;
  status: IngestionRunStatus;
  companiesAttempted: number;
  companiesCompleted: number;
  companiesPartial: number;
  companiesFailed: number;
  filingsDiscovered: number;
  filingsDownloaded: number;
  filingsParsed: number;
  warningsCount: number;
  errors: string[];
}

// ─── Per-company result within a run ─────────────────────────────────────────

export type RunResultStatus = 'completed' | 'partial' | 'failed' | 'skipped';

export type IngestionStage =
  | 'ticker_resolution'
  | 'sec_fetch'
  | 'filing_selection'
  | 'document_parsing'
  | 'financing_extraction'
  | 'persistence'
  | 'intelligence_aggregation';

export interface RunResult {
  runId: string;
  cik: string;
  ticker: string;
  status: RunResultStatus;
  /** Stage at which failure occurred — only set when status === 'failed' */
  failedStage?: IngestionStage;
  filingsDiscovered: number;
  filingsDownloaded: number;
  filingsParsed: number;
  warningsCount: number;
  errorMessage?: string;
  durationMs: number;
  startedAt: string;
  endedAt: string;
}

// ─── Seed list entry ──────────────────────────────────────────────────────────

export type SeedCategory =
  | 'convertible_note'
  | 'equity_facility'
  | 'preferred_stock'
  | 'warrant_heavy'
  | 'related_party'
  | 'clean_balance_sheet';

export interface SeedCompany {
  ticker: string;
  companyName: string;
  category: SeedCategory;
  notes?: string;
}
