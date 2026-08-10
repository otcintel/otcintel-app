/**
 * OTCIntel — PostgreSQL companies repository
 *
 * Implements ICompaniesRepository against the `companies` table.
 * All identifiers use CIK as the canonical key; ticker is a queryable
 * denormalized field, not the relational primary key.
 */

import type { CompanyRecord, CompanyIngestionStatus, CompanyConfidenceStatus } from '../../universe/types';
import type { ICompaniesRepository } from '../types';
import { getClient, assertNoError } from './client';

// ─── Row type (matches Supabase table schema) ─────────────────────────────────

interface CompanyRow {
  id: string;
  cik: string;
  ticker: string;
  company_name: string;
  exchange: string | null;
  sec_reporting_status: string | null;
  active: boolean;
  ingestion_status: string;
  confidence_status: string | null;
  filings_discovered: number;
  filings_parsed: number;
  warnings_count: number;
  rejected_candidates_count: number;
  latest_filing_date: string | null;
  last_ingestion_time: string | null;
  last_successful_parse_time: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Mapping ──────────────────────────────────────────────────────────────────

function rowToRecord(row: CompanyRow): CompanyRecord {
  return {
    cik:                      row.cik,
    ticker:                   row.ticker,
    companyName:              row.company_name,
    exchange:                 row.exchange ?? undefined,
    secReportingStatus:       row.sec_reporting_status ?? undefined,
    active:                   row.active,
    ingestionStatus:          row.ingestion_status as CompanyIngestionStatus,
    confidenceStatus:         (row.confidence_status ?? undefined) as CompanyConfidenceStatus | undefined,
    filingsDiscovered:        row.filings_discovered,
    filingsParsed:            row.filings_parsed,
    warningsCount:            row.warnings_count,
    rejectedCandidatesCount:  row.rejected_candidates_count,
    latestFilingDate:         row.latest_filing_date ?? undefined,
    lastIngestionTime:        row.last_ingestion_time ?? undefined,
    lastSuccessfulParseTime:  row.last_successful_parse_time ?? undefined,
    errorMessage:             row.error_message ?? undefined,
    createdAt:                row.created_at,
    updatedAt:                row.updated_at,
  };
}

function recordToUpsertRow(c: CompanyRecord, now: string): Record<string, unknown> {
  return {
    cik:                        c.cik,
    ticker:                     c.ticker.toUpperCase(),
    company_name:               c.companyName,
    exchange:                   c.exchange ?? null,
    sec_reporting_status:       c.secReportingStatus ?? null,
    active:                     c.active,
    ingestion_status:           c.ingestionStatus,
    confidence_status:          c.confidenceStatus ?? null,
    filings_discovered:         c.filingsDiscovered,
    filings_parsed:             c.filingsParsed,
    warnings_count:             c.warningsCount,
    rejected_candidates_count:  c.rejectedCandidatesCount,
    latest_filing_date:         c.latestFilingDate ?? null,
    last_ingestion_time:        c.lastIngestionTime ?? null,
    last_successful_parse_time: c.lastSuccessfulParseTime ?? null,
    error_message:              c.errorMessage ?? null,
    updated_at:                 now,
  };
}

// ─── Repository ───────────────────────────────────────────────────────────────

export const postgresCompaniesDb: ICompaniesRepository = {
  async getAll(): Promise<CompanyRecord[]> {
    const db = getClient();
    const { data, error } = await db
      .from('companies')
      .select('*')
      .order('ticker', { ascending: true });
    assertNoError(error, 'companies.getAll');
    return (data as CompanyRow[]).map(rowToRecord);
  },

  async getByCik(cik: string): Promise<CompanyRecord | undefined> {
    const db = getClient();
    const { data, error } = await db
      .from('companies')
      .select('*')
      .eq('cik', cik)
      .maybeSingle();
    assertNoError(error, `companies.getByCik(${cik})`);
    return data ? rowToRecord(data as CompanyRow) : undefined;
  },

  async getByTicker(ticker: string): Promise<CompanyRecord | undefined> {
    const db = getClient();
    const { data, error } = await db
      .from('companies')
      .select('*')
      .eq('ticker', ticker.toUpperCase())
      .maybeSingle();
    assertNoError(error, `companies.getByTicker(${ticker})`);
    return data ? rowToRecord(data as CompanyRow) : undefined;
  },

  async upsert(company: CompanyRecord): Promise<void> {
    const db = getClient();
    const now = new Date().toISOString();
    const row = {
      ...recordToUpsertRow(company, now),
      created_at: company.createdAt,
    };
    const { error } = await db
      .from('companies')
      .upsert(row, { onConflict: 'cik' });
    assertNoError(error, `companies.upsert(${company.cik})`);
  },

  async upsertAll(companies: CompanyRecord[]): Promise<void> {
    if (companies.length === 0) return;
    const db = getClient();
    const now = new Date().toISOString();
    const rows = companies.map(c => ({
      ...recordToUpsertRow(c, now),
      created_at: c.createdAt,
    }));
    const { error } = await db
      .from('companies')
      .upsert(rows, { onConflict: 'cik' });
    assertNoError(error, 'companies.upsertAll');
  },

  async updateStatus(cik: string, updates: Partial<CompanyRecord>): Promise<void> {
    const db = getClient();
    const columnUpdates: Record<string, unknown> = {};
    if (updates.ingestionStatus   !== undefined) columnUpdates.ingestion_status           = updates.ingestionStatus;
    if (updates.confidenceStatus  !== undefined) columnUpdates.confidence_status          = updates.confidenceStatus;
    if (updates.filingsParsed     !== undefined) columnUpdates.filings_parsed             = updates.filingsParsed;
    if (updates.filingsDiscovered !== undefined) columnUpdates.filings_discovered         = updates.filingsDiscovered;
    if (updates.warningsCount     !== undefined) columnUpdates.warnings_count             = updates.warningsCount;
    if (updates.rejectedCandidatesCount !== undefined) columnUpdates.rejected_candidates_count = updates.rejectedCandidatesCount;
    if (updates.latestFilingDate  !== undefined) columnUpdates.latest_filing_date         = updates.latestFilingDate;
    if (updates.lastIngestionTime !== undefined) columnUpdates.last_ingestion_time        = updates.lastIngestionTime;
    if (updates.lastSuccessfulParseTime !== undefined) columnUpdates.last_successful_parse_time = updates.lastSuccessfulParseTime;
    if (updates.errorMessage      !== undefined) columnUpdates.error_message              = updates.errorMessage ?? null;
    if (updates.active            !== undefined) columnUpdates.active                     = updates.active;
    if (Object.keys(columnUpdates).length === 0) return;
    columnUpdates.updated_at = new Date().toISOString();

    const { error } = await db
      .from('companies')
      .update(columnUpdates)
      .eq('cik', cik);
    assertNoError(error, `companies.updateStatus(${cik})`);
  },

  async count(): Promise<number> {
    const db = getClient();
    const { count, error } = await db
      .from('companies')
      .select('*', { count: 'exact', head: true });
    assertNoError(error, 'companies.count');
    return count ?? 0;
  },
};
