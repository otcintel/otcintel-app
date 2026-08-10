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

import type { ICompaniesRepository, IFilingsRepository, IRunsRepository, IIntelligenceRepository } from './types';

const BACKEND = process.env.PERSISTENCE_BACKEND ?? 'filesystem';

// Lazy-loaded singletons — modules are loaded once and cached by Node's module system
let _companies:     ICompaniesRepository | null = null;
let _filings:       IFilingsRepository | null = null;
let _runs:          IRunsRepository | null = null;
let _intelligence:  IIntelligenceRepository | null = null;

async function loadBackend(): Promise<{
  companies: ICompaniesRepository;
  filings: IFilingsRepository;
  runs: IRunsRepository;
  intelligence: IIntelligenceRepository;
}> {
  if (BACKEND === 'postgres') {
    const [c, f, r, i] = await Promise.all([
      import('./postgres/companies'),
      import('./postgres/filings'),
      import('./postgres/runs'),
      import('./postgres/intelligence'),
    ]);
    return {
      companies:    c.postgresCompaniesDb,
      filings:      f.postgresFilingsDb,
      runs:         r.postgresRunsDb,
      intelligence: i.postgresIntelligenceDb,
    };
  }

  // Filesystem default — delegates to lib/db/index.ts synchronous implementations
  const { filesystemCompaniesRepo, filesystemFilingsRepo, filesystemRunsRepo, filesystemIntelligenceRepo } =
    await import('./filesystem');
  return {
    companies:    filesystemCompaniesRepo,
    filings:      filesystemFilingsRepo,
    runs:         filesystemRunsRepo,
    intelligence: filesystemIntelligenceRepo,
  };
}

export async function getCompaniesRepo(): Promise<ICompaniesRepository> {
  if (!_companies) {
    const b = await loadBackend();
    _companies    = b.companies;
    _filings      = b.filings;
    _runs         = b.runs;
    _intelligence = b.intelligence;
  }
  return _companies;
}

export async function getFilingsRepo(): Promise<IFilingsRepository> {
  if (!_filings) {
    const b = await loadBackend();
    _companies    = b.companies;
    _filings      = b.filings;
    _runs         = b.runs;
    _intelligence = b.intelligence;
  }
  return _filings;
}

export async function getRunsRepo(): Promise<IRunsRepository> {
  if (!_runs) {
    const b = await loadBackend();
    _companies    = b.companies;
    _filings      = b.filings;
    _runs         = b.runs;
    _intelligence = b.intelligence;
  }
  return _runs;
}

export async function getIntelligenceRepo(): Promise<IIntelligenceRepository> {
  if (!_intelligence) {
    const b = await loadBackend();
    _companies    = b.companies;
    _filings      = b.filings;
    _runs         = b.runs;
    _intelligence = b.intelligence;
  }
  return _intelligence;
}

/** Returns the active backend name — useful for logging. */
export function getBackendName(): string {
  return BACKEND;
}

/** Reset all singletons (for tests). */
export function resetRepositories(): void {
  _companies    = null;
  _filings      = null;
  _runs         = null;
  _intelligence = null;
}
