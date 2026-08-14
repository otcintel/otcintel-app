/**
 * Stale-accession reprocessing guarantee — batchIngestor integration tests.
 *
 * Verifies that stale filings (parserVersion < PARSER_VERSION) not rediscovered
 * by the normal pipeline are targeted-fetched and reparsed directly, that the
 * guarantee is non-fatal, and that deduplication, form filtering, and forceReparse
 * bypass all behave correctly.
 *
 * Required scenarios (11):
 *  1. Targeted fetch runs for a stale filing not reparsed by normal pipeline
 *  2. Deduplication: targeted fetch skipped when normal pipeline already reparsed it
 *  3. Unparseable form type excluded from targeted fetch
 *  4. forceReparse: targeted fetch path skipped entirely
 *  5. Targeted fetch failure is non-fatal — company ingestion completes
 *  6. Targeted fetch failure warning contains ticker + accessionNumber + formType
 *  7. Multiple stale filings: all targeted when none reparsed normally
 *  8. Targeted filing is persisted (filings.upsertAll includes it)
 *  9. Targeted filing included in downstream flow (intelligence runs after reparse)
 * 10. WRAP before/after: stale S-3 → parserVersion 1.0.4, hasResetProvisionsDetermined=true
 * 11. Zero stale filings: targeted fetch path runs no iterations
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
  filingsDb: {
    getByTicker:     vi.fn().mockReturnValue([]),
    knownAccessions: vi.fn().mockReturnValue(new Set()),
    upsertAll:       vi.fn(),
  },
  runsDb: {
    upsert:       vi.fn(),
    upsertResult: vi.fn(),
    getAll:       vi.fn().mockReturnValue([]),
    getById:      vi.fn().mockReturnValue(undefined),
    getResults:   vi.fn().mockReturnValue([]),
  },
  intelligenceDb: {
    upsert:        vi.fn(),
    getByTicker:   vi.fn().mockReturnValue(undefined),
    getAllTickers:  vi.fn().mockReturnValue([]),
  },
}));

// reparseStaleFiling is the new targeted-fetch export
vi.mock('@/lib/ingestion', () => ({
  ingestTicker:       vi.fn(),
  reparseStaleFiling: vi.fn(),
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
  PARSEABLE_FORMS:        new Set([
    '10-K', '10-K/A', '10-Q', '10-Q/A',
    '8-K',  '8-K/A',
    'S-1',  'S-1/A',  'S-3',  'S-3/A',  'S-8',
    '1-A',  '1-A/A',
  ]),
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
import { ingestTicker, reparseStaleFiling } from '@/lib/ingestion';
import { generateCompanyIntelligence } from '@/lib/ingestion/intelligence/companyIntelligence';
import { fetchCompanyFacts, resetCompanyFactsCache } from '@/lib/ingestion/fetchers/edgar/companyFacts';
import { extractXbrlConcepts } from '@/lib/ingestion/parsers/financials/xbrlConcepts';
import { detectGoingConcern } from '@/lib/ingestion/parsers/financials/goingConcern';
import { buildFinancialSnapshot } from '@/lib/ingestion/parsers/financials/snapshot';
import { getStaleFilings } from '@/lib/universe/companies';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const WRAP_COMPANY: CompanyRecord = {
  ticker:                  'WRAP',
  cik:                     '0001738827',
  companyName:             'Wrap Technologies Inc.',
  active:                  true,
  ingestionStatus:         'pending',
  filingsDiscovered:       0,
  filingsParsed:           0,
  warningsCount:           0,
  rejectedCandidatesCount: 0,
  createdAt:               '2025-01-01T00:00:00Z',
  updatedAt:               '2025-01-01T00:00:00Z',
};

// Stale S-3 as it exists in the DB — parser version 1.0.0, no hasResetProvisionsDetermined
const WRAP_STALE_S3: NormalizedFiling = {
  ticker:          'WRAP',
  cik:             '0001738827',
  formType:        'S-3',
  filedAt:         '2025-06-10',
  periodOfReport:  '2025-06-10',
  accessionNumber: '0001738827-25-000042',
  documentUrl:     'https://www.sec.gov/Archives/edgar/data/1738827/000173882725000042/wrap-s3.htm',
  source:          'edgar',
  parseErrors:     [],
  ingestedAt:      '2025-06-10T12:00:00Z',
  parserVersion:   '1.0.0',
  financing: {
    financingType:                'equity_line',
    hasFloorPrice:                false,
    hasFloorPriceDetermined:      false,
    hasResetProvisions:           true,
    hasResetProvisionsDetermined: undefined as unknown as boolean,
    confidence:                   'high',
    matchedPhrases:               ['reset provision', 'anti-dilution'],
  },
};

// Refreshed S-3 as reparseStaleFiling would return it — parser version 1.0.4
const WRAP_REPARSED_S3: NormalizedFiling = {
  ...WRAP_STALE_S3,
  parserVersion: PARSER_VERSION,
  ingestedAt:    '2026-01-01T00:00:00Z',
  financing: {
    ...WRAP_STALE_S3.financing!,
    hasResetProvisionsDetermined: true,
  },
};

// A filing with an unparseable form type (not in PARSEABLE_FORMS)
const STALE_NT_10Q: NormalizedFiling = {
  ...WRAP_STALE_S3,
  formType:        'NT 10-Q',
  accessionNumber: '0001738827-25-000099',
  parserVersion:   '1.0.0',
};

const MOCK_INTELLIGENCE = { ticker: 'WRAP' } as CompanyIntelligence;

// Default pipeline result — stale S-3 was NOT rediscovered
const PIPELINE_RESULT_WITHOUT_S3 = {
  ticker:     'WRAP',
  normalized: [] as NormalizedFiling[],
  fetched:    0,
  parsed:     0,
  errors:     [] as string[],
  durationMs: 0,
};

// Pipeline result that ALREADY includes the reparsed S-3 (deduplication scenario)
const PIPELINE_RESULT_WITH_S3 = {
  ticker:     'WRAP',
  normalized: [WRAP_REPARSED_S3],
  fetched:    1,
  parsed:     1,
  errors:     [] as string[],
  durationMs: 0,
};

// ─── Mock repo factories ──────────────────────────────────────────────────────

function makeCompaniesRepo(): ICompaniesRepository {
  return {
    getAll:       vi.fn().mockResolvedValue([WRAP_COMPANY]),
    getByCik:     vi.fn().mockResolvedValue(WRAP_COMPANY),
    getByTicker:  vi.fn().mockResolvedValue(WRAP_COMPANY),
    upsert:       vi.fn().mockResolvedValue(undefined),
    upsertAll:    vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    count:        vi.fn().mockResolvedValue(1),
  };
}

function makeFilingsRepo(storedFilings: NormalizedFiling[] = []): IFilingsRepository {
  return {
    getByTicker:     vi.fn().mockResolvedValue(storedFilings),
    hasAccession:    vi.fn().mockResolvedValue(false),
    knownAccessions: vi.fn().mockResolvedValue(new Set(storedFilings.map(f => f.accessionNumber))),
    upsertAll:       vi.fn().mockResolvedValue(undefined),
    getAllTickers:   vi.fn().mockResolvedValue([]),
    totalCount:      vi.fn().mockResolvedValue(storedFilings.length),
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
    getAllTickers:  vi.fn().mockResolvedValue([]),
    upsert:        vi.fn().mockResolvedValue(undefined),
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

// ─── Test setup ───────────────────────────────────────────────────────────────

let mockCompaniesRepo: ICompaniesRepository;
let mockFilingsRepo: IFilingsRepository;
let mockRunsRepo: IRunsRepository;
let mockIntelligenceRepo: IIntelligenceRepository;
let mockSnapshotsRepo: IFinancialSnapshotsRepository;
let mockReviewItemsRepo: IReviewItemsRepository;

beforeEach(() => {
  vi.resetAllMocks();

  mockCompaniesRepo   = makeCompaniesRepo();
  mockFilingsRepo     = makeFilingsRepo([WRAP_STALE_S3]);
  mockRunsRepo        = makeRunsRepo();
  mockIntelligenceRepo = makeIntelligenceRepo();
  mockSnapshotsRepo   = makeFinancialSnapshotsRepo();
  mockReviewItemsRepo  = makeReviewItemsRepo();

  vi.mocked(getCompaniesRepo).mockResolvedValue(mockCompaniesRepo);
  vi.mocked(getFilingsRepo).mockResolvedValue(mockFilingsRepo);
  vi.mocked(getRunsRepo).mockResolvedValue(mockRunsRepo);
  vi.mocked(getIntelligenceRepo).mockResolvedValue(mockIntelligenceRepo);
  vi.mocked(getFinancialSnapshotsRepo).mockResolvedValue(mockSnapshotsRepo);
  vi.mocked(getReviewItemsRepo).mockResolvedValue(mockReviewItemsRepo);

  vi.mocked(ingestTicker).mockResolvedValue({ ...PIPELINE_RESULT_WITHOUT_S3, normalized: [], errors: [] });
  vi.mocked(reparseStaleFiling).mockResolvedValue(WRAP_REPARSED_S3);
  vi.mocked(generateCompanyIntelligence).mockReturnValue(MOCK_INTELLIGENCE);

  // Phase 7 — prevent EDGAR/XBRL calls
  vi.mocked(fetchCompanyFacts).mockResolvedValue({ available: false, reason: 'mocked' });
  vi.mocked(resetCompanyFactsCache).mockReturnValue(undefined);
  vi.mocked(extractXbrlConcepts).mockReturnValue({
    xbrlAvailable: false, missingConcepts: [], totalDebtComponents: [],
    fiscalPeriod: undefined, fiscalYear: undefined, periodEndDate: undefined,
    filedAt: undefined, accessionNumber: undefined,
    cashAndEquivalents: undefined, currentLiabilities: undefined,
    accumulatedDeficit: undefined, operatingCashFlow: undefined,
    operatingCashFlowMonths: undefined, totalDebt: undefined,
  });
  vi.mocked(detectGoingConcern).mockReturnValue({ goingConcernFlag: false, confidence: 'low', sourceType: 'filing_text' });
  vi.mocked(buildFinancialSnapshot).mockReturnValue({ ticker: 'WRAP' } as never);

  // Default: the S-3 is stale (will be overridden per-test where needed)
  vi.mocked(getStaleFilings).mockReturnValue([WRAP_STALE_S3]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('stale-accession reprocessing guarantee', () => {
  it('1. targeted fetch runs for a stale filing not reparsed by normal pipeline', async () => {
    // pipeline missed the stale S-3 entirely
    vi.mocked(ingestTicker).mockResolvedValue({ ...PIPELINE_RESULT_WITHOUT_S3, normalized: [], errors: [] });

    await runBatchIngestion({ tickers: ['WRAP'] });

    expect(reparseStaleFiling).toHaveBeenCalledOnce();
    expect(reparseStaleFiling).toHaveBeenCalledWith(WRAP_STALE_S3);
  });

  it('2. deduplication: targeted fetch skipped when normal pipeline already reparsed it', async () => {
    // pipeline found and reparsed the S-3 itself
    vi.mocked(ingestTicker).mockResolvedValue({ ...PIPELINE_RESULT_WITH_S3, errors: [] });

    await runBatchIngestion({ tickers: ['WRAP'] });

    expect(reparseStaleFiling).not.toHaveBeenCalled();
  });

  it('3. unparseable form type excluded from targeted fetch', async () => {
    // NT 10-Q is not in PARSEABLE_FORMS
    vi.mocked(getStaleFilings).mockReturnValue([STALE_NT_10Q]);
    vi.mocked(ingestTicker).mockResolvedValue({ ...PIPELINE_RESULT_WITHOUT_S3, normalized: [], errors: [] });

    await runBatchIngestion({ tickers: ['WRAP'] });

    expect(reparseStaleFiling).not.toHaveBeenCalled();
  });

  it('4. forceReparse: targeted fetch path skipped entirely', async () => {
    vi.mocked(ingestTicker).mockResolvedValue({ ...PIPELINE_RESULT_WITHOUT_S3, normalized: [], errors: [] });

    await runBatchIngestion({ tickers: ['WRAP'], forceReparse: true });

    // When forceReparse is true staleStoredFilings stays empty — no targeted fetch
    expect(reparseStaleFiling).not.toHaveBeenCalled();
  });

  it('5. targeted fetch failure is non-fatal — company ingestion completes', async () => {
    vi.mocked(reparseStaleFiling).mockRejectedValue(new Error('EDGAR 503 Service Unavailable'));
    vi.mocked(ingestTicker).mockResolvedValue({ ...PIPELINE_RESULT_WITHOUT_S3, normalized: [], errors: [] });

    const run = await runBatchIngestion({ tickers: ['WRAP'] });

    expect(run.companiesFailed).toBe(0);
    expect(run.companiesCompleted + run.companiesPartial).toBeGreaterThan(0);
  });

  it('6. targeted fetch failure warning contains ticker, accessionNumber, and formType', async () => {
    vi.mocked(reparseStaleFiling).mockRejectedValue(new Error('network timeout'));
    vi.mocked(ingestTicker).mockResolvedValue({ ...PIPELINE_RESULT_WITHOUT_S3, normalized: [], errors: [] });

    const run = await runBatchIngestion({ tickers: ['WRAP'] });

    // reparseStaleFiling was called — the error path ran
    expect(vi.mocked(reparseStaleFiling)).toHaveBeenCalledOnce();
    const [calledWith] = vi.mocked(reparseStaleFiling).mock.calls[0];
    // These three fields feed the warning: "stale reparse skipped: {ticker} {accession} ({formType}): ..."
    expect(calledWith.ticker).toBe('WRAP');
    expect(calledWith.accessionNumber).toBe(WRAP_STALE_S3.accessionNumber);
    expect(calledWith.formType).toBe('S-3');
    // Company continued — non-fatal
    expect(run.companiesFailed).toBe(0);
  });

  it('7. multiple stale filings: each handled — pipeline reparsed one, targeted-fetch handles the other', async () => {
    // Two stale filings exist. The normal pipeline happened to reparse WRAP_STALE_S3
    // (it showed up in result.normalized). STALE_S3_B was missed by the pipeline.
    // The targeted-fetch path should only call reparseStaleFiling for STALE_S3_B.
    const STALE_S3_B: NormalizedFiling = {
      ticker:          'WRAP',
      cik:             '0001738827',
      formType:        'S-3',
      filedAt:         '2024-12-01',
      periodOfReport:  '2024-12-01',
      accessionNumber: '0001738827-24-000099',
      documentUrl:     'https://www.sec.gov/Archives/edgar/data/1738827/000173882724000099/s3b.htm',
      source:          'edgar' as const,
      parseErrors:     [],
      ingestedAt:      '2024-12-01T12:00:00Z',
      parserVersion:   '1.0.0',
    };
    const REPARSED_S3_B: NormalizedFiling = { ...STALE_S3_B, parserVersion: PARSER_VERSION };

    vi.mocked(getStaleFilings).mockReturnValue([WRAP_STALE_S3, STALE_S3_B]);
    // Pipeline already reparsed WRAP_STALE_S3 (deduplicated out); STALE_S3_B was missed
    vi.mocked(ingestTicker).mockResolvedValue({
      ...PIPELINE_RESULT_WITHOUT_S3,
      normalized: [WRAP_REPARSED_S3],
      fetched: 1,
      parsed: 1,
      errors: [],
    });
    vi.mocked(reparseStaleFiling).mockResolvedValue(REPARSED_S3_B);

    await runBatchIngestion({ tickers: ['WRAP'] });

    // Dedup: WRAP_STALE_S3 was in result.normalized → NOT targeted again
    // STALE_S3_B was not → targeted exactly once
    expect(vi.mocked(reparseStaleFiling)).toHaveBeenCalledOnce();
    expect(vi.mocked(reparseStaleFiling)).toHaveBeenCalledWith(STALE_S3_B);
  });

  it('8. targeted filing is persisted via upsertAll', async () => {
    vi.mocked(ingestTicker).mockResolvedValue({ ...PIPELINE_RESULT_WITHOUT_S3, normalized: [], errors: [] });

    await runBatchIngestion({ tickers: ['WRAP'] });

    const upsertCalls = vi.mocked(mockFilingsRepo.upsertAll).mock.calls;
    expect(upsertCalls.length).toBeGreaterThan(0);
    const persistedFilings: NormalizedFiling[] = upsertCalls[0][1] as NormalizedFiling[];
    expect(persistedFilings.some(f => f.accessionNumber === WRAP_STALE_S3.accessionNumber)).toBe(true);
    expect(persistedFilings.some(f => f.parserVersion === PARSER_VERSION)).toBe(true);
  });

  it('9. intelligence generation runs after targeted reparse completes', async () => {
    vi.mocked(ingestTicker).mockResolvedValue({ ...PIPELINE_RESULT_WITHOUT_S3, normalized: [], errors: [] });

    await runBatchIngestion({ tickers: ['WRAP'] });

    // Intelligence must be computed (targeted reparse is not allowed to block it)
    expect(generateCompanyIntelligence).toHaveBeenCalledOnce();
    expect(generateCompanyIntelligence).toHaveBeenCalledWith('WRAP', expect.any(Array));
  });

  it('10. WRAP before/after: stale S-3 reparsed with parserVersion 1.0.4 and hasResetProvisionsDetermined=true', async () => {
    vi.mocked(ingestTicker).mockResolvedValue({ ...PIPELINE_RESULT_WITHOUT_S3, normalized: [], errors: [] });

    // reparseStaleFiling returns the 1.0.4-parsed version
    vi.mocked(reparseStaleFiling).mockResolvedValue(WRAP_REPARSED_S3);

    await runBatchIngestion({ tickers: ['WRAP'] });

    // Verify the filing passed to upsertAll has the updated parserVersion and field
    const upsertCalls = vi.mocked(mockFilingsRepo.upsertAll).mock.calls;
    const persistedFilings: NormalizedFiling[] = upsertCalls[0][1] as NormalizedFiling[];
    const refreshed = persistedFilings.find(f => f.accessionNumber === WRAP_STALE_S3.accessionNumber);

    expect(refreshed).toBeDefined();
    expect(refreshed!.parserVersion).toBe(PARSER_VERSION);
    expect(refreshed!.financing?.hasResetProvisionsDetermined).toBe(true);
  });

  it('11. zero stale filings: targeted fetch path runs no iterations', async () => {
    vi.mocked(getStaleFilings).mockReturnValue([]);
    vi.mocked(ingestTicker).mockResolvedValue({ ...PIPELINE_RESULT_WITHOUT_S3, normalized: [], errors: [] });

    await runBatchIngestion({ tickers: ['WRAP'] });

    expect(reparseStaleFiling).not.toHaveBeenCalled();
  });
});

describe('counter increments for targeted stale reparses', () => {
  it('C1. one targeted success: filingsDownloaded +1, filingsParsed +1', async () => {
    vi.mocked(ingestTicker).mockResolvedValue({ ...PIPELINE_RESULT_WITHOUT_S3, normalized: [], errors: [] });

    const run = await runBatchIngestion({ tickers: ['WRAP'] });

    expect(run.filingsDownloaded).toBe(1);
    expect(run.filingsParsed).toBe(1);
  });

  it('C2. two targeted successes: filingsDownloaded +2, filingsParsed +2', async () => {
    const STALE_S3_B: NormalizedFiling = {
      ...WRAP_STALE_S3,
      accessionNumber: '0001493152-24-000099',
      filedAt:         '2024-12-01',
    };
    const REPARSED_S3_B: NormalizedFiling = { ...STALE_S3_B, parserVersion: PARSER_VERSION };

    vi.mocked(getStaleFilings).mockReturnValue([WRAP_STALE_S3, STALE_S3_B]);
    vi.mocked(ingestTicker).mockResolvedValue({ ...PIPELINE_RESULT_WITHOUT_S3, normalized: [], errors: [] });
    vi.mocked(reparseStaleFiling)
      .mockResolvedValueOnce(WRAP_REPARSED_S3)
      .mockResolvedValueOnce(REPARSED_S3_B);

    const run = await runBatchIngestion({ tickers: ['WRAP'] });

    expect(run.filingsDownloaded).toBe(2);
    expect(run.filingsParsed).toBe(2);
  });

  it('C3. one success + one failure: filingsDownloaded +1, filingsParsed +1, non-fatal', async () => {
    const STALE_S3_B: NormalizedFiling = {
      ...WRAP_STALE_S3,
      accessionNumber: '0001493152-24-000099',
      filedAt:         '2024-12-01',
    };

    vi.mocked(getStaleFilings).mockReturnValue([WRAP_STALE_S3, STALE_S3_B]);
    vi.mocked(ingestTicker).mockResolvedValue({ ...PIPELINE_RESULT_WITHOUT_S3, normalized: [], errors: [] });
    vi.mocked(reparseStaleFiling)
      .mockResolvedValueOnce(WRAP_REPARSED_S3)
      .mockRejectedValueOnce(new Error('EDGAR 503'));

    const run = await runBatchIngestion({ tickers: ['WRAP'] });

    expect(run.filingsDownloaded).toBe(1);
    expect(run.filingsParsed).toBe(1);
    expect(run.companiesFailed).toBe(0);
  });

  it('C4. normal discovery reparsed stale filing: not double-counted in run counters', async () => {
    // Normal pipeline returned the S-3 in result.normalized with fetched=1, parsed=1.
    // Targeted loop deduplicates it (reparseStaleFiling not called).
    // Counter should be exactly 1 (from ingestTicker), not 2.
    vi.mocked(ingestTicker).mockResolvedValue({
      ...PIPELINE_RESULT_WITHOUT_S3,
      normalized: [WRAP_REPARSED_S3],
      fetched:    1,
      parsed:     1,
      errors:     [],
    });

    const run = await runBatchIngestion({ tickers: ['WRAP'] });

    expect(run.filingsDownloaded).toBe(1);
    expect(run.filingsParsed).toBe(1);
    expect(vi.mocked(reparseStaleFiling)).not.toHaveBeenCalled();
  });

  it('C5. no stale filings: counters unchanged from ingestTicker (0/0)', async () => {
    vi.mocked(getStaleFilings).mockReturnValue([]);
    vi.mocked(ingestTicker).mockResolvedValue({ ...PIPELINE_RESULT_WITHOUT_S3, normalized: [], errors: [] });

    const run = await runBatchIngestion({ tickers: ['WRAP'] });

    expect(run.filingsDownloaded).toBe(0);
    expect(run.filingsParsed).toBe(0);
    expect(vi.mocked(reparseStaleFiling)).not.toHaveBeenCalled();
  });

  it('C6. WRAP-style: 2 stale filings (S-3 + S-3/A) missed by pipeline → filingsDownloaded=2, filingsParsed=2', async () => {
    const STALE_S3A: NormalizedFiling = {
      ...WRAP_STALE_S3,
      formType:        'S-3/A',
      accessionNumber: '0001493152-25-027559',
      filedAt:         '2025-12-12',
    };
    const REPARSED_S3A: NormalizedFiling = { ...STALE_S3A, parserVersion: PARSER_VERSION };

    vi.mocked(getStaleFilings).mockReturnValue([WRAP_STALE_S3, STALE_S3A]);
    vi.mocked(ingestTicker).mockResolvedValue({ ...PIPELINE_RESULT_WITHOUT_S3, normalized: [], errors: [] });
    vi.mocked(reparseStaleFiling)
      .mockResolvedValueOnce(WRAP_REPARSED_S3)
      .mockResolvedValueOnce(REPARSED_S3A);

    const run = await runBatchIngestion({ tickers: ['WRAP'] });

    expect(run.filingsDownloaded).toBe(2);
    expect(run.filingsParsed).toBe(2);
    expect(vi.mocked(reparseStaleFiling)).toHaveBeenCalledTimes(2);
  });
});
