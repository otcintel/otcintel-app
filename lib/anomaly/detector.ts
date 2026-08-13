/**
 * OTCIntel — Anomaly detector
 *
 * Pure function. Accepts a fully resolved InspectionContext (the outputs of
 * the ingestion pipeline for one company) and returns ReviewItemInput[] — all
 * anomalies detected. No DB writes occur here; the caller hands the results to
 * ReviewItemRepository.upsertDetected().
 *
 * Phase 1A rules (7 high-confidence rules):
 *   1. unknown_financing_type
 *   2. variable_pricing_missing_discount
 *   3. extreme_discount_rate
 *   4. implausible_principal_low
 *   5. stale_active_source
 *   6. going_concern_healthy_runway
 *   7. asserted_but_undetermined
 */

import type { ExtractedFinancingTerms } from '../ingestion/types';
import type { FinancialSnapshot } from '../ingestion/parsers/financials/snapshot';
import type { RiskScoreRecord } from '../types';
import { buildDedupKey } from './dedup';
import type { ReviewItemInput } from './types';

// ─── Inspection context ───────────────────────────────────────────────────────

/** Metadata about the filing that supplied the active financing terms. */
export interface SourceFilingContext {
  accessionNumber: string | undefined;
  formType: string;
  filedAt: string;
  parserVersion: string | undefined;
  /** True when this filing is the one currently used for live display/scoring. */
  isActiveScoringSource: boolean;
}

/**
 * All information needed to run the anomaly rules for one company.
 * Built by the caller from ingestion pipeline outputs; no fetching done here.
 */
export interface InspectionContext {
  ticker: string;
  cik?: string;

  /**
   * Whether any filing for this company was positively classified as a
   * financing event (financingType was set — possibly to 'unknown').
   * Needed to distinguish "we tried and got unknown" from "no financing filing".
   */
  hasFinancingClassification: boolean;

  /**
   * Effective financing terms after selectEffectiveFinancing()
   * (bridge-sourced or raw 8-K parser output).
   */
  activeFinancing: ExtractedFinancingTerms | undefined;

  /** Source filing for the active financing. */
  sourceFiling: SourceFilingContext | undefined;

  /** Latest financial snapshot (for runway / going-concern rules). */
  snapshot: FinancialSnapshot | undefined;

  /** Final risk score record (after applyRunwayUplift). */
  riskScore: RiskScoreRecord | undefined;

  /** Current PARSER_VERSION — imported by caller from lib/universe/types. */
  currentParserVersion: string;

