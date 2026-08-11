/**
 * Phase 7 Step 8B — Cash-runway uplift for quantitative financing scores.
 *
 * applyRunwayUplift() takes an existing valid RiskScoreRecord (produced by
 * scoreFinancingRisk()) and enhances it with liquidity urgency derived from
 * a FinancialSnapshot. It does NOT create a score when none exists.
 *
 * Uplift table (added to the base financing score, capped at 100):
 *   critical (< 3 mo)            → +15
 *   high     (3–6 mo)            → +10
 *   moderate (6–12 mo)           → +5
 *   healthy / not_applicable
 *   / insufficient_data          → +0
 *
 * Going-concern flag: surfaced as a separate driver with no numeric contribution.
 * Base object is never mutated.
 * All provenance fields (scoreBasis, knownFactors, unknownFactors, dataWarnings)
 * are preserved unchanged from the base record.
 */

import type { RiskScoreRecord, RiskFactor, RiskDriver, RiskLevel, RiskColor } from '../types';
import type { FinancialSnapshot } from './parsers/financials/snapshot';
import { scoreRunwayUrgency } from './parsers/financials/runwayUrgency';
import type { RunwayStatus } from './parsers/financials/runwayUrgency';

// ─── Uplift table ─────────────────────────────────────────────────────────────

export const RUNWAY_UPLIFT: Record<RunwayStatus, number> = {
  critical:          15,
  high:              10,
  moderate:           5,
  healthy:            0,
  not_applicable:     0,
  insufficient_data:  0,
};

// ─── Score threshold helpers (identical semantics to scoring.ts) ──────────────

function colorForScore(score: number): RiskColor {
  if (score >= 70) return 'red';
  if (score >= 40) return 'amber';
  return 'green';
}

function levelForScore(score: number): RiskLevel {
  if (score >= 70) return 'high';
  if (score >= 40) return 'med';
  return 'low';
}

function labelForFactor(score: number): string {
  if (score >= 70) return 'High';
  if (score >= 40) return 'Med';
  return 'Low';
}

function cssColorForFactor(score: number): string {
  if (score >= 70) return 'var(--red)';
  if (score >= 40) return 'var(--amber)';
  return 'var(--green)';
}

// ─── Banner rebuilder ─────────────────────────────────────────────────────────

