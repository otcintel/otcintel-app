/**
 * Phase 1B: anomaly detection wired into batch ingestion.
 *
 * Verifies detector is called, items are persisted via repository,
 * markResolvedIfAbsent is always called, and failures are non-fatal.
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
import type { ReviewItemInput } from '@/lib/anomaly/types';

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
    upsertAll:      vi.fn(),
    upsert:         vi.fn(),
    getByTicker:    vi.fn().mockReturnValue([]),
    getMostRecent:  vi.fn().mockReturnValue(undefined),
    getByAccession: vi.fn().mockReturnValue(undefined),
    getAllTickers:  vi.fn().mockReturnValue([]),
    count:          vi.fn().mockReturnValue(0),
    clearTicker:    vi.fn(),
    clearAll:       vi.fn(),
  },
}));

vi.mock('@/lib/ingestion/intelligence/companyIntelligence', () => ({
  generateCompanyIntelligence: vi.fn(),
}));

vi.mock('@/lib/ingestion/fetchers/edgar/companyFacts', () => ({
  fetchCompanyFacts:      vi.fn(),
  resetCompanyFactsCache: vi.fn(),
  padCik:                 (cik: string | number) => String(cik).padStart(10, '0'),
  companyFactsCacheSize:  vi.fn().mockReturnValue(0),
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

vi.mock('@/lib/universe/companies', () => ({
  seedToRecord:           vi.fn(),
  applyIngestionResult:   vi.fn((company: CompanyRecord) => ({ ...company, ingestionStatus: 'parsed', filingsParsed: 1 })),
  getStaleFilings:        vi.fn().mockReturnValue([]),
  hasStaleFilings:        vi.fn().mockReturnValue(false),
  deriveConfidenceStatus: vi.fn().mockReturnValue('insufficient_data'),
}));

vi.mock('@/lib/anomaly/detector', () => ({
  inspect: vi.fn().mockReturnValue([]),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { runBatchIngestion } from '@/lib/universe/batchIngestor';
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
import { inspect } from '@/lib/anomaly/detector';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_COMPANY: CompanyRecord = {
  ticker:                   'GOVX',
  cik:                      '0001398987',
  companyName:              'GeoVax Labs Inc.',
  active:                   true,
  ingestionStatus:          'pending',
  filingsDiscovered:        0,
  filingsParsed:            0,
  warningsCount:            0,
  rejectedCandidatesCount:  0,
  createdAt:                '2025-01-01T00:00:00Z',
  updatedAt:                '2025-01-01T00:00:00Z',
};

const MOCK_FILING = {
  ticker:          'GOVX',
  accessionNumber: '0001398987-26-000001',
  form:            '8-K',
  filedAt:         '2026-01-15T00:00:00Z',
  parserVersion:   PARSER_VERSION,
} as unknown as NormalizedFiling;

const MOCK_INTELLIGENCE = { ticker: 'GOVX' } as CompanyIntelligence;

const MOCK_PIPELINE_RESULT = {
  ticker:     'GOVX',
  normalized: [MOCK_FILING],
  fetched:    1,
  parsed:     1,
  errors:     [] as string[],
  durationMs: 0,
};

const GOVX_UNKNOWN_TYPE_ITEM: ReviewItemInput = {
  dedupKey:        'GOVX:unknown_financing_type:0001398987-26-000001:financing.financingType',
  ticker:          'GOVX',
  cik:             '0001398987',
  accessionNumber: '0001398987-26-000001',
  anomalyType:     'unknown_financing_type',
  category:        'financing_extraction',
  severity:        'high',
  title:           'Unknown financing type',
  description:     'Financing type could not be classified',
  parserVersion:   PARSER_VERSION,
};

const NVVE_VARIABLE_PRICING_ITEM: ReviewItemInput = {
  dedupKey:        'NVVE:variable_pricing_missing_discount:0001801999-26-000001:financing.discountRate',
  ticker:          'NVVE',
  cik:             '0001801999',
  accessionNumber: '0001801999-26-000001',
  anomalyType:     'variable_pricing_missing_discount',
  category:        'financing_extraction',
  severity:        'high',
  title:           'Variable pricing missing discount',
  description:     'Note has variable pricing but no discount rate extracted',
  parserVersion:   PARSER_VERSION,
};

// ─── Mock repo factories ──────────────────────────────────────────────────────

function makeCompaniesRepo(): ICompaniesRepository {
  return {
    getAll:       vi.fn().mockResolvedValue([MOCK_COMPANY]),
    getByCik:     vi.fn().mockResolvedValue(MOCK_COMPANY),
    getByTicker:  vi.fn().mockResolvedValue(MOCK_COMPANY),
    upsert:       vi.fn().mockResolvedValue(undefined),
    upsertAll:    vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    count:        vi.fn().mockResolvedValue(1),
  };
}

function makeFilingsRepo(): IFilingsRepository {
  return {
    getByTicker:     vi.fn().mockResolvedValue([]),
    hasAccession:    vi.fn().mockResolvedValue(false),
    knownAccessions: vi.fn().mockResolvedValue(new Set<string>()),
    upsertAll:       vi.fn().mockResolvedValue(undefined),
    getAllTickers:   vi.fn().mockResolvedValue([]),
    totalCount:      vi.fn().mockResolvedValue(0),
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
    getByTicker:   vi.fn().mockResolvedValue(undefined),
    upsert:        vi.fn().mockResolvedValue(undefined),
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
    getById:              vi.fn().mockResolvedValue(undefined),
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
  vi.mocked(inspect).mockReturnValue([]);

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
    ticker: 'GOVX', cik: '0001398987', formType: '', accessionNumber: undefined,
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

describe('Phase 1B: anomaly detector wired into batch ingestion', () => {
  it('calls inspect exactly once per company', async () => {
    await runBatchIngestion({ tickers: ['GOVX'] });

    expect(inspect).toHaveBeenCalledTimes(1);
    expect(inspect).toHaveBeenCalledWith(
      expect.objectContaining({ ticker: 'GOVX' }),
    );
  });

  it('persists a HIGH unknown_financing_type item (GOVX-style)', async () => {
    vi.mocked(inspect).mockReturnValue([GOVX_UNKNOWN_TYPE_ITEM]);

    await runBatchIngestion({ tickers: ['GOVX'] });

    expect(mockReviewItemsRepo.upsertDetected).toHaveBeenCalledWith([GOVX_UNKNOWN_TYPE_ITEM]);
  });

  it('persists a HIGH variable_pricing_missing_discount item (NVVE-style)', async () => {
    vi.mocked(inspect).mockReturnValue([NVVE_VARIABLE_PRICING_ITEM]);

    await runBatchIngestion({ tickers: ['GOVX'] });

    expect(mockReviewItemsRepo.upsertDetected).toHaveBeenCalledWith([NVVE_VARIABLE_PRICING_ITEM]);
  });

  it('does NOT call upsertDetected when detector returns no items', async () => {
    vi.mocked(inspect).mockReturnValue([]);

    await runBatchIngestion({ tickers: ['GOVX'] });

    expect(mockReviewItemsRepo.upsertDetected).not.toHaveBeenCalled();
  });

  it('always calls markResolvedIfAbsent even when no items are detected', async () => {
    vi.mocked(inspect).mockReturnValue([]);

    await runBatchIngestion({ tickers: ['GOVX'] });

    expect(mockReviewItemsRepo.markResolvedIfAbsent).toHaveBeenCalledWith([], 'GOVX');
  });

  it('passes active dedup keys and company ticker to markResolvedIfAbsent', async () => {
    vi.mocked(inspect).mockReturnValue([GOVX_UNKNOWN_TYPE_ITEM]);

    await runBatchIngestion({ tickers: ['GOVX'] });

    expect(mockReviewItemsRepo.markResolvedIfAbsent).toHaveBeenCalledWith(
      [GOVX_UNKNOWN_TYPE_ITEM.dedupKey],
      'GOVX',
    );
  });

  it('emits the same dedup key on recurrence (second run with same anomaly)', async () => {
    vi.mocked(inspect).mockReturnValue([GOVX_UNKNOWN_TYPE_ITEM]);

    await runBatchIngestion({ tickers: ['GOVX'] });
    await runBatchIngestion({ tickers: ['GOVX'] });

    const calls = vi.mocked(mockReviewItemsRepo.upsertDetected).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0][0].dedupKey).toBe(calls[1][0][0].dedupKey);
  });

  it('passes empty active keys on second run when anomaly disappears (triggers resolution)', async () => {
    vi.mocked(inspect).mockReturnValue([GOVX_UNKNOWN_TYPE_ITEM]);
    await runBatchIngestion({ tickers: ['GOVX'] });

    vi.mocked(inspect).mockReturnValue([]);
    await runBatchIngestion({ tickers: ['GOVX'] });

    const calls = vi.mocked(mockReviewItemsRepo.markResolvedIfAbsent).mock.calls;
    expect(calls[1]).toEqual([[], 'GOVX']);
  });

  it('does not include suppressed items in the active dedup key set passed to markResolvedIfAbsent', async () => {
    // The batchIngestor only passes keys the detector emitted; the DB layer
    // filters by status when resolving. Suppressed keys are never injected here.
    vi.mocked(inspect).mockReturnValue([GOVX_UNKNOWN_TYPE_ITEM]);

    await runBatchIngestion({ tickers: ['GOVX'] });

    const [activeDedupKeys] = vi.mocked(mockReviewItemsRepo.markResolvedIfAbsent).mock.calls[0];
    expect(activeDedupKeys).toEqual([GOVX_UNKNOWN_TYPE_ITEM.dedupKey]);
    expect(activeDedupKeys).not.toContain('some-expected-behavior-key');
    expect(activeDedupKeys).not.toContain('some-ignored-key');
  });

  it('detector failure is non-fatal — company ingestion completes successfully', async () => {
    vi.mocked(inspect).mockImplementation(() => { throw new Error('detector crashed'); });

    const run = await runBatchIngestion({ tickers: ['GOVX'] });

    expect(run.companiesCompleted).toBe(1);
    expect(run.companiesFailed).toBe(0);
    expect(mockReviewItemsRepo.upsertDetected).not.toHaveBeenCalled();
    expect(mockReviewItemsRepo.markResolvedIfAbsent).not.toHaveBeenCalled();
  });

  it('repository upsertDetected failure is non-fatal — company ingestion completes successfully', async () => {
    vi.mocked(inspect).mockReturnValue([GOVX_UNKNOWN_TYPE_ITEM]);
    vi.mocked(mockReviewItemsRepo.upsertDetected).mockRejectedValue(new Error('DB write failed'));

    const run = await runBatchIngestion({ tickers: ['GOVX'] });

    expect(run.companiesCompleted).toBe(1);
    expect(run.companiesFailed).toBe(0);
  });

  it('Postgres path: getReviewItemsRepo is called and upsertDetected persists items', async () => {
    vi.mocked(inspect).mockReturnValue([GOVX_UNKNOWN_TYPE_ITEM]);

    await runBatchIngestion({ tickers: ['GOVX'] });

    expect(getReviewItemsRepo).toHaveBeenCalled();
    expect(mockReviewItemsRepo.upsertDetected).toHaveBeenCalledWith([GOVX_UNKNOWN_TYPE_ITEM]);
  });

  it('filesystem/no-op path: no Supabase calls are made and ingestion completes', async () => {
    const noOpRepo: IReviewItemsRepository = {
      upsertDetected:       vi.fn().mockResolvedValue(undefined),
      list:                 vi.fn().mockResolvedValue([]),
      getById:              vi.fn().mockResolvedValue(undefined),
      getByDedupKey:        vi.fn().mockResolvedValue(undefined),
      updateStatus:         vi.fn().mockResolvedValue(undefined),
      markResolvedIfAbsent: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(getReviewItemsRepo).mockResolvedValue(noOpRepo);
    vi.mocked(inspect).mockReturnValue([GOVX_UNKNOWN_TYPE_ITEM]);

    const run = await runBatchIngestion({ tickers: ['GOVX'] });

    expect(run.companiesCompleted).toBe(1);
    expect(run.companiesFailed).toBe(0);
    expect(noOpRepo.upsertDetected).toHaveBeenCalledWith([GOVX_UNKNOWN_TYPE_ITEM]);
    expect(noOpRepo.markResolvedIfAbsent).toHaveBeenCalledWith(
      [GOVX_UNKNOWN_TYPE_ITEM.dedupKey],
      'GOVX',
    );
  });
});
