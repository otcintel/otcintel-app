/**
 * Batch ingestion service
 *
 * Orchestrates production-grade population of the company universe:
 *   1. Load pending / failed companies from the persistent DB
 *   2. For each company, resolve CIK via EDGAR (already handled by EdgarFilingFetcher)
 *   3. Fetch filing metadata — skip accession numbers already stored (idempotency)
 *   4. Download + parse only new filings
 *   5. Persist to filingsDb + normalizedFilingStore
 *   6. Update company status and confidence scoring
 *   7. Record per-company result in the IngestionRun
 *   8. Continue on per-company failure — never abort the batch
 *
 * Designed to run sequentially to stay within EDGAR rate limits.
 */

import { randomUUID } from 'node:crypto';
import type { CompanyRecord, IngestionRun, RunResult, IngestionStage } from './types';
import { PARSER_VERSION } from './types';
import type { SeedCompany } from './types';
import { companiesDb, filingsDb, runsDb, intelligenceDb } from '../db';
import { seedToRecord, applyIngestionResult, getStaleFilings } from './companies';
import { ingestTicker } from '../ingestion';
import { normalizedFilingStore } from '../ingestion/store';
import { generateCompanyIntelligence } from '../ingestion/intelligence/companyIntelligence';
import { createPostgresSync, type PostgresSync } from '../db/postgresSync';

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

