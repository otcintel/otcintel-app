/**
 * GET /api/admin/universe/status
 *
 * Returns the full company universe status — all companies with their
 * ingestion status, confidence, filing counts, and warnings.
 *
 * Query params:
 *   ?status=pending|parsed|failed|...   — filter by ingestion status
 *   ?confidence=needs_review|...        — filter by confidence status
 *   ?review=true                        — shortcut for confidence=needs_review
 */

import { NextRequest, NextResponse } from 'next/server';
import { companiesDb, filingsDb, runsDb } from '@/lib/db';
import { requireAdminAuth } from '@/lib/api/adminAuth';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  const sp = request.nextUrl.searchParams;
  const statusFilter     = sp.get('status');
  const confidenceFilter = sp.get('review') === 'true' ? 'needs_review' : sp.get('confidence');

  let companies = companiesDb.getAll();

  if (statusFilter)     companies = companies.filter(c => c.ingestionStatus === statusFilter);
  if (confidenceFilter) companies = companies.filter(c => c.confidenceStatus === confidenceFilter);

  const recentRuns = runsDb.getAll().slice(0, 5);

  const byStatus = Object.fromEntries(
    ['pending','ingesting','parsed','partial','failed','stale','needs_review'].map(s => [
      s, companiesDb.getAll().filter(c => c.ingestionStatus === s).length,
    ]),
  );

  const byConfidence = Object.fromEntries(
    ['high_confidence','usable_with_warnings','needs_review','insufficient_data'].map(s => [
      s, companiesDb.getAll().filter(c => c.confidenceStatus === s).length,
    ]),
  );

  return NextResponse.json({
    totalCompanies:   companiesDb.count(),
    totalFilings:     filingsDb.totalCount(),
    byStatus,
    byConfidence,
    recentRuns: recentRuns.map(r => ({
      runId:              r.runId,
      startedAt:          r.startedAt,
      status:             r.status,
      companiesAttempted: r.companiesAttempted,
      companiesCompleted: r.companiesCompleted,
      companiesFailed:    r.companiesFailed,
    })),
    companies: companies.map(c => ({
      cik:                  c.cik,
      ticker:               c.ticker,
      companyName:          c.companyName,
      ingestionStatus:      c.ingestionStatus,
      confidenceStatus:     c.confidenceStatus,
      filingsDiscovered:    c.filingsDiscovered,
      filingsParsed:        c.filingsParsed,
      warningsCount:        c.warningsCount,
      rejectedCandidatesCount: c.rejectedCandidatesCount,
      latestFilingDate:     c.latestFilingDate,
      lastIngestionTime:    c.lastIngestionTime,
      errorMessage:         c.errorMessage,
    })),
  });
}
