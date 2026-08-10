/**
 * FinancialSnapshot assembler — Phase 7 Step 4
 *
 * Pure function: combines an XbrlConceptsResult and an optional
 * GoingConcernResult into a single, typed FinancialSnapshot.
 *
 * Derivation rules:
 *   monthlyBurnRate   = abs(operatingCashFlow) / operatingCashFlowMonths
 *                       Only when operatingCashFlow < 0 and months > 0.
 *   cashRunwayMonths  = cashAndEquivalents / monthlyBurnRate
 *                       Only when cash >= 0 and monthlyBurnRate > 0.
 *
 * Data source classification:
 *   'xbrl'       — xbrlAvailable:true, no GoingConcernResult provided
 *   'text'       — xbrlAvailable:false, GoingConcernResult provided
 *   'xbrl+text'  — xbrlAvailable:true, GoingConcernResult provided
 *
 *   A GoingConcernResult with goingConcernFlag:false still counts as
 *   "text analysis ran" — downstream consumers can distinguish a valid
 *   negative from missing text analysis by the absence of the parameter.
 *
 * No fetch calls, no database calls, no scoring changes.
 */

import type { XbrlConceptsResult } from './xbrlConcepts';
import type { GoingConcernResult }  from './goingConcern';

// ─── Output type ──────────────────────────────────────────────────────────────

export interface FinancialSnapshot {
  // ── Identity ──────────────────────────────────────────────────────────────
  ticker:          string;
  cik:             string;
  accessionNumber: string    | undefined;
  formType:        string;

  // ── Period ────────────────────────────────────────────────────────────────
  fiscalPeriod:    string    | undefined;
  fiscalYear:      number    | undefined;
  periodEndDate:   string    | undefined;
  filedAt:         string    | undefined;

  // ── Balance sheet ─────────────────────────────────────────────────────────
  /** Cash and cash equivalents at period end. */
  cashAndEquivalents:  number | undefined;
  /** Total current liabilities. */
  currentLiabilities:  number | undefined;
  /** Retained earnings / accumulated deficit — negative value is a deficit. */
  accumulatedDeficit:  number | undefined;

  // ── Debt ──────────────────────────────────────────────────────────────────
  /** Sum of found debt components; undefined when none were present in XBRL. */
  totalDebt:           number   | undefined;
  totalDebtComponents: string[];

  // ── Cash flow ─────────────────────────────────────────────────────────────
  /** YTD operating cash flow through periodEndDate. Negative = burning cash. */
  operatingCashFlow:       number | undefined;
  /** Number of months covered by operatingCashFlow (3 | 6 | 9 | 12). */
  operatingCashFlowMonths: number | undefined;

  // ── Derived liquidity signals ─────────────────────────────────────────────
  /** Monthly cash burn in USD. Present only when operatingCashFlow < 0. */
  monthlyBurnRate:   number | undefined;
  /**
   * Estimated months of runway at current burn rate.
   * Present only when both cash and monthly burn rate are available and burn > 0.
   * Not capped, not rounded.
   */
  cashRunwayMonths:  number | undefined;

  // ── Going concern ─────────────────────────────────────────────────────────
  /** True when genuine going-concern language was found in the filing text. */
  goingConcernFlag:     boolean;
  /** Full normalized sentence that triggered the going-concern flag, verbatim. */
  goingConcernSentence: string | undefined;

  // ── Data quality ──────────────────────────────────────────────────────────
  xbrlAvailable:   boolean;
  /** XBRL concept names that were attempted but absent from the document. */
  missingConcepts: string[];

  // ── Metadata ──────────────────────────────────────────────────────────────
  /** ISO timestamp of when this snapshot was assembled. */
  extractedAt: string;
  /** Which data sources contributed to this snapshot. */
  dataSource:  'xbrl' | 'text' | 'xbrl+text';
}

// ─── Assembler ────────────────────────────────────────────────────────────────

