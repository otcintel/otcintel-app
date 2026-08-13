/**
 * OTCIntel — PostgreSQL review items repository
 *
 * Implements the review-item lifecycle against the `review_items` table.
 *
 * Lifecycle semantics:
 *
 *   A. Same anomaly + same accession (same dedup_key):
 *      → increment recurrence_count, update last_seen_at, preserve status.
 *
 *   B. expected_behavior / ignored:
 *      → same dedup_key: timestamps updated, status stays suppressed.
 *      → different accession → different dedup_key → new item inserted.
 *
 *   C. open / investigating / confirmed_bug:
 *      → firing on same accession keeps item unresolved (status preserved).
 *      → human must explicitly set status; detector never auto-resolves.
 *
 *   D. resolved:
 *      → markResolvedIfAbsent() resolves items whose dedup_key was NOT emitted
 *         in the current run, but only for status IN (open, investigating,
 *         confirmed_bug). expected_behavior and ignored are never auto-resolved.
 */

import { getClient, assertNoError } from './client';
import type {
  ReviewItem,
  ReviewItemInput,
  ReviewItemFilters,
  ReviewStatus,
} from '../../anomaly/types';

// ─── Row type ─────────────────────────────────────────────────────────────────

interface ReviewItemRow {
  id: string;
  dedup_key: string;
  ticker: string;
  cik: string | null;
  accession_number: string | null;
  anomaly_type: string;
  category: string;
  severity: string;
  title: string;
  description: string;
  current_value: unknown;
  expected_behavior: unknown;
  source_path: string | null;
  parser_version: string | null;
  confidence: string | null;
  run_id: string | null;
  status: string;
  recurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
}

// ─── Mapping ──────────────────────────────────────────────────────────────────

function rowToItem(row: ReviewItemRow): ReviewItem {
  return {
    id:               row.id,
    dedupKey:         row.dedup_key,
    ticker:           row.ticker,
    cik:              row.cik ?? undefined,
    accessionNumber:  row.accession_number ?? undefined,
    anomalyType:      row.anomaly_type,
    category:         row.category as ReviewItem['category'],
    severity:         row.severity as ReviewItem['severity'],
    title:            row.title,
    description:      row.description,
    currentValue:     row.current_value ?? undefined,
    expectedBehavior: row.expected_behavior ?? undefined,
    sourcePath:       row.source_path ?? undefined,
    parserVersion:    row.parser_version ?? undefined,
    confidence:       row.confidence ?? undefined,
    runId:            row.run_id ?? undefined,
    status:           row.status as ReviewItem['status'],
    recurrenceCount:  row.recurrence_count,
    firstSeenAt:      row.first_seen_at,
    lastSeenAt:       row.last_seen_at,
    createdAt:        row.created_at,
    updatedAt:        row.updated_at,
    resolvedAt:       row.resolved_at ?? undefined,
    resolutionNote:   row.resolution_note ?? undefined,
  };
}

function inputToInsertRow(item: ReviewItemInput, now: string): Record<string, unknown> {
  return {
    dedup_key:         item.dedupKey,
    ticker:            item.ticker.toUpperCase(),
    cik:               item.cik ?? null,
    accession_number:  item.accessionNumber ?? null,
    anomaly_type:      item.anomalyType,
    category:          item.category,
    severity:          item.severity,
    title:             item.title,
    description:       item.description,
    current_value:     item.currentValue ?? null,
    expected_behavior: item.expectedBehavior ?? null,
    source_path:       item.sourcePath ?? null,
    parser_version:    item.parserVersion ?? null,
    confidence:        item.confidence ?? null,
    run_id:            item.runId ?? null,
    status:            'open',
    recurrence_count:  1,
    first_seen_at:     now,
    last_seen_at:      now,
    created_at:        now,
    updated_at:        now,
    resolved_at:       null,
    resolution_note:   null,
  };
}

// ─── Repository ───────────────────────────────────────────────────────────────

/**
 * Upsert detected review items.
 *
 * Strategy (compatible with supabase-js v2 without DB functions):
 *   1. Fetch existing rows for the incoming dedup_keys.
 *   2. Partition into new (not found) vs existing.
 *   3. INSERT new rows with status='open', recurrence_count=1.
 *   4. UPDATE existing rows: increment recurrence_count, bump last_seen_at,
 *      update run_id. Status, resolution_note, resolved_at are preserved.
 *
 * This is correct at 24-company scale. At 1,000+ companies, replace with a
 * Postgres function (INSERT … ON CONFLICT DO UPDATE SET recurrence_count =
 * review_items.recurrence_count + 1) to avoid the N+1 round-trips.
 */
