/**
 * OTCIntel — Anomaly detector types
 *
 * ReviewItem is the persistent record written to the review_items Postgres table.
 * ReviewItemInput is the shape produced by rule functions before DB assignment.
 * All field names are camelCase; the repository layer maps to snake_case columns.
 */

export type AnomalyCategory =
  | 'financing_extraction'
  | 'financial_statement'
  | 'provenance'
  | 'scoring'
  | 'system';

export type AnomalySeverity = 'critical' | 'high' | 'medium' | 'low';

export type ReviewStatus =
  | 'open'
  | 'investigating'
  | 'confirmed_bug'
  | 'expected_behavior'
  | 'resolved'
  | 'ignored';

/**
 * Everything the detector produces for one anomaly event.
 * No DB-assigned fields (id, timestamps, status, recurrenceCount).
 */
export interface ReviewItemInput {
  dedupKey: string;
  ticker: string;
  cik?: string;
  accessionNumber?: string;
  anomalyType: string;
  category: AnomalyCategory;
  severity: AnomalySeverity;
  title: string;
  description: string;
  currentValue?: unknown;
  expectedBehavior?: unknown;
  sourcePath?: string;
  parserVersion?: string;
  confidence?: string;
  runId?: string;
}

/** Full review item as stored in and returned from Postgres. */
export interface ReviewItem extends ReviewItemInput {
  id: string;
  status: ReviewStatus;
  recurrenceCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  resolutionNote?: string;
}

/** Filters for list(). All fields are optional and ANDed together. */
export interface ReviewItemFilters {
  ticker?: string;
  status?: ReviewStatus | ReviewStatus[];
  severity?: AnomalySeverity | AnomalySeverity[];
  category?: AnomalyCategory | AnomalyCategory[];
  anomalyType?: string;
  limit?: number;
  offset?: number;
}
