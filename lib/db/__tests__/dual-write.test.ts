/**
 * Tests for the Postgres dual-write sync adapter (lib/db/postgresSync.ts)
 *
 * Uses makePostgresSync() to inject mock repositories — no real DB, no
 * environment variables required.
 *
 * Coverage:
 *   1. Company dual-write  — upsertCompany calls companiesRepo.upsert
 *   2. Filing dual-write   — upsertFilings calls filingsRepo.upsertAll
 *   3. Intelligence dual-write — upsertIntelligence calls intelligenceRepo.upsert
 *   4. Duplicate filing prevention — upsertAll is always idempotent (onConflict)
 *   5. Postgres failure handling — errors propagate; the sync layer never swallows
 */

import { describe, it, expect, vi } from 'vitest';
import { makePostgresSync } from '../postgresSync';
import type {
  ICompaniesRepository,
  IFilingsRepository,
  IIntelligenceRepository,
  IRunsRepository,
} from '../types';
import type { CompanyRecord } from '../../universe/types';
import type { NormalizedFiling, CompanyIntelligence } from '../../ingestion/types';
import { PARSER_VERSION } from '../../universe/types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeCompany(overrides: Partial<CompanyRecord> = {}): CompanyRecord {
  return {
    cik:                     '0001234567',
    ticker:                  'TEST',
    companyName:             'Test Corp',
    active:                  true,
    ingestionStatus:         'parsed',
    confidenceStatus:        'high_confidence',
    filingsParsed:           2,
    filingsDiscovered:       2,
    warningsCount:           0,
    rejectedCandidatesCount: 0,
    createdAt:               '2026-01-01T00:00:00Z',
    updatedAt:               '2026-07-01T00:00:00Z',
    ...overrides,
  };
}

function makeFiling(overrides: Partial<NormalizedFiling> = {}): NormalizedFiling {
  return {
    accessionNumber: '0001234567-26-000001',
    ticker:          'TEST',
    cik:             '0001234567',
    formType:        '8-K',
    filedAt:         '2026-07-01',
    periodOfReport:  '2026-06-30',
    documentUrl:     'https://www.sec.gov/Archives/edgar/data/1234567/filing.htm',
    ingestedAt:      '2026-07-01T00:00:00Z',
    source:          'edgar',
    parseErrors:     [],
    parserVersion:   PARSER_VERSION,
    ...overrides,
  };
}

function makeIntelligence(): CompanyIntelligence {
  return {
    ticker:          'TEST',
    generatedAt:     '2026-07-01T00:00:00Z',
    filingsAnalyzed: 2,
    overview: {
      dilutionRisk:              'low',
      latestSharesOutstanding:   50_000_000,
      latestAuthorizedShares:    200_000_000,
      summaryNarrative:          'No material dilutive instruments.',
      activeFinancingInstruments: [],
      shareStructureHistory:     [],
    },
    financingProfile: {
      totalConvertiblePrincipal:      0,
      toxicNoteCount:                 0,
      noFloorNoteCount:               0,
      hasActiveEloc:                  false,
      totalEquityFacilityCommitment:  0,
      totalWarrantShares:             0,
      instruments:                    [],
    },
    riskScores: {
      financingRisk: { score: 'Insufficient Data', factors: [] },
    },
    filings: [],
  } as unknown as CompanyIntelligence;
}

// ─── Mock repo builders ───────────────────────────────────────────────────────

