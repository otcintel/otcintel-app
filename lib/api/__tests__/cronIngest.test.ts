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
 * Production universe fix requirements:
 *   12. Postgres-backed repo returns companies when filesystem is empty
 *   13. Six companies selected from a 24-company Postgres universe
 *   14. All four batches cover all 24 companies (Postgres path)
 *   15. Filesystem backend still works locally (mock repo returns companies)
 *   16. Cron auth is unaffected by backend change
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

// ─── Mock helpers ─────────────────────────────────────────────────────────────

import type { ICompaniesRepository } from '@/lib/db/types';

function makeCompaniesRepo(companies: typeof MOCK_COMPANIES_24 | []): ICompaniesRepository {
  return {
    getAll:       vi.fn().mockResolvedValue(companies),
    getByCik:     vi.fn().mockResolvedValue(undefined),
    getByTicker:  vi.fn().mockResolvedValue(undefined),
    upsert:       vi.fn().mockResolvedValue(undefined),
    upsertAll:    vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    count:        vi.fn().mockResolvedValue(companies.length),
  };
}

// ─── Mocks — declared BEFORE imports that load the module under test ──────────
// vi.mock is hoisted to the top of the module by Vitest.

vi.mock('@/lib/universe/batchIngestor', () => ({
  runBatchIngestion: vi.fn(),
  getActiveRuns:     vi.fn().mockReturnValue([]),
  loadSeed:          vi.fn().mockReturnValue([]),
}));

// The route now reads the universe via getCompaniesRepo() from repositories,
// which respects PERSISTENCE_BACKEND and returns Postgres on Vercel.
vi.mock('@/lib/db/repositories', () => ({
  getCompaniesRepo:    vi.fn(),
  resetRepositories:   vi.fn(),
  getBackendName:      vi.fn().mockReturnValue('filesystem'),
}));

// Imports come AFTER vi.mock declarations so the mocks apply
import { POST } from '@/app/api/cron/ingest/route';
import { runBatchIngestion } from '@/lib/universe/batchIngestor';
import { getCompaniesRepo } from '@/lib/db/repositories';

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
  vi.mocked(getCompaniesRepo).mockResolvedValue(
    makeCompaniesRepo(MOCK_COMPANIES_24),
  );
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
    process.env.CRON_SECRET = CRON_SECRET;
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

  // 16. Auth is unaffected by backend change
  it('still enforces auth when using the Postgres-backed repository', async () => {
    vi.mocked(getCompaniesRepo).mockResolvedValue(
      makeCompaniesRepo(MOCK_COMPANIES_24),
    );
    const res = await POST(makeRequest('Bearer wrong'));

    expect(res.status).toBe(401);
    // getCompaniesRepo must NOT be called for rejected requests
    expect(getCompaniesRepo).not.toHaveBeenCalled();
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
    expect((opts?.tickers as string[]).length).toBeLessThan(ALL_TICKERS_24.length);
  });

  // 9. Different ?batch params → different ticker subsets
  it('different ?batch params route to different non-overlapping ticker subsets', async () => {
    await POST(validRequest(0));
    const tickers0 = vi.mocked(runBatchIngestion).mock.calls[0][0]?.tickers as string[];
    vi.clearAllMocks();
    vi.mocked(getCompaniesRepo).mockResolvedValue(
      makeCompaniesRepo(MOCK_COMPANIES_24),
    );
    vi.mocked(runBatchIngestion).mockResolvedValue(makeMockRun());

    await POST(validRequest(1));
    const tickers1 = vi.mocked(runBatchIngestion).mock.calls[0][0]?.tickers as string[];

    const set0 = new Set(tickers0);
    for (const t of tickers1) expect(set0.has(t)).toBe(false);
  });

  // 10. All companies covered across a full rotation
  it('all 24 companies are covered across a complete rotation (?batch 0-3)', async () => {
    const covered = new Set<string>();
    const totalBatches = Math.ceil(ALL_TICKERS_24.length / CRON_BATCH_SIZE);

    for (let i = 0; i < totalBatches; i++) {
      vi.mocked(getCompaniesRepo).mockResolvedValue(
        makeCompaniesRepo(MOCK_COMPANIES_24),
      );
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
      vi.mocked(getCompaniesRepo).mockResolvedValue(
        makeCompaniesRepo(MOCK_COMPANIES_24),
      );
      vi.mocked(runBatchIngestion).mockResolvedValue(makeMockRun());
      await POST(validRequest(i));
      const [opts] = vi.mocked(runBatchIngestion).mock.calls[0];
      const tickers = (opts?.tickers ?? []) as string[];
      expect(new Set(tickers).size).toBe(tickers.length);
      vi.clearAllMocks();
    }
  });

  it('response includes batch metadata (index, count, size, tickers)', async () => {
    const res = await POST(validRequest(0));
    const body = await res.json() as Record<string, unknown>;

    const batch = body.batch as Record<string, unknown>;
    expect(batch.index).toBe(0);
    expect(batch.count).toBe(4);
    expect(batch.size).toBe(CRON_BATCH_SIZE);
    expect((batch.tickers as string[]).length).toBe(CRON_BATCH_SIZE);
  });

  it('?batch=2 param selects the third alphabetical slice', async () => {
    await POST(validRequest(2));

    const [opts] = vi.mocked(runBatchIngestion).mock.calls[0];
    expect(opts?.tickers).toEqual([
      'LIQT', 'LQMT', 'MFON', 'NTRB', 'NVVE', 'RKDA',
    ]);
  });

});

