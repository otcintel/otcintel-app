import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CompanyRecord } from '../universe/types';
import type { NormalizedFiling } from '../ingestion/types';
import { PARSER_VERSION } from '../universe/types';

// ── Module mocks ──────────────────────────────────────────────────────────────
// server-only throws outside Next.js — mock it to a no-op
vi.mock('server-only', () => ({}));

// Mock the repository layer so tests do not touch the real data/ directory
const mockGetAll       = vi.fn(async () => [] as CompanyRecord[]);
const mockGetByTicker  = vi.fn(async (_t: string) => undefined as CompanyRecord | undefined);
const mockFilingsByTick = vi.fn(async (_t: string) => [] as NormalizedFiling[]);

vi.mock('../db/repositories', () => ({
  getCompaniesRepo: async () => ({
    getAll:      () => mockGetAll(),
    getByTicker: (t: string) => mockGetByTicker(t),
  }),
  getFilingsRepo: async () => ({
    getByTicker: (t: string) => mockFilingsByTick(t),
  }),
}));

// Import AFTER mocks are registered
const { getCompanies, getCompanyRecord, getCompanyFilings, getDashboardStats } =
  await import('../server-data');

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<CompanyRecord> = {}): CompanyRecord {
  return {
    cik:                     '0001234567',
    ticker:                  'TEST',
    companyName:             'Test Corp',
    active:                  true,
    ingestionStatus:         'parsed',
    confidenceStatus:        'high_confidence',
    filingsParsed:           5,
    filingsDiscovered:       5,
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
    formType:        '10-K',
    filedAt:         '2026-01-15',
    periodOfReport:  '2025-12-31',
    documentUrl:     'https://www.sec.gov/Archives/edgar/data/1234567/filing.htm',
    ingestedAt:      '2026-07-01T00:00:00Z',
    source:          'edgar',
    parseErrors:     [],
    parserVersion:   PARSER_VERSION,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAll.mockResolvedValue([]);
  mockGetByTicker.mockResolvedValue(undefined);
  mockFilingsByTick.mockResolvedValue([]);
});

// ── getCompanies ──────────────────────────────────────────────────────────────

describe('getCompanies', () => {
  it('returns an empty array when the DB has no companies', async () => {
    const result = await getCompanies();
    expect(result).toEqual([]);
  });

  it('maps CompanyRecord to CompanyRow correctly', async () => {
    const rec = makeRecord({ ticker: 'AITX', companyName: 'AITX Corp', cik: '0001745839', filingsParsed: 20, latestFilingDate: '2026-07-17' });
    mockGetAll.mockResolvedValue([rec]);

    const [row] = await getCompanies();
    expect(row.ticker).toBe('AITX');
    expect(row.companyName).toBe('AITX Corp');
    expect(row.cik).toBe('0001745839');
    expect(row.filingsParsed).toBe(20);
    expect(row.latestFilingDate).toBe('2026-07-17');
    expect(row.confidenceStatus).toBe('high_confidence');
  });

  it('does not fabricate latestFilingDate when it is missing from the record', async () => {
    const rec = makeRecord({ latestFilingDate: undefined });
    mockGetAll.mockResolvedValue([rec]);

    const [row] = await getCompanies();
    expect(row.latestFilingDate).toBeUndefined();
  });

  it('does not fabricate confidenceStatus when it is missing from the record', async () => {
    const rec = makeRecord({ confidenceStatus: undefined });
    mockGetAll.mockResolvedValue([rec]);

    const [row] = await getCompanies();
    expect(row.confidenceStatus).toBeUndefined();
  });

  it('returns all companies from the DB', async () => {
    const records = [
      makeRecord({ ticker: 'AAA' }),
      makeRecord({ ticker: 'BBB' }),
      makeRecord({ ticker: 'CCC' }),
    ];
    mockGetAll.mockResolvedValue(records);

    expect(await getCompanies()).toHaveLength(3);
  });
});

// ── getCompanyRecord ──────────────────────────────────────────────────────────

