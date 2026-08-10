/**
 * OTCIntel — Ingestion Layer Types
 *
 * All types specific to the data ingestion pipeline.
 * These represent the shapes flowing through: fetch → parse → normalize.
 *
 * Separation from lib/types.ts is intentional — ingestion types are
 * internal pipeline concerns; lib/types.ts types are UI-facing contracts.
 */

import type { FilingTerm } from '../types';

// ─── SEC form classification ──────────────────────────────────────────────────

export type SecFormType =
  | '8-K'
  | '8-K/A'
  | '10-K'
  | '10-K/A'
  | '10-Q'
  | '10-Q/A'
  | 'S-1'
  | 'S-1/A'
  | 'S-3'
  | 'S-3/A'
  | 'S-8'
  | '1-A'
  | '1-A/A'
  | 'NT 10-Q'
  | 'NT 10-K';

/**
 * Tier 1 — highest-signal forms for dilution and financing analysis.
 * These are prioritized first when building the filing result set.
 */
export const TIER_1_FORM_TYPES: SecFormType[] = ['8-K', '8-K/A', '10-Q', '10-Q/A', '10-K', '10-K/A'];

/**
 * Tier 2 — offering and registration forms; high signal for financing analysis.
 * Prioritized over everything else (Form 4, 144, etc.) but below Tier 1.
 */
export const TIER_2_FORM_TYPES: SecFormType[] = ['S-1', 'S-1/A', 'S-3', 'S-3/A', 'S-8', '1-A', '1-A/A'];

/** Which forms contain financing-relevant disclosures */
export const FINANCING_FORM_TYPES: SecFormType[] = [
  '8-K', '8-K/A',
  'S-1', 'S-1/A',
  'S-3', 'S-3/A',
  'S-8',
  '1-A', '1-A/A',
];

/** Which forms contain share structure updates */
export const STRUCTURE_FORM_TYPES: SecFormType[] = [
  '10-K', '10-K/A',
  '10-Q', '10-Q/A',
  '8-K', '8-K/A',
  'S-1', 'S-1/A',
  'S-3', 'S-3/A',
  'S-8',
  '1-A', '1-A/A',
];

export type ExtractionConfidence = 'high' | 'medium' | 'low';

export type FinancingType =
  | 'convertible_note'
  | 'equity_line'
  | 'preferred_stock'
  | 'warrant_only'
  | 'unknown';

export type EventType =
  | 'financing'
  | 'partnership'
  | 'product_launch'
  | 'management_change'
  | 'operational_update'
  | 'other';

// ─── Step 1: Raw (fetched) ────────────────────────────────────────────────────

/**
 * Raw filing metadata returned by a filing fetcher.
 * Mirrors the structure of the SEC EDGAR submissions API response.
 * `text` is populated in a second pass by fetchFilingText().
 */
export interface RawFiling {
  accessionNumber: string;   // e.g. "0001876543-26-000001"
  ticker: string;
  cik: string;               // zero-padded, e.g. "0001876543"
  formType: SecFormType;
  filedAt: string;           // ISO date, e.g. "2026-03-18"
  periodOfReport: string;    // ISO date
  /** URL to the primary HTML/text document (for display/linking) */
  documentUrl: string;
  /** URL to the full submission text file (for parsing) */
  fullTextUrl: string;
  /** 8-K item numbers, comma-separated, e.g. "1.01,9.01" */
  items?: string;
  /** Full filing text — populated by fetchFilingText(), undefined until then */
  text?: string;
}

// ─── Step 2: Parsed (extracted) ──────────────────────────────────────────────

/**
 * Financing terms extracted from a filing's text.
 * Produced by parsers/financing.ts.
 */
export interface ExtractedFinancingTerms {
  financingType: FinancingType;
  /** Face value in USD */
  principalAmount?: number;
  /** 0–1, e.g. 0.22 for a 22% discount */
  discountRate?: number;
  /** VWAP lookback period in trading days */
  lookbackDays?: number;
  /** Floor conversion price in USD; null means no floor was stated */
  floorPrice?: number | null;
  hasFloorPrice: boolean;
  hasResetProvisions: boolean;
  warrantShares?: number;
  warrantExercisePrice?: number;
  /** ISO date or human-readable string */
  maturityDate?: string;
  investorName?: string;
  confidence: ExtractionConfidence;
  /** Raw text snippets that triggered each extraction (for debugging + audit) */
  matchedPhrases: string[];
}

