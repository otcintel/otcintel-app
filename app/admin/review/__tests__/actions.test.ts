/**
 * Tests for app/admin/review/actions.ts — updateItemStatus server action.
 *
 * Covers: auth enforcement, status persistence, resolution note, all
 * terminal statuses (expected_behavior, ignored, resolved), invalid input.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockUpdateStatus } = vi.hoisted(() => ({
  mockUpdateStatus: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/db/repositories', () => ({
  getReviewItemsRepo: vi.fn().mockResolvedValue({
    updateStatus: mockUpdateStatus,
  }),
}));

vi.mock('@/lib/admin/cookieAuth', () => ({
  requireAdminCookie: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { updateItemStatus } from '../actions';
import { requireAdminCookie } from '@/lib/admin/cookieAuth';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFormData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('updateItemStatus server action', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('calls requireAdminCookie to enforce browser session auth', async () => {
    const fd = makeFormData({ id: 'item-001', status: 'investigating' });
    await updateItemStatus(fd);
    expect(requireAdminCookie).toHaveBeenCalledOnce();
  });

  it('throws (and does not call updateStatus) when requireAdminCookie rejects', async () => {
    vi.mocked(requireAdminCookie).mockRejectedValueOnce(new Error('NEXT_REDIRECT'));
    const fd = makeFormData({ id: 'item-001', status: 'investigating' });
    await expect(updateItemStatus(fd)).rejects.toThrow();
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });

  it('calls updateStatus with the correct id and status', async () => {
    const fd = makeFormData({ id: 'item-001', status: 'investigating' });
    await updateItemStatus(fd);
    expect(mockUpdateStatus).toHaveBeenCalledWith('item-001', 'investigating', undefined);
  });

  it('passes a non-empty resolutionNote to updateStatus', async () => {
    const fd = makeFormData({ id: 'item-001', status: 'resolved', resolutionNote: 'Fixed in 1.0.5' });
    await updateItemStatus(fd);
    expect(mockUpdateStatus).toHaveBeenCalledWith('item-001', 'resolved', 'Fixed in 1.0.5');
  });

  it('passes undefined (not empty string) when resolutionNote is blank', async () => {
    const fd = makeFormData({ id: 'item-001', status: 'resolved', resolutionNote: '   ' });
    await updateItemStatus(fd);
    expect(mockUpdateStatus).toHaveBeenCalledWith('item-001', 'resolved', undefined);
  });

  it('accepts expected_behavior as a distinct status', async () => {
    const fd = makeFormData({ id: 'item-001', status: 'expected_behavior', resolutionNote: 'By design' });
    await updateItemStatus(fd);
    expect(mockUpdateStatus).toHaveBeenCalledWith('item-001', 'expected_behavior', 'By design');
  });

  it('accepts ignored as a distinct status', async () => {
    const fd = makeFormData({ id: 'item-001', status: 'ignored' });
    await updateItemStatus(fd);
    expect(mockUpdateStatus).toHaveBeenCalledWith('item-001', 'ignored', undefined);
  });

  it('accepts resolved status', async () => {
    const fd = makeFormData({ id: 'item-001', status: 'resolved' });
    await updateItemStatus(fd);
    expect(mockUpdateStatus).toHaveBeenCalledWith('item-001', 'resolved', undefined);
  });

  it('throws for an invalid status and does not call updateStatus', async () => {
    const fd = makeFormData({ id: 'item-001', status: 'not_a_status' });
    await expect(updateItemStatus(fd)).rejects.toThrow(/invalid status/i);
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });

  it('revalidates and redirects to the item detail page on success', async () => {
    const fd = makeFormData({ id: 'item-001', status: 'investigating' });
    await updateItemStatus(fd);
    expect(revalidatePath).toHaveBeenCalledWith('/admin/review/item-001');
    expect(redirect).toHaveBeenCalledWith('/admin/review/item-001');
  });
});
