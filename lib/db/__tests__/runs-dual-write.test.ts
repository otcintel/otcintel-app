/**
 * Tests for run-record dual-write via PostgresSync (lib/db/postgresSync.ts)
 *
 * Coverage:
 *   1. Run creation dual-write       — upsertRun calls runsRepo.upsert
 *   2. Run status update dual-write  — subsequent upsertRun calls update, not duplicate
 *   3. Per-company result dual-write — upsertRunResult calls runsRepo.upsertResult
 *   4. Repeated update idempotency   — same run_id upserted multiple times stays unique
 *   5. Postgres run write failure    — errors propagate; sync layer never swallows
 */

import { describe, it, expect, vi } from 'vitest';
import { makePostgresSync } from '../postgresSync';
import type {
  ICompaniesRepository,
  IFilingsRepository,
  IIntelligenceRepository,
  IRunsRepository,
} from '../types';
import type { IngestionRun, RunResult } from '../../universe/types';
import { PARSER_VERSION } from '../../universe/types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeRun(overrides: Partial<IngestionRun> = {}): IngestionRun {
  return {
    runId:               'run-test-00000000-0000-0000-0000-000000000001',
    startedAt:           '2026-08-07T12:00:00Z',
    parserVersion:       PARSER_VERSION,
    status:              'running',
    companiesAttempted:  0,
    companiesCompleted:  0,
    companiesPartial:    0,
    companiesFailed:     0,
    filingsDiscovered:   0,
    filingsDownloaded:   0,
    filingsParsed:       0,
    warningsCount:       0,
    errors:              [],
    ...overrides,
  };
}

function makeRunResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    runId:              'run-test-00000000-0000-0000-0000-000000000001',
    cik:                '0001234567',
    ticker:             'TEST',
    status:             'completed',
    filingsDiscovered:  3,
    filingsDownloaded:  1,
    filingsParsed:      1,
    warningsCount:      0,
    durationMs:         4200,
    startedAt:          '2026-08-07T12:00:05Z',
    endedAt:            '2026-08-07T12:00:09Z',
    ...overrides,
  };
}

// ─── Mock repo builders ───────────────────────────────────────────────────────

function makeMockCompaniesRepo(): ICompaniesRepository {
  return {
    upsert:       vi.fn().mockResolvedValue(undefined),
    upsertAll:    vi.fn().mockResolvedValue(undefined),
    getAll:       vi.fn().mockResolvedValue([]),
    getByCik:     vi.fn().mockResolvedValue(undefined),
    getByTicker:  vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    count:        vi.fn().mockResolvedValue(0),
  };
}

function makeMockFilingsRepo(): IFilingsRepository {
  return {
    upsertAll:       vi.fn().mockResolvedValue(undefined),
    getByTicker:     vi.fn().mockResolvedValue([]),
    hasAccession:    vi.fn().mockResolvedValue(false),
    knownAccessions: vi.fn().mockResolvedValue(new Set<string>()),
    getAllTickers:   vi.fn().mockResolvedValue([]),
    totalCount:      vi.fn().mockResolvedValue(0),
  };
}

function makeMockIntelligenceRepo(): IIntelligenceRepository {
  return {
    upsert:       vi.fn().mockResolvedValue(undefined),
    getByTicker:  vi.fn().mockResolvedValue(undefined),
    getAllTickers: vi.fn().mockResolvedValue([]),
  };
}

