/**
 * Liquidity Risk display builder — Phase 7 Step 9
 *
 * Pure function: converts a FinancialSnapshot into a LiquidityRiskAssessment
 * ready for direct rendering on the company page.
 *
 * Design constraints:
 *   - No numeric 0-100 score. Categorical only.
 *   - "OTCIntel Risk Score" label is reserved for compound financing+liquidity.
 *   - No DB calls, no fetch calls, no scoring changes.
 *   - scoreRunwayUrgency() is the single source of truth for status classification.
 */

import { scoreRunwayUrgency } from './parsers/financials/runwayUrgency';
import type { FinancialSnapshot } from './parsers/financials/snapshot';
import type { RunwayStatus } from './parsers/financials/runwayUrgency';

// ─── Output type ──────────────────────────────────────────────────────────────

export interface LiquidityRiskAssessment {
  /** Categorical runway status — the single authoritative classification. */
  runwayStatus:             RunwayStatus;
  /** Pre-computed months from the snapshot; present when scoreable. */
  cashRunwayMonths:         number | undefined;
  goingConcernFlag:         boolean;
  goingConcernSentence:     string | undefined;
  /**
   * True when financing activity is present in filings but lacks the structured
   * terms (discount rate, etc.) needed to produce an OTCIntel Risk Score.
   * Surfaces a contextual note in the UI.
   */
  hasUnquantifiedFinancing: boolean;
  /** Human-readable label for the status (e.g. "Critical", "Cash-Flow Positive"). */
  displayLabel:             string;
  /** Semantic color for the status — maps to existing CSS custom properties. */
  displayColor:             'red' | 'amber' | 'green' | 'muted';
  /** One-sentence reason string for display below the label. */
  displayReason:            string;
  /** Going-concern warning text when flag is true; undefined otherwise. */
  gcWarning:                string | undefined;
}

// ─── Label / color maps ───────────────────────────────────────────────────────

const DISPLAY_LABELS: Record<RunwayStatus, string> = {
  critical:          'Critical',
  high:              'High',
  moderate:          'Moderate',
  healthy:           'Healthy',
  not_applicable:    'Cash-Flow Positive',
  insufficient_data: 'Insufficient Data',
};

const DISPLAY_COLORS: Record<RunwayStatus, LiquidityRiskAssessment['displayColor']> = {
  critical:          'red',
  high:              'red',
  moderate:          'amber',
  healthy:           'green',
  not_applicable:    'green',
  insufficient_data: 'muted',
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build a LiquidityRiskAssessment from a FinancialSnapshot.
 *
 * @param snapshot                 - The latest persisted FinancialSnapshot for the company.
 * @param hasUnquantifiedFinancing - True when financing activity was detected in filings
 *                                   but no scoreable convertible note / ELOC terms were found.
 */
export function buildLiquidityRiskAssessment(
  snapshot:                 FinancialSnapshot,
  hasUnquantifiedFinancing: boolean,
): LiquidityRiskAssessment {
  const { runwayStatus, cashRunwayMonths } = scoreRunwayUrgency(snapshot);

  const displayReason =
    runwayStatus === 'critical'
      ? `Cash runway of ${cashRunwayMonths?.toFixed(1) ?? '< 3'} months — immediate liquidity risk.`
    : runwayStatus === 'high'
      ? `Cash runway of ${cashRunwayMonths?.toFixed(1) ?? '3–6'} months — elevated liquidity risk.`
    : runwayStatus === 'moderate'
      ? `Cash runway of ${cashRunwayMonths?.toFixed(1) ?? '6–12'} months — monitor burn rate closely.`
    : runwayStatus === 'healthy'
      ? `Cash runway of ${cashRunwayMonths?.toFixed(1) ?? '≥ 12'} months — adequate near-term liquidity.`
    : runwayStatus === 'not_applicable'
      ? 'Operating cash flow is non-negative; the cash-runway framework does not apply.'
    : 'Insufficient XBRL data to classify liquidity risk.';

  const gcWarning = snapshot.goingConcernFlag
    ? (snapshot.goingConcernSentence ?? 'Auditor going-concern doubt disclosed in the filing.')
    : undefined;

  return {
    runwayStatus,
    cashRunwayMonths,
    goingConcernFlag:         snapshot.goingConcernFlag,
    goingConcernSentence:     snapshot.goingConcernSentence,
    hasUnquantifiedFinancing,
    displayLabel:             DISPLAY_LABELS[runwayStatus],
    displayColor:             DISPLAY_COLORS[runwayStatus],
    displayReason,
    gcWarning,
  };
}