/**
 * Share structure data extracted from a filing's text.
 * Produced by parsers/shareStructure.ts.
 */
export interface ExtractedShareStructure {
  sharesAuthorized?: number;
  sharesOutstanding?: number;
  sharesFloat?: number;
  preferredSharesOutstanding?: number;
  confidence: ExtractionConfidence;
  matchedPhrases: string[];
}

/**
 * Share structure data sourced from OTC Markets (supplementary).
 * Used when SEC filings do not contain extractable share structure data.
 * Populated by lib/ingestion/enrichment/otcMarkets.ts.
 */
export interface OtcShareStructure {
  sharesOutstanding?: number;
  sharesFloat?: number;
  authorizedShares?: number;
  /** ISO timestamp of when this data was fetched from OTC Markets */
  fetchedAt: string;
  /** Full URL used to retrieve the data — for attribution and debugging */
  sourceUrl: string;
}

/**
 * Dilution-related language extracted from a filing's text.
 * Produced by parsers/dilution.ts.
 */
export interface ExtractedDilutionLanguage {
  hasDilutionWarning: boolean;
  /** Verbatim excerpts mentioning dilution */
  dilutionPhrases: string[];
  estimatedNewShares?: number;
  estimatedDilutionPct?: number;
  confidence: ExtractionConfidence;
}

/**
 * The output of running all parsers against a single RawFiling.
 * Each extraction field is optional — not every filing contains all data types.
 */
export interface ParsedFiling {
  raw: RawFiling;
  financing?: ExtractedFinancingTerms;
  shareStructure?: ExtractedShareStructure;
  dilution?: ExtractedDilutionLanguage;
  /**
   * 1–2 sentence plain-text description of the primary event in an 8-K.
   * Populated by parsers/eventSummary.ts for 8-K and 8-K/A form types only.
   */
  eventSummary?: string;
  /** Classified event category (8-K / 8-K/A only). Set by parsers/eventType.ts. */
  eventType?: EventType;
  /**
   * Structured financing and dilution report.
   * Only populated for 10-K, 10-K/A, 10-Q, 10-Q/A form types.
   */
  financingReport?: FinancingReport;
  /** ISO timestamp of when parsing occurred */
  parsedAt: string;
  /** Non-fatal errors encountered during parsing */
  parseErrors: string[];
}

// ─── Step 3: Normalized (UI-ready) ───────────────────────────────────────────

/**
 * The final normalized shape stored per filing after ingestion.
 * This is what gets persisted (to a DB in production, to mock data in dev)
 * and consumed by the data assembler in lib/data.ts.
 *
 * The `summary`, `terms`, and `tags` fields are the UI-ready fields that
 * map directly to FilingRecord in lib/types.ts. They are populated by
 * normalize.ts from the raw parsed extractions.
 */
export interface NormalizedFiling {
  // ── Identity ──
  ticker: string;
  formType: SecFormType;
  filedAt: string;
  periodOfReport: string;
  cik: string;
  accessionNumber: string;
  documentUrl: string;
  // ── Parsed extractions (preserved for downstream use) ──
  financing?: ExtractedFinancingTerms;
  shareStructure?: ExtractedShareStructure;
  /**
   * Supplementary share structure from OTC Markets.
   * Only populated when no SEC filing in this ingestion run contained
   * extractable share structure data.
   * SEC data (shareStructure) always takes precedence over this field.
   */
  otcShareStructure?: OtcShareStructure;
  dilution?: ExtractedDilutionLanguage;
  /**
   * Structured financing and dilution report (10-K / 10-Q only).
   * Summarizes convertible debt, equity issuances, conversions, warrants,
   * related-party transactions, equity facilities, and dilution metrics.
   */
  financingReport?: FinancingReport;
  // ── UI-ready display fields (generated by normalize.ts) ──
  /**
   * 1–2 sentence plain-text description of the primary event (8-K / 8-K/A only).
   * Extracted by parsers/eventSummary.ts; suitable for display without further processing.
   */
  eventSummary?: string;
  /** Classified event category (8-K / 8-K/A only). Set by parsers/eventType.ts. */
  eventType?: EventType;
  /** Narrative summary with inline HTML (<strong> tags allowed) */
  summary?: string;
  /** Structured terms for the filing terms grid */
  terms?: FilingTerm[];
  /** Tag chips shown below the filing summary */
  tags?: string[];
  // ── Ingestion metadata ──
  /** ISO timestamp of when ingestion completed */
  ingestedAt: string;
  /** Source used to fetch this filing */
  source: 'mock' | 'edgar' | 'third-party';
  parseErrors: string[];
  /** Semver of the parser that produced this record — used for controlled reprocessing */
  parserVersion?: string;
}

