/**
 * GET /api/filings/[ticker]
 *
 * Returns all normalized filings for a ticker from the in-memory store,
 * sorted newest-first by filedAt.
 *
 * Auto-ingestion: if the store has no filings for this ticker, the pipeline
 * runs inline before the response is returned.  The response includes an
 * `ingested` flag so callers can detect when a cold-start fetch occurred.
 *
 * Query parameters:
 *   limit    max number of filings to return (default: all)
 *   type     filter by form type, e.g. "8-K"
 *
 * Example:
 *   GET /api/filings/WXYZ
 *   GET /api/filings/WXYZ?type=8-K&limit=1
 */

import { NextRequest, NextResponse } from 'next/server';
import { normalizedFilingStore } from '@/lib/ingestion/store';
import { ingestTicker } from '@/lib/ingestion';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> },
): Promise<NextResponse> {
  const { ticker } = await params;
  const symbol = ticker.toUpperCase();

  const searchParams = request.nextUrl.searchParams;
  const typeFilter = searchParams.get('type');
  const limitStr   = searchParams.get('limit');

  let ingested = false;
  let ingestError: string | undefined;

  // Auto-ingest when the store has no data for this ticker
  if (normalizedFilingStore.getByTicker(symbol).length === 0) {
    try {
      const result = await ingestTicker(symbol);
      normalizedFilingStore.upsertAll(result.normalized);
      ingested = true;
    } catch (err) {
      ingestError = err instanceof Error ? err.message : String(err);
    }
  }

  let filings = normalizedFilingStore.getByTicker(symbol);

  // Optional form type filter
  if (typeFilter) {
    filings = filings.filter(f => f.formType === typeFilter);
  }

  // Optional limit
  if (limitStr) {
    const limit = parseInt(limitStr, 10);
    if (!isNaN(limit) && limit > 0) {
      filings = filings.slice(0, limit);
    }
  }

  return NextResponse.json({
    ticker:   symbol,
    count:    filings.length,
    ingested,
    ...(ingestError ? { ingestError } : {}),
    filings,
  });
}
