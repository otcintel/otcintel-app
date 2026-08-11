/**
 * Cash-runway urgency scorer — Phase 7 Step 8A
 *
 * Pure function: given a FinancialSnapshot, classifies cash-runway urgency and
 * returns a score contribution for eventual integration into risk scoring.
 *
 * Design principles:
 *   - Never fabricate missing runway.
 *   - Never treat positive cash flow as infinite runway.
 *   - Positive or zero operating cash flow is explicitly not applicable.
 *   - Going concern flag is surfaced as a separate signal — not added to urgencyScore
 *     here to avoid double-counting when later combined with runway status.
 *   - urgencyScore values (0–1) are provisional until integration weight is decided.
 *
 * Integration status: helper is independently testable. scoreFinancingRisk() in
 * lib/ingestion/scoring.ts is NOT yet modified — Phase 7 Step 8B.
 */

import type { FinancialSnapshot } from './snapshot';

// ─── Output type ──────────────────────────────────────────────────────────────

export type RunwayStatus =
  | 'critical'          // < 3 months
  | 'high'              // 3 to < 6 months
  | 'moderate'          // 6 to < 12 months
  | 'healthy'           // >= 12 months
  | 'not_applicable'    // operating cash flow is non-negative; runway concept does not apply
  | 'insufficient_data';// required XBRL data is absent; score contribution is zero

export interface RunwayUrgencyResult {
  runwayStatus:      RunwayStatus;
  /** The pre-computed cash runway from the snapshot (months). Present when scoreable. */
  cashRunwayMonths?: number;
  /**
   * Provisional urgency score contribution (0–1 scale).
   *
   *   critical (< 3 mo)    → 1.00
   *   high     (3–6 mo)    → 0.75
   *   moderate (6–12 mo)   → 0.40
   *   healthy  (≥ 12 mo)   → 0.10  (non-zero: company is still burning cash)
   *   not_applicable       → 0.00
   *   insufficient_data    → 0.00
   *
   * Final integration weight is determined in Phase 7 Step 8B.
   */
  urgencyScore: number;
  /** Human-readable explanation of the classification. */
  reason: string;
  /**
   * Going-concern flag from the snapshot, preserved as a separate signal.
   * NOT added to urgencyScore — consumers may layer it on top independently.
   */
  goingConcernFlag: boolean;
}

// ─── Score table ──────────────────────────────────────────────────────────────

const SCORES: Record<Exclude<RunwayStatus, 'not_applicable' | 'insufficient_data'>, number> = {
  critical: 1.00,
  high:     0.75,
  moderate: 0.40,
  healthy:  0.10,
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Classify cash-runway urgency from a FinancialSnapshot.
 *
 * Uses pre-computed fields from the snapshot (cashRunwayMonths, operatingCashFlow)
 * rather than re-deriving them. Snapshot fields are the authoritative source.
 */
export function scoreRunwayUrgency(snapshot: FinancialSnapshot): RunwayUrgencyResult {
  const { operatingCashFlow, cashAndEquivalents, cashRunwayMonths, goingConcernFlag } = snapshot;
  const gcFlag = goingConcernFlag ?? false;

  // ── Case 1: positive or zero operating CF → runway not applicable ──────────
  if (operatingCashFlow !== undefined && operatingCashFlow >= 0) {
    return {
      runwayStatus:    'not_applicable',
      urgencyScore:    0,
      reason:          'Operating cash flow is non-negative; cash runway does not apply.',
      goingConcernFlag: gcFlag,
    };
  }

  // ── Case 2: missing required data ─────────────────────────────────────────
  if (operatingCashFlow === undefined) {
    return {
      runwayStatus:    'insufficient_data',
      urgencyScore:    0,
      reason:          'Operating cash flow not available from XBRL.',
      goingConcernFlag: gcFlag,
    };
  }

  if (cashAndEquivalents === undefined) {
    return {
      runwayStatus:    'insufficient_data',
      urgencyScore:    0,
      reason:          'Cash and equivalents not available from XBRL.',
      goingConcernFlag: gcFlag,
    };
  }

  // operatingCashFlow < 0 and cashAndEquivalents is defined.
  // cashRunwayMonths should be computable, but guard against edge cases.

  if (
    cashRunwayMonths === undefined ||
    !Number.isFinite(cashRunwayMonths) ||
    cashRunwayMonths < 0
  ) {
    return {
      runwayStatus:    'insufficient_data',
      urgencyScore:    0,
      reason:          'Cash runway value is absent or non-finite.',
      goingConcernFlag: gcFlag,
    };
  }

  // ── Case 3: bucket by runway months ───────────────────────────────────────
  let runwayStatus: Exclude<RunwayStatus, 'not_applicable' | 'insufficient_data'>;

  if (cashRunwayMonths < 3) {
    runwayStatus = 'critical';
  } else if (cashRunwayMonths < 6) {
    runwayStatus = 'high';
  } else if (cashRunwayMonths < 12) {
    runwayStatus = 'moderate';
  } else {
    runwayStatus = 'healthy';
  }

  return {
    runwayStatus,
    cashRunwayMonths,
    urgencyScore:    SCORES[runwayStatus],
    reason:          `Cash runway: ${cashRunwayMonths.toFixed(1)} months (${runwayStatus}).`,
    goingConcernFlag: gcFlag,
  };
}
