/**
 * OTCIntel — Mock data assembler (DEV / TEST ONLY)
 *
 * This module is NOT used by any production UI page. It exists solely for
 * dev tooling and tests that reference the mock company fixtures (WXYZ, EFGH, ABCD).
 *
 * Production pages use lib/server-data.ts which reads from the real persistence
 * layer (data/*.json via lib/db/index.ts).
 *
 * Exported API (unchanged — no page modifications required):
 *   companies     — Record<string, CompanyData>  (mock only)
 *   companiesList — CompanyListItem[]            (mock only)
 *
 * In a production app, `buildCompanyData` and `buildCompanyListItem` would be
 * replaced by Supabase RPC calls or joined queries. The mock records in
 * lib/mock/ simulate individual database table responses.
 */

import type { CompanyData, CompanyListItem } from './types';
import { companyProfiles } from './mock/profiles';
import { financingDeals, dilutionEstimates, warrantRecords } from './mock/financing';
import { riskScoreRecords } from './mock/risk';
import { filingRecords } from './mock/filings';

// Re-export types used by pages so they can import from a single location.
export type { CompanyData, CompanyListItem, RiskLevel, RiskColor } from './types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Map a risk color string to its CSS custom property */
function riskColorVar(color: 'red' | 'amber' | 'green'): string {
  return { red: 'var(--red)', amber: 'var(--amber)', green: 'var(--green)' }[color];
}

/** Format a raw price number for the companies list column */
function formatPrice(price: number): string {
  return '$' + price.toFixed(4).replace(/0+$/, '').replace(/\.$/, '').padEnd(4, '0');
}

/** Format a price change for the companies list column */
function formatPriceChange(pct: number, dir: 'up' | 'down'): string {
  const arrow = dir === 'up' ? '▲' : '▼';
  const sign  = dir === 'up' ? '+' : '';
  return `${arrow} ${sign}${pct.toFixed(1)}%`;
}

// ─── Assemblers ───────────────────────────────────────────────────────────────

/**
 * Join all domain records for a single ticker into the full CompanyData view.
 * Mirrors what a Supabase RPC or joined query would return.
 *
 * Throws if any required record is missing — this catches data gaps at build time.
 */
function buildCompanyData(ticker: string): CompanyData {
  const profile  = companyProfiles[ticker];
  const risk     = riskScoreRecords[ticker];
  const deal     = financingDeals[ticker];
  const dilution = dilutionEstimates[ticker];
  const warrants = warrantRecords[ticker];
  const filing   = filingRecords[ticker];

  if (!profile || !risk || !deal || !dilution || !warrants || !filing) {
    throw new Error(
      `buildCompanyData: missing domain record(s) for ticker "${ticker}". ` +
      `Ensure entries exist in all mock files (profiles, risk, financing, filings).`
    );
  }

  const { ticker: _pt, ...dealFields }     = deal;
  const { ticker: _dt, ...dilutionFields } = dilution;
  const { ticker: _wt, ...warrantFields }  = warrants;
  const { ticker: _ft, ...filingFields }   = filing;

  return {
    // ── From CompanyProfile ──
    ticker:                 profile.ticker,
    name:                   profile.name,
    market:                 profile.market,
    sector:                 profile.sector,
    price:                  profile.price,
    priceChangeAmt:         profile.priceChangeAmt,
    priceChangePct:         profile.priceChangePct,
    priceDirection:         profile.priceDirection,
    marketCap:              profile.marketCap,
    sharesOutstanding:      profile.sharesOutstanding,
    floatShares:            profile.floatShares,
    authorizedShares:       profile.authorizedShares,
    preferredShares:        profile.preferredShares,
    reservedShares:         profile.reservedShares,
    sharesRemaining:        profile.sharesRemaining,
    issuedBarPct:           profile.issuedBarPct,
    reservedBarPct:         profile.reservedBarPct,
    issuedBarColor:         profile.issuedBarColor,
    reservedBarColor:       profile.reservedBarColor,
    financingType:          profile.financingTypeLabel,
    financingTypeCategory:  profile.financingTypeCategory,
    // ── From RiskScoreRecord ──
    riskScore:         risk.score,
    riskLevel:         risk.level,
    riskScoreColor:    risk.color,
    riskBarWidth:      risk.barWidth,
    riskFactors:       risk.factors,
    riskDrivers:       risk.drivers,
    bannerVariant:     risk.bannerVariant,
    bannerDotColor:    risk.bannerDotColor,
    bannerPillVariant: risk.bannerPillVariant,
    bannerMessage:     risk.bannerMessage,
    // ── From domain records (ticker stripped) ──
    financing: dealFields,
    dilution:  dilutionFields,
    warrants:  warrantFields,
    filing:    filingFields,
  };
}

/**
 * Build a flattened CompanyListItem from a company profile + risk score record.
 * Used to populate the companies list table.
 */
function buildCompanyListItem(ticker: string): CompanyListItem {
  const profile = companyProfiles[ticker];
  const risk    = riskScoreRecords[ticker];

  if (!profile || !risk) {
    throw new Error(
      `buildCompanyListItem: missing profile or risk record for ticker "${ticker}".`
    );
  }

  return {
    ticker,
    name:           profile.name,
    sub:            profile.sub,
    price:          formatPrice(profile.price),
    priceChange:    formatPriceChange(profile.priceChangePct, profile.priceDirection),
    priceChangeDir: profile.priceDirection,
    marketCap:      profile.marketCap,
    riskScore:      risk.score,
    riskColor:      riskColorVar(risk.color),
    riskClass:      risk.level,
    riskFillWidth:  `${risk.score}%`,
    financingType:  profile.financingTypeLabel,
    riskFilter:     risk.level,
    typeFilter:     profile.financingTypeCategory,
  };
}

// ─── Tickers with full intelligence pages ─────────────────────────────────────

/** Tickers that have complete domain records across all tables */
const INTELLIGENCE_TICKERS = ['WXYZ', 'EFGH', 'ABCD'] as const;

/** Ordered list for the companies table (determines display order) */
const LIST_TICKERS = [
  'ABCD', 'WXYZ', 'EFGH', 'MNOP', 'QRST', 'UVWX', 'GLBX', 'NEXM',
] as const;

// ─── Public exports ───────────────────────────────────────────────────────────

/**
 * Full company intelligence data keyed by ticker.
 * Consumed by: /company/[ticker]/page.tsx
 */
export const companies: Record<string, CompanyData> = Object.fromEntries(
  INTELLIGENCE_TICKERS.map(ticker => [ticker, buildCompanyData(ticker)])
);

/**
 * Flattened company rows for the companies list table.
 * Consumed by: /companies/page.tsx
 */
export const companiesList: CompanyListItem[] = LIST_TICKERS.map(buildCompanyListItem);
