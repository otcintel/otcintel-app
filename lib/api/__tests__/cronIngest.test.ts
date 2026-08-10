/**
 * Tests for app/api/cron/ingest/route.ts
 *
 * Task 4 requirements:
 *   1. Valid CRON_SECRET → 200, run summary returned
 *   2. Missing Authorization header → 401
 *   3. Wrong secret → 401
 *   4. CRON_SECRET not configured → 503
 *   5. runBatchIngestion called with includeAlreadyParsed: true
 *   6. forceReparse is NOT enabled
 *   7. Response JSON exposes the full run summary
 *
 * Task 5 requirements:
 *   8.  One invocation targets only a subset of companies (≤ CRON_BATCH_SIZE)
 *   9.  Different ?batch= params → different ticker subsets
 *   10. All companies covered across a full rotation (?batch=0..N-1)
 *   11. No ticker duplicated within one subset
 *
 * All tests are pure unit tests — no filesystem, no EDGAR calls, no real DB.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { IngestionRun } from '@/lib/universe/types';
import { PARSER_VERSION } from '@/lib/universe/types';
import { CRON_BATCH_SIZE } from '@/lib/universe/batchSelection';

// ─── Fixture: 24-company universe ────────────────────────────────────────────

const ALL_TICKERS_24 = [
  'ABVC', 'AITX', 'ATVK', 'BOXL', 'CANN', 'CENN',
  'CLPS', 'CODA', 'CUEN', 'GFAI', 'GOVX', 'LCTX',
  'LIQT', 'LQMT', 'MFON', 'NTRB', 'NVVE', 'RKDA',
  'SHIP', 'SINT', 'SOBR', 'TUSK', 'VNRX', 'WRAP',
];

const MOCK_COMPANIES_24 = ALL_TICKERS_24.map(ticker => ({
  ticker,
  cik: `000${ticker.charCodeAt(0)}`,
  companyName: `${ticker} Corp`,
  exchange: 'OTC',
  active: true,
  ingestionStatus: 'pending' as const,
  filingsDiscovered: 0,
  filingsParsed: 0,
  warningsCount: 0,
  rejectedCandidatesCount: 0,
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
}));

// ─── Mocks — declared BEFORE imports that load the module under test ──────────
// vi.mock is hoisted to the top of the module by Vitest.

vi.mock('@/lib/universe/batchIngestor', () => ({
  runBatchIngestion: vi.fn(),
  getActiveRuns:     vi.fn().mockReturnValue([]),
  loadSeed:          vi.fn().mockReturnValue([]),
}));

vi.mock('@/lib/db', () => ({
  companiesDb: {
    getAll: vi.fn(),
  },
}));

// Imports come AFTER vi.mock declarations so the mocks apply
import { POST } from '@/app/api/cron/ingest/route';
import { runBatchIngestion } from '@/lib/universe/batchIngestor';
import { companiesDb } from '@/lib/db';

// ─── Constants ────────────────────────────────────────────────────────────────

const CRON_SECRET = 'test-cron-secret-xxyyzz112233';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockRun(overrides: Partial<IngestionRun> = {}): IngestionRun {
  return {
    runId:               'run-cron-00000000-0000-0000-0000-000000000001',
    startedAt:           '2026-08-10T00:00:00Z',
    endedAt:             '2026-08-10T00:01:30Z',
    parserVersion:       PARSER_VERSION,
    status:              'completed',
    companiesAttempted:  CRON_BATCH_SIZE,
    companiesCompleted:  CRON_BATCH_SIZE,
    companiesPartial:    0,
    companiesFailed:     0,
    filingsDiscovered:   5,
    filingsDownloaded:   2,
    filingsParsed:       2,
    warningsCount:       0,
    errors:              [],
    ...overrides,
  };
}

function makeRequest(authHeader?: string, batchParam?: number): NextRequest {
  const url = batchParam !== undefined
    ? `http://localhost/api/cron/ingest?batch=${batchParam}`
    : 'http://localhost/api/cron/ingest';
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) headers['Authorization'] = authHeader;
  return new NextRequest(url, { method: 'POST', headers });
}

function validRequest(batchParam?: number): NextRequest {
  return makeRequest(`Bearer ${CRON_SECRET}`, batchParam);
}

// ─── Test lifecycle ───────────────────────────────────────────────────────────

let _origSecret: string | undefined;

beforeEach(() => {
  _origSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = CRON_SECRET;
  vi.mocked(runBatchIngestion).mockResolvedValue(makeMockRun());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(companiesDb.getAll).mockReturnValue(MOCK_COMPANIES_24 as any);
});

afterEach(() => {
  if (_origSecret === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = _origSecret;
  }
  vi.clearAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/cron/ingest — auth', () => {

  // 1. Valid CRON_SECRET
  it('returns 200 and run summary for a valid CRON_SECRET', async () => {
    const res = await POST(validRequest());

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.runId).toBe('run-cron-00000000-0000-0000-0000-000000000001');
    expect(body.status).toBe('completed');
  });

  // 2. Missing Authorization header → 401
  it('returns 401 when Authorization header is absent', async () => {
    const res = await POST(makeRequest());

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/Missing Authorization header/i);
    expect(runBatchIngestion).not.toHaveBeenCalled();
  });

  // 3. Wrong secret → 401
  it('returns 401 when the Bearer token does not match CRON_SECRET', async () => {
    const res = await POST(makeRequest('Bearer completely-wrong-secret'));

    expect(res.status).toBe(401);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/Unauthorized/i);
    expect(runBatchIngestion).not.toHaveBeenCalled();
  });

  // 4. CRON_SECRET not set → 503
  it('returns 503 when CRON_SECRET environment variable is not configured', async () => {
    delete process.env.CRON_SECRET;

    const res = await POST(makeRequest(`Bearer ${CRON_SECRET}`));

    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/not configured/i);
    expect(runBatchIngestion).not.toHaveBeenCalled();
  });

  // Additional: non-Bearer scheme rejected
  it('returns 401 for non-Bearer Authorization scheme', async () => {
    const res = await POST(makeRequest('Basic dXNlcjpwYXNz'));

    expect(res.status).toBe(401);
    expect(runBatchIngestion).not.toHaveBeenCalled();
  });

  // Additional: ADMIN_SECRET is not accepted as a cron credential
  it('rejects ADMIN_SECRET even if set; secrets are fully independent', async () => {
    process.env.CRON_SECRET  = 'cron-specific-secret-aabb';
    process.env.ADMIN_SECRET = 'admin-specific-secret-ccdd';

    const res = await POST(makeRequest('Bearer admin-specific-secret-ccdd'));

    expect(res.status).toBe(401);
    expect(runBatchIngestion).not.toHaveBeenCalled();

    delete process.env.ADMIN_SECRET;
    process.env.CRON_SECRET = CRON_SECRET; // restore
  });

  // Additional: pipeline error → 500, not crash
  it('returns 500 when runBatchIngestion throws an unexpected error', async () => {
    vi.mocked(runBatchIngestion).mockRejectedValue(new Error('database unavailable'));

    const res = await POST(validRequest());

    expect(res.status).toBe(500);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('database unavailable');
  });

});

describe('POST /api/cron/ingest — ingestion options (task 4)', () => {

  // 5. includeAlreadyParsed: true
  it('calls runBatchIngestion with includeAlreadyParsed: true', async () => {
    await POST(validRequest());

    expect(runBatchIngestion).toHaveBeenCalledOnce();
    const [opts] = vi.mocked(runBatchIngestion).mock.calls[0];
    expect(opts).toMatchObject({ includeAlreadyParsed: true });
  });

  // 6. forceReparse is NOT true
  it('does not enable forceReparse', async () => {
    await POST(validRequest());

    const [opts] = vi.mocked(runBatchIngestion).mock.calls[0];
    expect(opts?.forceReparse).not.toBe(true);
  });

  // 7. Full run summary fields in response
  it('exposes all required run summary fields in the response', async () => {
    const mockRun = makeMockRun({
      status:             'partial',
      companiesAttempted: CRON_BATCH_SIZE,
      companiesCompleted: 4,
      companiesPartial:   1,
      companiesFailed:    1,
      filingsDiscovered:  8,
      filingsDownloaded:  3,
      filingsParsed:      3,
      warningsCount:      2,
      errors:             ['ATVK [sec_fetch]: timeout'],
    });
    vi.mocked(runBatchIngestion).mockResolvedValue(mockRun);

    const res = await POST(validRequest(0));
    const body = await res.json() as Record<string, unknown>;

    expect(body.ok).toBe(true);
    expect(body.runId).toBe(mockRun.runId);
    expect(body.status).toBe('partial');
    expect(body.companiesAttempted).toBe(CRON_BATCH_SIZE);
    expect(body.companiesCompleted).toBe(4);
    expect(body.companiesPartial).toBe(1);
    expect(body.companiesFailed).toBe(1);
    expect(body.filingsDiscovered).toBe(8);
    expect(body.filingsDownloaded).toBe(3);
    expect(body.filingsParsed).toBe(3);
    expect(body.warningsCount).toBe(2);
    expect(body.errors).toEqual(['ATVK [sec_fetch]: timeout']);
    expect(body.startedAt).toBe(mockRun.startedAt);
    expect(body.endedAt).toBe(mockRun.endedAt);
  });

});

describe('POST /api/cron/ingest — batching (task 5)', () => {

  // 8. One invocation targets only a subset (≤ CRON_BATCH_SIZE companies)
  it('passes only a subset of companies to runBatchIngestion per call', async () => {
    await POST(validRequest(0));

    expect(runBatchIngestion).toHaveBeenCalledOnce();
    const [opts] = vi.mocked(runBatchIngestion).mock.calls[0];
    expect(opts?.tickers).toBeDefined();
    expect((opts?.tickers as string[]).length).toBeLessThanOrEqual(CRON_BATCH_SIZE);
    // Must not send all 24
    expect((opts?.tickers as string[]).length).toBeLessThan(ALL_TICKERS_24.length);
  });

  // 9. Different ?batch params → different ticker subsets
  it('different ?batch params route to different non-overlapping ticker subsets', async () => {
    await POST(validRequest(0));
    const tickers0 = vi.mocked(runBatchIngestion).mock.calls[0][0]?.tickers as string[];
    vi.clearAllMocks();

    vi.mocked(runBatchIngestion).mockResolvedValue(makeMockRun());
    await POST(validRequest(1));
    const tickers1 = vi.mocked(runBatchIngestion).mock.calls[0][0]?.tickers as string[];

    expect(tickers0).toBeDefined();
    expect(tickers1).toBeDefined();
    // The two batches must be disjoint
    const set0 = new Set(tickers0);
    for (const t of tickers1) expect(set0.has(t)).toBe(false);
  });

  // 10. All companies covered across a full rotation
  it('all 24 companies are covered across a complete rotation (?batch 0-3)', async () => {
    const covered = new Set<string>();
    const totalBatches = Math.ceil(ALL_TICKERS_24.length / CRON_BATCH_SIZE); // 4

    for (let i = 0; i < totalBatches; i++) {
      vi.mocked(runBatchIngestion).mockResolvedValue(makeMockRun());
      await POST(validRequest(i));
      const [opts] = vi.mocked(runBatchIngestion).mock.calls[0];
      for (const t of (opts?.tickers ?? []) as string[]) covered.add(t);
      vi.clearAllMocks();
    }

    expect(covered.size).toBe(ALL_TICKERS_24.length);
    for (const t of ALL_TICKERS_24) expect(covered.has(t)).toBe(true);
  });

  // 11. No ticker duplicated within one subset
  it('no ticker appears more than once in the batch passed to runBatchIngestion', async () => {
    const totalBatches = Math.ceil(ALL_TICKERS_24.length / CRON_BATCH_SIZE);
    for (let i = 0; i < totalBatches; i++) {
      vi.mocked(runBatchIngestion).mockResolvedValue(makeMockRun());
      await POST(validRequest(i));
      const [opts] = vi.mocked(runBatchIngestion).mock.calls[0];
      const tickers = (opts?.tickers ?? []) as string[];
      const unique = new Set(tickers);
      expect(unique.size).toBe(tickers.length);
      vi.clearAllMocks();
    }
  });

  // Batch metadata appears in the response
  it('response includes batch metadata (index, count, size, tickers)', async () => {
    const res = await POST(validRequest(0));
    const body = await res.json() as Record<string, unknown>;

    expect(body.ok).toBe(true);
    const batch = body.batch as Record<string, unknown>;
    expect(batch).toBeDefined();
    expect(typeof batch.index).toBe('number');
    expect(typeof batch.count).toBe('number');
    expect(typeof batch.size).toBe('number');
    expect(Array.isArray(batch.tickers)).toBe(true);
    expect(batch.index).toBe(0);
    expect(batch.count).toBe(4);             // 24 / 6 = 4 batches
    expect(batch.size).toBe(CRON_BATCH_SIZE);
    expect((batch.tickers as string[]).length).toBe(CRON_BATCH_SIZE);
  });

  // ?batch param overrides time-based selection
  it('?batch=2 param selects the third alphabetical slice', async () => {
    await POST(validRequest(2));

    const [opts] = vi.mocked(runBatchIngestion).mock.calls[0];
    // Alphabetical order: ABVC…CENN=0, CLPS…LCTX=1, LIQT…RKDA=2, SHIP…WRAP=3
    expect(opts?.tickers).toEqual([
      'LIQT', 'LQMT', 'MFON', 'NTRB', 'NVVE', 'RKDA',
    ]);
  });

  // Empty universe — graceful short-circuit
  it('returns ok with empty tickers when no companies are registered', async () => {
    vi.mocked(companiesDb.getAll).mockReturnValue([]);

    const res = await POST(validRequest());
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.message).toMatch(/nothing to ingest/i);
    expect(runBatchIngestion).not.toHaveBeenCalled();
  });

});
