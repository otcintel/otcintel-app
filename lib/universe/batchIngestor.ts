/**
 * Batch ingestion service
 *
 * Orchestrates production-grade population of the company universe:
 *   1. Load pending / failed companies from the persistent DB
 *   2. For each company, resolve CIK via EDGAR (already handled by EdgarFilingFetcher)
 *   3. Fetch filing metadata — skip accession numbers already stored (idempotency)
 *   4. Download + parse only new filings
 *   5. Persist via the active backend (Postgres on Vercel, filesystem locally)
 *   6. Update company status and confidence scoring
 *   7. Record per-company result in the IngestionRun
 *   8. Continue on per-company failure — never abort the batch
 *
 * Persistence is backend-aware:
 *   PERSISTENCE_BACKEND=postgres — all writes go through the Postgres repository
 *     layer (no required filesystem writes; Vercel-safe).
 *   PERSISTENCE_BACKEND=filesystem (default) — writes go to the local JSON store.
 *
 * Designed to run sequentially to stay within EDGAR rate limits.
 */

import { randomUUID } from 'node:crypto';
import type { CompanyRecord, IngestionRun, RunResult, IngestionStage } from './types';
import { PARSER_VERSION } from './types';
import type { SeedCompany } from './types';
import { companiesDb } from '../db';
import {
  getCompaniesRepo,
  getFilingsRepo,
  getRunsRepo,
  getIntelligenceRepo,
} from '../db/repositories';
import type {
  ICompaniesRepository,
  IFilingsRepository,
  IIntelligenceRepository,
} from '../db/types';
import { seedToRecord, applyIngestionResult, getStaleFilings } from './companies';
import { ingestTicker } from '../ingestion';
import { normalizedFilingStore } from '../ingestion/store';
import { generateCompanyIntelligence } from '../ingestion/intelligence/companyIntelligence';

// ─── Seed loading ─────────────────────────────────────────────────────────────

let _seedCache: SeedCompany[] | null = null;

export function loadSeed(): SeedCompany[] {
  if (_seedCache) return _seedCache;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  _seedCache = require('./seed.json') as SeedCompany[];
  return _seedCache;
}

// ─── CIK resolution ───────────────────────────────────────────────────────────

let _tickerMap: Record<string, { cik_str: number | string; ticker: string; title: string }> | null = null;