  /** Ingestion run ID — attached to emitted items for traceability. */
  runId?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Keywords that indicate variable / market-linked conversion pricing.
 * Matched case-insensitively against each entry in matchedPhrases.
 */
const VARIABLE_PRICING_RE =
  /vwap|lowest\s+trading\s+price|market\s+price|average\s+(?:closing\s+)?price|conversion\s+(?:price\s+(?:formula|equal\s+to)|formula)|(?:^|\s)discount\s+(?:to|of|from)/i;

function hasVariablePricingEvidence(financing: ExtractedFinancingTerms): boolean {
  return financing.matchedPhrases.some(p => VARIABLE_PRICING_RE.test(p));
}

function key(
  ticker: string,
  anomalyType: string,
  accessionNumber: string | undefined,
  sourcePath: string,
): string {
  return buildDedupKey({ ticker, anomalyType, accessionNumber, sourcePath });
}

// ─── Rule 1: unknown_financing_type ──────────────────────────────────────────

function ruleUnknownFinancingType(ctx: InspectionContext): ReviewItemInput | null {
  if (!ctx.hasFinancingClassification) return null;
  if (!ctx.activeFinancing) return null;
  if (ctx.activeFinancing.financingType !== 'unknown') return null;

  const acc = ctx.sourceFiling?.accessionNumber;
  return {
    dedupKey: key(ctx.ticker, 'unknown_financing_type', acc, 'financing_raw.financingType'),
    ticker: ctx.ticker,
    cik: ctx.cik,
    accessionNumber: acc,
    anomalyType: 'unknown_financing_type',
    category: 'financing_extraction',
    severity: 'high',
    title: 'Financing type unclassified',
    description:
      `${ctx.ticker}: a financing filing was detected but the instrument type could not be ` +
      `classified (financingType = 'unknown'). The company cannot be scored until the ` +
      `parser correctly identifies the instrument as convertible_note, equity_line, ` +
      `preferred_stock, or warrant_only.`,
    currentValue: { financingType: 'unknown' },
    expectedBehavior: { financingType: 'convertible_note | equity_line | preferred_stock | warrant_only' },
    sourcePath: 'financing_raw.financingType',
    parserVersion: ctx.sourceFiling?.parserVersion,
    confidence: ctx.activeFinancing.confidence,
    runId: ctx.runId,
  };
}

// ─── Rule 2: variable_pricing_missing_discount ────────────────────────────────

function ruleVariablePricingMissingDiscount(ctx: InspectionContext): ReviewItemInput | null {
  const f = ctx.activeFinancing;
  if (!f) return null;
  if (f.financingType !== 'convertible_note' && f.financingType !== 'equity_line') return null;
  if (f.discountRate !== undefined) return null;
  // Only fire when there is affirmative evidence of variable/market-linked pricing
  if (!hasVariablePricingEvidence(f)) return null;

  const acc = ctx.sourceFiling?.accessionNumber;
  return {
    dedupKey: key(ctx.ticker, 'variable_pricing_missing_discount', acc, 'financing_raw.discountRate'),
    ticker: ctx.ticker,
    cik: ctx.cik,
    accessionNumber: acc,
    anomalyType: 'variable_pricing_missing_discount',
    category: 'financing_extraction',
    severity: 'high',
    title: 'Variable-pricing convertible note: discount rate not extracted',
    description:
      `${ctx.ticker}: the filing contains matched phrases indicating variable/market-linked ` +
      `conversion pricing (VWAP, market price, discount language), but no discountRate was ` +
      `extracted. The company cannot be scored. Likely a phrasing variant not yet covered ` +
      `by the parser.`,
    currentValue: { discountRate: undefined, matchedPhrases: f.matchedPhrases },
    expectedBehavior: { discountRate: 'number between 0 and 1' },
    sourcePath: 'financing_raw.discountRate',
    parserVersion: ctx.sourceFiling?.parserVersion,
    confidence: f.confidence,
    runId: ctx.runId,
  };
}

// ─── Rule 3: extreme_discount_rate ───────────────────────────────────────────

function ruleExtremeDiscountRate(ctx: InspectionContext): ReviewItemInput | null {
  const f = ctx.activeFinancing;
  if (!f) return null;
  if (f.discountRate === undefined) return null;
  if (f.discountRate <= 0.50) return null;

  const acc = ctx.sourceFiling?.accessionNumber;
  const pct = (f.discountRate * 100).toFixed(1);
  return {
    dedupKey: key(ctx.ticker, 'extreme_discount_rate', acc, 'financing_raw.discountRate'),
    ticker: ctx.ticker,
    cik: ctx.cik,
    accessionNumber: acc,
    anomalyType: 'extreme_discount_rate',
    category: 'financing_extraction',
    severity: 'high',
    title: `Extreme discount rate: ${pct}%`,
    description:
      `${ctx.ticker}: discountRate = ${f.discountRate} (${pct}%) exceeds the 50% threshold. ` +
      `This almost always indicates an inverse-form parsing error — a phrase like "conversion ` +
      `price equal to X% of market" was treated as a direct discount rather than an inverse ` +
      `form (1 − X%). Could also represent genuinely extreme economics but warrants inspection.`,
    currentValue: { discountRate: f.discountRate, matchedPhrases: f.matchedPhrases },
    expectedBehavior: { discountRate: '≤ 0.50 for typical instruments' },
    sourcePath: 'financing_raw.discountRate',
    parserVersion: ctx.sourceFiling?.parserVersion,
    confidence: f.confidence,
    runId: ctx.runId,
  };
}

// ─── Rule 4: implausible_principal_low ───────────────────────────────────────

function ruleImplausiblePrincipalLow(ctx: InspectionContext): ReviewItemInput | null {
  const f = ctx.activeFinancing;
  if (!f) return null;
  if (f.principalAmount === undefined) return null;
  if (f.principalAmount <= 0) return null;
  if (f.principalAmount >= 1_000) return null;

  const acc = ctx.sourceFiling?.accessionNumber;
  return {
    dedupKey: key(ctx.ticker, 'implausible_principal_low', acc, 'financing_raw.principalAmount'),
    ticker: ctx.ticker,
    cik: ctx.cik,
    accessionNumber: acc,
    anomalyType: 'implausible_principal_low',
    category: 'financing_extraction',
    severity: 'high',
    title: `Principal implausibly small: $${f.principalAmount.toFixed(2)}`,
    description:
      `${ctx.ticker}: principalAmount = ${f.principalAmount} is below $1,000. This almost ` +
      `certainly indicates a unit scaling error — the parser extracted a value in millions ` +
      `(e.g. "3.85" from "$3,850,000") without applying the million-dollar multiplier.`,
    currentValue: { principalAmount: f.principalAmount },
    expectedBehavior: { principalAmount: '≥ 1,000 (raw USD)' },
    sourcePath: 'financing_raw.principalAmount',
    parserVersion: ctx.sourceFiling?.parserVersion,
    confidence: f.confidence,
    runId: ctx.runId,
  };
}

// ─── Rule 5: stale_active_source ─────────────────────────────────────────────

function ruleStaleActiveSource(ctx: InspectionContext): ReviewItemInput | null {
  if (!ctx.sourceFiling) return null;
  if (!ctx.sourceFiling.isActiveScoringSource) return null;
  if (!ctx.sourceFiling.parserVersion) return null;
  if (ctx.sourceFiling.parserVersion >= ctx.currentParserVersion) return null;

  const acc = ctx.sourceFiling.accessionNumber;
  return {
    dedupKey: key(ctx.ticker, 'stale_active_source', acc, 'filings.parser_version'),
    ticker: ctx.ticker,
    cik: ctx.cik,
    accessionNumber: acc,
    anomalyType: 'stale_active_source',
    category: 'provenance',
    severity: 'medium',
    title: `Active scoring source at parser ${ctx.sourceFiling.parserVersion} (current: ${ctx.currentParserVersion})`,
    description:
      `${ctx.ticker}: the filing providing the live display/score was parsed at version ` +
      `${ctx.sourceFiling.parserVersion}, which predates the current parser version ` +
      `${ctx.currentParserVersion}. Extraction logic has changed since this filing was ` +
      `processed; re-ingestion may produce different values.`,
    currentValue: { parserVersion: ctx.sourceFiling.parserVersion, accessionNumber: acc },
    expectedBehavior: { parserVersion: ctx.currentParserVersion },
    sourcePath: 'filings.parser_version',
    parserVersion: ctx.sourceFiling.parserVersion,
    runId: ctx.runId,
  };
}

// ─── Rule 6: going_concern_healthy_runway ────────────────────────────────────

function ruleGoingConcernHealthyRunway(ctx: InspectionContext): ReviewItemInput | null {
  const s = ctx.snapshot;
  if (!s) return null;
  if (!s.goingConcernFlag) return null;
  if (s.cashRunwayMonths === undefined) return null;
  if (!isFinite(s.cashRunwayMonths)) return null;
  if (s.cashRunwayMonths <= 24) return null;

  return {
    dedupKey: key(ctx.ticker, 'going_concern_healthy_runway', 'none', 'financial_snapshots.goingconcernflag'),
    ticker: ctx.ticker,
    cik: ctx.cik,
    accessionNumber: undefined,
    anomalyType: 'going_concern_healthy_runway',
    category: 'financial_statement',
    severity: 'high',
    title: `Going-concern flag set but runway is ${s.cashRunwayMonths.toFixed(1)} months`,
    description:
      `${ctx.ticker}: goingConcernFlag = true but cashRunwayMonths = ` +
      `${s.cashRunwayMonths.toFixed(1)} (> 24 months). These are contradictory. ` +
      `Either the going-concern extraction is a false positive (boilerplate language, ` +
      `missed negation, or prior-period text) or the runway calculation is incorrect. ` +
      `One of these values will be wrong on the UI.`,
    currentValue: {
      goingConcernFlag: true,
      cashRunwayMonths: s.cashRunwayMonths,
      goingConcernSentence: s.goingConcernSentence,
    },
    expectedBehavior: {
      description: 'goingConcernFlag and runway should not both indicate health; one is likely wrong',
    },
    sourcePath: 'financial_snapshots.goingConcernFlag',
    runId: ctx.runId,
  };
}

// ─── Rule 7: asserted_but_undetermined ───────────────────────────────────────

function ruleAssertedButUndetermined(ctx: InspectionContext): ReviewItemInput[] {
  const f = ctx.activeFinancing;
  if (!f) return [];

  const items: ReviewItemInput[] = [];
  const acc = ctx.sourceFiling?.accessionNumber;

  // hasFloorPrice=true + hasFloorPriceDetermined=false is logically impossible:
  // the Determined flag is only set true when a pattern match succeeds, and a
  // pattern match is required to assert hasFloorPrice=true.
  if (f.hasFloorPrice && !f.hasFloorPriceDetermined) {
    items.push({
      dedupKey: key(ctx.ticker, 'asserted_but_undetermined', acc, 'financing_raw.hasfloorprice'),
      ticker: ctx.ticker,
      cik: ctx.cik,
      accessionNumber: acc,
      anomalyType: 'asserted_but_undetermined',
      category: 'provenance',
      severity: 'critical',
      title: 'hasFloorPrice=true but hasFloorPriceDetermined=false — logically impossible state',
      description:
        `${ctx.ticker}: hasFloorPrice is true but hasFloorPriceDetermined is false. ` +
        `This is a parser invariant violation: the Determined flag should only be set ` +
        `false when neither a positive floor pattern nor an explicit no-floor pattern ` +
        `matched, which means hasFloorPrice must remain false. The scoring driver text ` +
        `produced by this state is undefined.`,
      currentValue: { hasFloorPrice: true, hasFloorPriceDetermined: false },
      expectedBehavior: {
        rule: 'hasFloorPrice=true requires hasFloorPriceDetermined=true',
      },
      sourcePath: 'financing_raw.hasFloorPrice',
      parserVersion: ctx.sourceFiling?.parserVersion,
      confidence: f.confidence,
      runId: ctx.runId,
    });
  }

  if (f.hasResetProvisions && !f.hasResetProvisionsDetermined) {
    items.push({
      dedupKey: key(ctx.ticker, 'asserted_but_undetermined', acc, 'financing_raw.hasresetprovisions'),
      ticker: ctx.ticker,
      cik: ctx.cik,
      accessionNumber: acc,
      anomalyType: 'asserted_but_undetermined',
      category: 'provenance',
      severity: 'critical',
      title: 'hasResetProvisions=true but hasResetProvisionsDetermined=false — logically impossible state',
      description:
        `${ctx.ticker}: hasResetProvisions is true but hasResetProvisionsDetermined is false. ` +
        `This is a parser invariant violation: the Determined flag should only be false ` +
        `when neither a reset-provision pattern nor an explicit no-reset pattern matched, ` +
        `which means hasResetProvisions must remain false.`,
      currentValue: { hasResetProvisions: true, hasResetProvisionsDetermined: false },
      expectedBehavior: {
        rule: 'hasResetProvisions=true requires hasResetProvisionsDetermined=true',
      },
      sourcePath: 'financing_raw.hasResetProvisions',
      parserVersion: ctx.sourceFiling?.parserVersion,
      confidence: f.confidence,
      runId: ctx.runId,
    });
  }

  return items;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run all Phase 1A anomaly rules against one company's pipeline outputs.
 * Returns all detected anomalies as ReviewItemInput[].
 * Pure function — no DB access, no side effects.
 */
export function inspect(ctx: InspectionContext): ReviewItemInput[] {
  const items: ReviewItemInput[] = [];

  const push = (item: ReviewItemInput | null) => {
    if (item) items.push(item);
  };

  push(ruleUnknownFinancingType(ctx));
  push(ruleVariablePricingMissingDiscount(ctx));
  push(ruleExtremeDiscountRate(ctx));
  push(ruleImplausiblePrincipalLow(ctx));
  push(ruleStaleActiveSource(ctx));
  push(ruleGoingConcernHealthyRunway(ctx));
  items.push(...ruleAssertedButUndetermined(ctx));

  return items;
}