// ─── Field-level attribution types ───────────────────────────────────────────

export interface FieldProvenanceEntry {
  sourceText:      string;
  sentenceIndex:   number;
  paragraphIndex?: number;
  anchorDistance?: number;
  method:          'primary' | 'enrichment';
}

export interface RejectedCandidate {
  field:           string;
  value:           unknown;
  sourceText?:     string;
  sentenceIndex?:  number;
  reason:          string;
}

// ─── Financing report (10-K / 10-Q) ──────────────────────────────────────────

/**
 * A single convertible note or debt instrument found in a 10-K / 10-Q.
 */
export interface ConvertibleNote {
  // ── Identity ────────────────────────────────────────────────────────────────
  /** Instrument name as stated in filing, e.g. "First Convertible Note", "Note A" */
  instrumentName?: string;
  /** Instrument classification derived from filing language */
  instrumentType?: 'convertible_note' | 'promissory_note' | 'bridge_note' | 'demand_note' | 'debenture' | 'other';
  /** True when this document is an amendment or restatement of a prior note */
  isAmendment?: boolean;
  /** True when this note explicitly replaced or cancelled a prior note */
  isReplacement?: boolean;
  /** Investor / lender name */
  investorName?: string;
  /** Free-text descriptor, e.g. "First Tranche", "Note #3" */
  label?: string;

  // ── Economics ───────────────────────────────────────────────────────────────
  /** Original face value in USD */
  principalAmount?: number;
  /** Actual consideration paid for the note — may be less than principal when OID exists */
  purchasePrice?: number;
  /** Original Issue Discount in USD (= principalAmount − purchasePrice) */
  originalIssueDiscount?: number;
  /** Net cash proceeds received after deducting all fees */
  netProceeds?: number;
  /** Legal fees deducted from proceeds, in USD */
  legalFees?: number;
  /** Placement agent / finder fees deducted from proceeds, in USD */
  placementFees?: number;
  /** Outstanding balance remaining (may differ from principal after partial conversions) */
  outstandingBalance?: number;
  /** Annual interest rate, 0–1 (e.g. 0.08 for 8%) */
  interestRate?: number;
  /** Annual interest rate that applies upon an event of default, 0–1 */
  defaultInterestRate?: number;
  /** ISO date or human-readable date string */
  maturityDate?: string;
  /** Date the note was originally executed/entered into */
  executionDate?: string;
  /**
   * Prepayment premium as a fraction above par (e.g. 0.25 = must pay 125% of outstanding).
   * 0 = no premium; 0.25 = 25% premium above par.
   */
  prepaymentPremium?: number;
  /** Free-text description of prepayment / early redemption terms */
  prepaymentTerms?: string;
  /** Redemption premium at maturity, as fraction above par (e.g. 0.10 = 110% of face value) */
  redemptionPremium?: number;

  // ── Conversion ──────────────────────────────────────────────────────────────
  /** Human-readable description of the full conversion formula */
  conversionFormula?: string;
  /**
   * Fixed conversion price in USD per share.
   * Only set when the filing explicitly states a fixed price (e.g. "conversion price of $0.001").
   * Presence of this field (not discountRate) triggers the 'fixed' tier classification.
   */
  fixedConversionPrice?: number;
  /** 0–1, e.g. 0.22 for a 22% discount to VWAP */
  discountRate?: number;
  /** VWAP lookback period in trading days */
  lookbackDays?: number;
  /** Floor conversion price in USD; null = no floor stated */
  floorPrice?: number | null;
  hasFloorPrice: boolean;
  /** Ceiling / maximum conversion price in USD */
  ceilingPrice?: number;
  /** Maximum shares issuable under this note (exchange compliance cap) */
  exchangeCap?: number;
  /** Beneficial ownership blocker as a fraction (e.g. 0.0499 for 4.99%) */
  beneficialOwnershipBlocker?: number;
  hasResetProvisions: boolean;
  /** Broader anti-dilution provisions (MFN clauses, full-ratchet, weighted-average) */
  antiDilutionProvisions?: boolean;