async function fetchTickerMap(): Promise<typeof _tickerMap> {
  if (_tickerMap) return _tickerMap;
  const res = await fetch('https://www.sec.gov/files/company_tickers.json', {
    headers: { 'User-Agent': 'OTCIntel/1.0 (contact: alec@otcintel.com)', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`EDGAR ticker map fetch failed: ${res.status}`);
  _tickerMap = await res.json() as typeof _tickerMap;
  return _tickerMap;
}

function padCik(cik: string | number): string {
  return String(cik).replace(/^CIK/i, '').trim().padStart(10, '0');
}

// ─── Seed population ──────────────────────────────────────────────────────────

/**
 * Resolve all seed companies against EDGAR and add any new ones to the
 * persistent company DB. Existing companies (same CIK) are not overwritten
 * unless their ticker changed.
 *
 * Returns: { added, skipped, failed }
 */
export async function seedCompanyUniverse(): Promise<{
  added: string[];
  skipped: string[];
  failed: Array<{ ticker: string; reason: string }>;
}> {
  const seeds = loadSeed();
  const added: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ ticker: string; reason: string }> = [];

  // Fetch EDGAR ticker map once for all companies
  let map: Awaited<ReturnType<typeof fetchTickerMap>>;
  try {
    map = await fetchTickerMap();
  } catch (err) {
    throw new Error(`Could not fetch EDGAR ticker map: ${err instanceof Error ? err.message : String(err)}`);
  }

  for (const seed of seeds) {
    const upper = seed.ticker.toUpperCase();
    const entry = Object.values(map!).find(e => e.ticker === upper);

    if (!entry) {
      failed.push({ ticker: upper, reason: 'Not found in EDGAR company tickers' });
      continue;
    }

    const cik = padCik(entry.cik_str);
    const existing = companiesDb.getByCik(cik);

    if (existing) {
      skipped.push(upper);
      continue;
    }

    const record = seedToRecord(seed, cik, entry.title);
    companiesDb.upsert(record);
    added.push(upper);
  }

  return { added, skipped, failed };
}

// ─── Batch ingestion ──────────────────────────────────────────────────────────

export interface BatchIngestionOptions {
  /** Only ingest companies with these tickers (subset of universe) */
  tickers?: string[];
  /** Include 'parsed' companies (re-check for new filings) — default false */
  includeAlreadyParsed?: boolean;
  /** If true, re-parse even filings already in the DB (reprocessing) */
  forceReparse?: boolean;
  verbose?: boolean;
}

/** Repositories passed into per-company ingestion */
interface IngestionRepos {
  companies: ICompaniesRepository;
  filings: IFilingsRepository;
  intelligence: IIntelligenceRepository;
}

/** Track which batches are currently running to prevent double-starts */
const _activeRuns = new Set<string>();

/**
 * Run batch ingestion for the company universe (or a subset).
 *
 * All persistence goes through backend-aware repositories — Postgres on Vercel,
 * filesystem locally — so no filesystem write is required in production.
 *
 * Processes companies sequentially to respect EDGAR rate limits.
 */
export async function runBatchIngestion(opts: BatchIngestionOptions = {}): Promise<IngestionRun> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();

  // Initialize backend-aware repositories once.
  // On Vercel (PERSISTENCE_BACKEND=postgres) these go to Supabase.
  // Locally (PERSISTENCE_BACKEND=filesystem) these delegate to the JSON store.
  const [companiesRepo, filingsRepo, runsRepo, intelligenceRepo] = await Promise.all([
    getCompaniesRepo(),
    getFilingsRepo(),
    getRunsRepo(),
    getIntelligenceRepo(),
  ]);

  const run: IngestionRun = {
    runId,
    startedAt,
    parserVersion: PARSER_VERSION,
    status: 'running',
    companiesAttempted: 0,
    companiesCompleted: 0,
    companiesPartial:   0,
    companiesFailed:    0,
    filingsDiscovered:  0,
    filingsDownloaded:  0,
    filingsParsed:      0,
    warningsCount:      0,
    errors:             [],
  };

  await runsRepo.upsert(run);
  _activeRuns.add(runId);

  const repos: IngestionRepos = { companies: companiesRepo, filings: filingsRepo, intelligence: intelligenceRepo };

  try {
    // Build target company list via the backend-aware repo.
    // When PERSISTENCE_BACKEND=postgres this reads from Supabase, so the 24
    // production companies are found even though data/companies.json is empty.
    const companies: CompanyRecord[] = opts.tickers?.length
      ? (await Promise.all(opts.tickers.map(t => companiesRepo.getByTicker(t))))
          .filter((c): c is CompanyRecord => c != null)
      : (await companiesRepo.getAll()).filter(c =>
          c.ingestionStatus === 'pending' ||
          c.ingestionStatus === 'failed' ||
          c.ingestionStatus === 'stale' ||
          (opts.includeAlreadyParsed && c.ingestionStatus === 'parsed'),
        );

    if (opts.tickers?.length && companies.length === 0) {
      run.errors.push('None of the specified tickers are in the company universe. Run /seed first.');
    }

    run.companiesAttempted = companies.length;
    await runsRepo.upsert(run);

    for (const company of companies) {
      const result = await ingestOneCompany(company, run, opts, repos);

      await runsRepo.upsertResult(result);

      if (result.status === 'completed') run.companiesCompleted++;
      else if (result.status === 'partial')   run.companiesPartial++;
      else if (result.status === 'failed')    run.companiesFailed++;

      run.filingsDiscovered += result.filingsDiscovered;
      run.filingsDownloaded += result.filingsDownloaded;
      run.filingsParsed     += result.filingsParsed;
      run.warningsCount     += result.warningsCount;

      await runsRepo.upsert(run);
    }

    run.status = run.companiesFailed === run.companiesAttempted && run.companiesAttempted > 0
      ? 'failed'
      : run.companiesFailed > 0 || run.companiesPartial > 0
        ? 'partial'
        : 'completed';

  } catch (err) {
    run.status = 'failed';
    run.errors.push(err instanceof Error ? err.message : String(err));
  }

  run.endedAt = new Date().toISOString();
  await runsRepo.upsert(run);
  _activeRuns.delete(runId);

  return run;
}

// ─── Per-company ingestion ────────────────────────────────────────────────────

