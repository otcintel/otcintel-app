/**
 * OTCIntel — Domain Type Definitions
 *
 * Interfaces are organized by domain to mirror the intended database schema.
 * Each domain interface maps to one logical table in the backend.
 * The assembled CompanyData and CompanyListItem interfaces are the consumed
 * view types used by UI pages.
 */

// ─── Shared primitives ────────────────────────────────────────────────────────

export type RiskLevel = 'high' | 'med' | 'low';
export type RiskColor = 'red' | 'amber' | 'green';

/** CSS modifier class applied to data values in the UI */
export type DataClass = 'danger' | 'warning' | 'positive' | 'muted' | '';

// ─── Sub-record shapes ────────────────────────────────────────────────────────

/** A single factor row in the risk score breakdown */
export interface RiskFactor {
  name: string;
  fillWidth: number;   // 0–100 (percentage)
  fillColor: string;   // CSS color value
  label: string;       // "High" | "Med" | "Low"
  labelColor: string;  // CSS color value
}

/** A narrative driver entry explaining a risk score component */
export interface RiskDriver {
  dotColor: string; // CSS color value
  text: string;     // may contain inline HTML (<strong>)
}

/** A single term row in the filing terms grid */
export interface FilingTerm {
  label: string;
  value: string;
  className: DataClass;
}

// ─── Domain records (map 1-to-1 with DB tables) ──────────────────────────────

/**
 * Core company identity, pricing, and share structure.
 * DB table: companies
 */
export interface CompanyProfile {
  ticker: string;
  name: string;
  /** Full display string e.g. "OTC Markets · Common Stock · Pink Sheets · Industrials" */
  market: string;
  /** Short exchange label e.g. "OTC · Pink Sheets" */
  sub: string;
  sector: string;
  price: number;
  priceChangeAmt: number;
  priceChangePct: number;
  priceDirection: 'up' | 'down';
  marketCap: string;
  sharesOutstanding: number;
  floatShares: number;
  authorizedShares: number;
  preferredShares: number;
  reservedShares: number;
  sharesRemaining: number;
  /** Issued shares as % of authorized — used for cap bar width */
  issuedBarPct: number;
  /** Reserved shares as % of authorized — used for cap bar width */
  reservedBarPct: number;
  issuedBarColor: string;
  reservedBarColor: string;
  /** Display label for financing type e.g. "Convertible Note" */
  financingTypeLabel: string;
  financingTypeCategory: 'convertible' | 'equity' | 'none';
}

/**
 * Active financing deal terms as disclosed in public filings.
 * DB table: financing_deals
 */
export interface FinancingDeal {
  ticker: string;
  type: string;
  /** Controls the color of the "Active" tag in the card header */
  tagVariant: 'danger' | 'warning' | 'positive' | 'neutral';
  principal: string;
  discount: string;
  discountClass: DataClass;
  lookback: string;
  floorPrice: string;
  floorPriceClass: DataClass;
  resetProvisions: string;
  resetClass: DataClass;
  maturityDate: string;
  investor: string;
}

/**
 * Estimated dilution exposure derived from the active financing deal.
 * DB table: dilution_estimates
 */
export interface DilutionEstimate {
  ticker: string;
  conversionPrice: string;
  sharesFromNote: string;
  sharesFromNoteClass: DataClass;
  sharesFromWarrants: string;
  sharesFromWarrantsClass: DataClass;
  totalNewShares: string;
  totalNewSharesClass: DataClass;
  fullyDiluted: string;
  dilutionPct: string;
  dilutionPctClass: DataClass;
  /** Disclaimer note rendered below the dilution table */
  disclaimer: string;
}

/**
 * Warrants issued in connection with an active financing deal.
 * DB table: warrants
 */
export interface WarrantRecord {
  ticker: string;
  shares: string;
  sharesClass: DataClass;
  exercisePrice: string;
  expiration: string;
  overhangPct: string;
  overhangPctClass: DataClass;
  issuedWith: string;
  status: string;
  statusClass: DataClass;
  /** Label for the last row in the overhang card (varies by deal structure) */
  lastFieldLabel: string;
  lastFieldValue: string;
  lastFieldClass: DataClass;
}

