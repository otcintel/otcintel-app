/**
 * Deterministic batch-selection logic for the cron ingestion route.
 *
 * Strategy: stateless alphabetical partitioning.
 *   - Companies are sorted by ticker (deterministic across invocations).
 *   - The universe is divided into fixed-size slices (CRON_BATCH_SIZE).
 *   - Each scheduled invocation processes one slice.
 *   - The active slice is derived from the current UTC hour so that a
 *     6-hourly scheduler naturally rotates through all 4 batches in 24h.
 *   - The ?batch=N query param overrides time-based selection for testing
 *     and manual one-off triggers.
 *
 * With 24 companies and CRON_BATCH_SIZE=6:
 *   Batch 0 — UTC hours 0–5
 *   Batch 1 — UTC hours 6–11
 *   Batch 2 — UTC hours 12–17
 *   Batch 3 — UTC hours 18–23
 *   Full rotation: 4 invocations × 6h = 24h
 *
 * All functions are pure (no I/O, no side effects) so they can be tested
 * directly without mocking.
 */

/** Companies processed per scheduled invocation. */
export const CRON_BATCH_SIZE = 6;

/**
 * Partition a ticker list into a deterministic slice.
 *
 * @param tickers   Full universe — need not be pre-sorted (sorted internally).
 * @param batchIndex  Zero-based index of the slice to select.
 * @param batchSize   Companies per slice (default CRON_BATCH_SIZE).
 * @returns Sorted slice of tickers for this batch.
 */
export function selectBatch(
  tickers: string[],
  batchIndex: number,
  batchSize: number = CRON_BATCH_SIZE,
): string[] {
  if (tickers.length === 0 || batchSize <= 0) return [];
  const sorted = [...tickers].sort();
  const total = Math.ceil(sorted.length / batchSize);
  // Wrap negative indices so any integer is valid input
  const safe = ((batchIndex % total) + total) % total;
  const start = safe * batchSize;
  return sorted.slice(start, start + batchSize);
}

/**
 * Total number of batches for a universe of the given size.
 * Always at least 1.
 */
export function batchCount(
  tickerCount: number,
  batchSize: number = CRON_BATCH_SIZE,
): number {
  if (tickerCount <= 0) return 1;
  return Math.ceil(tickerCount / batchSize);
}

/**
 * Derive the current batch index from the UTC hour.
 *
 * Assumes the scheduler fires at the boundary of each period
 * (e.g. every 6h for 4 batches) so each invocation lands in a unique window.
 */
export function currentBatchIndex(totalBatches: number): number {
  if (totalBatches <= 1) return 0;
  const hour = new Date().getUTCHours();
  const hoursPerBatch = Math.floor(24 / totalBatches);
  return hoursPerBatch > 0 ? Math.floor(hour / hoursPerBatch) % totalBatches : 0;
}
