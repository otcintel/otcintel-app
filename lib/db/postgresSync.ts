/**
 * OTCIntel — Postgres dual-write sync adapter
 *
 * Provides a thin synchronisation layer that mirrors ingestion writes to
 * PostgreSQL alongside the existing filesystem persistence.
 *
 * Design decisions:
 *  - Uses the Postgres repositories directly (not via the backend factory), so
 *    the sync always targets Postgres regardless of PERSISTENCE_BACKEND.
 *    PERSISTENCE_BACKEND controls only the UI read path.
 *  - Returns null when Supabase credentials are absent — callers skip the sync
 *    rather than failing. This allows local dev without Supabase.
 *  - makePostgresSync() is separated from createPostgresSync() so tests can
 *    inject mock repositories without touching the environment.
 */

import type { CompanyRecord, IngestionRun, RunResult } from '../universe/types';
import type { NormalizedFiling, CompanyIntelligence } from '../ingestion/types';
import type {
  ICompaniesRepository,
  IFilingsRepository,
  IIntelligenceRepository,
  IRunsRepository,
} from './types';

// ─── Public interface ─────────────────────────────────────────────────────────

export interface PostgresSync {
  upsertCompany(company: CompanyRecord): Promise<void>;
  upsertFilings(ticker: string, filings: NormalizedFiling[]): Promise<void>;
  upsertIntelligence(intelligence: CompanyIntelligence): Promise<void>;
  upsertRun(run: IngestionRun): Promise<void>;
  upsertRunResult(result: RunResult): Promise<void>;
}

// ─── Factory — production use ─────────────────────────────────────────────────

/**
 * Build a PostgresSync backed by the real Postgres repositories.
 * Returns null if SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not configured —
 * the caller must check for null and skip the sync gracefully.
 */
export async function createPostgresSync(): Promise<PostgresSync | null> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }

  // Import concrete Postgres implementations directly so the sync always
  // targets Postgres, independent of PERSISTENCE_BACKEND.
  const [
    { postgresCompaniesDb },
    { postgresFilingsDb },
    { postgresIntelligenceDb },
    { postgresRunsDb },
  ] = await Promise.all([
    import('./postgres/companies'),
    import('./postgres/filings'),
    import('./postgres/intelligence'),
    import('./postgres/runs'),
  ]);

  return makePostgresSync(postgresCompaniesDb, postgresFilingsDb, postgresIntelligenceDb, postgresRunsDb);
}

// ─── Factory — testable form ──────────────────────────────────────────────────

/**
 * Build a PostgresSync from injected repository implementations.
 * Use this in tests to supply mock repositories without touching the DB.
 */
export function makePostgresSync(
  companiesRepo:    ICompaniesRepository,
  filingsRepo:      IFilingsRepository,
  intelligenceRepo: IIntelligenceRepository,
  runsRepo:         IRunsRepository,
): PostgresSync {
  return {
    async upsertCompany(company: CompanyRecord): Promise<void> {
      await companiesRepo.upsert(company);
    },

    async upsertFilings(ticker: string, filings: NormalizedFiling[]): Promise<void> {
      if (filings.length === 0) return;
      // filingsRepo.upsertAll uses onConflict: 'accession_number' — idempotent
      await filingsRepo.upsertAll(ticker, filings);
    },

    async upsertIntelligence(intelligence: CompanyIntelligence): Promise<void> {
      await intelligenceRepo.upsert(intelligence);
    },

    async upsertRun(run: IngestionRun): Promise<void> {
      // runsRepo.upsert uses onConflict: 'run_id' — safe to call on every status update
      await runsRepo.upsert(run);
    },

    async upsertRunResult(result: RunResult): Promise<void> {
      // runsRepo.upsertResult uses onConflict: 'run_id,cik' — idempotent per company
      await runsRepo.upsertResult(result);
    },
  };
}