  // ── Defaults ────────────────────────────────────────────────────────────────
  /** Key events of default described in the filing (up to 5 excerpts) */
  eventsOfDefault?: string[];
  /** Description of lender conversion or acceleration rights upon default */
  defaultConversionRights?: string;
  /** True when the note includes an explicit acceleration-on-default clause */
  hasAccelerationClause?: boolean;
  /** Additional penalty rate upon default, as fraction (e.g. 0.02 per month) */
  penaltyRate?: number;

  // ── Status ──────────────────────────────────────────────────────────────────
  /** Current status of this note as of the filing date */
  status?: 'outstanding' | 'converted' | 'repaid' | 'settled' | 'cancelled' | 'matured' | 'unknown';
  /** Principal amount already converted to equity, in USD */
  amountConverted?: number;
  /** Principal amount already repaid in cash, in USD */
  amountRepaid?: number;

  // ── Provenance ──────────────────────────────────────────────────────────────
  /** True when the trigger text or surrounding context explicitly mentions "convertible" */
  isExplicitlyConvertible?: boolean;
  /** Raw text excerpt that yielded this record */
  matchedPhrase?: string;
  /** Note number from the filing's Notes to Financial Statements, if detected */
  _noteNumber?: number;
  /** Section of the filing where this record was extracted */
  _section?: string;
  /** Sentence indices (within the note block) that contributed to this record */
  _sourceSentences?: number[];
  /** Per-field extraction confidence scores (0–1) keyed by field name */
  _fieldConfidence?: Partial<Record<string, number>>;
  /** Structured validation warnings detected on this specific note */
  _validationWarnings?: string[];
  /** Raw text of source sentences — populated during extraction for debugging */
  _sourceSentenceTexts?: string[];
  /** Sentence index of the primary anchor that established this note's existence */
  _anchorSentenceIndex?: number;
  /** Principal amount from the anchor sentence — used for contamination ratio checks */
  _anchorPrincipalAmount?: number;
  /** Per-field attribution: how each extracted value was sourced */
  _fieldProvenance?: Record<string, FieldProvenanceEntry>;
  /** Fields that were rejected due to contamination — debug endpoint only */
  _rejectedCandidates?: RejectedCandidate[];
}

/**
 * A single equity issuance event (common stock, preferred stock, or at-the-market).
 */
export interface EquityIssuance {
  /** Number of shares issued */
  sharesIssued?: number;
  /** Price per share in USD */
  pricePerShare?: number;
  /** Gross proceeds in USD */
  grossProceeds?: number;
  /** Type of issuance */
  issuanceType?: 'common' | 'preferred' | 'atm' | 'registered_direct' | 'other';
  /** Investor / purchaser name */
  investorName?: string;
  /** ISO date or human-readable date string */
  issuanceDate?: string;
  matchedPhrase?: string;
  _noteNumber?: number;
  _section?: string;
  _sourceSentences?: number[];
}

/**
 * A single debt-to-equity conversion event.
 */
export interface ConversionRecord {
  /** Amount of debt (USD) converted */
  debtConverted?: number;
  /** Number of shares issued on conversion */
  sharesIssued?: number;
  /** Effective conversion price per share in USD */
  effectivePrice?: number;
  /** ISO date or human-readable date string */
  conversionDate?: string;
  /** Investor / holder name */
  investorName?: string;
  matchedPhrase?: string;
  _noteNumber?: number;
  _section?: string;
  _sourceSentences?: number[];
}

/**
 * A single warrant grant.
 */
export interface WarrantRecord {
  /** Number of warrant shares */
  warrantShares?: number;
  /** Exercise price per share in USD */
  exercisePrice?: number;
  /** ISO date or human-readable date string */
  expirationDate?: string;
  /** Recipient / holder name */
  recipientName?: string;
  /** Context: whether these were issued in connection with a note or offering */
  issuedWithNote?: boolean;
  matchedPhrase?: string;
  _noteNumber?: number;
  _section?: string;
  _sourceSentences?: number[];
}

/**
 * What a related-party amount represents.
 * Distinguishes balance-sheet snapshots from period cash flows —
 * never sum 'beginning_balance' + 'ending_balance' + 'advance' from the same period.
 */
