/**
 * OTCIntel — Repository factory
 *
 * Selects the active persistence backend based on PERSISTENCE_BACKEND env var.
 *
 *   PERSISTENCE_BACKEND=filesystem  (default) — file-based JSON in data/
 *   PERSISTENCE_BACKEND=postgres              — Supabase / PostgreSQL
 *
 * This module is the ONLY place where the backend is selected. All callers
 * (server-data.ts and any future async consumers) import from here.
 *
 * The ingestion pipeline and admin routes continue to use lib/db/index.ts
 * directly (always filesystem) and are migrated in a future phase.
 */

import type { ICompaniesRepository, IFilingsRepository, IRunsRepository, IIntelligenceRepository, IFinancialSnapshotsRepository, IReviewItemsRepository } from './types';

const BACKEND = process.env.PERSISTENCE_BACKEND ?? 'filesystem';

// Lazy-loaded singletons — modules are loaded once and cached by Node's module system
let _companies:          ICompaniesRepository | null = null;
let _filings:            IFilingsRepository | null = null;
let _runs:               IRunsRepository | null = null;
let _intelligence:       IIntelligenceRepository | null = null;
let _financialSnapshots: IFinancialSnapshotsRepository | null = null;
let _reviewItems:        IReviewItemsRepository | null = null;

// Review items are Postgres-only. On the filesystem backend, all writes are
// silently discarded and reads return empty results so that the batch ingestor
// runs locally without Supabase credentials.
const _noOpReviewItemsRepo: IReviewItemsRepository = {
  async upsertDetected()       { /* filesystem: review items require Postgres */ },
  async list()                 { return []; },
  async getByDedupKey()        { return undefined; },
  async updateStatus()         { /* no-op */ },
  async markResolvedIfAbsent() { /* no-op */ },
};

async function loadBackend(): Promise<{
  companies: ICompaniesRepository;
  filings: IFilingsRepository;
  runs: IRunsRepository;
  intelligence: IIntelligenceRepository;
  financialSnapshots: IFinancialSnapshotsRepository;
}> {
  if (BACKEND === 'postgres') {
    const [c, f, r, i, s] = await Promise.all([
      import('./postgres/companies'),
      import('./postgres/filings'),
      import('./postgres/runs'),
      import('./postgres/intelligence'),
      import('./postgres/financialSnapshots'),
    ]);
    return {
      companies:          c.postgresCompaniesDb,
      filings:            f.postgresFilingsDb,
      runs:               r.postgresRunsDb,
      intelligence:       i.postgresIntelligenceDb,
      financialSnapshots: s.postgresFinancialSnapshotsDb,
    };
  }

  // Filesystem default — delegates to lib/db/index.ts synchronous implementations
  const {
    filesystemCompaniesRepo,
    filesystemFilingsRepo,
    filesystemRunsRepo,
    filesystemIntelligenceRepo,
    filesystemFinancialSnapshotsRepo,
  } = await import('./filesystem');
  return {
    companies:          filesystemCompaniesRepo,
    filings:            filesystemFilingsRepo,
    runs:               filesystemRunsRepo,
    intelligence:       filesystemIntelligenceRepo,
    financialSnapshots: filesystemFinancialSnapshotsRepo,
  };
}

function populateSingletons(b: Awaited<ReturnType<typeof loadBackend>>): void {
  _companies          = b.companies;
  _filings            = b.filings;
  _runs               = b.runs;
  _intelligence       = b.intelligence;
  _financialSnapshots = b.financialSnapshots;
}

export async function getCompaniesRepo(): Promise<ICompaniesRepository> {
  if (!_companies) populateSingletons(await loadBackend());
  return _companies!;
}

export async function getFilingsRepo(): Promise<IFilingsRepository> {
  if (!_filings) populateSingletons(await loadBackend());
  return _filings!;
}

export async function getRunsRepo(): Promise<IRunsRepository> {
  if (!_runs) populateSingletons(await loadBackend());
  return _runs!;
}

export async function getIntelligenceRepo(): Promise<IIntelligenceRepository> {
  if (!_intelligence) populateSingletons(await loadBackend());
  return _intelligence!;
}

export async function getFinancialSnapshotsRepo(): Promise<IFinancialSnapshotsRepository> {
  if (!_financialSnapshots) populateSingletons(await loadBackend());
  return _financialSnapshots!;
}

export async function getReviewItemsRepo(): Promise<IReviewItemsRepository> {
  if (_reviewItems) return _reviewItems;
  if (BACKEND === 'postgres') {
    const { postgresReviewItemsDb } = await import('./postgres/reviewItems');
    _reviewItems = postgresReviewItemsDb;
  } else {
    _reviewItems = _noOpReviewItemsRepo;
  }
  return _reviewItems;
}

/** Returns the active backend name — useful for logging. */
export function getBackendName(): string {
  return BACKEND;
}

/** Reset all singletons (for tests). */
export function resetRepositories(): void {
  _companies          = null;
  _filings            = null;
  _runs               = null;
  _intelligence       = null;
  _financialSnapshots = null;
  _reviewItems        = null;
}