describe('getCompanyRecord', () => {
  it('returns undefined for an unknown ticker', async () => {
    mockGetByTicker.mockResolvedValue(undefined);
    expect(await getCompanyRecord('UNKNOWN')).toBeUndefined();
  });

  it('delegates case-insensitive lookup to the repository', async () => {
    const rec = makeRecord({ ticker: 'AITX' });
    mockGetByTicker.mockResolvedValue(rec);

    const result = await getCompanyRecord('aitx');
    expect(result).toBe(rec);
    expect(mockGetByTicker).toHaveBeenCalledWith('aitx');
  });

  it('returns the full CompanyRecord unchanged', async () => {
    const rec = makeRecord({ ticker: 'AITX', companyName: 'Artificial Intelligence Technology Solutions Inc.' });
    mockGetByTicker.mockResolvedValue(rec);

    expect(await getCompanyRecord('AITX')).toBe(rec);
  });
});

// ── getCompanyFilings ─────────────────────────────────────────────────────────

describe('getCompanyFilings', () => {
  it('returns an empty array when no filings exist for the ticker', async () => {
    expect(await getCompanyFilings('NONE')).toEqual([]);
  });

  it('returns filings from the repository for a known ticker', async () => {
    const f1 = makeFiling({ formType: '10-K', filedAt: '2026-01-15' });
    const f2 = makeFiling({ formType: '8-K',  filedAt: '2026-03-01', accessionNumber: '0001234567-26-000002' });
    mockFilingsByTick.mockResolvedValue([f2, f1]);

    const result = await getCompanyFilings('TEST');
    expect(result).toHaveLength(2);
    expect(result[0].formType).toBe('8-K');
  });

  it('does not fabricate financing or shareStructure fields when absent', async () => {
    const f = makeFiling({ financing: undefined, shareStructure: undefined });
    mockFilingsByTick.mockResolvedValue([f]);

    const [result] = await getCompanyFilings('TEST');
    expect(result.financing).toBeUndefined();
    expect(result.shareStructure).toBeUndefined();
  });

  it('preserves source provenance fields on each filing', async () => {
    const f = makeFiling({
      source: 'edgar',
      documentUrl: 'https://www.sec.gov/Archives/edgar/data/1234567/filing.htm',
      accessionNumber: '0001234567-26-000001',
    });
    mockFilingsByTick.mockResolvedValue([f]);

    const [result] = await getCompanyFilings('TEST');
    expect(result.source).toBe('edgar');
    expect(result.documentUrl).toContain('sec.gov');
    expect(result.accessionNumber).toBe('0001234567-26-000001');
  });
});

// ── getDashboardStats ─────────────────────────────────────────────────────────