export type RelatedPartyBasis =
  | 'ending_balance'       // balance at end of period (balance-sheet snapshot — use this for totals)
  | 'beginning_balance'    // balance at start of period
  | 'period_activity'      // net change during the period
  | 'compensation_expense' // salary / bonus / consulting fee recognized
  | 'repayment'            // cash paid back to the related party
  | 'advance'              // new funds loaned / drawn
  | 'unknown';             // basis could not be determined from context

/**
 * A transaction with a related party (officer, director, major shareholder, affiliate).
 */
export interface RelatedPartyTransaction {
  /** Description of the relationship */
  partyDescription?: string;
  /** Amount in USD */
  amount?: number;
  /** Nature of the transaction */
  transactionType?: 'loan' | 'compensation' | 'lease' | 'service' | 'other';
  /**
   * The economic basis of this amount.
   * Only 'ending_balance' records with confidence >= 0.85 are used for company-level totals.
   * Activity records (advance, repayment, period_activity) must NOT be stacked with balances.
   */
  basis?: RelatedPartyBasis;
  /**
   * Extraction confidence 0–1.
   * 0.90+ = explicit loan-balance phrase in source text (loan payable, amount due to, etc.)
   * 0.70–0.84 = generic balance/outstanding language without explicit loan-balance phrase
   * Only records with confidence >= 0.85 and basis = ending_balance count toward totals.
   */
  confidence?: number;
  /** The exact phrase that triggered the basis classification, for diagnostics */
  matchedPhrase?: string;
  /** Full combined source text of matched sentences — diagnostic only, not stored in prod */
  _sourceText?: string;
  /** Current-period balance extracted from the phrase sentence (overrides sentence-layer amount) */
  currentBalance?: number;
  /** Prior-period balance extracted from the same sentence */
  priorBalance?: number;
  /** Date string associated with currentBalance (as stated in the filing) */
  currentBalanceDate?: string;
  /** Date string associated with priorBalance */
  priorBalanceDate?: string;
  _noteNumber?: number;
  _section?: string;
  _sourceSentences?: number[];
}

/**
 * An equity line of credit, equity facility, or variable-rate note facility.
 */
export interface EquityFacility {
  /** Total commitment / maximum draw in USD */
  facilitySize?: number;
  /** Amount drawn / utilized so far in USD */
  drawnAmount?: number;
  /** Price formula description, e.g. "90% of VWAP" */
  pricingFormula?: string;
  /** Facility type */
  facilityType?: 'eloc' | 'efa' | 'equity_line' | 'variable_note' | 'other';
  /** Counterparty / investor name */
  counterpartyName?: string;
  matchedPhrase?: string;
  _noteNumber?: number;
  _section?: string;
  _sourceSentences?: number[];
  /** Source filing label (formType · filedAt), set by the intelligence layer for provenance */
  _sourceFiling?: string;
}

/**
 * Aggregated dilution analysis for the reporting period.
 */
export interface DilutionSummary {
  /** Shares outstanding at the start of the period */
  sharesOutstandingStart?: number;
  /** Shares outstanding at the end of the period */
  sharesOutstandingEnd?: number;
  /** Total shares added from conversions in this period */
  sharesFromConversions?: number;
  /** Total shares added from equity issuances in this period */
  sharesFromIssuances?: number;
  /** Maximum potential shares from all outstanding convertible instruments */
  potentialDilutiveShares?: number;
  /** Verbatim dilution-related language excerpts from the filing */
  dilutionPhrases: string[];
  /** True if the filing explicitly warns of future dilution */
  hasDilutionWarning: boolean;
}

/**
 * Financial statement data extracted from income statement, balance sheet, and cash flow.
 * Numbers are in USD unless the filing uses thousands, in which case the multiplier is applied.
 * All loss/deficit values are stored as negative numbers.
 */
