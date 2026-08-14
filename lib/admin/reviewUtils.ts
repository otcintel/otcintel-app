import type { AnomalySeverity, ReviewStatus, ReviewItem, ReviewItemFilters } from '@/lib/anomaly/types';

export const SEVERITY_ORDER: Record<AnomalySeverity, number> = {
  critical: 0,
  high:     1,
  medium:   2,
  low:      3,
};

export const UNRESOLVED_STATUSES: ReviewStatus[] = [
  'open',
  'investigating',
  'confirmed_bug',
];

/** Sort items severity-first (critical → low), then newest lastSeenAt first. */
export function sortBySeverity(items: ReviewItem[]): ReviewItem[] {
  return [...items].sort((a, b) => {
    const sev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sev !== 0) return sev;
    return b.lastSeenAt.localeCompare(a.lastSeenAt);
  });
}

/**
 * Build ReviewItemFilters from URL search params.
 * Default (no showAll): restricts to unresolved statuses.
 */
export function buildListFilters(params: URLSearchParams): ReviewItemFilters {
  const showAll    = params.get('showAll') === 'true';
  const ticker     = params.get('ticker') ?? undefined;
  const severity   = params.get('severity') as AnomalySeverity | null;
  const category   = params.get('category') as ReviewItemFilters['category'] | null;
  const anomalyType = params.get('anomalyType') ?? undefined;

  return {
    status:      showAll ? undefined : UNRESOLVED_STATUSES,
    ticker:      ticker ?? undefined,
    severity:    severity ?? undefined,
    category:    category ?? undefined,
    anomalyType: anomalyType ?? undefined,
  };
}
