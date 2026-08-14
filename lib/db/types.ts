/**
 * OTCIntel — Repository interfaces
 *
 * These interfaces define the behavioral contract that both the filesystem
 * and PostgreSQL backends must satisfy. Callers should depend only on these
 * interfaces, not on concrete implementations.
 *
 * All methods return Promises so the interface is compatible with async
 * backends (Supabase/Postgres). The filesystem implementation wraps its
 * synchronous reads in Promise.resolve().
 */

import type { CompanyRecord, IngestionRun, RunResult } from '../universe/types';
import type { NormalizedFiling, CompanyIntelligence } from '../ingestion/types';
import type { FinancialSnapshot } from '../ingestion/parsers/financials/snapshot';
import type { ReviewItemInput, ReviewItem, ReviewItemFilters, ReviewStatus } from '../anomaly/types';

// ─── Companies ────────────────────────────────────────────────────────────────

export interface ICompaniesRepository {
  /** All companies, sorted alphabetically by ticker. */
  getAll(): Promise<CompanyRecord[]>;

  /** Company by CIK (exact match). */
  getByCik(cik: string): Promise<CompanyRecord | undefined>;

  /** Company by ticker (case-insensitive). */
  getByTicker(ticker: string): Promise<CompanyRecord | undefined>;

  /** Insert or update a company record (keyed by CIK). */
  upsert(company: CompanyRecord): Promise<void>;

  /** Bulk upsert — more efficient than N single upserts. */
  upsertAll(companies: CompanyRecord[]): Promise<void>;

  /** Partial update of company fields (by CIK). No-op if CIK not found. */
  updateStatus(cik: string, updates: Partial<CompanyRecord>): Promise<void>;

  /** Total number of company records. */
  count(): Promise<number>;
}

// ─── Filings ──────────────────────────────────────────────────────────────────

export interface IFilingsRepository {
  /** All filings for a ticker, sorted newest-first. */
  getByTicker(ticker: string): Promise<NormalizedFiling[]>;

  /** True if the exact accession number exists for this ticker. */
  hasAccession(ticker: string, accessionNumber: string): Promise<boolean>;

  /** Set of accession numbers already stored for this ticker. */
  knownAccessions(ticker: string): Promise<Set<string>>;

  /**
   * Upsert a batch of filings for a ticker.
   * Merges with existing records by accession number — does not delete.
   * Result set remains sorted newest-first.
   */
  upsertAll(ticker: string, incoming: NormalizedFiling[]): Promise<void>;

  /** All tickers with at least one stored filing. */
  getAllTickers(): Promise<string[]>;

  /** Total filing count across all tickers. */
  totalCount(): Promise<number>;
}

// ─── Ingestion runs ───────────────────────────────────────────────────────────

export interface IRunsRepository {
  /** All ingestion runs, newest-first (capped at 100). */
  getAll(): Promise<IngestionRun[]>;

  /** A specific run by its UUID. */
  getById(runId: string): Promise<IngestionRun | undefined>;

  /** Insert or update a run record. */
  upsert(run: IngestionRun): Promise<void>;

  /** All per-company results for a run. */
  getResults(runId: string): Promise<RunResult[]>;

  /** Insert or update a per-company result within a run. */
  upsertResult(result: RunResult): Promise<void>;
}

// ─── Company intelligence ─────────────────────────────────────────────────────

export interface IIntelligenceRepository {
  /** Intelligence record for a ticker. Undefined if not yet generated. */
  getByTicker(ticker: string): Promise<CompanyIntelligence | undefined>;

  /** Insert or update an intelligence record. */
  upsert(intelligence: CompanyIntelligence): Promise<void>;

  /** All tickers with stored intelligence records. */
  getAllTickers(): Promise<string[]>;
}

// ─── Financial snapshots ──────────────────────────────────────────────────────

export interface IFinancialSnapshotsRepository {
  /**
   * Most recent snapshot for a company (by filed_at DESC, then extracted_at DESC).
   * Returns undefined when no snapshot exists yet.
   */
  getLatestByCompany(ticker: string): Promise<FinancialSnapshot | undefined>;

  /** All snapshots for a company, newest-first by filed_at. */
  getByCompany(ticker: string): Promise<FinancialSnapshot[]>;

  /** Snapshot by exact accession number (undefined if not found). */
  getByAccession(accessionNumber: string): Promise<FinancialSnapshot | undefined>;

  /**
   * Insert or update a snapshot.
   * Conflict key: (company_id, accession_number) when accession_number is set.
   * When accession_number is null, always inserts a new row.
   */
  upsert(snapshot: FinancialSnapshot): Promise<void>;
}

// ─── Review items ─────────────────────────────────────────────────────────────

export interface IReviewItemsRepository {
  upsertDetected(items: ReviewItemInput[]): Promise<void>;
  list(filters?: ReviewItemFilters): Promise<ReviewItem[]>;
  getById(id: string): Promise<ReviewItem | undefined>;
  getByDedupKey(dedupKey: string): Promise<ReviewItem | undefined>;
  updateStatus(id: string, status: ReviewStatus, resolutionNote?: string): Promise<void>;
  markResolvedIfAbsent(activeDedupKeys: string[], ticker?: string): Promise<void>;
}

// ─── Combined ─────────────────────────────────────────────────────────────────

export interface IRepositories {
  companies: ICompaniesRepository;
  filings: IFilingsRepository;
  runs: IRunsRepository;
  intelligence: IIntelligenceRepository;
  financialSnapshots: IFinancialSnapshotsRepository;
  reviewItems?: IReviewItemsRepository;
}