export async function upsertDetected(items: ReviewItemInput[]): Promise<void> {
  if (items.length === 0) return;

  const db  = getClient();
  const now = new Date().toISOString();
  const incomingKeys = items.map(i => i.dedupKey);

  // Step 1: fetch existing rows for the dedup_keys in this batch
  const { data: existingData, error: fetchErr } = await db
    .from('review_items')
    .select('id, dedup_key, recurrence_count')
    .in('dedup_key', incomingKeys);
  assertNoError(fetchErr, 'reviewItems.upsertDetected fetch');

  const existingMap = new Map(
    ((existingData ?? []) as { id: string; dedup_key: string; recurrence_count: number }[])
      .map(r => [r.dedup_key, r]),
  );

  // Step 2: partition
  const toInsert: ReviewItemInput[] = [];
  const toUpdate: { id: string; dedupKey: string; recurrenceCount: number; runId?: string }[] = [];

  for (const item of items) {
    const existing = existingMap.get(item.dedupKey);
    if (existing) {
      toUpdate.push({
        id: existing.id,
        dedupKey: item.dedupKey,
        recurrenceCount: existing.recurrence_count,
        runId: item.runId,
      });
    } else {
      toInsert.push(item);
    }
  }

  // Step 3: insert new items
  if (toInsert.length > 0) {
    const { error: insertErr } = await db
      .from('review_items')
      .insert(toInsert.map(item => inputToInsertRow(item, now)));
    assertNoError(insertErr, 'reviewItems.upsertDetected insert');
  }

  // Step 4: update existing items (increment recurrence, preserve status)
  for (const { id, recurrenceCount, runId } of toUpdate) {
    const patch: Record<string, unknown> = {
      recurrence_count: recurrenceCount + 1,
      last_seen_at:     now,
      updated_at:       now,
    };
    if (runId !== undefined) patch.run_id = runId;

    const { error: upErr } = await db
      .from('review_items')
      .update(patch)
      .eq('id', id);
    assertNoError(upErr, `reviewItems.upsertDetected update(${id})`);
  }
}

/**
 * List review items with optional filters. Sorted by last_seen_at DESC.
 */
export async function list(filters: ReviewItemFilters = {}): Promise<ReviewItem[]> {
  const db = getClient();
  let q = db.from('review_items').select('*');

  if (filters.ticker) {
    q = q.eq('ticker', filters.ticker.toUpperCase());
  }
  if (filters.anomalyType) {
    q = q.eq('anomaly_type', filters.anomalyType);
  }
  if (filters.status !== undefined) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
    q = q.in('status', statuses);
  }
  if (filters.severity !== undefined) {
    const severities = Array.isArray(filters.severity) ? filters.severity : [filters.severity];
    q = q.in('severity', severities);
  }
  if (filters.category !== undefined) {
    const categories = Array.isArray(filters.category) ? filters.category : [filters.category];
    q = q.in('category', categories);
  }

  q = q.order('last_seen_at', { ascending: false });

  if (filters.limit !== undefined)  q = q.limit(filters.limit);
  if (filters.offset !== undefined) {
    q = q.range(filters.offset, filters.offset + (filters.limit ?? 100) - 1);
  }

  const { data, error } = await q;
  assertNoError(error, 'reviewItems.list');
  return ((data ?? []) as ReviewItemRow[]).map(rowToItem);
}

/**
 * Retrieve one item by dedup key. Returns undefined if not found.
 */
export async function getByDedupKey(dedupKey: string): Promise<ReviewItem | undefined> {
  const db = getClient();
  const { data, error } = await db
    .from('review_items')
    .select('*')
    .eq('dedup_key', dedupKey)
    .maybeSingle();
  assertNoError(error, `reviewItems.getByDedupKey(${dedupKey})`);
  return data ? rowToItem(data as ReviewItemRow) : undefined;
}

/**
 * Update the lifecycle status of a review item.
 * Optionally attach or replace the resolution note.
 * Setting status='resolved' also stamps resolved_at.
 */
export async function updateStatus(
  id: string,
  status: ReviewStatus,
  resolutionNote?: string,
): Promise<void> {
  const db  = getClient();
  const now = new Date().toISOString();

  const patch: Record<string, unknown> = { status, updated_at: now };
  if (resolutionNote !== undefined) patch.resolution_note = resolutionNote;
  if (status === 'resolved') patch.resolved_at = now;

  const { error } = await db
    .from('review_items')
    .update(patch)
    .eq('id', id);
  assertNoError(error, `reviewItems.updateStatus(${id})`);
}

/**
 * Mark as 'resolved' all items whose dedup_key was NOT emitted by the current
 * detector run, restricted to resolvable statuses (open / investigating /
 * confirmed_bug). Items with status 'expected_behavior' or 'ignored' are left
 * untouched.
 *
 * @param activeDedupKeys - dedup_keys emitted by the detector in this run
 * @param ticker - when provided, scope to one company; omit for full-universe runs
 */
export async function markResolvedIfAbsent(
  activeDedupKeys: string[],
  ticker?: string,
): Promise<void> {
  const db  = getClient();
  const now = new Date().toISOString();

  const resolvableStatuses: ReviewStatus[] = ['open', 'investigating', 'confirmed_bug'];

  let q = db
    .from('review_items')
    .select('id, dedup_key')
    .in('status', resolvableStatuses);

  if (ticker) q = q.eq('ticker', ticker.toUpperCase());

  const { data, error } = await q;
  assertNoError(error, 'reviewItems.markResolvedIfAbsent select');

  const activeSet   = new Set(activeDedupKeys);
  const toResolveIds = ((data ?? []) as { id: string; dedup_key: string }[])
    .filter(row => !activeSet.has(row.dedup_key))
    .map(row => row.id);

  if (toResolveIds.length === 0) return;

  const { error: upErr } = await db
    .from('review_items')
    .update({ status: 'resolved', resolved_at: now, updated_at: now })
    .in('id', toResolveIds);
  assertNoError(upErr, 'reviewItems.markResolvedIfAbsent update');
}
