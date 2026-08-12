/**
 * Risk scoring engine
 *
 * Derives a structured risk score from extracted financing terms and share structure.
 * Produces the same shape as RiskScoreRecord in lib/types.ts so that ingestion-derived
 * scores can be consumed by the same UI components as hand-curated mock scores.
 *
 * Scoring model — five factors (each 0–100):
 *   1. Discount depth      — higher discount = higher risk
 *   2. Lookback window     — longer VWAP window = higher risk
 *   3. Warrant coverage    — larger overhang as % of shares = higher risk
 *   4. Reset provisions    — present = maximum risk; absent = low
 *   5. Floor price         — no floor = maximum risk; floor present = low
 *
 * Overall score = weighted average of the five factor scores.
 * Weights: discount 30% | warrants 20% | reset 20% | lookback 20% | floor 10%
 *
 * Level thresholds:
 *   ≥ 70 → high (red)
 *   40–69 → med  (amber)
 *   < 40  → low  (green)
 */

import type { ExtractedFinancingTerms, ExtractedShareStructure } from './types';
import type { RiskFactor, RiskDriver, RiskLevel, RiskColor, RiskScoreRecord } from '../types';

// ─── Factor score helpers ─────────────────────────────────────────────────────

/**
 * Map a discount rate (0–1) to a factor score (0–100).
 * 22% discount → 82, 12% → 30, ≥25% → 90+
 */
function discountFactor(rate: number): number {
  const pct = rate * 100;
  if (pct >= 30) return 95;
  if (pct >= 25) return 90;
  if (pct >= 20) return 82;
  if (pct >= 18) return 72;
  if (pct >= 15) return 60;
  if (pct >= 12) return 30;
  if (pct >= 10) return 20;
  return 10;
}

/**
 * Map a VWAP lookback window (days) to a factor score.
 * 10-day → 72, 5-day → 18
 */
function lookbackFactor(days: number): number {
  if (days >= 20) return 90;
  if (days >= 15) return 85;
  if (days >= 10) return 72;
  if (days >= 7)  return 55;
  if (days >= 5)  return 18;
  return 10;
}

/**
 * Map warrant overhang (warrantShares / sharesOutstanding) to a factor score.
 * Returns 0 if no warrants were issued.
 */
function warrantFactor(warrantShares: number, sharesOutstanding: number): number {
  if (warrantShares === 0) return 0;
  if (sharesOutstanding === 0) return 55; // can't compute %; use medium default
  const overhangPct = (warrantShares / sharesOutstanding) * 100;
  if (overhangPct >= 30) return 90;
  if (overhangPct >= 20) return 82;
  if (overhangPct >= 15) return 72;
  if (overhangPct >= 10) return 60;
  if (overhangPct >= 5)  return 45;
  if (overhangPct >= 2)  return 28;
  return 15;
}

// ─── Driver text builders ─────────────────────────────────────────────────────