async function resolveCik(ticker: string): Promise<{ cik: string; companyName: string }> {
  const map = await fetchTickerMap();
  const upper = ticker.toUpperCase();
  const entry = Object.values(map!).find(e => e.ticker === upper);
  if (!entry) throw new Error(`Ticker "${ticker}" not found in EDGAR company tickers`);
  return { cik: padCik(entry.cik_str), companyName: entry.title };
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

/** Track which batches are currently running to prevent double-starts */
const _activeRuns = new Set<string>();

// ─── Postgres run-write helpers ───────────────────────────────────────────────
// Errors are caught and pushed to run.errors so they are surfaced in the run
// record without aborting the batch.  The filesystem write always happens first.

async function pgRunWrite(pgSync: PostgresSync | null, run: IngestionRun): Promise<void> {
  if (!pgSync) return;
  try {
    await pgSync.upsertRun(run);
  } catch (err) {
    run.errors.push(
      `[pg-sync] run ${run.runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function pgResultWrite(
  pgSync: PostgresSync | null,
  result: RunResult,
  run: IngestionRun,
): Promise<void> {
  if (!pgSync) return;
  try {
    await pgSync.upsertRunResult(result);
  } catch (err) {
    run.errors.push(
      `[pg-sync] run result ${result.ticker} (${result.cik}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Run batch ingestion for the company universe (or a subset).
 * Processes companies sequentially — one at a time — to respect EDGAR rate limits.
 * Safe to call while another batch is running (different run IDs, companies
 * are claimed via status updates before processing begins).
 */
export async function runBatchIngestion(opts: BatchIngestionOptions = {}): Promise<IngestionRun> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();

  // Build Postgres sync before the first run write so every run event is captured.
  // A failed init is non-fatal — pgSync stays null and the batch runs filesystem-only.
  let pgSync: PostgresSync | null = null;
  try {
    pgSync = await createPostgresSync();
  } catch {
    // Errors are recorded after the run object is created below
  }

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

  runsDb.upsert(run);                        // filesystem: initial 'running' record
  await pgRunWrite(pgSync, run);             // postgres:   initial 'running' record
  _activeRuns.add(runId);

  try {
    // Build target company list
    const companies = opts.tickers?.length
      ? opts.tickers.map(t => companiesDb.getByTicker(t)).filter((c): c is CompanyRecord => c != null)
      : companiesDb.getAll().filter(c =>
          c.ingestionStatus === 'pending' ||
          c.ingestionStatus === 'failed' ||
          c.ingestionStatus === 'stale' ||
          (opts.includeAlreadyParsed && c.ingestionStatus === 'parsed'),
        );

    if (opts.tickers?.length && companies.length === 0) {
      run.errors.push('None of the specified tickers are in the company universe. Run /seed first.');
    }

    run.companiesAttempted = companies.length;
    runsDb.upsert(run);                      // filesystem: company count set
    await pgRunWrite(pgSync, run);           // postgres:   company count set

    for (const company of companies) {
      const result = await ingestOneCompany(company, run, opts, pgSync);

      runsDb.upsertResult(result);                 // filesystem: per-company result
      await pgResultWrite(pgSync, result, run);    // postgres:   per-company result

      if (result.status === 'completed') run.companiesCompleted++;
      else if (result.status === 'partial')   run.companiesPartial++;
      else if (result.status === 'failed')    run.companiesFailed++;

      run.filingsDiscovered += result.filingsDiscovered;
      run.filingsDownloaded += result.filingsDownloaded;
      run.filingsParsed     += result.filingsParsed;
      run.warningsCount     += result.warningsCount;

      runsDb.upsert(run);                    // filesystem: progress after company
      await pgRunWrite(pgSync, run);         // postgres:   progress after company
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
  runsDb.upsert(run);                        // filesystem: final status
  await pgRunWrite(pgSync, run);             // postgres:   final status
  _activeRuns.delete(runId);

  return run;
}

// ─── Per-company ingestion ────────────────────────────────────────────────────

async function ingestOneCompany(
  company: CompanyRecord,
  run: IngestionRun,
  opts: BatchIngestionOptions,
  pgSync: PostgresSync | null,
): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  let stage: IngestionStage = 'ticker_resolution';

  // Mark in-progress so concurrent batches won't double-ingest
  companiesDb.updateStatus(company.cik, { ingestionStatus: 'ingesting' });

  try {
    stage = 'sec_fetch';

    // Idempotency: skip accession numbers already stored at the current parser
    // version. Filings whose parserVersion differs from PARSER_VERSION are
    // excluded from the skip set so they are re-fetched and re-parsed.
    // opts.forceReparse overrides this entirely and re-parses everything.
    let skipAccessions: Set<string>;
    if (opts.forceReparse) {
      skipAccessions = new Set<string>();
    } else {
      const storedFilings = filingsDb.getByTicker(company.ticker);
      const staleAccessions = new Set(getStaleFilings(storedFilings).map(f => f.accessionNumber));
      const allKnown = filingsDb.knownAccessions(company.ticker);
      // Skip everything except stale filings (those need re-parsing)
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

    // Filesystem write (existing behaviour — errors are non-fatal inside the store)
    normalizedFilingStore.upsertAll(result.normalized);

    // Postgres dual-write: filings
    const pgErrors: string[] = [];
    if (pgSync) {
      try {
        await pgSync.upsertFilings(company.ticker, result.normalized);
      } catch (err) {
        const msg = `Postgres filings sync for ${company.ticker}: ${err instanceof Error ? err.message : String(err)}`;
        pgErrors.push(msg);
        run.errors.push(`[pg-sync] ${msg}`);
      }
    }

    stage = 'intelligence_aggregation';

    // Load all filings (including previously stored) for confidence scoring + intelligence
    const allFilings = normalizedFilingStore.getByTicker(company.ticker);
    const updated = applyIngestionResult(company, allFilings, discovered);
    companiesDb.upsert(updated);

    // Postgres dual-write: company record
    if (pgSync) {
      try {
        await pgSync.upsertCompany(updated);
      } catch (err) {
        const msg = `Postgres company sync for ${company.ticker}: ${err instanceof Error ? err.message : String(err)}`;
        pgErrors.push(msg);
        run.errors.push(`[pg-sync] ${msg}`);
      }
    }

    // Persist company intelligence so it survives server restart
    const intelligence = generateCompanyIntelligence(company.ticker, allFilings);
    intelligenceDb.upsert(intelligence);

    // Postgres dual-write: intelligence
    if (pgSync) {
      try {
        await pgSync.upsertIntelligence(intelligence);
      } catch (err) {
        const msg = `Postgres intelligence sync for ${company.ticker}: ${err instanceof Error ? err.message : String(err)}`;
        pgErrors.push(msg);
        run.errors.push(`[pg-sync] ${msg}`);
      }
    }

    const endedAt = new Date().toISOString();
    const durationMs = Date.parse(endedAt) - Date.parse(startedAt);

    const parseErrors = result.errors;
    const hasErrors = parseErrors.length > 0 || pgErrors.length > 0;

    return {
      runId:             run.runId,
      cik:               company.cik,
      ticker:            company.ticker,
      status:            hasErrors ? 'partial' : 'completed',
      filingsDiscovered: discovered,
      filingsDownloaded: downloaded,
      filingsParsed:     result.parsed,
      warningsCount:     updated.warningsCount,
      errorMessage:      hasErrors
        ? [...parseErrors.slice(0, 3), ...pgErrors].join('; ')
        : undefined,
      durationMs,
      startedAt,
      endedAt,
    };

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const failedStage: IngestionStage = (err as { stage?: IngestionStage }).stage ?? stage;

    companiesDb.updateStatus(company.cik, {
      ingestionStatus: 'failed',
      errorMessage,
    });

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