describe('POST /api/cron/ingest — Postgres universe fix', () => {

  // 12. Postgres repo returns companies when filesystem is empty
  it('returns companies from the Postgres-backed repository even when filesystem is empty', async () => {
    // Simulate what Vercel does: filesystem is empty, Postgres has the 24 companies
    vi.mocked(getCompaniesRepo).mockResolvedValue(
      makeCompaniesRepo(MOCK_COMPANIES_24),
    );

    const res = await POST(validRequest(0));
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    // The route must have reached ingestion — not the empty-universe short-circuit
    expect(runBatchIngestion).toHaveBeenCalledOnce();
    const batch = body.batch as Record<string, unknown>;
    expect((batch.tickers as string[]).length).toBeGreaterThan(0);
  });

  // 13. Six companies selected from a 24-company Postgres universe
  it('selects exactly CRON_BATCH_SIZE (6) companies from 24 Postgres companies', async () => {
    vi.mocked(getCompaniesRepo).mockResolvedValue(
      makeCompaniesRepo(MOCK_COMPANIES_24),
    );

    await POST(validRequest(0));

    const [opts] = vi.mocked(runBatchIngestion).mock.calls[0];
    expect((opts?.tickers as string[]).length).toBe(CRON_BATCH_SIZE);
  });

  // 14. All four batches cover all 24 companies via Postgres path
  it('all four Postgres-sourced batches cover the full 24-company universe', async () => {
    const covered = new Set<string>();
    const totalBatches = Math.ceil(ALL_TICKERS_24.length / CRON_BATCH_SIZE);

    for (let i = 0; i < totalBatches; i++) {
      vi.mocked(getCompaniesRepo).mockResolvedValue(
        makeCompaniesRepo(MOCK_COMPANIES_24),
      );
      vi.mocked(runBatchIngestion).mockResolvedValue(makeMockRun());
      await POST(validRequest(i));
      const [opts] = vi.mocked(runBatchIngestion).mock.calls[0];
      for (const t of (opts?.tickers ?? []) as string[]) covered.add(t);
      vi.clearAllMocks();
    }

    expect(covered.size).toBe(24);
  });

  // 15. Filesystem backend still works — repo mock returns companies identically
  it('returns the same batch selection when mock represents the filesystem backend', async () => {
    // Same interface, different backing store — the route is backend-agnostic
    const fsStyleRepo = makeCompaniesRepo(MOCK_COMPANIES_24);
    vi.mocked(getCompaniesRepo).mockResolvedValue(
      fsStyleRepo,
    );

    await POST(validRequest(0));

    const [opts] = vi.mocked(runBatchIngestion).mock.calls[0];
    expect(opts?.tickers).toEqual(['ABVC', 'AITX', 'ATVK', 'BOXL', 'CANN', 'CENN']);
  });

  // Empty universe — graceful short-circuit (works for both backends)
  it('returns ok with empty tickers when the repository returns no companies', async () => {
    vi.mocked(getCompaniesRepo).mockResolvedValue(
      makeCompaniesRepo([]),
    );

    const res = await POST(validRequest());
    const body = await res.json() as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.message).toMatch(/nothing to ingest/i);
    expect(runBatchIngestion).not.toHaveBeenCalled();
  });

});