function buildDrivers(
  financing: ExtractedFinancingTerms,
  shareStructure: ExtractedShareStructure | undefined,
  factorScores: { discount: number; lookback: number; warrants: number; reset: number; floor: number },
): RiskDriver[] {
  const drivers: RiskDriver[] = [];
  const sharesOut = shareStructure?.sharesOutstanding ?? 0;

  // Discount driver
  if (financing.discountRate !== undefined) {
    const pct = (financing.discountRate * 100).toFixed(0);
    const lookbackStr = financing.lookbackDays ? `${financing.lookbackDays}-day ` : '';
    const color = factorScores.discount >= 70 ? 'var(--red)' : factorScores.discount >= 40 ? 'var(--amber)' : 'var(--green)';
    const threshold = financing.discountRate >= 0.20
      ? `significantly exceeds the 15% elevated risk threshold`
      : financing.discountRate >= 0.15
        ? `is at or above the 15% elevated risk threshold`
        : `is below the 15% elevated risk threshold`;
    const floor = financing.hasFloorPrice
      ? ` The floor price of $${financing.floorPrice} bounds the downside.`
      : financing.hasFloorPriceDetermined
        ? ' No floor price means conversion shares are uncapped as stock price declines.'
        : ' Floor price status not determined from filing text.';
    drivers.push({
      dotColor: color,
      text: `<strong>${pct}% discount to ${lookbackStr}VWAP</strong> ${threshold}.${floor}`,
    });
  }

  // Reset provisions driver
  if (financing.hasResetProvisions) {
    drivers.push({
      dotColor: 'var(--red)',
      text: '<strong>Reset provisions present.</strong> Anti-dilution clauses allow the conversion price to step down if the stock trades below prior conversion levels, compounding dilution over time.',
    });
  } else if (financing.hasResetProvisionsDetermined) {
    drivers.push({
      dotColor: 'var(--green)',
      text: '<strong>No reset provisions.</strong> The absence of anti-dilution reset clauses fixes the conversion price, capping share issuance at current terms regardless of future price movement.',
    });
  } else {
    drivers.push({
      dotColor: 'var(--amber)',
      text: '<strong>Reset provisions status not determined.</strong> The filing text did not include explicit reset-provision language — scored conservatively as absent. Provisions may exist.',
    });
  }

  // Warrant driver
  if (financing.warrantShares && financing.warrantShares > 0) {
    const shares = financing.warrantShares.toLocaleString();
    const priceStr = financing.warrantExercisePrice ? ` at $${financing.warrantExercisePrice} per share` : '';
    let overhangStr = '';
    if (sharesOut > 0) {
      const pct = ((financing.warrantShares / sharesOut) * 100).toFixed(1);
      overhangStr = ` — a ${pct}% overhang`;
    }
    const color = factorScores.warrants >= 70 ? 'var(--red)' : factorScores.warrants >= 40 ? 'var(--amber)' : 'var(--green)';
    drivers.push({
      dotColor: color,
      text: `<strong>${shares} warrants outstanding</strong>${priceStr}${overhangStr} with near-term exercise risk.`,
    });
  }

  // Lookback driver (only noteworthy if ≥ 7 days)
  if (financing.lookbackDays !== undefined && financing.lookbackDays >= 7) {
    const color = factorScores.lookback >= 70 ? 'var(--red)' : 'var(--amber)';
    drivers.push({
      dotColor: color,
      text: `<strong>${financing.lookbackDays}-day VWAP lookback</strong> increases downside sensitivity and lowers the effective conversion price in a sustained price decline.`,
    });
  }

  // Floor price driver
  if (!financing.hasFloorPrice) {
    if (financing.hasFloorPriceDetermined) {
      drivers.push({
        dotColor: 'var(--red)',
        text: '<strong>No floor price stated.</strong> Absent a contractual minimum, share issuance from the note escalates without limit as stock price declines.',
      });
    } else {
      drivers.push({
        dotColor: 'var(--amber)',
        text: '<strong>Floor price status not determined.</strong> The filing text did not include explicit floor-price language — scored conservatively as absent. A floor may exist.',
      });
    }
  } else if (financing.floorPrice) {
    drivers.push({
      dotColor: 'var(--green)',
      text: `<strong>Floor price of $${financing.floorPrice} stated.</strong> A contractual conversion minimum limits share issuance regardless of how far the stock declines.`,
    });
  }

  return drivers;
}

// ─── Main scorer ──────────────────────────────────────────────────────────────

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

/**
 * Compute a RiskScoreRecord from extracted financing and share structure data.
 *
 * Returns undefined if there is no financing data to score against.
 * In production, this output is persisted to the risk_scores table.
 */
