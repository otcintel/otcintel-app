/**
 * OTCIntel — Postgres financial snapshots repository tests
 *
 * Tests repository behavior using a mocked Supabase client.
 * Does NOT require a live database.
 *
 * Coverage:
 *   1. insert snapshot
 *   2. idempotent upsert (same accession_number → update, not duplicate)
 *   3. amendment stored as distinct row (different accession_number)
 *   4. latest snapshot selection (getLatestByCompany)
 *   5. historical ordering (getByCompany newest-first)
 *   6. null/missing values preserved in raw_payload round-trip
 *   7. raw_payload provenance preserved
 *   8. goingConcernSentence preserved
 *   9. cashRunwayMonths round-trip
 *  10. getByAccession lookup
 *  11. throws when company not found
 *  12. no accession_number → insert (not upsert)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FinancialSnapshot } from '../../ingestion/parsers/financials/snapshot';

// ─── Mock Supabase client ─────────────────────────────────────────────────────

vi.mock('../postgres/client', () => ({
  getClient: vi.fn(),
  assertNoError: vi.fn((error: { message: string } | null, ctx: string) => {
    if (error) throw new Error(`[mock] ${ctx}: ${error.message}`);
  }),
  resetClient: vi.fn(),
}));

// Import after mocks
import { postgresFinancialSnapshotsDb } from '../postgres/financialSnapshots';
import { getClient } from '../postgres/client';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeSnapshot(overrides: Partial<FinancialSnapshot> = {}): FinancialSnapshot {
  return {
    ticker:                  'ABVC',
    cik:                     '0001655050',
    accessionNumber:         '0001655050-26-010001',
    formType:                '10-K',
    fiscalPeriod:            'FY',
    fiscalYear:              2025,
    periodEndDate:           '2025-12-31',
    filedAt:                 '2026-01-15',
    cashAndEquivalents:      1_500_000,
    currentLiabilities:      800_000,
    accumulatedDeficit:      -12_000_000,
    totalDebt:               5_000_000,
    totalDebtComponents:     ['ConvertibleNote', 'TermLoan'],
    operatingCashFlow:       -2_400_000,
    operatingCashFlowMonths: 12,
    monthlyBurnRate:         200_000,
    cashRunwayMonths:        7.5,
    goingConcernFlag:        true,
    goingConcernSentence:    'The company raises substantial doubt about its ability to continue as a going concern.',
    xbrlAvailable:           true,
    missingConcepts:         [],
    extractedAt:             '2026-01-20T00:00:00.000Z',
    dataSource:              'xbrl+text',
    ...overrides,
  };
}

function makeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const snap = makeSnapshot();
  return {
    id:                          'uuid-snap-001',
    company_id:                  'uuid-company-001',
    ticker:                      snap.ticker,
    cik:                         snap.cik,
    accession_number:            snap.accessionNumber,
    form_type:                   snap.formType,
    fiscal_period:               snap.fiscalPeriod,
    fiscal_year:                 snap.fiscalYear,
    period_end_date:             snap.periodEndDate,
    filed_at:                    snap.filedAt,
    cash_and_equivalents:        snap.cashAndEquivalents,
    current_liabilities:         snap.currentLiabilities,
    accumulated_deficit:         snap.accumulatedDeficit,
    total_debt:                  snap.totalDebt,
    total_debt_components:       snap.totalDebtComponents,
    operating_cash_flow:         snap.operatingCashFlow,
    operating_cash_flow_months:  snap.operatingCashFlowMonths,
    monthly_burn_rate:           snap.monthlyBurnRate,
    cash_runway_months:          snap.cashRunwayMonths,
    going_concern_flag:          snap.goingConcernFlag,
    going_concern_sentence:      snap.goingConcernSentence,
    xbrl_available:              snap.xbrlAvailable,
    missing_concepts:            snap.missingConcepts,
    data_source:                 snap.dataSource,
    extracted_at:                snap.extractedAt,
    raw_payload:                 snap,
    created_at:                  '2026-01-20T00:00:00.000Z',
    updated_at:                  '2026-01-20T00:00:00.000Z',
    ...overrides,
  };
}

// ─── Mock builder ─────────────────────────────────────────────────────────────

type QueryResult = { data: unknown; error: null | { message: string }; count?: number };

function buildMockClient(opts: {
  companyRow?: Record<string, unknown> | null;
  snapshotRow?: Record<string, unknown> | null;
  snapshotRows?: Record<string, unknown>[];
  upsertError?: { message: string } | null;
  insertError?: { message: string } | null;
  captureUpsert?: (row: Record<string, unknown>) => void;
  captureInsert?: (row: Record<string, unknown>) => void;
}) {
  const companyResult: QueryResult = {
    data: opts.companyRow !== undefined ? opts.companyRow : { id: 'uuid-company-001' },
    error: null,
  };

  const capturedUpsertRows: Array<Record<string, unknown>> = [];
  const capturedInsertRows: Array<Record<string, unknown>> = [];

  const mockClient = {
    from: vi.fn((table: string) => {
      if (table === 'companies') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue(companyResult),
            }),
          }),
        };
      }

      // financial_snapshots table
      const snapshotResult: QueryResult = {
        data: opts.snapshotRow !== undefined ? opts.snapshotRow : makeRow(),
        error: null,
      };
      const snapshotListResult: QueryResult = {
        data: opts.snapshotRows ?? [makeRow()],
        error: null,
      };

      // getByCompany:       .select().eq().order()         → awaitable list
      // getLatestByCompany: .select().eq().order().order().limit().maybeSingle()
      const innerOrderChain = {
        limit: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue(snapshotResult),
        }),
      };
      const firstOrderResult = Object.assign(
        Promise.resolve(snapshotListResult),
        { order: vi.fn().mockReturnValue(innerOrderChain) },
      );

      return {
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue(firstOrderResult),
            maybeSingle: vi.fn().mockResolvedValue(snapshotResult),
          }),
        }),
        upsert: vi.fn((row: Record<string, unknown>) => {
          capturedUpsertRows.push(row);
          if (opts.captureUpsert) opts.captureUpsert(row);
          return Promise.resolve({ data: null, error: opts.upsertError ?? null });
        }),
        insert: vi.fn((row: Record<string, unknown>) => {
          capturedInsertRows.push(row);
          if (opts.captureInsert) opts.captureInsert(row);
          return Promise.resolve({ data: null, error: opts.insertError ?? null });
        }),
      };
    }),
    _capturedUpsertRows: capturedUpsertRows,
    _capturedInsertRows: capturedInsertRows,
  };

  vi.mocked(getClient).mockReturnValue(mockClient as unknown as ReturnType<typeof getClient>);
  return mockClient;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('postgresFinancialSnapshotsDb — insert snapshot (test 1)', () => {

  it('calls upsert when accession_number is set', async () => {
    const client = buildMockClient({});
    const snap = makeSnapshot();

    await postgresFinancialSnapshotsDb.upsert(snap);

    const fromCalls = vi.mocked(client.from).mock.calls.map(c => c[0]);
    expect(fromCalls).toContain('financial_snapshots');
  });

  it('passes ticker, cik, and form_type to the row', async () => {
    let captured: Record<string, unknown> = {};
    buildMockClient({ captureUpsert: row => { captured = row; } });

    await postgresFinancialSnapshotsDb.upsert(makeSnapshot());

    expect(captured.ticker).toBe('ABVC');
    expect(captured.cik).toBe('0001655050');
    expect(captured.form_type).toBe('10-K');
  });

});

describe('postgresFinancialSnapshotsDb — idempotent upsert (test 2)', () => {

  it('passes onConflict: company_id,accession_number for conflict resolution', async () => {
    let capturedConflict: string | undefined;
    const mockFrom = vi.fn((table: string) => {
      if (table === 'companies') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'uuid-company-001' }, error: null }),
            }),
          }),
        };
      }
      return {
        upsert: vi.fn((_row: unknown, opts: { onConflict?: string }) => {
          capturedConflict = opts?.onConflict;
          return Promise.resolve({ data: null, error: null });
        }),
      };
    });
    vi.mocked(getClient).mockReturnValue({ from: mockFrom } as unknown as ReturnType<typeof getClient>);

    await postgresFinancialSnapshotsDb.upsert(makeSnapshot());

    expect(capturedConflict).toBe('company_id,accession_number');
  });

});

describe('postgresFinancialSnapshotsDb — amendment stored distinctly (test 3)', () => {

  it('stores amendment under its own accession_number (different from original)', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const mockFrom = vi.fn((table: string) => {
      if (table === 'companies') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'uuid-company-001' }, error: null }),
            }),
          }),
        };
      }
      return {
        upsert: vi.fn((row: Record<string, unknown>) => {
          rows.push(row);
          return Promise.resolve({ data: null, error: null });
        }),
      };
    });
    vi.mocked(getClient).mockReturnValue({ from: mockFrom } as unknown as ReturnType<typeof getClient>);

    const original  = makeSnapshot({ accessionNumber: '0001655050-26-010001', formType: '10-K' });
    const amendment = makeSnapshot({ accessionNumber: '0001655050-26-020001', formType: '10-K/A' });

    await postgresFinancialSnapshotsDb.upsert(original);
    await postgresFinancialSnapshotsDb.upsert(amendment);

    expect(rows).toHaveLength(2);
    expect(rows[0].accession_number).toBe('0001655050-26-010001');
    expect(rows[1].accession_number).toBe('0001655050-26-020001');
  });

});

describe('postgresFinancialSnapshotsDb — getLatestByCompany (test 4)', () => {

  it('returns the snapshot reconstructed from raw_payload', async () => {
    const snap = makeSnapshot();
    buildMockClient({ snapshotRow: makeRow({ raw_payload: snap }) });

    const result = await postgresFinancialSnapshotsDb.getLatestByCompany('ABVC');

    expect(result).toEqual(snap);
  });

  it('returns undefined when no snapshot exists', async () => {
    buildMockClient({ snapshotRow: null });

    const result = await postgresFinancialSnapshotsDb.getLatestByCompany('UNKNOWN');

    expect(result).toBeUndefined();
  });

});

describe('postgresFinancialSnapshotsDb — historical ordering (test 5)', () => {

  it('getByCompany returns all snapshots as FinancialSnapshot objects', async () => {
    const snap1 = makeSnapshot({ filedAt: '2026-01-15', accessionNumber: '0001655050-26-010001' });
    const snap2 = makeSnapshot({ filedAt: '2025-07-01', accessionNumber: '0001655050-25-010001' });
    buildMockClient({ snapshotRows: [makeRow({ raw_payload: snap1 }), makeRow({ raw_payload: snap2 })] });

    const results = await postgresFinancialSnapshotsDb.getByCompany('ABVC');

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual(snap1);
    expect(results[1]).toEqual(snap2);
  });

});

describe('postgresFinancialSnapshotsDb — null/missing values preserved (test 6)', () => {

  it('stores snapshot with all optional fields undefined without error', async () => {
    let captured: Record<string, unknown> = {};
    buildMockClient({ captureUpsert: row => { captured = row; } });

    const minimalSnap = makeSnapshot({
      cashAndEquivalents:      undefined,
      currentLiabilities:      undefined,
      accumulatedDeficit:      undefined,
      totalDebt:               undefined,
      operatingCashFlow:       undefined,
      operatingCashFlowMonths: undefined,
      monthlyBurnRate:         undefined,
      cashRunwayMonths:        undefined,
      fiscalPeriod:            undefined,
      fiscalYear:              undefined,
      periodEndDate:           undefined,
      filedAt:                 undefined,
    });

    await postgresFinancialSnapshotsDb.upsert(minimalSnap);

    expect(captured.cash_and_equivalents).toBeNull();
    expect(captured.current_liabilities).toBeNull();
    expect(captured.accumulated_deficit).toBeNull();
    expect(captured.total_debt).toBeNull();
    expect(captured.operating_cash_flow).toBeNull();
    expect(captured.fiscal_period).toBeNull();
    expect(captured.period_end_date).toBeNull();
    expect(captured.filed_at).toBeNull();
  });

  it('round-trips snapshot with undefined fields via raw_payload', async () => {
    const minimalSnap = makeSnapshot({
      cashAndEquivalents: undefined,
      cashRunwayMonths:   undefined,
      goingConcernSentence: undefined,
    });
    buildMockClient({ snapshotRow: makeRow({ raw_payload: minimalSnap }) });

    const result = await postgresFinancialSnapshotsDb.getLatestByCompany('ABVC');

    expect(result?.cashAndEquivalents).toBeUndefined();
    expect(result?.cashRunwayMonths).toBeUndefined();
    expect(result?.goingConcernSentence).toBeUndefined();
  });

});

describe('postgresFinancialSnapshotsDb — raw_payload provenance preserved (test 7)', () => {

  it('stores the full FinancialSnapshot object in raw_payload', async () => {
    let captured: Record<string, unknown> = {};
    buildMockClient({ captureUpsert: row => { captured = row; } });

    const snap = makeSnapshot();
    await postgresFinancialSnapshotsDb.upsert(snap);

    expect(captured.raw_payload).toEqual(snap);
  });

  it('raw_payload round-trip returns the original FinancialSnapshot', async () => {
    const snap = makeSnapshot({ missingConcepts: ['Cash', 'CurrentLiabilities'] });
    buildMockClient({ snapshotRow: makeRow({ raw_payload: snap }) });

    const result = await postgresFinancialSnapshotsDb.getLatestByCompany('ABVC');

    expect(result?.missingConcepts).toEqual(['Cash', 'CurrentLiabilities']);
  });

});

describe('postgresFinancialSnapshotsDb — goingConcernSentence preserved (test 8)', () => {

  it('stores goingConcernSentence verbatim', async () => {
    let captured: Record<string, unknown> = {};
    buildMockClient({ captureUpsert: row => { captured = row; } });

    const sentence = 'The company raises substantial doubt about its ability to continue as a going concern.';
    await postgresFinancialSnapshotsDb.upsert(makeSnapshot({ goingConcernSentence: sentence }));

    expect(captured.going_concern_sentence).toBe(sentence);
  });

  it('round-trips goingConcernSentence via raw_payload', async () => {
    const sentence = 'These conditions raise substantial doubt about the going concern.';
    const snap = makeSnapshot({ goingConcernSentence: sentence });
    buildMockClient({ snapshotRow: makeRow({ raw_payload: snap }) });

    const result = await postgresFinancialSnapshotsDb.getLatestByCompany('ABVC');

    expect(result?.goingConcernSentence).toBe(sentence);
  });

});

describe('postgresFinancialSnapshotsDb — cashRunwayMonths round-trip (test 9)', () => {

  it('stores cashRunwayMonths as a numeric value', async () => {
    let captured: Record<string, unknown> = {};
    buildMockClient({ captureUpsert: row => { captured = row; } });

    await postgresFinancialSnapshotsDb.upsert(makeSnapshot({ cashRunwayMonths: 7.5 }));

    expect(captured.cash_runway_months).toBe(7.5);
  });

  it('round-trips cashRunwayMonths exactly via raw_payload', async () => {
    const snap = makeSnapshot({ cashRunwayMonths: 14.25 });
    buildMockClient({ snapshotRow: makeRow({ raw_payload: snap }) });

    const result = await postgresFinancialSnapshotsDb.getLatestByCompany('ABVC');

    expect(result?.cashRunwayMonths).toBe(14.25);
  });

});

describe('postgresFinancialSnapshotsDb — getByAccession (test 10)', () => {

  it('returns snapshot matching the accession number from raw_payload', async () => {
    const snap = makeSnapshot({ accessionNumber: '0001655050-26-010001' });
    buildMockClient({ snapshotRow: makeRow({ raw_payload: snap }) });

    const result = await postgresFinancialSnapshotsDb.getByAccession('0001655050-26-010001');

    expect(result?.accessionNumber).toBe('0001655050-26-010001');
  });

  it('returns undefined when accession not found', async () => {
    buildMockClient({ snapshotRow: null });

    const result = await postgresFinancialSnapshotsDb.getByAccession('0000000000-00-000000');

    expect(result).toBeUndefined();
  });

});

describe('postgresFinancialSnapshotsDb — company not found (test 11)', () => {

  it('throws when ticker has no matching company record', async () => {
    buildMockClient({ companyRow: null });

    await expect(postgresFinancialSnapshotsDb.upsert(makeSnapshot())).rejects.toThrow(
      /company ABVC not found/i,
    );
  });

});

describe('postgresFinancialSnapshotsDb — no accession_number uses insert (test 12)', () => {

  it('calls insert (not upsert) when accession_number is undefined', async () => {
    let insertCalled = false;
    let upsertCalled = false;

    const mockFrom = vi.fn((table: string) => {
      if (table === 'companies') {
        return {
          select: vi.fn().mockReturnValue({
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'uuid-company-001' }, error: null }),
            }),
          }),
        };
      }
      return {
        upsert: vi.fn(() => { upsertCalled = true; return Promise.resolve({ data: null, error: null }); }),
        insert: vi.fn(() => { insertCalled = true; return Promise.resolve({ data: null, error: null }); }),
      };
    });
    vi.mocked(getClient).mockReturnValue({ from: mockFrom } as unknown as ReturnType<typeof getClient>);

    await postgresFinancialSnapshotsDb.upsert(makeSnapshot({ accessionNumber: undefined }));

    expect(insertCalled).toBe(true);
    expect(upsertCalled).toBe(false);
  });

});