/**
 * Risk score assessment and scoring breakdown.
 * DB table: risk_scores
 */
export interface RiskScoreRecord {
  ticker: string;
  score: number;    // 0–100
  level: RiskLevel;
  color: RiskColor;
  /** Width of the risk bar fill in the score display — same as score but typed separately */
  barWidth: number;
  // Banner (alert strip at the top of the company page)
  bannerVariant: 'red-risk' | 'amber-risk' | 'green-risk';
  bannerDotColor: string;
  bannerPillVariant: RiskColor;
  /** Banner message — may contain inline HTML (<strong>) */
  bannerMessage: string;
  // Score breakdown
  factors: RiskFactor[];
  drivers: RiskDriver[];
  // Scoring provenance
  /** Always 'valid': eligibility gate guarantees discountRate is present before scoring. */
  scoreBasis: 'valid';
  /** Factor names whose values were extracted from filing text. */
  knownFactors: string[];
  /** Factor names whose values were not in the filing and were inferred or defaulted. */
  unknownFactors: string[];
  /** Human-readable notes about conservative inferences applied to unknown factors. */
  dataWarnings: string[];
}

/**
 * Most recent SEC filing record for a tracked company.
 * DB table: filings
 */
export interface FilingRecord {
  ticker: string;
  type: string;   // e.g. "8-K", "S-1", "10-K/A"
  date: string;
  cik: string;
  /**
   * 1–2 sentence plain-text description of the primary event in the filing.
   * Extracted by the ingestion pipeline's event summary parser (8-K / 8-K/A only).
   * Displayed as a short teaser above the full narrative summary on the company page.
   */
  eventSummary?: string;
  /** Classified event category — mirrors EventType in the ingestion layer. */
  eventType?: string;
  /** Narrative summary — may contain inline HTML (<strong>) */
  summary: string;
  terms: FilingTerm[];
  tags: string[];
}

// ─── Assembled view types (consumed by UI pages) ─────────────────────────────

/**
 * Full company intelligence — the result of joining all domain records.
 * This is what the company intelligence page consumes.
 * In a real app, this would be the result of a Supabase RPC or joined query.
 */
export interface CompanyData {
  // From CompanyProfile
  ticker: string;
  name: string;
  market: string;
  sector: string;
  price: number;
  priceChangeAmt: number;
  priceChangePct: number;
  priceDirection: 'up' | 'down';
  marketCap: string;
  sharesOutstanding: number;
  floatShares: number;
  authorizedShares: number;
  preferredShares: number;
  reservedShares: number;
  sharesRemaining: number;
  issuedBarPct: number;
  reservedBarPct: number;
  issuedBarColor: string;
  reservedBarColor: string;
  financingType: string;
  financingTypeCategory: 'convertible' | 'equity' | 'none';
  // From RiskScoreRecord
  riskScore: number;
  riskLevel: RiskLevel;
  riskScoreColor: RiskColor;
  riskBarWidth: number;
  riskFactors: RiskFactor[];
  riskDrivers: RiskDriver[];
  bannerVariant: 'red-risk' | 'amber-risk' | 'green-risk';
  bannerDotColor: string;
  bannerPillVariant: RiskColor;
  bannerMessage: string;
  // From FinancingDeal (nested, ticker stripped)
  financing: Omit<FinancingDeal, 'ticker'>;
  // From DilutionEstimate (nested, ticker stripped)
  dilution: Omit<DilutionEstimate, 'ticker'>;
  // From WarrantRecord (nested, ticker stripped)
  warrants: Omit<WarrantRecord, 'ticker'>;
  // From FilingRecord (nested, ticker stripped)
  filing: Omit<FilingRecord, 'ticker'>;
}

/**
 * Flattened row shape for the companies list table.
 * Built from CompanyProfile + RiskScoreRecord.
 */
export interface CompanyListItem {
  ticker: string;
  name: string;
  sub: string;
  price: string;
  priceChange: string;
  priceChangeDir: 'up' | 'down';
  marketCap: string;
  riskScore: number;
  riskColor: string;
  riskClass: RiskLevel;
  riskFillWidth: string;
  financingType: string;
  riskFilter: RiskLevel;
  typeFilter: 'convertible' | 'equity' | 'none';
}
