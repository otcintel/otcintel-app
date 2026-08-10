/**
 * Server-only UI data access layer
 *
 * All reads from the persistence layer for use by Next.js server components
 * and server actions. Never import this in client components.
 *
 * This module is the single point of contact between the UI and the
 * repository layer. It does not fabricate missing values.
 *
 * Backend selection is controlled by the PERSISTENCE_BACKEND env var:
 *   filesystem (default) — reads from data/*.json files
 *   postgres             — reads from Supabase/PostgreSQL
 *
 * See lib/db/repositories.ts for backend selection logic.
 */

import 'server-only';
import { getCompaniesRepo, getFilingsRepo } from './db/repositories';
import type { CompanyRecord, CompanyConfidenceStatus, CompanyIngestionStatus } from './universe/types';
import type { NormalizedFiling } from './ingestion/types';

// Re-export types that pages need
export type { CompanyRecord, CompanyConfidenceStatus, CompanyIngestionStatus, NormalizedFiling };

// ─── Company list ─────────────────────────────────────────────────────────────

export interface CompanyRow {
  ticker: string;
  companyName: string;
  cik: string;
  ingestionStatus: CompanyIngestionStatus;
  confidenceStatus: CompanyConfidenceStatus | undefined;
  /** Filings parsed per the CompanyRecord — authoritative count without reading each file */
  filingsParsed: number;
  filingsDiscovered: number;
  latestFilingDate: string | undefined;
  updatedAt: string;
}

/** All ingested companies, sorted alphabetically by ticker. */
export async function getCompanies(): Promise<CompanyRow[]> {
  const repo = await getCompaniesRepo();
  const all = await repo.getAll();
  return all.map(c => ({
    ticker:           c.ticker,
    companyName:      c.companyName,
    cik:              c.cik,
    ingestionStatus:  c.ingestionStatus,
    confidenceStatus: c.confidenceStatus,
    filingsParsed:    c.filingsParsed,
    filingsDiscovered:c.filingsDiscovered,
    latestFilingDate: c.latestFilingDate,
    updatedAt:        c.updatedAt,
  }));
}

// ─── Single company ───────────────────────────────────────────────────────────

/** CompanyRecord for a ticker (case-insensitive). Undefined if not in DB. */
export async function getCompanyRecord(ticker: string): Promise<CompanyRecord | undefined> {
  const repo = await getCompaniesRepo();
  return repo.getByTicker(ticker);
}

/** NormalizedFilings for a ticker, newest-first. Empty array if not ingested. */
export async function getCompanyFilings(ticker: string): Promise<NormalizedFiling[]> {
  const repo = await getFilingsRepo();
  return repo.getByTicker(ticker);
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

export interface RecentFiling {
  ticker: string;
  companyName: string;
  formType: string;
  filedAt: string;
  accessionNumber: string;
  documentUrl: string;
}

export interface DashboardStats {
  companiesTracked: number;
  totalFilingsParsed: number;
  /** Companies with confidence status other than insufficient_data */
  companiesWithIntelligence: number;
  companiesInsufficient: number;
  companiesNeedingReview: number;
  recentFilings: RecentFiling[];
  /** ISO timestamp of the most recent company record update */
  lastUpdated: string | undefined;
}

/**
 * Aggregate statistics from the persistence layer for the dashboard.
 * At current scale (24 companies): acceptable read cost for both backends.
 */
export async function getDashboardStats(): Promise<DashboardStats> {
  const [companiesRepo, filingsRepo] = await Promise.all([
    getCompaniesRepo(),
    getFilingsRepo(),
  ]);

  const companies = await companiesRepo.getAll();

  const companiesTracked          = companies.length;
  const totalFilingsParsed        = companies.reduce((s, c) => s + c.filingsParsed, 0);
  const companiesWithIntelligence = companies.filter(
    c => c.confidenceStatus && c.confidenceStatus !== 'insufficient_data',
  ).length;
  const companiesInsufficient     = companies.filter(
    c => c.confidenceStatus === 'insufficient_data',
  ).length;
  const companiesNeedingReview    = companies.filter(
    c => c.confidenceStatus === 'needs_review',
  ).length;

  const lastUpdated = companies
    .map(c => c.updatedAt)
    .sort()
    .at(-1);

  // Collect most-recent filing per company, then take 10 globally newest
  const recentFilings: RecentFiling[] = [];
  for (const company of companies) {
    const filings = await filingsRepo.getByTicker(company.ticker);
    const latest  = filings[0];
    if (latest) {
      recentFilings.push({
        ticker:          company.ticker,
        companyName:     company.companyName,
        formType:        latest.formType,
        filedAt:         latest.filedAt,
        accessionNumber: latest.accessionNumber,
        documentUrl:     latest.documentUrl,
      });
    }
  }

  recentFilings.sort((a, b) => b.filedAt.localeCompare(a.filedAt));

  return {
    companiesTracked,
    totalFilingsParsed,
    companiesWithIntelligence,
    companiesInsufficient,
    companiesNeedingReview,
    recentFilings: recentFilings.slice(0, 10),
    lastUpdated,
  };
}