export interface BuildSnapshotParams {
  ticker:   string;
  cik:      string;
  formType: string;
  xbrl:     XbrlConceptsResult;
  /**
   * Omit when text extraction was not performed (e.g. filing text unavailable).
   * Providing this — even with goingConcernFlag:false — signals that text
   * analysis ran and produced a valid negative result.
   */
  gc?:          GoingConcernResult;
  /**
   * Override the assembly timestamp. Used in tests to produce deterministic
   * output; omit in production to use the current UTC time.
   */
  extractedAt?: string;
}

/**
 * Assemble a FinancialSnapshot from structured XBRL output and an optional
 * going-concern text extraction result.
 *
 * All derivations are computed here and nowhere else. The returned object is
 * ready for storage and downstream risk scoring.
 */
export function buildFinancialSnapshot({
  ticker,
  cik,
  formType,
  xbrl,
  gc,
  extractedAt,
}: BuildSnapshotParams): FinancialSnapshot {

  // ── Derived: monthly burn rate ─────────────────────────────────────────────

  let monthlyBurnRate: number | undefined;

  if (
    xbrl.operatingCashFlow !== undefined &&
    xbrl.operatingCashFlow < 0 &&
    xbrl.operatingCashFlowMonths !== undefined &&
    xbrl.operatingCashFlowMonths > 0
  ) {
    monthlyBurnRate = Math.abs(xbrl.operatingCashFlow) / xbrl.operatingCashFlowMonths;
  }

  // ── Derived: cash runway ───────────────────────────────────────────────────
  //
  // Conditions:
  //   - cashAndEquivalents must be present and non-negative
  //   - monthlyBurnRate must be present and > 0 (guarantees no division-by-zero)
  //
  // Result is the exact quotient — not capped, not rounded.
  // Infinity cannot occur because monthlyBurnRate > 0 is required.

  let cashRunwayMonths: number | undefined;

  if (
    xbrl.cashAndEquivalents !== undefined &&
    xbrl.cashAndEquivalents >= 0 &&
    monthlyBurnRate !== undefined &&
    monthlyBurnRate > 0
  ) {
    cashRunwayMonths = xbrl.cashAndEquivalents / monthlyBurnRate;
  }

  // ── Data source ────────────────────────────────────────────────────────────

  const textRan = gc !== undefined;
  const dataSource: 'xbrl' | 'text' | 'xbrl+text' =
    xbrl.xbrlAvailable && textRan ? 'xbrl+text' :
    xbrl.xbrlAvailable            ? 'xbrl' :
    'text';

  // ── Assemble ───────────────────────────────────────────────────────────────

  return {
    // Identity
    ticker,
    cik,
    accessionNumber: xbrl.accessionNumber,
    formType,

    // Period (from XBRL)
    fiscalPeriod:  xbrl.fiscalPeriod,
    fiscalYear:    xbrl.fiscalYear,
    periodEndDate: xbrl.periodEndDate,
    filedAt:       xbrl.filedAt,

    // Balance sheet
    cashAndEquivalents: xbrl.cashAndEquivalents,
    currentLiabilities: xbrl.currentLiabilities,
    accumulatedDeficit: xbrl.accumulatedDeficit,

    // Debt
    totalDebt:           xbrl.totalDebt,
    totalDebtComponents: xbrl.totalDebtComponents,

    // Cash flow
    operatingCashFlow:       xbrl.operatingCashFlow,
    operatingCashFlowMonths: xbrl.operatingCashFlowMonths,

    // Derived
    monthlyBurnRate,
    cashRunwayMonths,

    // Going concern (from text extractor, or defaults when not run)
    goingConcernFlag:     gc?.goingConcernFlag     ?? false,
    goingConcernSentence: gc?.matchedSentence,

    // Data quality
    xbrlAvailable:  xbrl.xbrlAvailable,
    missingConcepts: xbrl.missingConcepts,

    // Metadata
    extractedAt: extractedAt ?? new Date().toISOString(),
    dataSource,
  };
}