export interface FinancialStatements {
  // ── Income Statement ──────────────────────────────────────────────────────
  revenue?: number;
  grossProfit?: number;
  grossMarginPct?: number;          // 0–1, e.g. 0.42 for 42% gross margin
  totalOperatingExpenses?: number;
  operatingLoss?: number;           // negative = loss
  netLoss?: number;                 // negative = loss
  /** Prior comparable period net loss (same quarter prior year or prior annual) */
  netLossPriorPeriod?: number;
  /** Prior comparable period revenue */
  revenuePriorPeriod?: number;
  // ── Balance Sheet ─────────────────────────────────────────────────────────
  cashAndEquivalents?: number;
  totalAssets?: number;
  totalLiabilities?: number;
  /** Stockholders' equity (negative = deficit) */
  stockholdersEquity?: number;
  /** Working capital (negative = working capital deficit) */
  workingCapital?: number;
  // ── Cash Flow ─────────────────────────────────────────────────────────────
  /** Net cash used in / provided by operating activities */
  cashFromOperations?: number;      // negative = cash burned
  // ── Going Concern ─────────────────────────────────────────────────────────
  hasGoingConcern: boolean;
  goingConcernLanguage?: string;    // verbatim excerpt (first 300 chars)
  // ── Period metadata ───────────────────────────────────────────────────────
  /** Human-readable period label, e.g. "Three months ended March 31, 2024" */
  periodLabel?: string;
  balanceSheetDate?: string;        // e.g. "March 31, 2024"
  /** Multiplier applied to raw table values (1 for actual dollars, 1000 for "in thousands") */
  reportingMultiplier: number;
  confidence: ExtractionConfidence;
  warnings: string[];
}

/**
 * Structured financing and dilution report for a 10-K or 10-Q filing.
 * Produced by parsers/financingReport.ts.
 * Only populated for 10-K, 10-K/A, 10-Q, 10-Q/A form types.
 */
export interface FinancingReport {
  /** All identified convertible notes and debt instruments */
  convertibleDebt:          ConvertibleNote[];
  /** All identified equity issuance events */
  equityIssuances:          EquityIssuance[];
  /** All identified debt-to-equity conversion events */
  conversions:              ConversionRecord[];
  /** All identified warrants */
  warrants:                 WarrantRecord[];
  /** All identified related-party transactions */
  relatedPartyTransactions: RelatedPartyTransaction[];
  /** All identified equity facilities / ELOCs */
  equityFacilities:         EquityFacility[];
  /** Aggregated dilution picture */
  dilutionSummary:          DilutionSummary;
  /**
   * Extracted financial statement data (income statement, balance sheet, cash flow).
   * Populated for 10-K / 10-Q filings that contain financial statement sections.
   */
  financialStatements?:     FinancialStatements;
  /** Plain-text multi-section report, suitable for display */
  reportText:               string;
  /** ISO timestamp of when parsing ran */
  extractedAt:              string;
  /** Overall confidence given what the parser could find */
  confidence:               ExtractionConfidence;
  /** Non-fatal warnings: missing sections, ambiguous values, etc. */
  warnings:                 string[];
}

// ─── Fetcher interface ────────────────────────────────────────────────────────

export type FetcherMode = 'mock' | 'edgar' | 'edgar-with-fallback' | 'third-party';

export interface FilingFetcherConfig {
  mode: FetcherMode;
  /** Base URL for the SEC EDGAR data API (default: https://data.sec.gov) */
  edgarBaseUrl?: string;
  /** Optional API key for third-party providers */
  apiKey?: string;
  /** Minimum delay between requests in ms — EDGAR requires ≥100ms */
  rateLimitMs?: number;
  /** Max filings to fetch per ticker per call */
  maxFilings?: number;
}

export interface FetchOptions {
  /** Only fetch these form types */
  formTypes?: SecFormType[];
  /** Only fetch filings on or after this ISO date */
  since?: string;
  limit?: number;
  /**
   * How many entries to scan from the source's recent list when building the
   * prioritized result set.  Higher values find filings buried under Form 4 /
   * insider-trading noise at the cost of more in-memory iteration.
   * Defaults to the fetcher's built-in SCAN_WINDOW constant (100 for EDGAR).
   */
  scanWindow?: number;
}

/** The result of fetching a filing index for a ticker */
export interface FilingIndexResult {
  ticker: string;
  cik: string;
  filings: RawFiling[];
  fetchedAt: string;
  source: FetcherMode;
}

/**
 * The filing fetcher interface.
 * Both MockFilingFetcher and EdgarFilingFetcher implement this.
 * Swap the implementation via createFilingFetcher() in fetcher.ts.
 */
