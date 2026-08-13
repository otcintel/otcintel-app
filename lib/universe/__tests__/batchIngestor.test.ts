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
  IFinancialSnapshotsRepository,
  IReviewItemsRepository,
} from '@/lib/db/types';
import type { NormalizedFiling, CompanyIntelligence } from '@/lib/ingestion/types';

// ─── Mocks — hoisted before any import of the module under test ───────────────

vi.mock('@/lib/db/repositories', () => ({
  getCompaniesRepo:          vi.fn(),
  getFilingsRepo:            vi.fn(),
  getRunsRepo:               vi.fn(),
  getIntelligenceRepo:       vi.fn(),
  getFinancialSnapshotsRepo: vi.fn(),
  getReviewItemsRepo:        vi.fn(),
  resetRepositories:         vi.fn(),
  getBackendName:            vi.fn().mockReturnValue('postgres'),
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

// Phase 7 Step 5 mocks — prevent any EDGAR/XBRL network calls during existing tests
vi.mock('@/lib/ingestion/fetchers/edgar/companyFacts', () => ({
  fetchCompanyFacts:       vi.fn(),
  resetCompanyFactsCache:  vi.fn(),
  padCik:                  (cik: string | number) => String(cik).padStart(10, '0'),
  companyFactsCacheSize:   vi.fn().mockReturnValue(0),
}));

vi.mock('@/lib/ingestion/parsers/financials/xbrlConcepts', () => ({
  extractXbrlConcepts: vi.fn(),
}));

vi.mock('@/lib/ingestion/parsers/financials/goingConcern', () => ({
  detectGoingConcern: vi.fn(),
}));

vi.mock('@/lib/ingestion/parsers/financials/snapshot', () => ({
  buildFinancialSnapshot: vi.fn(),
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
import { runBatchIngestion, selectFinancialFiling } from '@/lib/universe/batchIngestor';
import {
  getCompaniesRepo,
  getFilingsRepo,
  getRunsRepo,
  getIntelligenceRepo,
  getFinancialSnapshotsRepo,
  getReviewItemsRepo,
} from '@/lib/db/repositories';
import { ingestTicker } from '@/lib/ingestion';
import { generateCompanyIntelligence } from '@/lib/ingestion/intelligence/companyIntelligence';
import { fetchCompanyFacts, resetCompanyFactsCache } from '@/lib/ingestion/fetchers/edgar/companyFacts';
import { extractXbrlConcepts } from '@/lib/ingestion/parsers/financials/xbrlConcepts';
import { detectGoingConcern } from '@/lib/ingestion/parsers/financials/goingConcern';
import { buildFinancialSnapshot } from '@/lib/ingestion/parsers/financials/snapshot';

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

function makeFinancialSnapshotsRepo(): IFinancialSnapshotsRepository {
  return {
    getLatestByCompany: vi.fn().mockResolvedValue(undefined),
    getByCompany:       vi.fn().mockResolvedValue([]),
    getByAccession:     vi.fn().mockResolvedValue(undefined),
    upsert:             vi.fn().mockResolvedValue(undefined),
  };
}

function makeReviewItemsRepo(): IReviewItemsRepository {
  return {
    upsertDetected:       vi.fn().mockResolvedValue(undefined),
    list:                 vi.fn().mockResolvedValue([]),
    getByDedupKey:        vi.fn().mockResolvedValue(undefined),
    updateStatus:         vi.fn().mockResolvedValue(undefined),
    markResolvedIfAbsent: vi.fn().mockResolvedValue(undefined),
  };
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

let mockCompaniesRepo: ICompaniesRepository;
let mockFilingsRepo: IFilingsRepository;
let mockRunsRepo: IRunsRepository;
let mockIntelligenceRepo: IIntelligenceRepository;
let mockFinancialSnapshotsRepo: IFinancialSnapshotsRepository;
let mockReviewItemsRepo: IReviewItemsRepository;

beforeEach(() => {
  mockCompaniesRepo          = makeCompaniesRepo();
  mockFilingsRepo            = makeFilingsRepo();
  mockRunsRepo               = makeRunsRepo();
  mockIntelligenceRepo       = makeIntelligenceRepo();
  mockFinancialSnapshotsRepo = makeFinancialSnapshotsRepo();
  mockReviewItemsRepo        = makeReviewItemsRepo();

  vi.mocked(getCompaniesRepo).mockResolvedValue(mockCompaniesRepo);
  vi.mocked(getFilingsRepo).mockResolvedValue(mockFilingsRepo);
  vi.mocked(getRunsRepo).mockResolvedValue(mockRunsRepo);
  vi.mocked(getIntelligenceRepo).mockResolvedValue(mockIntelligenceRepo);
  vi.mocked(getFinancialSnapshotsRepo).mockResolvedValue(mockFinancialSnapshotsRepo);
  vi.mocked(getReviewItemsRepo).mockResolvedValue(mockReviewItemsRepo);

  vi.mocked(ingestTicker).mockResolvedValue(MOCK_PIPELINE_RESULT);
  vi.mocked(generateCompanyIntelligence).mockReturnValue({ ...MOCK_INTELLIGENCE });

  // Phase 7 defaults — prevent network calls in all existing tests
  vi.mocked(resetCompanyFactsCache).mockReturnValue(undefined);
  vi.mocked(fetchCompanyFacts).mockResolvedValue({ available: false, reason: 'test default' });
  vi.mocked(extractXbrlConcepts).mockReturnValue({
    fiscalPeriod: undefined, fiscalYear: undefined, periodEndDate: undefined,
    filedAt: undefined, accessionNumber: undefined, cashAndEquivalents: undefined,
    currentLiabilities: undefined, accumulatedDeficit: undefined, operatingCashFlow: undefined,
    operatingCashFlowMonths: undefined, totalDebt: undefined, totalDebtComponents: [],
    xbrlAvailable: false, missingConcepts: [],
  });
  vi.mocked(detectGoingConcern).mockReturnValue({
    goingConcernFlag: false, confidence: 'low', sourceType: 'filing_text',
  });
  vi.mocked(buildFinancialSnapshot).mockReturnValue({
    ticker: 'ABVC', cik: '0001655050', formType: '', accessionNumber: undefined,
    fiscalPeriod: undefined, fiscalYear: undefined, periodEndDate: undefined,
    filedAt: undefined, cashAndEquivalents: undefined, currentLiabilities: undefined,
    accumulatedDeficit: undefined, totalDebt: undefined, totalDebtComponents: [],
    operatingCashFlow: undefined, operatingCashFlowMonths: undefined,
    monthlyBurnRate: undefined, cashRunwayMonths: undefined,
    goingConcernFlag: false, goingConcernSentence: undefined,
    xbrlAvailable: false, missingConcepts: [],
    extractedAt: '2026-01-01T00:00:00.000Z', dataSource: 'text',
  });
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
    // generateCompanyIntelligence returns a new object (spread in beforeEach) with
    // financialSnapshot added — check structural identity, not reference equality.
    expect(intel).toMatchObject({ ticker: 'ABVC' });
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

// ─── Phase 7 Step 5: Financial snapshot integration tests ─────────────────────

// Additional fixtures for snapshot tests
const MOCK_10K_FILING = {
  ticker:          'ABVC',
  accessionNumber: '0001655050-26-010001',
  formType:        '10-K',
  filedAt:         '2026-01-15T00:00:00Z',
  parserVersion:   PARSER_VERSION,
} as unknown as NormalizedFiling;

const MOCK_10KA_FILING = {
  ticker:          'ABVC',
  accessionNumber: '0001655050-26-020001',
  formType:        '10-K/A',
  filedAt:         '2026-02-01T00:00:00Z',
  parserVersion:   PARSER_VERSION,
} as unknown as NormalizedFiling;

const GC_TEXT = 'The company raises substantial doubt about its ability to continue as a going concern.';

const MOCK_PIPELINE_WITH_10K = {
  ticker:     'ABVC',
  normalized: [MOCK_10K_FILING],
  fetched:    1,
  parsed:     1,
  errors:     [] as string[],
  durationMs: 0,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rawFilings: [{ accessionNumber: '0001655050-26-010001', text: GC_TEXT } as any],
};

// ─── selectFinancialFiling — period selection (test 3) ───────────────────────

describe('selectFinancialFiling — most recent 10-K/10-Q selected (test 3)', () => {

  it('returns the most recently filed 10-K', () => {
    const older = { ...MOCK_10K_FILING, accessionNumber: '0001655050-25-010001', filedAt: '2025-06-30T00:00:00Z' } as unknown as NormalizedFiling;
    expect(selectFinancialFiling([older, MOCK_10K_FILING])?.accessionNumber)
      .toBe(MOCK_10K_FILING.accessionNumber);
  });

  it('returns the most recent when 10-K and 10-Q are both present', () => {
    const tenQ = { ...MOCK_10K_FILING, accessionNumber: '0001655050-26-030001', formType: '10-Q', filedAt: '2026-03-01T00:00:00Z' } as unknown as NormalizedFiling;
    expect(selectFinancialFiling([MOCK_10K_FILING, tenQ])?.accessionNumber)
      .toBe(tenQ.accessionNumber);
  });

  it('returns undefined when array is empty', () => {
    expect(selectFinancialFiling([])).toBeUndefined();
  });

});

// ─── selectFinancialFiling — amendment selection (test 4) ────────────────────

describe('selectFinancialFiling — amendment selection (test 4)', () => {

  it('selects 10-K/A over 10-K when the amendment is more recent', () => {
    const result = selectFinancialFiling([MOCK_10K_FILING, MOCK_10KA_FILING]);
    expect(result?.formType).toBe('10-K/A');
    expect(result?.accessionNumber).toBe(MOCK_10KA_FILING.accessionNumber);
  });

  it('selects 10-Q/A when it is the most recent financial filing', () => {
    const tenQA = { ...MOCK_10K_FILING, accessionNumber: '0001655050-26-040001', formType: '10-Q/A', filedAt: '2026-04-01T00:00:00Z' } as unknown as NormalizedFiling;
    expect(selectFinancialFiling([MOCK_10KA_FILING, tenQA])?.formType).toBe('10-Q/A');
  });

});

// ─── selectFinancialFiling — 8-K/other forms ignored (test 5) ────────────────

describe('selectFinancialFiling — 8-K and other forms excluded (test 5)', () => {

  it('returns undefined when only 8-K filings are present', () => {
    expect(selectFinancialFiling([MOCK_FILING])).toBeUndefined();
  });

  it('returns undefined for S-1', () => {
    const s1 = { ...MOCK_FILING, formType: 'S-1' } as unknown as NormalizedFiling;
    expect(selectFinancialFiling([s1])).toBeUndefined();
  });

  it('still selects the 10-K when mixed with 8-K filings', () => {
    expect(selectFinancialFiling([MOCK_FILING, MOCK_10K_FILING])?.formType).toBe('10-K');
  });

});

// ─── Cache reset once per batch (test 1) ─────────────────────────────────────

describe('runBatchIngestion — Company Facts cache reset once per batch (test 1)', () => {

  it('calls resetCompanyFactsCache exactly once even for a multi-company batch', async () => {
    mockCompaniesRepo = makeCompaniesRepo([MOCK_COMPANY, MOCK_COMPANY_2]);
    vi.mocked(getCompaniesRepo).mockResolvedValue(mockCompaniesRepo);
    vi.mocked(ingestTicker).mockResolvedValue({ ...MOCK_PIPELINE_RESULT });

    await runBatchIngestion({ includeAlreadyParsed: true });

    expect(resetCompanyFactsCache).toHaveBeenCalledOnce();
  });

});

// ─── Company Facts fetched once per company (test 2) ─────────────────────────

describe('runBatchIngestion — Company Facts fetched once per company (test 2)', () => {

  it('calls fetchCompanyFacts with the company CIK for a single-company batch', async () => {
    await runBatchIngestion({ tickers: ['ABVC'], includeAlreadyParsed: true });

    expect(fetchCompanyFacts).toHaveBeenCalledOnce();
    expect(fetchCompanyFacts).toHaveBeenCalledWith(MOCK_COMPANY.cik);
  });

  it('calls fetchCompanyFacts once per company in a multi-company batch', async () => {
    mockCompaniesRepo = makeCompaniesRepo([MOCK_COMPANY, MOCK_COMPANY_2]);
    vi.mocked(getCompaniesRepo).mockResolvedValue(mockCompaniesRepo);
    vi.mocked(ingestTicker).mockResolvedValue({ ...MOCK_PIPELINE_RESULT });

    await runBatchIngestion({ includeAlreadyParsed: true });

    expect(fetchCompanyFacts).toHaveBeenCalledTimes(2);
    expect(fetchCompanyFacts).toHaveBeenCalledWith(MOCK_COMPANY.cik);
    expect(fetchCompanyFacts).toHaveBeenCalledWith(MOCK_COMPANY_2.cik);
  });

});

// ─── XBRL unavailable does not fail ingestion (test 6) ───────────────────────

describe('runBatchIngestion — XBRL unavailable does not fail ingestion (test 6)', () => {

  it('completes successfully when fetchCompanyFacts returns available:false', async () => {
    // Default mock already returns { available: false } — verify batch still completes
    const run = await runBatchIngestion({ tickers: ['ABVC'], includeAlreadyParsed: true });

    expect(run.status).toBe('completed');
    expect(run.companiesFailed).toBe(0);
    expect(buildFinancialSnapshot).toHaveBeenCalledOnce();
  });

});

// ─── Valid snapshot attached to CompanyIntelligence (test 7) ─────────────────

describe('runBatchIngestion — valid snapshot attached to CompanyIntelligence (test 7)', () => {

  it('attaches the built FinancialSnapshot to the intelligence object before upsert', async () => {
    const SNAPSHOT = {
      ticker: 'ABVC', cik: '0001655050', formType: '10-K',
      xbrlAvailable: false, missingConcepts: [], goingConcernFlag: false,
      totalDebtComponents: [], extractedAt: '2026-01-01T00:00:00.000Z', dataSource: 'text' as const,
    };
    vi.mocked(buildFinancialSnapshot).mockReturnValueOnce(SNAPSHOT as unknown as ReturnType<typeof buildFinancialSnapshot>);

    vi.mocked(ingestTicker).mockResolvedValue({ ...MOCK_PIPELINE_WITH_10K });
    vi.mocked(mockFilingsRepo.getByTicker)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([MOCK_10K_FILING]);

    await runBatchIngestion({ tickers: ['ABVC'], includeAlreadyParsed: true });

    const intel = vi.mocked(mockIntelligenceRepo.upsert).mock.calls[0][0];
    expect(intel.financialSnapshot).toBe(SNAPSHOT);
  });

});

// ─── Going concern uses matching financial filing text (test 8) ───────────────

describe('runBatchIngestion — going concern uses matching financial filing text (test 8)', () => {

  it('calls detectGoingConcern with the text of the matching raw filing', async () => {
    vi.mocked(ingestTicker).mockResolvedValue({ ...MOCK_PIPELINE_WITH_10K });
    vi.mocked(mockFilingsRepo.getByTicker)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([MOCK_10K_FILING]);

    await runBatchIngestion({ tickers: ['ABVC'], includeAlreadyParsed: true });

    expect(detectGoingConcern).toHaveBeenCalledOnce();
    expect(detectGoingConcern).toHaveBeenCalledWith(GC_TEXT);
  });

  it('skips detectGoingConcern when rawFilings is absent (all filings skipped)', async () => {
    const resultNoRaw = { ...MOCK_PIPELINE_RESULT, rawFilings: undefined };
    vi.mocked(ingestTicker).mockResolvedValue(resultNoRaw);
    vi.mocked(mockFilingsRepo.getByTicker)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([MOCK_10K_FILING]);

    await runBatchIngestion({ tickers: ['ABVC'], includeAlreadyParsed: true });

    expect(detectGoingConcern).not.toHaveBeenCalled();
  });

});

// ─── financialSnapshot persists through intelligence repo (test 9) ────────────

describe('runBatchIngestion — financialSnapshot persists through intelligence repo (test 9)', () => {

  it('intelligenceRepo.upsert receives the intelligence object with financialSnapshot set', async () => {
    vi.mocked(ingestTicker).mockResolvedValue({ ...MOCK_PIPELINE_WITH_10K });
    vi.mocked(mockFilingsRepo.getByTicker)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([MOCK_10K_FILING]);

    await runBatchIngestion({ tickers: ['ABVC'], includeAlreadyParsed: true });

    expect(mockIntelligenceRepo.upsert).toHaveBeenCalledOnce();
    const intel = vi.mocked(mockIntelligenceRepo.upsert).mock.calls[0][0];
    expect(intel).toHaveProperty('financialSnapshot');
    expect(intel.financialSnapshot).toBeDefined();
  });

});

// ─── Financial snapshot error does not destroy intelligence (test 10) ─────────

describe('runBatchIngestion — financial snapshot error non-fatal (test 10)', () => {

  it('batch completes with status "completed" when buildFinancialSnapshot throws', async () => {
    vi.mocked(buildFinancialSnapshot).mockImplementationOnce(() => {
      throw new Error('EDGAR rate limit exceeded');
    });

    const run = await runBatchIngestion({ tickers: ['ABVC'], includeAlreadyParsed: true });

    expect(run.status).toBe('completed');
    expect(run.companiesCompleted).toBe(1);
    expect(run.companiesFailed).toBe(0);
  });

  it('intelligenceRepo.upsert is still called even when snapshot generation fails', async () => {
    vi.mocked(buildFinancialSnapshot).mockImplementationOnce(() => {
      throw new Error('transient network error');
    });

    await runBatchIngestion({ tickers: ['ABVC'], includeAlreadyParsed: true });

    expect(mockIntelligenceRepo.upsert).toHaveBeenCalledOnce();
    const intel = vi.mocked(mockIntelligenceRepo.upsert).mock.calls[0][0];
    expect(intel.financialSnapshot).toBeUndefined();
  });

});

// ─── Postgres production path (test 11) ──────────────────────────────────────

describe('runBatchIngestion — Postgres production path (test 11)', () => {

  it('builds and attaches snapshot on the Postgres backend path', async () => {
    vi.mocked(ingestTicker).mockResolvedValue({ ...MOCK_PIPELINE_WITH_10K });
    vi.mocked(mockFilingsRepo.getByTicker)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([MOCK_10K_FILING]);

    const run = await runBatchIngestion({ tickers: ['ABVC'], includeAlreadyParsed: true });

    expect(run.status).toBe('completed');
    expect(buildFinancialSnapshot).toHaveBeenCalledOnce();

    const intel = vi.mocked(mockIntelligenceRepo.upsert).mock.calls[0][0];
    expect(intel.financialSnapshot).toBeDefined();
  });

});

// ─── Filesystem local path (test 12) ─────────────────────────────────────────

describe('runBatchIngestion — filesystem local path (test 12)', () => {

  it('builds and attaches snapshot on the filesystem backend path', async () => {
    const fsCompaniesRepo   = makeCompaniesRepo([MOCK_COMPANY]);
    const fsFilingsRepo     = makeFilingsRepo([]);
    const fsRunsRepo        = makeRunsRepo();
    const fsIntelRepo       = makeIntelligenceRepo();
    const fsSnapshotsRepo   = makeFinancialSnapshotsRepo();

    vi.mocked(getCompaniesRepo).mockResolvedValue(fsCompaniesRepo);
    vi.mocked(getFilingsRepo).mockResolvedValue(fsFilingsRepo);
    vi.mocked(getRunsRepo).mockResolvedValue(fsRunsRepo);
    vi.mocked(getIntelligenceRepo).mockResolvedValue(fsIntelRepo);
    vi.mocked(getFinancialSnapshotsRepo).mockResolvedValue(fsSnapshotsRepo);

    vi.mocked(ingestTicker).mockResolvedValue({ ...MOCK_PIPELINE_WITH_10K });
    vi.mocked(fsFilingsRepo.getByTicker as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([MOCK_10K_FILING]);

    const run = await runBatchIngestion({ tickers: ['ABVC'], includeAlreadyParsed: true });

    expect(run.status).toBe('completed');
    expect(buildFinancialSnapshot).toHaveBeenCalledOnce();

    const intel = vi.mocked(fsIntelRepo.upsert).mock.calls[0][0];
    expect(intel.financialSnapshot).toBeDefined();
  });

});

// ─── Step 6: financial_snapshots repo persistence ─────────────────────────────

describe('runBatchIngestion — Postgres backend writes to financial_snapshots (Step 6, test A)', () => {

  it('calls financialSnapshotsRepo.upsert with the built snapshot', async () => {
    vi.mocked(ingestTicker).mockResolvedValue({ ...MOCK_PIPELINE_WITH_10K });
    vi.mocked(mockFilingsRepo.getByTicker)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([MOCK_10K_FILING]);

    await runBatchIngestion({ tickers: ['ABVC'], includeAlreadyParsed: true });

    expect(mockFinancialSnapshotsRepo.upsert).toHaveBeenCalledOnce();
    const persisted = vi.mocked(mockFinancialSnapshotsRepo.upsert).mock.calls[0][0];
    expect(persisted).toBeDefined();
    expect(persisted.ticker).toBe('ABVC');
  });

  it('financialSnapshotsRepo.upsert failure is non-fatal — intelligence still upserted', async () => {
    vi.mocked(mockFinancialSnapshotsRepo.upsert).mockRejectedValueOnce(
      new Error('Supabase write failed'),
    );

    const run = await runBatchIngestion({ tickers: ['ABVC'], includeAlreadyParsed: true });

    // Company must still complete (snapshot persistence error is non-fatal)
    expect(run.status).toBe('completed');
    expect(run.companiesCompleted).toBe(1);
  });

});

describe('runBatchIngestion — filesystem backend financialSnapshotsRepo (Step 6, test B)', () => {

  it('calls filesystemFinancialSnapshotsRepo.upsert on the filesystem path', async () => {
    const fsCompaniesRepo   = makeCompaniesRepo([MOCK_COMPANY]);
    const fsFilingsRepo     = makeFilingsRepo([]);
    const fsRunsRepo        = makeRunsRepo();
    const fsIntelRepo       = makeIntelligenceRepo();
    const fsSnapshotsRepo   = makeFinancialSnapshotsRepo();

    vi.mocked(getCompaniesRepo).mockResolvedValue(fsCompaniesRepo);
    vi.mocked(getFilingsRepo).mockResolvedValue(fsFilingsRepo);
    vi.mocked(getRunsRepo).mockResolvedValue(fsRunsRepo);
    vi.mocked(getIntelligenceRepo).mockResolvedValue(fsIntelRepo);
    vi.mocked(getFinancialSnapshotsRepo).mockResolvedValue(fsSnapshotsRepo);

    vi.mocked(ingestTicker).mockResolvedValue({ ...MOCK_PIPELINE_WITH_10K });
    vi.mocked(fsFilingsRepo.getByTicker as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([MOCK_10K_FILING]);

    await runBatchIngestion({ tickers: ['ABVC'], includeAlreadyParsed: true });

    expect(fsSnapshotsRepo.upsert).toHaveBeenCalledOnce();
    const persisted = vi.mocked(fsSnapshotsRepo.upsert).mock.calls[0][0];
    expect(persisted.ticker).toBe('ABVC');
  });

});
