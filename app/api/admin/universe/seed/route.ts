/**
 * POST /api/admin/universe/seed
 *
 * Resolves all entries in lib/universe/seed.json against EDGAR, then adds any
 * new companies to the persistent company universe (companies.json).
 *
 * Existing companies (same CIK) are skipped, not overwritten.
 * Companies whose tickers cannot be resolved in EDGAR are rejected with a reason.
 *
 * Safe to call multiple times — idempotent.
 *
 * Returns:
 *   { added[], skipped[], failed[{ ticker, reason }], total }
 */

import { NextRequest, NextResponse } from 'next/server';
import { seedCompanyUniverse } from '@/lib/universe/batchIngestor';
import { companiesDb } from '@/lib/db';
import { requireAdminAuth } from '@/lib/api/adminAuth';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;
  try {
    const result = await seedCompanyUniverse();

    return NextResponse.json({
      ok:      true,
      added:   result.added,
      skipped: result.skipped,
      failed:  result.failed,
      total:   companiesDb.count(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function GET(): Promise<NextResponse> {
  const companies = companiesDb.getAll();
  return NextResponse.json({
    total:     companies.length,
    byStatus:  Object.fromEntries(
      ['pending','ingesting','parsed','partial','failed','stale','needs_review'].map(s => [
        s,
        companies.filter(c => c.ingestionStatus === s).length,
      ]),
    ),
    companies: companies.map(c => ({
      cik:             c.cik,
      ticker:          c.ticker,
      companyName:     c.companyName,
      ingestionStatus: c.ingestionStatus,
      confidenceStatus: c.confidenceStatus,
      filingsParsed:   c.filingsParsed,
      warningsCount:   c.warningsCount,
    })),
  });
}
