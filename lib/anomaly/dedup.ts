/**
 * Stable deduplication key for review items.
 *
 * Format: TICKER:anomalyType:accession-or-none:source.path
 *
 * Rules:
 *   - ticker uppercased and trimmed
 *   - anomalyType trimmed as-is (camelCase preserved)
 *   - accessionNumber whitespace-stripped; 'none' when absent or empty
 *   - sourcePath lowercased and trimmed; 'none' when absent or empty
 *   - no timestamps, run IDs, or values embedded in the key
 *
 * The key is stable across ingestion runs for the same filing/anomaly pair,
 * so a re-ingest of the same filing that still fires the same rule hits the
 * same dedup_key row and increments recurrence_count rather than inserting
 * a duplicate.
 */
export function buildDedupKey(params: {
  ticker: string;
  anomalyType: string;
  accessionNumber?: string | null;
  sourcePath?: string | null;
}): string {
  const ticker      = params.ticker.toUpperCase().trim();
  const anomalyType = params.anomalyType.trim();
  const accession   = (params.accessionNumber ?? '').replace(/\s+/g, '').trim() || 'none';
  const sourcePath  = (params.sourcePath ?? '').toLowerCase().trim() || 'none';

  return `${ticker}:${anomalyType}:${accession}:${sourcePath}`;
}