function rebuildBannerMessage(
  base: RiskScoreRecord,
  newLevel: RiskLevel,
  runwayStatus: RunwayStatus,
  cashRunwayMonths: number | undefined,
  uplift: number,
): string {
  const levelLabel = newLevel === 'high' ? 'High' : newLevel === 'med' ? 'Medium' : 'Low';
  const newPrefix  = `<strong>${levelLabel} financing risk${newLevel !== 'low' ? ' detected' : ''}.</strong>`;
  // Strip the existing leading <strong>…</strong> and keep the body.
  const body = base.bannerMessage.replace(/^<strong>[^<]*<\/strong>/, '');

  let runwayNote = '';
  if (uplift > 0 && cashRunwayMonths !== undefined) {
    runwayNote = ` Cash runway: ${cashRunwayMonths.toFixed(1)} months (${runwayStatus}).`;
  } else if (uplift > 0) {
    runwayNote = ` Runway urgency: ${runwayStatus}.`;
  }

  return newPrefix + body + runwayNote;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Enhance a valid quantitative financing score with cash-runway urgency.
 *
 * Returns a new RiskScoreRecord with:
 *  - score adjusted by the runway uplift (capped at 100)
 *  - level / color / banner recalculated from the new score
 *  - a "Cash runway" factor appended as the 6th factor row
 *  - a runway narrative driver appended to the drivers list
 *  - a separate going-concern driver appended when goingConcernFlag=true
 *  - all provenance fields from the base record preserved unchanged
 *
 * Does NOT mutate the base object.
 */
export function applyRunwayUplift(
  base: RiskScoreRecord,
  snapshot: FinancialSnapshot,
): RiskScoreRecord {
  const runway = scoreRunwayUrgency(snapshot);
  const uplift = RUNWAY_UPLIFT[runway.runwayStatus];

  const score = Math.min(100, base.score + uplift);
  const level = levelForScore(score);
  const color = colorForScore(score);

  // ── Cash runway factor (appended as 6th factor row) ──────────────────────
  const runwayFillWidth = Math.round(runway.urgencyScore * 100);
  const runwayFactor: RiskFactor = {
    name:       'Cash runway',
    fillWidth:  runwayFillWidth,
    fillColor:  cssColorForFactor(runwayFillWidth),
    label:      labelForFactor(runwayFillWidth),
    labelColor: cssColorForFactor(runwayFillWidth),
  };

  // ── Drivers ───────────────────────────────────────────────────────────────
  const additionalDrivers: RiskDriver[] = [];

  const monthsStr = runway.cashRunwayMonths !== undefined
    ? `${runway.cashRunwayMonths.toFixed(1)} months`
    : undefined;

  let runwayDriverText: string;
  switch (runway.runwayStatus) {
    case 'critical':
      runwayDriverText =
        `<strong>Critical cash runway${monthsStr ? ` (${monthsStr})` : ''}.</strong>` +
        ` Financing risk score increased by ${uplift} points.` +
        ' Immediate liquidity pressure compounds the dilution risk of the active convertible position.';
      break;
    case 'high':
      runwayDriverText =
        `<strong>High runway urgency${monthsStr ? ` (${monthsStr})` : ''}.</strong>` +
        ` Financing risk score increased by ${uplift} points.` +
        ' Near-term cash constraints increase the probability of forced financing events.';
      break;
    case 'moderate':
      runwayDriverText =
        `<strong>Moderate runway urgency${monthsStr ? ` (${monthsStr})` : ''}.</strong>` +
        ` Financing risk score increased by ${uplift} points.` +
        ' Runway of 6–12 months warrants monitoring alongside the active convertible position.';
      break;
    case 'healthy':
      runwayDriverText =
        `<strong>Healthy cash runway${monthsStr ? ` (${monthsStr})` : ''}.</strong>` +
        ' No uplift applied — runway does not compound the financing risk at this time.';
      break;
    case 'not_applicable':
      runwayDriverText =
        '<strong>Cash runway not applicable.</strong>' +
        ' Operating cash flow is non-negative; the company is not burning cash. No uplift applied.';
      break;
    case 'insufficient_data':
      runwayDriverText =
        '<strong>Cash runway data unavailable.</strong>' +
        ' XBRL cash flow or balance sheet data could not be extracted. No uplift applied.';
      break;
  }

  additionalDrivers.push({
    dotColor: cssColorForFactor(runwayFillWidth),
    text:     runwayDriverText,
  });

  // Going-concern driver — no numeric score contribution.
  if (runway.goingConcernFlag) {
    additionalDrivers.push({
      dotColor: 'var(--red)',
      text:
        '<strong>Going-concern doubt disclosed.</strong>' +
        " Auditors have raised substantial doubt about the company's ability to continue" +
        ' as a going concern. This signal is surfaced separately and does not add to' +
        ' the numeric financing risk score.',
    });
  }

  // ── Banner ────────────────────────────────────────────────────────────────
  const bannerVariant: RiskScoreRecord['bannerVariant'] =
    level === 'high' ? 'red-risk' :
    level === 'med'  ? 'amber-risk' :
    'green-risk';
  const bannerDotColor = `var(--${color})`;
  const bannerMessage  = rebuildBannerMessage(
    base, level, runway.runwayStatus, runway.cashRunwayMonths, uplift,
  );

  return {
    ...base,
    score,
    level,
    color,
    barWidth:          score,
    bannerVariant,
    bannerDotColor,
    bannerPillVariant: color,
    bannerMessage,
    factors:           [...base.factors, runwayFactor],
    drivers:           [...base.drivers, ...additionalDrivers],
  };
}
