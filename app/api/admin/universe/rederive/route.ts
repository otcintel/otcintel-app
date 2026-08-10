/**
 * POST /api/admin/universe/rederive
 *
 * Re-derives confidence status and company intelligence from stored filings
 * WITHOUT re-fetching anything from EDGAR.  Use this after:
 *   - Updating the confidence model (deriveConfidenceStatus)
 *   - Updating the intelligence generator
 *   - Adding companies whose filings are already on disk
 *
 * Safe to call multiple times — idempotent.
 *
 * Body (all optional):
 *   { tickers?: string[] }  — only rederive these tickers
 */

import { NextRequest, NextResponse } from 'next/server';
import { companiesDb, filingsDb, intelligenceDb } from '@/lib/db';
import { requireAdminAuth } from '@/lib/api/adminAuth';
import { applyIngestionResult } from '@/lib/universe/companies';
import { generateCompanyIntelligence } from '@/lib/ingestion/intelligence/companyIntelligence';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const unauthorized = requireAdminAuth(request);
  if (unauthorized) return unauthorized;

  let body: { tickers?: string[] } = {};
  try { body = await request.json(); } catch { /* empty body ok */ }

  const allCompanies = companiesDb.getAll();
  const targets = body.tickers?.length
    ? allCompanies.filter(c => body.tickers!.includes(c.ticker))
    : allCompanies;

  const results: Array<{
    ticker: string;
    oldConfidence: string | undefined;
    newConfidence: string | undefined;
    filingCount: number;
    intelligenceGenerated: boolean;
  }> = [];

  for (const company of targets) {
    const filings = filingsDb.getByTicker(company.ticker);
    const oldConfidence = company.confidenceStatus;

    const updated = applyIngestionResult(company, filings, company.filingsDiscovered);
    companiesDb.upsert(updated);

    const intelligence = generateCompanyIntelligence(company.ticker, filings);
    intelligenceDb.upsert(intelligence);

    results.push({
      ticker:               company.ticker,
      oldConfidence,
      newConfidence:        updated.confidenceStatus,
      filingCount:          filings.length,
      intelligenceGenerated: true,
    });
  }

  const changed = results.filter(r => r.oldConfidence !== r.newConfidence);

  return NextResponse.json({
    ok:             true,
    companiesProcessed: results.length,
    confidenceChanged:  changed.length,
    changes:        changed,
    all:            results,
  });
}
