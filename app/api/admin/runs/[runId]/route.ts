/**
 * GET /api/admin/runs/[runId]
 *
 * Returns the full detail of an ingestion run including per-company results.
 *
 * GET /api/admin/runs/latest
 *   Returns the most recently started run.
 */

import { NextResponse } from 'next/server';
import { runsDb } from '@/lib/db';
import { requireAdminAuth } from '@/lib/api/adminAuth';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  const { runId } = await params;

  const run = runId === 'latest'
    ? runsDb.getAll()[0]
    : runsDb.getById(runId);

  if (!run) {
    return NextResponse.json({ error: `Run "${runId}" not found` }, { status: 404 });
  }

  const results = runsDb.getResults(run.runId);

  const durationMs = run.endedAt
    ? Date.parse(run.endedAt) - Date.parse(run.startedAt)
    : undefined;

  // Failure breakdown by stage
  const failuresByStage: Record<string, number> = {};
  for (const r of results.filter(r => r.status === 'failed')) {
    const stage = r.failedStage ?? 'unknown';
    failuresByStage[stage] = (failuresByStage[stage] ?? 0) + 1;
  }

  return NextResponse.json({
    run: {
      runId:               run.runId,
      startedAt:           run.startedAt,
      endedAt:             run.endedAt,
      parserVersion:       run.parserVersion,
      status:              run.status,
      durationMs,
      companiesAttempted:  run.companiesAttempted,
      companiesCompleted:  run.companiesCompleted,
      companiesPartial:    run.companiesPartial,
      companiesFailed:     run.companiesFailed,
      filingsDiscovered:   run.filingsDiscovered,
      filingsDownloaded:   run.filingsDownloaded,
      filingsParsed:       run.filingsParsed,
      warningsCount:       run.warningsCount,
      errors:              run.errors,
    },
    failuresByStage,
    results: results.map(r => ({
      ticker:            r.ticker,
      cik:               r.cik,
      status:            r.status,
      failedStage:       r.failedStage,
      filingsDiscovered: r.filingsDiscovered,
      filingsDownloaded: r.filingsDownloaded,
      filingsParsed:     r.filingsParsed,
      warningsCount:     r.warningsCount,
      durationMs:        r.durationMs,
      errorMessage:      r.errorMessage,
    })),
  });
}
