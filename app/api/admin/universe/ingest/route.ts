/**
 * POST /api/admin/universe/ingest
 *
 * Triggers batch ingestion for the company universe.
 *
 * Request body (all optional):
 *   {
 *     tickers?: string[]       — ingest only these tickers (must already be in universe)
 *     includeAlreadyParsed?: boolean  — re-check 'parsed' companies for new filings
 *     forceReparse?: boolean   — ignore skipAccessions; reparse everything
 *     async?: boolean          — start background run, return runId immediately (default false)
 *     verbose?: boolean        — emit console.log progress
 *   }
 *
 * Synchronous mode (async: false, default):
 *   Runs the full batch in-request. Suitable for small batches (≤ 10 companies).
 *   Returns the completed IngestionRun.
 *
 * Asynchronous mode (async: true):
 *   Starts ingestion in the background, returns { runId } immediately.
 *   Check progress via GET /api/admin/runs/{runId}.
 *
 * POST /api/admin/universe/ingest/[ticker]
 *   Ingest a single company by ticker. Always synchronous.
 */

import { NextRequest, NextResponse } from 'next/server';
import { runBatchIngestion, getActiveRuns } from '@/lib/universe/batchIngestor';
import { requireAdminAuth } from '@/lib/api/adminAuth';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  let body: {
    tickers?: string[];
    includeAlreadyParsed?: boolean;
    forceReparse?: boolean;
    async?: boolean;
    verbose?: boolean;
  } = {};

  try {
    body = await request.json();
  } catch { /* empty body is fine — use defaults */ }

  const opts = {
    tickers:              body.tickers,
    includeAlreadyParsed: body.includeAlreadyParsed ?? false,
    forceReparse:         body.forceReparse ?? false,
    verbose:              body.verbose ?? true,
  };

  if (body.async) {
    // Fire-and-forget background run
    const runPromise = runBatchIngestion(opts);
    // Extract run ID from the first DB write (run record is created synchronously
    // inside runBatchIngestion before any awaits — peek via getActiveRuns())
    // Give the function a tick to register itself
    await new Promise<void>(resolve => setImmediate(resolve));
    const activeRuns = getActiveRuns();
    const runId = activeRuns[activeRuns.length - 1] ?? 'unknown';

    runPromise.catch(err => {
      console.error('[batch] Background ingestion failed:', err);
    });

    return NextResponse.json({ ok: true, async: true, runId });
  }

  // Synchronous run
  try {
    const run = await runBatchIngestion(opts);
    return NextResponse.json({
      ok:                  true,
      runId:               run.runId,
      status:              run.status,
      companiesAttempted:  run.companiesAttempted,
      companiesCompleted:  run.companiesCompleted,
      companiesPartial:    run.companiesPartial,
      companiesFailed:     run.companiesFailed,
      filingsDiscovered:   run.filingsDiscovered,
      filingsDownloaded:   run.filingsDownloaded,
      filingsParsed:       run.filingsParsed,
      warningsCount:       run.warningsCount,
      durationMs:          run.endedAt
        ? Date.parse(run.endedAt) - Date.parse(run.startedAt)
        : undefined,
      errors: run.errors,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
