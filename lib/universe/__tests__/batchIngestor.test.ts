/**
 * Tests for lib/universe/batchIngestor.ts — backend-aware persistence
 *
 * All tests use injected mock repositories so no filesystem access,
 * EDGAR fetches, or real DB calls are made.
 *
 * Required coverage:
 *   1. Postgres backend completes successfully without required filesystem writes
 *   2. Explicit ticker list resolves companies from the repo (not filesystem)
 *   3. Run records are upserted into the repo (Postgres)
 *   4. Filings are upserted into the repo (Postgres)
 *   5. Company records are updated via the repo (Postgres)
 *   6. Intelligence records are upserted via the repo (Postgres)
 *   7. Filesystem backend path works identically (same interface)
 *   8. No duplicate filings — upsertAll is called exactly once per company
 *   9. Cron route behavior unchanged (covered in cronIngest.test.ts)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CompanyRecord } from '@/lib/universe/types';
import { PARSER_VERSION } from '@/lib/universe/types';
import type {
  ICompaniesRepository,
  IFilingsRepository,
  IRunsRepository,
  IIntelligenceRepository,
} from '@/lib/db/types';
import type { NormalizedFiling, CompanyIntelligence } from '@/lib/ingestion/types';

// ─── Mocks — hoisted before any import of the module under test ───────────────

vi.mock('@/lib/db/repositories', () => ({
  getCompaniesRepo:    vi.fn(),
  getFilingsRepo:      vi.fn(),
  getRunsRepo:         vi.fn(),
  getIntelligenceRepo: vi.fn(),
  resetRepositories:   vi.fn(),
  getBackendName:      vi.fn().mockReturnValue('postgres'),
}));

// Prevent any filesystem access from the db singleton imports
vi.mock('@/lib/db', () => ({
  companiesDb: {
    getByCik:     vi.fn().mockReturnValue(undefined),
    getByTicker:  vi.fn().mockReturnValue(undefined),
    getAll:       vi.fn().mockReturnValue([]),
    upsert:       vi.fn(),
    upsertAll:    vi.fn(),
    updateStatus: vi.fn(),
    count:        vi.fn().mockReturnValue(0),
  },
  filingsDb:    { getByTicker: vi.fn().mockReturnValue([]), knownAccessions: vi.fn().mockReturnValue(new Set()), upsertAll: vi.fn() },
  runsDb:       { upsert: vi.fn(), upsertResult: vi.fn(), getAll: vi.fn().mockReturnValue([]), getById: vi.fn().mockReturnValue(undefined), getResults: vi.fn().mockReturnValue([]) },
  intelligenceDb: { upsert: vi.fn(), getByTicker: vi.fn().mockReturnValue(undefined), getAllTickers: vi.fn().mockReturnValue([]) },
}));

vi.mock('@/lib/ingestion', () => ({
  ingestTicker: vi.fn(),
}));

vi.mock('@/lib/ingestion/store', () => ({
  normalizedFilingStore: {
    upsertAll:     vi.fn(),
    upsert:        vi.fn(),
    getByTicker:   vi.fn().mockReturnValue([]),
    getMostRecent: vi.fn().mockReturnValue(undefined),
    getByAccession:vi.fn().mockReturnValue(undefined),
    getAllTickers: vi.fn().mockReturnValue([]),
    count:         vi.fn().mockReturnValue(0),
    clearTicker:   vi.fn(),
    clearAll:      vi.fn(),
  },
}));

vi.mock('@/lib/ingestion/intelligence/companyIntelligence', () => ({
  generateCompanyIntelligence: vi.fn(),
}));

// Mock companies helpers to avoid real NormalizedFiling field dependencies in tests
vi.mock('@/lib/universe/companies', () => ({
  seedToRecord:          vi.fn(),
  applyIngestionResult:  vi.fn((company: CompanyRecord) => ({ ...company, ingestionStatus: 'parsed', filingsParsed: 1 })),
  getStaleFilings:       vi.fn().mockReturnValue([]),
  hasStaleFilings:       vi.fn().mockReturnValue(false),
  deriveConfidenceStatus: vi.fn().mockReturnValue('insufficient_data'),
}));

// Imports after mocks
import { runBatchIngestion } from '@/lib/universe/batchIngestor';
import { getCompaniesRepo, getFilingsRepo, getRunsRepo, getIntelligenceRepo } from '@/lib/db/repositories';
import { ingestTicker } from '@/lib/ingestion';
import { generateCompanyIntelligence } from '@/lib/ingestion/intelligence/companyIntelligence';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_COMPANY: CompanyRecord = {
  ticker: 'ABVC',
  cik: '0001655050',
  companyName: 'ABVC BioPharma Inc.',
  active: true,
  ingestionStatus: 'pending',
  filingsDiscovered: 0,
  filingsParsed: 0,
  warningsCount: 0,
  rejectedCandidatesCount: 0,
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:00:00Z',
};

const MOCK_COMPANY_2: CompanyRecord = {
  ...MOCK_COMPANY,
  ticker: 'AITX',
  cik: '0001782430',
  companyName: 'Artificial Intelligence Technology Solutions Inc.',
};

const MOCK_FILING = {
  ticker:          'ABVC',
  accessionNumber: '0001655050-26-000001',
  form:            '8-K',
  filedAt:         '2026-01-15T00:00:00Z',
  parserVersion:   PARSER_VERSION,
} as unknown as NormalizedFiling;

const MOCK_INTELLIGENCE = { ticker: 'ABVC' } as CompanyIntelligence;

const MOCK_PIPELINE_RESULT = {
  ticker:     'ABVC',
  normalized: [MOCK_FILING],
  fetched:    1,
  parsed:     1,
  errors:     [] as string[],
  durationMs: 0,
};

// ─── Mock repo factories ──────────────────────────────────────────────────────

function makeCompaniesRepo(companies: CompanyRecord[] = [MOCK_COMPANY]): ICompaniesRepository {
  const byTicker = Object.fromEntries(companies.map(c => [c.ticker, c]));
  const byCik    = Object.fromEntries(companies.map(c => [c.cik, c]));
  return {
    getAll:       vi.fn().mockResolvedValue(companies),
    getByCik:     vi.fn((cik: string)    => Promise.resolve(byCik[cik])),
    getByTicker:  vi.fn((t: string)      => Promise.resolve(byTicker[t.toUpperCase()])),
    upsert:       vi.fn().mockResolvedValue(undefined),
    upsertAll:    vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    count:        vi.fn().mockResolvedValue(companies.length),
  };
}

function makeFilingsRepo(existingFilings: NormalizedFiling[] = []): IFilingsRepository {
  return {
    getByTicker:    vi.fn().mockResolvedValue(existingFilings),
    hasAccession:   vi.fn().mockResolvedValue(false),
    knownAccessions:vi.fn().mockResolvedValue(new Set<string>()),
    upsertAll:      vi.fn().mockResolvedValue(undefined),
    getAllTickers:   vi.fn().mockResolvedValue([]),
    totalCount:     vi.fn().mockResolvedValue(existingFilings.length),
  };
}

function makeRunsRepo(): IRunsRepository {
  return {
    getAll:       vi.fn().mockResolvedValue([]),
    getById:      vi.fn().mockResolvedValue(undefined),
    upsert:       vi.fn().mockResolvedValue(undefined),
    getResults:   vi.fn().mockResolvedValue([]),
    upsertResult: vi.fn().mockResolvedValue(undefined),
  };
}

function makeIntelligenceRepo(): IIntelligenceRepository {
  return {
    getByTicker:  vi.fn().mockResolvedValue(undefined),
    upsert:       vi.fn().mockResolvedValue(undefined),
    getAllTickers: vi.fn().mockResolvedValue([]),
  };
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

let mockCompaniesRepo: ICompaniesRepository;
let mockFilingsRepo: IFilingsRepository;
let mockRunsRepo: IRunsRepository;
let mockIntelligenceRepo: IIntelligenceRepository;

beforeEach(() => {
  mockCompaniesRepo   = makeCompaniesRepo();
  mockFilingsRepo     = makeFilingsRepo();
  mockRunsRepo        = makeRunsRepo();
  mockIntelligenceRepo = makeIntelligenceRepo();

  vi.mocked(getCompaniesRepo).mockResolvedValue(mockCompaniesRepo);
  vi.mocked(getFilingsRepo).mockResolvedValue(mockFilingsRepo);
  vi.mocked(getRunsRepo).mockResolvedValue(mockRunsRepo);
  vi.mocked(getIntelligenceRepo).mockResolvedValue(mockIntelligenceRepo);

  vi.mocked(ingestTicker).mockResolvedValue(MOCK_PIPELINE_RESULT);
  vi.mocked(generateCompanyIntelligence).mockReturnValue(MOCK_INTELLIGENCE);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('runBatchIngestion — Postgres backend (test 1: EROFS-safe)', () => {

  it('completes successfully without requiring any filesystem write', async () => {
    // Repos represent the Postgres backend — they all succeed.
    // There are zero direct filesystem calls in the hot path.
    const run = await runBatchIngestion({ includeAlreadyParsed: true });

    expect(run.status).toBe('completed');
    expect(run.companiesAttempted).toBe(1);
    expect(run.companiesCompleted).toBe(1);
    expect(run.errors).toHaveLength(0);
    // Repos were called — not filesystem singletons
    expect(getCompaniesRepo).toHaveBeenCalled();
    expect(getRunsRepo).toHaveBeenCalled();
    expect(getFilingsRepo).toHaveBeenCalled();
    expect(getIntelligenceRepo).toHaveBeenCalled();
  });

  it('returns a valid IngestionRun even when normalizedFilingStore.upsertAll throws', async () => {
    // Simulate in-memory store failure (worst-case for in-process cache)
    // — the Postgres repo writes should still succeed.
    const { normalizedFilingStore } = await import('@/lib/ingestion/store');
    vi.mocked(normalizedFilingStore.upsertAll).mockImplementationOnce(() => {
      throw new Error('EROFS: read-only file system');
    });

    // Expect the company to be marked failed (because the throw propagates
    // to ingestOneCompany's catch), but the batch itself should not throw.
    const run = await runBatchIngestion({ includeAlreadyParsed: true });

    // Run must return — not throw out to the route handler
    expect(run).toBeDefined();
    expect(run.runId).toBeTruthy();
    expect(run.endedAt).toBeTruthy();
  });

});

describe('runBatchIngestion — company resolution (test 2: ticker→Postgres)', () => {

  // 2. Explicit ticker list resolves companies from the repo, not filesystem
  it('resolves explicit tickers via companiesRepo.getByTicker, not companiesDb', async () => {
    await runBatchIngestion({ tickers: ['ABVC'], includeAlreadyParsed: true });

    expect(mockCompaniesRepo.getByTicker).toHaveBeenCalledWith('ABVC');
    // companiesRepo (Postgres) was used — ingestTicker was called, so ABVC was found
    expect(ingestTicker).toHaveBeenCalledWith('ABVC', expect.objectContaining({ skipAccessions: expect.any(Set) }));
  });

  it('returns zero-company run (not error) when explicit ticker is not in Postgres universe', async () => {
    vi.mocked(mockCompaniesRepo.getByTicker).mockResolvedValue(undefined);

    const run = await runBatchIngestion({ tickers: ['UNKNOWN'], includeAlreadyParsed: true });

    expect(run.companiesAttempted).toBe(0);
    expect(run.errors).toContain('None of the specified tickers are in the company universe. Run /seed first.');
  });

  it('resolves multiple explicit tickers independently', async () => {
    mockCompaniesRepo = makeCompaniesRepo([MOCK_COMPANY, MOCK_COMPANY_2]);
    vi.mocked(getCompaniesRepo).mockResolvedValue(mockCompaniesRepo);

    vi.mocked(ingestTicker).mockResolvedValue({ ...MOCK_PIPELINE_RESULT });

    await runBatchIngestion({ tickers: ['ABVC', 'AITX'], includeAlreadyParsed: true });

    expect(mockCompaniesRepo.getByTicker).toHaveBeenCalledWith('ABVC');
    expect(mockCompaniesRepo.getByTicker).toHaveBeenCalledWith('AITX');
    expect(ingestTicker).toHaveBeenCalledTimes(2);
  });

});

describe('runBatchIngestion — run persistence (test 3: Postgres)', () => {

  // 3. Run records persist in Postgres
  it('calls runsRepo.upsert for initial, per-company progress, and final status writes', async () => {
    const run = await runBatchIngestion({ includeAlreadyParsed: true });

    // At minimum: initial 'running', count-set, per-company progress, final
    // Note: run is a mutable object — all upsert() call args are the same reference,
    // so we verify count and final state on the returned run rather than per-call snapshots.
    expect(mockRunsRepo.upsert).toHaveBeenCalledTimes(4);
    expect(mockRunsRepo.upsert).toHaveBeenCalledWith(run);
    expect(['completed', 'partial', 'failed']).toContain(run.status);
    expect(run.endedAt).toBeTruthy();
    expect(run.runId).toBeTruthy();
  });

  it('calls runsRepo.upsertResult with the per-company result', async () => {
    await runBatchIngestion({ includeAlreadyParsed: true });

    expect(mockRunsRepo.upsertResult).toHaveBeenCalledOnce();
    const result = vi.mocked(mockRunsRepo.upsertResult).mock.calls[0][0];
    expect(result.ticker).toBe('ABVC');
    expect(result.cik).toBe('0001655050');
  });

});

describe('runBatchIngestion — filing persistence (test 4: Postgres)', () => {

  // 4. Filings persist in Postgres
  it('calls filingsRepo.upsertAll with the newly parsed filings', async () => {
    await runBatchIngestion({ includeAlreadyParsed: true });

    expect(mockFilingsRepo.upsertAll).toHaveBeenCalledOnce();
    const [ticker, filings] = vi.mocked(mockFilingsRepo.upsertAll).mock.calls[0];
    expect(ticker).toBe('ABVC');
    expect(filings).toEqual([MOCK_FILING]);
  });

  it('uses filingsRepo.getByTicker to retrieve skip-accession set (not filesystem)', async () => {
    await runBatchIngestion({ includeAlreadyParsed: true });

    // knownAccessions is called to build the skip set
    expect(mockFilingsRepo.knownAccessions).toHaveBeenCalledWith('ABVC');
  });

});

describe('runBatchIngestion — company persistence (test 5: Postgres)', () => {

  // 5. Company updates persist in Postgres
  it('calls companiesRepo.updateStatus to mark company as ingesting', async () => {
    await runBatchIngestion({ includeAlreadyParsed: true });

    expect(mockCompaniesRepo.updateStatus).toHaveBeenCalledWith(
      '0001655050',
      expect.objectContaining({ ingestionStatus: 'ingesting' }),
    );
  });

  it('calls companiesRepo.upsert with the updated company record after ingestion', async () => {
    await runBatchIngestion({ includeAlreadyParsed: true });

    expect(mockCompaniesRepo.upsert).toHaveBeenCalledOnce();
    const updated = vi.mocked(mockCompaniesRepo.upsert).mock.calls[0][0] as CompanyRecord;
    expect(updated.ticker).toBe('ABVC');
  });

});

describe('runBatchIngestion — intelligence persistence (test 6: Postgres)', () => {

  // 6. Intelligence persists in Postgres
  it('calls intelligenceRepo.upsert with the generated intelligence', async () => {
    await runBatchIngestion({ includeAlreadyParsed: true });

    expect(mockIntelligenceRepo.upsert).toHaveBeenCalledOnce();
    const intel = vi.mocked(mockIntelligenceRepo.upsert).mock.calls[0][0];
    expect(intel).toBe(MOCK_INTELLIGENCE);
  });

  it('generates intelligence from filingsRepo.getByTicker (all historical filings, not only new)', async () => {
    const historicalFiling = { ...MOCK_FILING, accessionNumber: '0001655050-25-000001', filedAt: '2025-06-01T00:00:00Z' } as NormalizedFiling;
    // After the new filings are upserted, getByTicker returns both old + new
    vi.mocked(mockFilingsRepo.getByTicker)
      .mockResolvedValueOnce([])              // first call: skip-accession check
      .mockResolvedValueOnce([historicalFiling, MOCK_FILING]); // second: intelligence input

    await runBatchIngestion({ includeAlreadyParsed: true });

    const [ticker, allFilings] = vi.mocked(generateCompanyIntelligence).mock.calls[0];
    expect(ticker).toBe('ABVC');
    expect(allFilings).toHaveLength(2);
  });

});

describe('runBatchIngestion — filesystem backend (test 7: local dev)', () => {

  // 7. Filesystem backend works identically — same interface, different backing
  it('completes successfully when repos simulate the filesystem backend', async () => {
    // The filesystem repos implement the same IRepository interfaces.
    // Here we simulate that by using mock repos that would represent
    // data/companies.json contents.
    const fsCompaniesRepo = makeCompaniesRepo([MOCK_COMPANY]);
    const fsFilingsRepo   = makeFilingsRepo([]);
    const fsRunsRepo      = makeRunsRepo();
    const fsIntelRepo     = makeIntelligenceRepo();

    vi.mocked(getCompaniesRepo).mockResolvedValue(fsCompaniesRepo);
    vi.mocked(getFilingsRepo).mockResolvedValue(fsFilingsRepo);
    vi.mocked(getRunsRepo).mockResolvedValue(fsRunsRepo);
    vi.mocked(getIntelligenceRepo).mockResolvedValue(fsIntelRepo);

    const run = await runBatchIngestion({ includeAlreadyParsed: true });

    expect(run.status).toBe('completed');
    expect(fsRunsRepo.upsert).toHaveBeenCalled();
    expect(fsFilingsRepo.upsertAll).toHaveBeenCalled();
    expect(fsCompaniesRepo.upsert).toHaveBeenCalled();
    expect(fsIntelRepo.upsert).toHaveBeenCalled();
  });

});

describe('runBatchIngestion — idempotency (test 8: no duplicate filings)', () => {

  // 8. No duplicate filings — upsertAll is called exactly once per company
  it('calls filingsRepo.upsertAll exactly once per company per run', async () => {
    await runBatchIngestion({ tickers: ['ABVC'], includeAlreadyParsed: true });

    expect(mockFilingsRepo.upsertAll).toHaveBeenCalledOnce();
  });

  it('passes existing accessions as skipAccessions so they are not re-fetched', async () => {
    const existingAccession = '0001655050-25-000001';
    vi.mocked(mockFilingsRepo.knownAccessions).mockResolvedValue(new Set([existingAccession]));

    await runBatchIngestion({ tickers: ['ABVC'], includeAlreadyParsed: true });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = vi.mocked(ingestTicker).mock.calls[0][1] as any;
    expect(opts.skipAccessions).toBeInstanceOf(Set);
    expect((opts.skipAccessions as Set<string>).has(existingAccession)).toBe(true);
  });

  it('clears skipAccessions when forceReparse is true', async () => {
    await runBatchIngestion({ tickers: ['ABVC'], forceReparse: true });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = vi.mocked(ingestTicker).mock.calls[0][1] as any;
    expect((opts.skipAccessions as Set<string>).size).toBe(0);
  });

});

describe('runBatchIngestion — error isolation', () => {

  it('marks run as partial when some companies fail but others succeed', async () => {
    mockCompaniesRepo = makeCompaniesRepo([MOCK_COMPANY, MOCK_COMPANY_2]);
    vi.mocked(getCompaniesRepo).mockResolvedValue(mockCompaniesRepo);

    // First company succeeds, second fails
    vi.mocked(ingestTicker)
      .mockResolvedValueOnce(MOCK_PIPELINE_RESULT)
      .mockRejectedValueOnce(new Error('EDGAR timeout'));

    const run = await runBatchIngestion({ includeAlreadyParsed: true });

    expect(run.status).toBe('partial');
    expect(run.companiesCompleted).toBe(1);
    expect(run.companiesFailed).toBe(1);
  });

  it('per-company failure does not abort the batch — remaining companies are still processed', async () => {
    mockCompaniesRepo = makeCompaniesRepo([MOCK_COMPANY, MOCK_COMPANY_2]);
    vi.mocked(getCompaniesRepo).mockResolvedValue(mockCompaniesRepo);

    vi.mocked(ingestTicker)
      .mockRejectedValueOnce(new Error('EDGAR timeout'))
      .mockResolvedValueOnce({ ...MOCK_PIPELINE_RESULT, ticker: 'AITX' });

    await runBatchIngestion({ includeAlreadyParsed: true });

    // Both companies were attempted
    expect(ingestTicker).toHaveBeenCalledTimes(2);
  });

});