describe('getDashboardStats', () => {
  it('returns zero counts when no companies are ingested', async () => {
    const stats = await getDashboardStats();
    expect(stats.companiesTracked).toBe(0);
    expect(stats.totalFilingsParsed).toBe(0);
    expect(stats.companiesWithIntelligence).toBe(0);
    expect(stats.companiesInsufficient).toBe(0);
    expect(stats.companiesNeedingReview).toBe(0);
    expect(stats.recentFilings).toEqual([]);
    expect(stats.lastUpdated).toBeUndefined();
  });

  it('counts tracked companies correctly', async () => {
    mockGetAll.mockResolvedValue([
      makeRecord({ ticker: 'A1' }),
      makeRecord({ ticker: 'A2' }),
      makeRecord({ ticker: 'A3' }),
    ]);
    expect((await getDashboardStats()).companiesTracked).toBe(3);
  });

  it('aggregates totalFilingsParsed from all company records', async () => {
    mockGetAll.mockResolvedValue([
      makeRecord({ ticker: 'A1', filingsParsed: 10 }),
      makeRecord({ ticker: 'A2', filingsParsed: 5 }),
      makeRecord({ ticker: 'A3', filingsParsed: 3 }),
    ]);
    expect((await getDashboardStats()).totalFilingsParsed).toBe(18);
  });

  it('counts companiesWithIntelligence excluding insufficient_data', async () => {
    mockGetAll.mockResolvedValue([
      makeRecord({ ticker: 'A1', confidenceStatus: 'high_confidence' }),
      makeRecord({ ticker: 'A2', confidenceStatus: 'usable_with_warnings' }),
      makeRecord({ ticker: 'A3', confidenceStatus: 'needs_review' }),
      makeRecord({ ticker: 'A4', confidenceStatus: 'insufficient_data' }),
      makeRecord({ ticker: 'A5', confidenceStatus: undefined }),
    ]);
    expect((await getDashboardStats()).companiesWithIntelligence).toBe(3);
  });

  it('counts companiesInsufficient correctly', async () => {
    mockGetAll.mockResolvedValue([
      makeRecord({ ticker: 'A1', confidenceStatus: 'high_confidence' }),
      makeRecord({ ticker: 'A2', confidenceStatus: 'insufficient_data' }),
      makeRecord({ ticker: 'A3', confidenceStatus: 'insufficient_data' }),
    ]);
    expect((await getDashboardStats()).companiesInsufficient).toBe(2);
  });

  it('counts companiesNeedingReview correctly', async () => {
    mockGetAll.mockResolvedValue([
      makeRecord({ ticker: 'A1', confidenceStatus: 'needs_review' }),
      makeRecord({ ticker: 'A2', confidenceStatus: 'high_confidence' }),
    ]);
    expect((await getDashboardStats()).companiesNeedingReview).toBe(1);
  });

  it('includes lastUpdated from the most recently updated company', async () => {
    mockGetAll.mockResolvedValue([
      makeRecord({ ticker: 'A1', updatedAt: '2026-07-01T00:00:00Z' }),
      makeRecord({ ticker: 'A2', updatedAt: '2026-08-01T00:00:00Z' }),
      makeRecord({ ticker: 'A3', updatedAt: '2026-06-01T00:00:00Z' }),
    ]);
    expect((await getDashboardStats()).lastUpdated).toBe('2026-08-01T00:00:00Z');
  });

  it('builds recentFilings from the latest filing per company', async () => {
    const companies = [
      makeRecord({ ticker: 'A1', companyName: 'Alpha Corp' }),
      makeRecord({ ticker: 'A2', companyName: 'Beta Corp' }),
    ];
    mockGetAll.mockResolvedValue(companies);
    mockFilingsByTick.mockImplementation(async (ticker) => {
      if (ticker === 'A1') return [makeFiling({ ticker: 'A1', formType: '10-K', filedAt: '2026-07-01', accessionNumber: 'A1-001' })];
      if (ticker === 'A2') return [makeFiling({ ticker: 'A2', formType: '8-K',  filedAt: '2026-07-15', accessionNumber: 'A2-001' })];
      return [];
    });

    const { recentFilings } = await getDashboardStats();
    expect(recentFilings).toHaveLength(2);
    // Sorted newest-first
    expect(recentFilings[0].ticker).toBe('A2');
    expect(recentFilings[0].formType).toBe('8-K');
    expect(recentFilings[1].ticker).toBe('A1');
  });

  it('limits recentFilings to 10 entries', async () => {
    const companies = Array.from({ length: 15 }, (_, i) =>
      makeRecord({ ticker: `T${i}` }),
    );
    mockGetAll.mockResolvedValue(companies);
    mockFilingsByTick.mockImplementation(async (ticker) => [
      makeFiling({ ticker, accessionNumber: `${ticker}-001`, filedAt: '2026-01-01' }),
    ]);

    const { recentFilings } = await getDashboardStats();
    expect(recentFilings.length).toBeLessThanOrEqual(10);
  });

  it('does not include a company in recentFilings if it has no filings', async () => {
    mockGetAll.mockResolvedValue([
      makeRecord({ ticker: 'A1' }),
      makeRecord({ ticker: 'A2' }),
    ]);
    mockFilingsByTick.mockImplementation(async (ticker) =>
      ticker === 'A1'
        ? [makeFiling({ ticker: 'A1', accessionNumber: 'A1-001' })]
        : [],
    );

    const { recentFilings } = await getDashboardStats();
    expect(recentFilings).toHaveLength(1);
    expect(recentFilings[0].ticker).toBe('A1');
  });
});