async function ingestOneCompany(
  company: CompanyRecord,
  run: IngestionRun,
  opts: BatchIngestionOptions,
  repos: IngestionRepos,
): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  let stage: IngestionStage = 'ticker_resolution';

  await repos.companies.updateStatus(company.cik, { ingestionStatus: 'ingesting' });

  try {
    stage = 'sec_fetch';

    // Idempotency: skip accession numbers already stored at the current parser
    // version. Stale filings (wrong parser version) are re-fetched and re-parsed.
    // opts.forceReparse overrides this entirely.
    let skipAccessions: Set<string>;
    if (opts.forceReparse) {
      skipAccessions = new Set<string>();
    } else {
      const storedFilings = await repos.filings.getByTicker(company.ticker);
      const staleAccessions = new Set(getStaleFilings(storedFilings).map(f => f.accessionNumber));
      const allKnown = await repos.filings.knownAccessions(company.ticker);
      // Remove stale from the skip set so they are re-parsed
      for (const acc of staleAccessions) allKnown.delete(acc);
      skipAccessions = allKnown;

      if (staleAccessions.size > 0 && opts.verbose) {
        console.log(
          `[batch] ${company.ticker}: ${staleAccessions.size} stale filing(s) will be re-parsed ` +
          `(parser version mismatch — current: ${PARSER_VERSION})`,
        );
      }
    }

    stage = 'document_parsing';

    const result = await ingestTicker(company.ticker, {
      verbose:        opts.verbose ?? false,
      skipAccessions,
    });

    if (result.errors.some(e => e.includes('not found in EDGAR'))) {
      throw Object.assign(new Error(result.errors.join('; ')), { stage: 'ticker_resolution' as IngestionStage });
    }

    stage = 'financing_extraction';

    const discovered = result.fetched + skipAccessions.size;
    const downloaded = result.fetched;

    stage = 'persistence';

    // Keep the in-memory store warm for same-process API reads.
    // Its internal filesystem write is non-fatal (silently swallowed on EROFS).
    normalizedFilingStore.upsertAll(result.normalized);

    // Authoritative persistence: backend-aware repo write.
    // On Vercel this goes to Supabase; locally to the JSON file store.
    await repos.filings.upsertAll(company.ticker, result.normalized);

    stage = 'intelligence_aggregation';

    // Read all filings for this ticker from the repo — includes historical data
    // stored in Postgres, not only the filings from the current run.
    const allFilings = await repos.filings.getByTicker(company.ticker);
    const updated = applyIngestionResult(company, allFilings, discovered);
    await repos.companies.upsert(updated);
    await repos.intelligence.upsert(generateCompanyIntelligence(company.ticker, allFilings));

    const endedAt = new Date().toISOString();

    return {
      runId:             run.runId,
      cik:               company.cik,
      ticker:            company.ticker,
      status:            result.errors.length > 0 ? 'partial' : 'completed',
      filingsDiscovered: discovered,
      filingsDownloaded: downloaded,
      filingsParsed:     result.parsed,
      warningsCount:     updated.warningsCount,
      errorMessage:      result.errors.length > 0 ? result.errors.slice(0, 3).join('; ') : undefined,
      durationMs:        Date.parse(endedAt) - Date.parse(startedAt),
      startedAt,
      endedAt,
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const failedStage: IngestionStage = (err as { stage?: IngestionStage }).stage ?? stage;

    // Update company status to 'failed' — best-effort, non-fatal
    try {
      await repos.companies.updateStatus(company.cik, { ingestionStatus: 'failed', errorMessage });
    } catch { /* don't mask the original error */ }

    if (opts.verbose) {
      console.error(`[batch] ${company.ticker} failed at ${failedStage}: ${errorMessage}`);
    }
    run.errors.push(`${company.ticker} [${failedStage}]: ${errorMessage}`);

    const endedAt = new Date().toISOString();
    return {
      runId:             run.runId,
      cik:               company.cik,
      ticker:            company.ticker,
      status:            'failed',
      failedStage,
      filingsDiscovered: 0,
      filingsDownloaded: 0,
      filingsParsed:     0,
      warningsCount:     0,
      errorMessage,
      durationMs:        Date.parse(endedAt) - Date.parse(startedAt),
      startedAt,
      endedAt,
    };
  }
}

// ─── Active run check ─────────────────────────────────────────────────────────

export function getActiveRuns(): string[] {
  return [..._activeRuns];
}
