/**
 * OTCIntel — PostgreSQL intelligence repository
 *
 * Implements IIntelligenceRepository against `company_intelligence`.
 * Stores the full CompanyIntelligence object as a JSONB raw_payload,
 * with key metrics denormalized into SQL columns for future analytics.
 */

import type { CompanyIntelligence } from '../../ingestion/types';
import type { IIntelligenceRepository } from '../types';
import { getClient, assertNoError } from './client';

// ─── Row type ─────────────────────────────────────────────────────────────────

interface IntelligenceRow {
  id: string;
  company_id: string;
  ticker: string;
  generated_at: string;
  filings_analyzed: number;
  dilution_risk: string | null;
  latest_shares_outstanding: number | null;
  latest_authorized_shares: number | null;
  total_convertible_principal: number | null;
  toxic_note_count: number | null;
  no_floor_note_count: number | null;
  has_active_eloc: boolean | null;
  total_equity_facility_commitment: number | null;
  total_warrant_shares: number | null;
  raw_payload: unknown;
  created_at: string;
  updated_at: string;
}

// ─── Mapping ──────────────────────────────────────────────────────────────────

function rowToIntelligence(row: IntelligenceRow): CompanyIntelligence {
  return row.raw_payload as CompanyIntelligence;
}

async function getCompanyId(db: ReturnType<typeof getClient>, ticker: string): Promise<string | null> {
  const { data } = await db
    .from('companies')
    .select('id')
    .eq('ticker', ticker.toUpperCase())
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

// ─── Repository ───────────────────────────────────────────────────────────────

export const postgresIntelligenceDb: IIntelligenceRepository = {
  async getByTicker(ticker: string): Promise<CompanyIntelligence | undefined> {
    const db = getClient();
    const { data, error } = await db
      .from('company_intelligence')
      .select('*')
      .eq('ticker', ticker.toUpperCase())
      .maybeSingle();
    assertNoError(error, `intelligence.getByTicker(${ticker})`);
    return data ? rowToIntelligence(data as IntelligenceRow) : undefined;
  },

  async upsert(intelligence: CompanyIntelligence): Promise<void> {
    const db = getClient();
    const ticker = intelligence.ticker.toUpperCase();

    const companyId = await getCompanyId(db, ticker);
    if (!companyId) {
      throw new Error(
        `[OTCIntel/postgres] intelligence.upsert: company with ticker ${ticker} not found.`,
      );
    }

    const fp = intelligence.financingProfile;
    const ov = intelligence.overview;

    const { error } = await db
      .from('company_intelligence')
      .upsert({
        company_id:                       companyId,
        ticker,
        generated_at:                     intelligence.generatedAt,
        filings_analyzed:                 intelligence.filingsAnalyzed,
        dilution_risk:                    ov.dilutionRisk ?? null,
        latest_shares_outstanding:        ov.latestSharesOutstanding ?? null,
        latest_authorized_shares:         ov.latestAuthorizedShares ?? null,
        total_convertible_principal:      fp.totalConvertiblePrincipal ?? null,
        toxic_note_count:                 fp.toxicNoteCount ?? null,
        no_floor_note_count:              fp.noFloorNoteCount ?? null,
        has_active_eloc:                  fp.hasActiveEloc ?? null,
        total_equity_facility_commitment: fp.totalEquityFacilityCommitment ?? null,
        total_warrant_shares:             fp.totalWarrantShares ?? null,
        raw_payload:                      intelligence,
      }, { onConflict: 'company_id' });
    assertNoError(error, `intelligence.upsert(${ticker})`);
  },

  async getAllTickers(): Promise<string[]> {
    const db = getClient();
    const { data, error } = await db
      .from('company_intelligence')
      .select('ticker')
      .order('ticker', { ascending: true });
    assertNoError(error, 'intelligence.getAllTickers');
    return (data as { ticker: string }[]).map(r => r.ticker);
  },
};
