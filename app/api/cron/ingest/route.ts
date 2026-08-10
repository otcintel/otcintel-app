/**
 * POST /api/cron/ingest
 *
 * Authenticated scheduled ingestion endpoint with deterministic batching.
 *
 * Authentication:
 *   Authorization: Bearer <CRON_SECRET>   (separate from ADMIN_SECRET)
 *
 * Batching:
 *   The 24-company universe is divided into batches of 6. Each invocation
 *   processes one batch, rotating through the full universe every 4 calls.
 *
 *   Batch index is derived from the UTC hour automatically, OR overridden
 *   via the ?batch=N query parameter (0-indexed, clamped to valid range).
 *   The ?batch param is intended for manual triggering and tests only.
 *
 *   Scheduler recommendation: fire every 6 hours at UTC hours 0, 6, 12, 18.
 *   Full rotation = 24 hours.
 *
 * Ingestion behavior:
 *   - includeAlreadyParsed: true   check every company, not just pending/failed
 *   - forceReparse: false          skip accessions already at current PARSER_VERSION
 *
 * Response:
 *   {
 *     ok, batch: { index, count, size, tickers },
 *     runId, status,
 *     companiesAttempted, companiesCompleted, companiesPartial, companiesFailed,
 *     filingsDiscovered, filingsDownloaded, filingsParsed,
 *     warningsCount, errors, startedAt, endedAt
 *   }
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCronAuth } from '@/lib/api/cronAuth';
import { runBatchIngestion } from '@/lib/universe/batchIngestor';
import { getCompaniesRepo } from '@/lib/db/repositories';
import {
  selectBatch,
  batchCount,
  currentBatchIndex,
  CRON_BATCH_SIZE,
} from '@/lib/universe/batchSelection';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const unauthorized = requireCronAuth(request);
  if (unauthorized) return unauthorized;

  // Use the backend-aware repository so that PERSISTENCE_BACKEND=postgres
  // sources companies from Supabase on Vercel (where the filesystem is empty).
  const companiesRepo = await getCompaniesRepo();
  const allTickers = (await companiesRepo.getAll()).map(c => c.ticker);
  const totalBatches = batchCount(allTickers.length, CRON_BATCH_SIZE);

  // Resolve batch index: explicit ?batch=N param takes precedence over
  // time-based selection so tests and manual triggers are fully deterministic.
  const batchParam = request.nextUrl.searchParams.get('batch');
  let batchIndex: number;
  if (batchParam !== null) {
    const parsed = parseInt(batchParam, 10);
    batchIndex = Number.isFinite(parsed)
      ? Math.max(0, Math.min(parsed, totalBatches - 1))
      : currentBatchIndex(totalBatches);
  } else {
    batchIndex = currentBatchIndex(totalBatches);
  }

  const batchTickers = selectBatch(allTickers, batchIndex, CRON_BATCH_SIZE);

  // Safeguard: if the universe is empty there is nothing to ingest.
  if (batchTickers.length === 0) {
    return NextResponse.json({
      ok:    true,
      batch: { index: batchIndex, count: totalBatches, size: 0, tickers: [] },
      message: 'No companies in universe — nothing to ingest.',
    });
  }

  try {
    const run = await runBatchIngestion({
      tickers:              batchTickers,
      includeAlreadyParsed: true,
      forceReparse:         false,
    });

    return NextResponse.json({
      ok: true,
      batch: {
        index:   batchIndex,
        count:   totalBatches,
        size:    batchTickers.length,
        tickers: batchTickers,
      },
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
      errors:              run.errors,
      startedAt:           run.startedAt,
      endedAt:             run.endedAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