function makeMockRunsRepo(overrides: Partial<IRunsRepository> = {}): IRunsRepository {
  return {
    upsert:       vi.fn().mockResolvedValue(undefined),
    upsertResult: vi.fn().mockResolvedValue(undefined),
    getAll:       vi.fn().mockResolvedValue([]),
    getById:      vi.fn().mockResolvedValue(undefined),
    getResults:   vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PostgresSync — run dual-write', () => {

  // 1. Run creation dual-write
  it('upsertRun calls runsRepo.upsert with the complete run record', async () => {
    const runsRepo = makeMockRunsRepo();
    const sync = makePostgresSync(
      makeMockCompaniesRepo(), makeMockFilingsRepo(), makeMockIntelligenceRepo(), runsRepo,
    );

    const run = makeRun();
    await sync.upsertRun(run);

    expect(runsRepo.upsert).toHaveBeenCalledOnce();
    expect(runsRepo.upsert).toHaveBeenCalledWith(run);
    expect(runsRepo.upsertResult).not.toHaveBeenCalled();
  });

  // 2. Run status update dual-write
  // The same run goes through multiple status transitions: running → completed/partial/failed.
  // Each transition is a separate upsert call; onConflict: 'run_id' ensures idempotency in the DB.
  it('upsertRun called for status update passes the updated run to runsRepo.upsert', async () => {
    const runsRepo = makeMockRunsRepo();
    const sync = makePostgresSync(
      makeMockCompaniesRepo(), makeMockFilingsRepo(), makeMockIntelligenceRepo(), runsRepo,
    );

    const runInitial = makeRun({ status: 'running' });
    await sync.upsertRun(runInitial);

    const runFinal = makeRun({
      status:              'completed',
      endedAt:             '2026-08-07T12:05:00Z',
      companiesAttempted:  5,
      companiesCompleted:  5,
      filingsDiscovered:   12,
      filingsDownloaded:   4,
      filingsParsed:       4,
    });
    await sync.upsertRun(runFinal);

    expect(runsRepo.upsert).toHaveBeenCalledTimes(2);
    // First call was the initial 'running' record
    expect(runsRepo.upsert).toHaveBeenNthCalledWith(1, runInitial);
    // Second call carries the final 'completed' state
    expect(runsRepo.upsert).toHaveBeenNthCalledWith(2, runFinal);
    expect(runsRepo.upsertResult).not.toHaveBeenCalled();
  });

  // 3. Per-company result dual-write
  it('upsertRunResult calls runsRepo.upsertResult with the exact result record', async () => {
    const runsRepo = makeMockRunsRepo();
    const sync = makePostgresSync(
      makeMockCompaniesRepo(), makeMockFilingsRepo(), makeMockIntelligenceRepo(), runsRepo,
    );

    const result = makeRunResult();
    await sync.upsertRunResult(result);

    expect(runsRepo.upsertResult).toHaveBeenCalledOnce();
    expect(runsRepo.upsertResult).toHaveBeenCalledWith(result);
    expect(runsRepo.upsert).not.toHaveBeenCalled();
  });

  it('upsertRunResult for a failed company preserves failedStage and errorMessage', async () => {
    const runsRepo = makeMockRunsRepo();
    const sync = makePostgresSync(
      makeMockCompaniesRepo(), makeMockFilingsRepo(), makeMockIntelligenceRepo(), runsRepo,
    );

    const result = makeRunResult({
      status:       'failed',
      failedStage:  'sec_fetch',
      errorMessage: 'EDGAR ticker map fetch failed: 503',
      filingsDiscovered: 0,
      filingsDownloaded: 0,
      filingsParsed:     0,
    });
    await sync.upsertRunResult(result);

    const calledWith = (runsRepo.upsertResult as ReturnType<typeof vi.fn>).mock.calls[0][0] as RunResult;
    expect(calledWith.status).toBe('failed');
    expect(calledWith.failedStage).toBe('sec_fetch');
    expect(calledWith.errorMessage).toBe('EDGAR ticker map fetch failed: 503');
  });

  // 4. Repeated update idempotency
  // upsertRun is called multiple times during a run (initial, per-company progress, final).
  // Each call must pass through to the DB — idempotency is enforced by onConflict: 'run_id'.
  it('upsertRun called N times for progress updates delegates each call to runsRepo.upsert', async () => {
    const runsRepo = makeMockRunsRepo();
    const sync = makePostgresSync(
      makeMockCompaniesRepo(), makeMockFilingsRepo(), makeMockIntelligenceRepo(), runsRepo,
    );

    const run = makeRun();
    // Simulate: initial write + 3 progress updates + final write = 5 calls
    for (let i = 0; i < 5; i++) {
      await sync.upsertRun(run);
    }

    expect(runsRepo.upsert).toHaveBeenCalledTimes(5);
  });

  // 5. Postgres run write failure handling
  // The sync layer must propagate errors — never swallow them.
  // batchIngestor's pgRunWrite / pgResultWrite helpers catch them into run.errors.
  it('upsertRun propagates errors from runsRepo.upsert without swallowing them', async () => {
    const runsRepo = makeMockRunsRepo({
      upsert: vi.fn().mockRejectedValue(new Error('relation "ingestion_runs" does not exist')),
    });
    const sync = makePostgresSync(
      makeMockCompaniesRepo(), makeMockFilingsRepo(), makeMockIntelligenceRepo(), runsRepo,
    );

    await expect(sync.upsertRun(makeRun())).rejects.toThrow(
      'relation "ingestion_runs" does not exist',
    );
  });

  it('upsertRunResult propagates errors from runsRepo.upsertResult without swallowing them', async () => {
    const runsRepo = makeMockRunsRepo({
      upsertResult: vi.fn().mockRejectedValue(new Error('foreign key violation: run_id not found')),
    });
    const sync = makePostgresSync(
      makeMockCompaniesRepo(), makeMockFilingsRepo(), makeMockIntelligenceRepo(), runsRepo,
    );

    await expect(sync.upsertRunResult(makeRunResult())).rejects.toThrow(
      'foreign key violation: run_id not found',
    );
  });

});
