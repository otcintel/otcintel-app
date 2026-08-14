/**
 * Tests for PATCH /api/admin/review/[id]
 * Covers: auth protection, status update, resolution note, status values.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const { mockUpdateStatus } = vi.hoisted(() => ({
  mockUpdateStatus: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/db/repositories', () => ({
  getReviewItemsRepo: vi.fn().mockResolvedValue({
    updateStatus: mockUpdateStatus,
  }),
}));

vi.mock('@/lib/api/adminAuth', () => ({
  requireAdminAuth: vi.fn(),
}));

import { PATCH } from '../[id]/route';
import { requireAdminAuth } from '@/lib/api/adminAuth';
import { NextResponse } from 'next/server';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEST_SECRET = 'test-admin-secret-xxyyzz';
const ITEM_ID     = 'uuid-review-001';

function makeRequest(body: unknown, authHeader?: string): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authHeader) headers['Authorization'] = authHeader;
  return new Request(`http://localhost/api/admin/review/${ITEM_ID}`, {
    method:  'PATCH',
    headers,
    body:    JSON.stringify(body),
  });
}

function makeParams(id = ITEM_ID): Promise<{ id: string }> {
  return Promise.resolve({ id });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

let _origSecret: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  _origSecret = process.env.ADMIN_SECRET;
  process.env.ADMIN_SECRET = TEST_SECRET;
});

afterEach(() => {
  if (_origSecret === undefined) delete process.env.ADMIN_SECRET;
  else process.env.ADMIN_SECRET = _origSecret;
});

describe('PATCH /api/admin/review/[id]', () => {

  it('returns 401 when requireAdminAuth rejects', async () => {
    vi.mocked(requireAdminAuth).mockReturnValue(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    );
    const res = await PATCH(makeRequest({ status: 'investigating' }), { params: makeParams() });
    expect(res.status).toBe(401);
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });

  it('returns 400 when status is missing', async () => {
    vi.mocked(requireAdminAuth).mockReturnValue(null);
    const res = await PATCH(makeRequest({}), { params: makeParams() });
    expect(res.status).toBe(400);
  });

  it('returns 400 when status is not a valid ReviewStatus', async () => {
    vi.mocked(requireAdminAuth).mockReturnValue(null);
    const res = await PATCH(makeRequest({ status: 'not_a_status' }), { params: makeParams() });
    expect(res.status).toBe(400);
  });

  it('calls updateStatus and returns 200 for valid status update', async () => {
    vi.mocked(requireAdminAuth).mockReturnValue(null);
    const res = await PATCH(makeRequest({ status: 'investigating' }), { params: makeParams() });
    expect(res.status).toBe(200);
    expect(mockUpdateStatus).toHaveBeenCalledWith(ITEM_ID, 'investigating', undefined);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('passes resolutionNote to updateStatus', async () => {
    vi.mocked(requireAdminAuth).mockReturnValue(null);
    const res = await PATCH(
      makeRequest({ status: 'resolved', resolutionNote: 'Fixed in 1.0.5' }),
      { params: makeParams() },
    );
    expect(res.status).toBe(200);
    expect(mockUpdateStatus).toHaveBeenCalledWith(ITEM_ID, 'resolved', 'Fixed in 1.0.5');
  });

  it('accepts expected_behavior as a distinct status (not resolved)', async () => {
    vi.mocked(requireAdminAuth).mockReturnValue(null);
    const res = await PATCH(
      makeRequest({ status: 'expected_behavior', resolutionNote: 'By design' }),
      { params: makeParams() },
    );
    expect(res.status).toBe(200);
    expect(mockUpdateStatus).toHaveBeenCalledWith(ITEM_ID, 'expected_behavior', 'By design');
  });

  it('accepts ignored as a distinct status (not resolved)', async () => {
    vi.mocked(requireAdminAuth).mockReturnValue(null);
    const res = await PATCH(
      makeRequest({ status: 'ignored' }),
      { params: makeParams() },
    );
    expect(res.status).toBe(200);
    expect(mockUpdateStatus).toHaveBeenCalledWith(ITEM_ID, 'ignored', undefined);
  });
});
