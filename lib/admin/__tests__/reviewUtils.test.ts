import { describe, it, expect } from 'vitest';
import {
  sortBySeverity,
  buildListFilters,
  UNRESOLVED_STATUSES,
} from '../reviewUtils';
import type { ReviewItem } from '@/lib/anomaly/types';

function makeItem(overrides: Partial<ReviewItem>): ReviewItem {
  return {
    id:              'id-1',
    dedupKey:        'GOVX:unknown:acc:path',
    ticker:          'GOVX',
    anomalyType:     'unknown_financing_type',
    category:        'financing_extraction',
    severity:        'medium',
    title:           'Test',
    description:     'Test description',
    status:          'open',
    recurrenceCount: 1,
    firstSeenAt:     '2026-01-01T00:00:00Z',
    lastSeenAt:      '2026-01-01T00:00:00Z',
    createdAt:       '2026-01-01T00:00:00Z',
    updatedAt:       '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ─── UNRESOLVED_STATUSES ──────────────────────────────────────────────────────

describe('UNRESOLVED_STATUSES', () => {
  it('contains open, investigating, confirmed_bug and nothing else', () => {
    expect(UNRESOLVED_STATUSES).toEqual(['open', 'investigating', 'confirmed_bug']);
    expect(UNRESOLVED_STATUSES).not.toContain('resolved');
    expect(UNRESOLVED_STATUSES).not.toContain('expected_behavior');
    expect(UNRESOLVED_STATUSES).not.toContain('ignored');
  });
});

// ─── buildListFilters ─────────────────────────────────────────────────────────

describe('buildListFilters', () => {
  it('defaults to unresolved statuses when no showAll param', () => {
    const filters = buildListFilters(new URLSearchParams());
    expect(filters.status).toEqual(UNRESOLVED_STATUSES);
  });

  it('removes status filter when showAll=true', () => {
    const filters = buildListFilters(new URLSearchParams('showAll=true'));
    expect(filters.status).toBeUndefined();
  });

  it('passes severity filter', () => {
    const filters = buildListFilters(new URLSearchParams('severity=critical'));
    expect(filters.severity).toBe('critical');
  });

  it('passes ticker filter', () => {
    const filters = buildListFilters(new URLSearchParams('ticker=WRAP'));
    expect(filters.ticker).toBe('WRAP');
  });

  it('passes anomalyType filter', () => {
    const filters = buildListFilters(new URLSearchParams('anomalyType=stale_active_source'));
    expect(filters.anomalyType).toBe('stale_active_source');
  });
});

// ─── sortBySeverity ───────────────────────────────────────────────────────────

describe('sortBySeverity', () => {
  it('orders critical → high → medium → low', () => {
    const items = [
      makeItem({ id: '1', severity: 'low' }),
      makeItem({ id: '2', severity: 'critical' }),
      makeItem({ id: '3', severity: 'medium' }),
      makeItem({ id: '4', severity: 'high' }),
    ];
    const sorted = sortBySeverity(items);
    expect(sorted.map(i => i.severity)).toEqual(['critical', 'high', 'medium', 'low']);
  });

  it('breaks ties by newest lastSeenAt first', () => {
    const items = [
      makeItem({ id: '1', severity: 'high', lastSeenAt: '2026-01-01T00:00:00Z' }),
      makeItem({ id: '2', severity: 'high', lastSeenAt: '2026-06-01T00:00:00Z' }),
    ];
    const sorted = sortBySeverity(items);
    expect(sorted[0].id).toBe('2');
    expect(sorted[1].id).toBe('1');
  });

  it('returns empty array unchanged', () => {
    expect(sortBySeverity([])).toEqual([]);
  });

  it('does not mutate the original array', () => {
    const items = [
      makeItem({ id: '1', severity: 'low' }),
      makeItem({ id: '2', severity: 'critical' }),
    ];
    const original = [...items];
    sortBySeverity(items);
    expect(items[0].id).toBe(original[0].id);
  });
});
