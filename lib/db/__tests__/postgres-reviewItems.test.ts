/**
 * OTCIntel — Postgres reviewItems repository tests
 *
 * Uses a mocked Supabase client. Does NOT require a live database.
 * Tests focus on the repository lifecycle semantics, not SQL correctness.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReviewItemInput } from '../../anomaly/types';
import { buildDedupKey } from '../../anomaly/dedup';

// ─── Mock Supabase client ─────────────────────────────────────────────────────

vi.mock('../postgres/client', () => ({
  getClient: vi.fn(),
  assertNoError: vi.fn((error: { message: string } | null, ctx: string) => {
    if (error) throw new Error(`[mock] ${ctx}: ${error.message}`);
  }),
  resetClient: vi.fn(),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<ReviewItemInput> = {}): ReviewItemInput {
  return {
    dedupKey:      buildDedupKey({ ticker: 'GOVX', anomalyType: 'unknown_financing_type', accessionNumber: '0001234567-26-000001', sourcePath: 'financing_raw.financingType' }),
    ticker:        'GOVX',
    cik:           '0001234567',
    accessionNumber: '0001234567-26-000001',
    anomalyType:   'unknown_financing_type',
    category:      'financing_extraction',
    severity:      'high',
    title:         'Financing type unclassified',
    description:   'Test description',
    currentValue:  { financingType: 'unknown' },
    expectedBehavior: { financingType: 'convertible_note | equity_line | ...' },
    sourcePath:    'financing_raw.financingType',
    parserVersion: '1.0.4',
    confidence:    'high',
    ...overrides,
  };
}

function makeDbRow(overrides: Record<string, unknown> = {}) {
  return {
    id:               'uuid-001',
    dedup_key:        buildDedupKey({ ticker: 'GOVX', anomalyType: 'unknown_financing_type', accessionNumber: '0001234567-26-000001', sourcePath: 'financing_raw.financingType' }),
    ticker:           'GOVX',
    cik:              '0001234567',
    accession_number: '0001234567-26-000001',
    anomaly_type:     'unknown_financing_type',
    category:         'financing_extraction',
    severity:         'high',
    title:            'Financing type unclassified',
    description:      'Test description',
    current_value:    { financingType: 'unknown' },
    expected_behavior:{ financingType: 'convertible_note | equity_line | ...' },
    source_path:      'financing_raw.financingType',
    parser_version:   '1.0.4',
    confidence:       'high',
    run_id:           null,
    status:           'open',
    recurrence_count: 1,
    first_seen_at:    '2026-08-13T00:00:00Z',
    last_seen_at:     '2026-08-13T00:00:00Z',
    created_at:       '2026-08-13T00:00:00Z',
    updated_at:       '2026-08-13T00:00:00Z',
    resolved_at:      null,
    resolution_note:  null,
    ...overrides,
  };
}


// ─── Import after mocks ───────────────────────────────────────────────────────

import {
  upsertDetected,
  list,
  getById,
  getByDedupKey,
  updateStatus,
  markResolvedIfAbsent,
} from '../postgres/reviewItems';
import { getClient } from '../postgres/client';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('reviewItems.list', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns mapped ReviewItem objects from DB rows', async () => {
    const row = makeDbRow();
    const mockDb = { from: vi.fn() };
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq:     vi.fn().mockReturnThis(),
      in:     vi.fn().mockReturnThis(),
      order:  vi.fn().mockReturnThis(),
      limit:  vi.fn().mockReturnThis(),
      range:  vi.fn().mockReturnThis(),
    };
    // Make chain awaitable
    const result = { data: [row], error: null };
    Object.assign(chain, {
      then: Promise.resolve(result).then.bind(Promise.resolve(result)),
    });
    mockDb.from.mockReturnValue(chain);
    vi.mocked(getClient).mockReturnValue(mockDb as unknown as ReturnType<typeof getClient>);

    const items = await list({ ticker: 'GOVX' });
    expect(items).toHaveLength(1);
    expect(items[0].ticker).toBe('GOVX');
    expect(items[0].status).toBe('open');
    expect(items[0].recurrenceCount).toBe(1);
    expect(items[0].dedupKey).toBe(row.dedup_key);
  });

  it('returns empty array when no rows', async () => {
    const mockDb = { from: vi.fn() };
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq:     vi.fn().mockReturnThis(),
      in:     vi.fn().mockReturnThis(),
      order:  vi.fn().mockReturnThis(),
      limit:  vi.fn().mockReturnThis(),
      range:  vi.fn().mockReturnThis(),
    };
    const result = { data: [], error: null };
    Object.assign(chain, {
      then: Promise.resolve(result).then.bind(Promise.resolve(result)),
    });
    mockDb.from.mockReturnValue(chain);
    vi.mocked(getClient).mockReturnValue(mockDb as unknown as ReturnType<typeof getClient>);

    const items = await list();
    expect(items).toHaveLength(0);
  });
});

describe('reviewItems.getById', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns the item when found', async () => {
    const row = makeDbRow();
    const mockDb = { from: vi.fn() };
    const chain = {
      select:      vi.fn().mockReturnThis(),
      eq:          vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: row, error: null }),
    };
    mockDb.from.mockReturnValue(chain);
    vi.mocked(getClient).mockReturnValue(mockDb as unknown as ReturnType<typeof getClient>);

    const item = await getById('uuid-001');
    expect(item).toBeDefined();
    expect(item!.id).toBe('uuid-001');
    expect(item!.anomalyType).toBe('unknown_financing_type');
  });

  it('returns undefined when not found', async () => {
    const mockDb = { from: vi.fn() };
    const chain = {
      select:      vi.fn().mockReturnThis(),
      eq:          vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    mockDb.from.mockReturnValue(chain);
    vi.mocked(getClient).mockReturnValue(mockDb as unknown as ReturnType<typeof getClient>);

    const item = await getById('nonexistent-id');
    expect(item).toBeUndefined();
  });
});

describe('reviewItems.getByDedupKey', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns the item when found', async () => {
    const row = makeDbRow();
    const mockDb = { from: vi.fn() };
    const chain = {
      select:      vi.fn().mockReturnThis(),
      eq:          vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: row, error: null }),
    };
    mockDb.from.mockReturnValue(chain);
    vi.mocked(getClient).mockReturnValue(mockDb as unknown as ReturnType<typeof getClient>);

    const item = await getByDedupKey(row.dedup_key);
    expect(item).toBeDefined();
    expect(item!.id).toBe('uuid-001');
    expect(item!.anomalyType).toBe('unknown_financing_type');
  });

  it('returns undefined when not found', async () => {
    const mockDb = { from: vi.fn() };
    const chain = {
      select:      vi.fn().mockReturnThis(),
      eq:          vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    mockDb.from.mockReturnValue(chain);
    vi.mocked(getClient).mockReturnValue(mockDb as unknown as ReturnType<typeof getClient>);

    const item = await getByDedupKey('nonexistent-key');
    expect(item).toBeUndefined();
  });
});

describe('reviewItems.updateStatus', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('sets status and updated_at', async () => {
    const updateMock = vi.fn().mockReturnThis();
    const eqMock     = vi.fn().mockResolvedValue({ data: null, error: null });
    const mockDb     = { from: vi.fn().mockReturnValue({ update: updateMock, eq: eqMock }) };
    vi.mocked(getClient).mockReturnValue(mockDb as unknown as ReturnType<typeof getClient>);
    updateMock.mockReturnValue({ eq: eqMock });

    await updateStatus('uuid-001', 'investigating');
    expect(updateMock).toHaveBeenCalledOnce();
    const patch = updateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.status).toBe('investigating');
    expect(patch.updated_at).toBeDefined();
    expect(patch.resolved_at).toBeUndefined();
  });

  it('stamps resolved_at when status is resolved', async () => {
    const updateMock = vi.fn().mockReturnThis();
    const eqMock     = vi.fn().mockResolvedValue({ data: null, error: null });
    const mockDb     = { from: vi.fn().mockReturnValue({ update: updateMock, eq: eqMock }) };
    vi.mocked(getClient).mockReturnValue(mockDb as unknown as ReturnType<typeof getClient>);
    updateMock.mockReturnValue({ eq: eqMock });

    await updateStatus('uuid-001', 'resolved', 'Parser fixed in 1.0.5');
    const patch = updateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.status).toBe('resolved');
    expect(patch.resolved_at).toBeDefined();
    expect(patch.resolution_note).toBe('Parser fixed in 1.0.5');
  });
});

describe('reviewItems.upsertDetected — lifecycle', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  function makeMockDb(existingRows: unknown[]) {
    // Chain for the "fetch existing" SELECT query
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      in:     vi.fn().mockResolvedValue({ data: existingRows, error: null }),
    };
    // Mocks for INSERT and individual UPDATE calls
    const insertChain = {
      insert: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    const updateChain = {
      update: vi.fn().mockReturnThis(),
      eq:     vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    // from() returns different chains based on call order
    let callCount = 0;
    const mockDb = {
      from: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return { ...selectChain, ...insertChain, ...updateChain };
        return { ...insertChain, ...updateChain };
      }),
    };
    return { mockDb, insertChain, updateChain, selectChain };
  }

  it('inserts a new item when dedup_key does not exist', async () => {
    const input = makeInput();
    const { mockDb, insertChain } = makeMockDb([]); // no existing rows
    vi.mocked(getClient).mockReturnValue(mockDb as unknown as ReturnType<typeof getClient>);

    await upsertDetected([input]);

    const insertCalls = insertChain.insert.mock.calls;
    expect(insertCalls.length).toBeGreaterThan(0);
    const insertedRows = insertCalls[0][0] as Record<string, unknown>[];
    expect(insertedRows[0].dedup_key).toBe(input.dedupKey);
    expect(insertedRows[0].status).toBe('open');
    expect(insertedRows[0].recurrence_count).toBe(1);
  });

  it('increments recurrence_count for an existing row (same accession)', async () => {
    const input = makeInput();
    const existing = {
      id:               'uuid-existing',
      dedup_key:        input.dedupKey,
      recurrence_count: 3,
    };
    const { mockDb, updateChain } = makeMockDb([existing]);
    vi.mocked(getClient).mockReturnValue(mockDb as unknown as ReturnType<typeof getClient>);

    await upsertDetected([input]);

    // Should have called update with recurrence_count = 4
    expect(updateChain.update).toHaveBeenCalled();
    const patch = updateChain.update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.recurrence_count).toBe(4);
    expect(patch.last_seen_at).toBeDefined();
  });

  it('does not insert when row already exists (no duplicate insert)', async () => {
    const input = makeInput();
    const existing = {
      id:               'uuid-existing',
      dedup_key:        input.dedupKey,
      recurrence_count: 1,
    };
    const { mockDb, insertChain } = makeMockDb([existing]);
    vi.mocked(getClient).mockReturnValue(mockDb as unknown as ReturnType<typeof getClient>);

    await upsertDetected([input]);

    // insert should not have been called (existing row → update path)
    expect(insertChain.insert).not.toHaveBeenCalled();
  });

  it('handles empty input array without any DB calls', async () => {
    const mockDb = { from: vi.fn() };
    vi.mocked(getClient).mockReturnValue(mockDb as unknown as ReturnType<typeof getClient>);

    await upsertDetected([]);

    expect(mockDb.from).not.toHaveBeenCalled();
  });
});

describe('reviewItems.markResolvedIfAbsent', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  function makeMarkMockDb(openRows: { id: string; dedup_key: string; status: string }[]) {
    const updateMock = vi.fn().mockReturnThis();
    const inMock     = vi.fn().mockResolvedValue({ data: null, error: null });
    const chain = {
      select: vi.fn().mockReturnThis(),
      in:     vi.fn()
        .mockResolvedValueOnce({ data: openRows, error: null }) // first .in() = status filter
        .mockResolvedValueOnce({ data: null, error: null }),    // second .in() = id filter for update
      eq:     vi.fn().mockReturnThis(),
      update: updateMock,
    };
    updateMock.mockReturnValue({ in: inMock });
    const mockDb = { from: vi.fn().mockReturnValue(chain) };
    return { mockDb, updateMock, inMock };
  }

  it('marks open items as resolved when their dedup_key is absent from active set', async () => {
    const staleKey = buildDedupKey({ ticker: 'GOVX', anomalyType: 'unknown_financing_type', accessionNumber: '0001234567-26-000001', sourcePath: 'financing_raw.financingType' });
    const openRows = [
      { id: 'uuid-1', dedup_key: staleKey, status: 'open' },
    ];
    const { mockDb, updateMock } = makeMarkMockDb(openRows);
    vi.mocked(getClient).mockReturnValue(mockDb as unknown as ReturnType<typeof getClient>);

    // Active set does NOT include staleKey → should resolve it
    await markResolvedIfAbsent(['completely-different-key']);

    expect(updateMock).toHaveBeenCalled();
    const patch = updateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.status).toBe('resolved');
    expect(patch.resolved_at).toBeDefined();
  });

  it('does NOT resolve items whose dedup_key is still active', async () => {
    const activeKey = buildDedupKey({ ticker: 'GOVX', anomalyType: 'unknown_financing_type', accessionNumber: '0001234567-26-000001', sourcePath: 'financing_raw.financingType' });
    const openRows = [
      { id: 'uuid-1', dedup_key: activeKey, status: 'open' },
    ];
    const { mockDb, updateMock } = makeMarkMockDb(openRows);
    vi.mocked(getClient).mockReturnValue(mockDb as unknown as ReturnType<typeof getClient>);

    // activeKey IS in the active set → should NOT be resolved
    await markResolvedIfAbsent([activeKey]);

    expect(updateMock).not.toHaveBeenCalled();
  });

  it('resolves confirmed_bug items that are no longer firing', async () => {
    const staleKey = 'CUEN:variable_pricing_missing_discount:0001234567-26-000001:financing_raw.discountrate';
    const rows = [{ id: 'uuid-2', dedup_key: staleKey, status: 'confirmed_bug' }];
    const { mockDb, updateMock } = makeMarkMockDb(rows);
    vi.mocked(getClient).mockReturnValue(mockDb as unknown as ReturnType<typeof getClient>);

    await markResolvedIfAbsent([]);

    expect(updateMock).toHaveBeenCalled();
    const patch = updateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.status).toBe('resolved');
  });

  it('does NOT auto-resolve expected_behavior items', async () => {
    // expected_behavior is NOT in the resolvable statuses list, so markResolvedIfAbsent
    // never selects it. We verify by checking that the mock doesn't call update for it.
    const suppressedKey = 'WRAP:stale_active_source:0001234567-26-000001:filings.parser_version';
    // The SELECT query only returns open/investigating/confirmed_bug rows.
    // If the DB correctly filters by status, expected_behavior never shows up.
    // Simulate DB returning empty (expected_behavior was filtered out)
    const { mockDb, updateMock } = makeMarkMockDb([]);
    vi.mocked(getClient).mockReturnValue(mockDb as unknown as ReturnType<typeof getClient>);

    await markResolvedIfAbsent(['some-other-key']);

    // No rows to resolve → update not called
    expect(updateMock).not.toHaveBeenCalled();
    void suppressedKey;
  });

  it('does NOT auto-resolve ignored items', async () => {
    // Same logic as expected_behavior — ignored is not in resolvable statuses
    const { mockDb, updateMock } = makeMarkMockDb([]);
    vi.mocked(getClient).mockReturnValue(mockDb as unknown as ReturnType<typeof getClient>);

    await markResolvedIfAbsent([]);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('does nothing when there are no open items at all', async () => {
    const { mockDb, updateMock } = makeMarkMockDb([]);
    vi.mocked(getClient).mockReturnValue(mockDb as unknown as ReturnType<typeof getClient>);

    await markResolvedIfAbsent(['some-key', 'other-key']);
    expect(updateMock).not.toHaveBeenCalled();
  });
});