function makeMockCompaniesRepo(overrides: Partial<ICompaniesRepository> = {}): ICompaniesRepository {
  return {
    upsert:       vi.fn().mockResolvedValue(undefined),
    upsertAll:    vi.fn().mockResolvedValue(undefined),
    getAll:       vi.fn().mockResolvedValue([]),
    getByCik:     vi.fn().mockResolvedValue(undefined),
    getByTicker:  vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    count:        vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

function makeMockFilingsRepo(overrides: Partial<IFilingsRepository> = {}): IFilingsRepository {
  return {
    upsertAll:       vi.fn().mockResolvedValue(undefined),
    getByTicker:     vi.fn().mockResolvedValue([]),
    hasAccession:    vi.fn().mockResolvedValue(false),
    knownAccessions: vi.fn().mockResolvedValue(new Set<string>()),
    getAllTickers:   vi.fn().mockResolvedValue([]),
    totalCount:      vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

function makeMockIntelligenceRepo(overrides: Partial<IIntelligenceRepository> = {}): IIntelligenceRepository {
  return {
    upsert:       vi.fn().mockResolvedValue(undefined),
    getByTicker:  vi.fn().mockResolvedValue(undefined),
    getAllTickers: vi.fn().mockResolvedValue([]),
    ...overrides,
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

describe('makePostgresSync', () => {

  // 1. Company dual-write
  it('upsertCompany delegates to companiesRepo.upsert with the same record', async () => {
    const companiesRepo    = makeMockCompaniesRepo();
    const filingsRepo      = makeMockFilingsRepo();
    const intelligenceRepo = makeMockIntelligenceRepo();
    const runsRepo         = makeMockRunsRepo();
    const sync = makePostgresSync(companiesRepo, filingsRepo, intelligenceRepo, runsRepo);

    const company = makeCompany();
    await sync.upsertCompany(company);

    expect(companiesRepo.upsert).toHaveBeenCalledOnce();
    expect(companiesRepo.upsert).toHaveBeenCalledWith(company);
    expect(filingsRepo.upsertAll).not.toHaveBeenCalled();
    expect(intelligenceRepo.upsert).not.toHaveBeenCalled();
    expect(runsRepo.upsert).not.toHaveBeenCalled();
  });

  // 2. Filing dual-write
  it('upsertFilings calls filingsRepo.upsertAll with the correct ticker and filings', async () => {
    const companiesRepo    = makeMockCompaniesRepo();
    const filingsRepo      = makeMockFilingsRepo();
    const intelligenceRepo = makeMockIntelligenceRepo();
    const runsRepo         = makeMockRunsRepo();
    const sync = makePostgresSync(companiesRepo, filingsRepo, intelligenceRepo, runsRepo);

    const filings = [makeFiling(), makeFiling({ accessionNumber: '0001234567-26-000002' })];
    await sync.upsertFilings('TEST', filings);

    expect(filingsRepo.upsertAll).toHaveBeenCalledOnce();
    expect(filingsRepo.upsertAll).toHaveBeenCalledWith('TEST', filings);
    expect(companiesRepo.upsert).not.toHaveBeenCalled();
    expect(intelligenceRepo.upsert).not.toHaveBeenCalled();
    expect(runsRepo.upsert).not.toHaveBeenCalled();
  });

  // 3. Intelligence dual-write
  it('upsertIntelligence calls intelligenceRepo.upsert with the correct record', async () => {
    const companiesRepo    = makeMockCompaniesRepo();
    const filingsRepo      = makeMockFilingsRepo();
    const intelligenceRepo = makeMockIntelligenceRepo();
    const runsRepo         = makeMockRunsRepo();
    const sync = makePostgresSync(companiesRepo, filingsRepo, intelligenceRepo, runsRepo);

    const intel = makeIntelligence();
    await sync.upsertIntelligence(intel);

    expect(intelligenceRepo.upsert).toHaveBeenCalledOnce();
    expect(intelligenceRepo.upsert).toHaveBeenCalledWith(intel);
    expect(companiesRepo.upsert).not.toHaveBeenCalled();
    expect(filingsRepo.upsertAll).not.toHaveBeenCalled();
    expect(runsRepo.upsert).not.toHaveBeenCalled();
  });

  // 4. Duplicate filing prevention
  it('upsertFilings with an empty array does not call the repo (no-op)', async () => {
    const filingsRepo = makeMockFilingsRepo();
    const sync = makePostgresSync(
      makeMockCompaniesRepo(), filingsRepo, makeMockIntelligenceRepo(), makeMockRunsRepo(),
    );

    await sync.upsertFilings('TEST', []);

    expect(filingsRepo.upsertAll).not.toHaveBeenCalled();
  });

  it('upsertFilings called twice with the same accession numbers calls upsertAll twice (idempotency is in the DB)', async () => {
    const filingsRepo = makeMockFilingsRepo();
    const sync = makePostgresSync(
      makeMockCompaniesRepo(), filingsRepo, makeMockIntelligenceRepo(), makeMockRunsRepo(),
    );

    const filings = [makeFiling()];
    await sync.upsertFilings('TEST', filings);
    await sync.upsertFilings('TEST', filings);

    expect(filingsRepo.upsertAll).toHaveBeenCalledTimes(2);
  });

  // 5. Postgres failure handling
  it('propagates errors from companiesRepo.upsert without swallowing them', async () => {
    const companiesRepo = makeMockCompaniesRepo({
      upsert: vi.fn().mockRejectedValue(new Error('connection timeout')),
    });
    const sync = makePostgresSync(
      companiesRepo, makeMockFilingsRepo(), makeMockIntelligenceRepo(), makeMockRunsRepo(),
    );

    await expect(sync.upsertCompany(makeCompany())).rejects.toThrow('connection timeout');
  });

  it('propagates errors from filingsRepo.upsertAll without swallowing them', async () => {
    const filingsRepo = makeMockFilingsRepo({
      upsertAll: vi.fn().mockRejectedValue(new Error('constraint violation')),
    });
    const sync = makePostgresSync(
      makeMockCompaniesRepo(), filingsRepo, makeMockIntelligenceRepo(), makeMockRunsRepo(),
    );

    await expect(sync.upsertFilings('TEST', [makeFiling()])).rejects.toThrow('constraint violation');
  });

  it('propagates errors from intelligenceRepo.upsert without swallowing them', async () => {
    const intelligenceRepo = makeMockIntelligenceRepo({
      upsert: vi.fn().mockRejectedValue(new Error('company with ticker TEST not found')),
    });
    const sync = makePostgresSync(
      makeMockCompaniesRepo(), makeMockFilingsRepo(), intelligenceRepo, makeMockRunsRepo(),
    );

    await expect(sync.upsertIntelligence(makeIntelligence())).rejects.toThrow(
      'company with ticker TEST not found',
    );
  });

});