export interface IFilingFetcher {
  readonly mode: FetcherMode;
  /**
   * Fetch the index of recent filings for a ticker.
   * Returns metadata only — call fetchFilingText() for full document content.
   */
  fetchFilingsIndex(ticker: string, options?: FetchOptions): Promise<FilingIndexResult>;
  /**
   * Fetch the full text of a filing document.
   * Populates RawFiling.text. Called after fetchFilingsIndex().
   */
  fetchFilingText(filing: RawFiling): Promise<string>;
}

// ─── Pipeline types ───────────────────────────────────────────────────────────

export interface PipelineOptions extends FetchOptions {
  /** If true, skip filings whose text is already cached */
  skipCached?: boolean;
  /** If true, emit verbose logs during pipeline execution */
  verbose?: boolean;
  /**
   * Accession numbers already stored in the persistent DB.
   * Filings in this set are skipped (not re-downloaded or re-parsed).
   * Used by the batch ingestor for idempotency.
   */
  skipAccessions?: Set<string>;
}

export interface PipelineResult {
  ticker: string;
  normalized: NormalizedFiling[];
  /** Number of filings fetched */
  fetched: number;
  /** Number of filings that parsed without errors */
  parsed: number;
  /** Aggregate parse errors across all filings */
  errors: string[];
  durationMs: number;
  /** Which data source the index fetch actually used (relevant in edgar-with-fallback mode) */
  indexSource?: 'edgar' | 'mock' | 'third-party';
  /** If edgar-with-fallback mode fell back, the EDGAR error that caused it */
  edgarError?: string;
}

// ─── Company Intelligence ─────────────────────────────────────────────────────

export type DilutionRiskLevel = 'low' | 'moderate' | 'high' | 'severe';
export type RiskSeverity      = 'critical' | 'high' | 'moderate' | 'low';

export interface ShareTrendPeriod {
  filedAt:           string;
  formType:          string;
  sharesOutstanding: number;
  sharesAuthorized?: number;
  source:            'sec' | 'otc';
}

export interface ShareStructureTrend {
  /** Oldest-first ordered data points */
  periods:             ShareTrendPeriod[];
  /** Growth from oldest to newest period, percentage */
  totalGrowthPct?:     number;
  /** Period-over-period growth rates, same order as periods */
  periodicGrowthRates: number[];
  /** True when the most recent growth rate exceeds the prior period's rate */
  isAccelerating:      boolean;
  narrative:           string;
}

export interface AggregatedFinancingProfile {
  totalConvertiblePrincipal:     number;
  totalConvertibleOutstanding:   number;
  totalEquityFacilityCommitment: number;
  totalEquityFacilityDrawn:      number;
  totalWarrantShares:            number;
  /**
   * Total related-party loan balance from the most recent filing.
   * undefined = insufficient confidence (no ending_balance records found).
   * Never summed across filings.
   */
  totalRelatedPartyLoans:        number | undefined;
  toxicNoteCount:                number;
  noFloorNoteCount:              number;
  resetNoteCount:                number;
  hasActiveEloc:                 boolean;
  recentFinancingEvents:         number;
  narrative:                     string;
  /** Which filing the related-party balance was sourced from */
  relatedPartyFilingSource?:     string;
  /** Data quality warnings for the related-party total */
  relatedPartyDataWarnings:      string[];
  /** Warnings about equity facility identity ambiguity (same vs separate facilities) */
  facilityAmbiguityWarnings:     string[];
  /** Total extraction warnings across all analyzed 10-Q/10-K filings */
  extractionWarningCount:        number;
}

export interface CompanyRiskFactor {
  severity: RiskSeverity;
  label:    string;
  detail:   string;
}

export interface CompanyPositiveSignal {
  label:  string;
  detail: string;
}

export interface CompanyIntelligence {
  ticker:           string;
  generatedAt:      string;
  filingsAnalyzed:  number;

  overview: {
    dilutionRisk:            DilutionRiskLevel;
    financingProfile:        string;
    latestSharesOutstanding?: number;
    latestAuthorizedShares?:  number;
    latestFilingDate?:        string;
    latestFormType?:          string;
  };

  shareStructureTrend:  ShareStructureTrend;
  financingProfile:     AggregatedFinancingProfile;
  keyRisks:             CompanyRiskFactor[];
  positiveSignals:      CompanyPositiveSignal[];
  executiveSummary:     string;
}