export function scoreFinancingRisk(
  ticker: string,
  financing: ExtractedFinancingTerms | undefined,
  shareStructure?: ExtractedShareStructure,
): RiskScoreRecord | undefined {
  if (!financing || financing.financingType === 'unknown') return undefined;

  // Type eligibility: the five-factor model is designed for market-linked convertible
  // instruments. preferred_stock and warrant_only have different conversion mechanics
  // and are explicitly ineligible for this model.
  if (
    financing.financingType !== 'convertible_note' &&
    financing.financingType !== 'equity_line'
  ) return undefined;

  // Mandatory pricing input: discount rate must be extracted from the filing.
  // Substituting a numeric assumption when discount is unknown fabricates a risk
  // assertion (domain rules 1 and 6).
  if (financing.discountRate === undefined) return undefined;

  const sharesOut = shareStructure?.sharesOutstanding ?? 0;

  // ── Compute factor scores ──
  // discountRate is guaranteed defined by the gate above.
  const discountScore  = discountFactor(financing.discountRate);
  const lookbackScore  = financing.lookbackDays  !== undefined ? lookbackFactor(financing.lookbackDays)  : 40;
  const warrantScore   = financing.warrantShares !== undefined ? warrantFactor(financing.warrantShares, sharesOut) : 0;
  const resetScore     = financing.hasResetProvisions ? 90 : 18;
  const floorScore     = financing.hasFloorPrice ? 18 : 90;

  const factorScores = {
    discount: discountScore,
    lookback: lookbackScore,
    warrants: warrantScore,
    reset:    resetScore,
    floor:    floorScore,
  };

  // ── Scoring provenance ──
  const knownFactors: string[] = ['discountRate']; // guaranteed present by eligibility gate
  const unknownFactors: string[] = [];
  const dataWarnings: string[] = [];

  if (financing.lookbackDays !== undefined) {
    knownFactors.push('lookbackDays');
  } else {
    unknownFactors.push('lookbackDays');
  }

  if (financing.warrantShares !== undefined) {
    knownFactors.push('warrantShares');
  } else {
    unknownFactors.push('warrantShares');
  }

  if (financing.hasFloorPriceDetermined) {
    knownFactors.push('floorPrice');
  } else {
    unknownFactors.push('floorPrice');
    dataWarnings.push(
      'floorPrice: no floor statement found in filing text — scored conservatively as absent (no floor protection assumed)',
    );
  }

  if (financing.hasResetProvisionsDetermined) {
    knownFactors.push('resetProvisions');
  } else {
    unknownFactors.push('resetProvisions');
    dataWarnings.push(
      'resetProvisions: no reset statement found in filing text — scored as absent from silence (may understate risk if provisions exist)',
    );
  }

  // ── Overall score — weighted average ──
  const score = Math.round(
    discountScore * 0.30 +
    lookbackScore * 0.20 +
    warrantScore  * 0.20 +
    resetScore    * 0.20 +
    floorScore    * 0.10,
  );

  const level  = levelForScore(score);
  const color  = colorForScore(score);

  // ── Factor breakdown for display ──
  const factors: RiskFactor[] = [
    {
      name:       'Discount depth',
      fillWidth:  discountScore,
      fillColor:  cssColorForFactor(discountScore),
      label:      labelForFactor(discountScore),
      labelColor: cssColorForFactor(discountScore),
    },
    {
      name:       'Lookback window',
      fillWidth:  lookbackScore,
      fillColor:  cssColorForFactor(lookbackScore),
      label:      labelForFactor(lookbackScore),
      labelColor: cssColorForFactor(lookbackScore),
    },
    {
      name:       'Warrant coverage',
      fillWidth:  warrantScore,
      fillColor:  cssColorForFactor(warrantScore),
      label:      labelForFactor(warrantScore),
      labelColor: cssColorForFactor(warrantScore),
    },
    {
      name:       'Reset provisions',
      fillWidth:  resetScore,
      fillColor:  cssColorForFactor(resetScore),
      label:      labelForFactor(resetScore),
      labelColor: cssColorForFactor(resetScore),
    },
    {
      name:       'Floor price',
      fillWidth:  floorScore,
      fillColor:  cssColorForFactor(floorScore),
      label:      labelForFactor(floorScore),
      labelColor: cssColorForFactor(floorScore),
    },
  ];

  // ── Risk drivers (narrative) ──
  const drivers = buildDrivers(financing, shareStructure, factorScores);

  // ── Banner message ──
  const levelLabel   = level === 'high' ? 'High' : level === 'med' ? 'Medium' : 'Low';
  const principalStr = financing.principalAmount
    ? `$${(financing.principalAmount / 1_000_000).toFixed(1).replace(/\.0$/, '')}M `
    : '';
  const discountStr  = financing.discountRate
    ? `at ${(financing.discountRate * 100).toFixed(0)}% discount`
    : '';
  const floorNote    = financing.hasFloorPrice && financing.floorPrice
    ? ` Floor price: $${financing.floorPrice}.`
    : ' No floor price stated.';

  const bannerMessage =
    `<strong>${levelLabel} financing risk${level !== 'low' ? ' detected' : ''}.</strong>` +
    (principalStr || discountStr
      ? ` Active ${principalStr}convertible note ${discountStr}.${floorNote}`
      : ` No high-risk convertible financing terms detected.`);

  const bannerVariant: RiskScoreRecord['bannerVariant'] =
    level === 'high' ? 'red-risk' :
    level === 'med'  ? 'amber-risk' :
    'green-risk';

  const bannerDotColor = `var(--${color})`;

  return {
    ticker,
    score,
    level,
    color,
    barWidth: score,
    bannerVariant,
    bannerDotColor,
    bannerPillVariant: color,
    bannerMessage,
    factors,
    drivers,
    scoreBasis: 'valid' as const,
    knownFactors,
    unknownFactors,
    dataWarnings,
  };
}
