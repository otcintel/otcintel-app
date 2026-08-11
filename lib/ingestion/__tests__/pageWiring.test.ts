/**
 * Tests for the company-page runway-uplift wiring logic.
 *
 * The page applies `applyRunwayUplift(base, snapshot)` only when both a valid
 * quantitative base score and a FinancialSnapshot are available. These tests
 * verify the conditional and its interaction with the two building blocks.
 *
 * The inline wiring logic under test (from page.tsx):
 *   const baseRiskScore = scoreFinancingRisk(symbol, activeFinancing, activeStructure);
 *   const riskScore = baseRiskScore && financialSnapshot
 *     ? applyRunwayUplift(baseRiskScore, financialSnapshot)
 *     : baseRiskScore;
 */

import { describe, it, expect } from 'vitest';
import { scoreFinancingRisk } from '../scoring';
import { applyRunwayUplift } from '../runwayIntegration';
import type { ExtractedFinancingTerms } from '../types';
import type { FinancialSnapshot } from '../parsers/financials/snapshot';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeFinancing(overrides: Partial<ExtractedFinancingTerms> = {}): ExtractedFinancingTerms {
  return {
    financingType:              'convertible_note',
    confidence:                 'high',
    discountRate:               0.20,
    hasFloorPrice:              false,
    hasFloorPriceDetermined:    true,
    hasResetProvisions:         false,
    hasResetProvisionsDetermined: true,
    matchedPhrases:             [],
    ...overrides,
  };
}

/**
 * Build a FinancialSnapshot that scoreRunwayUrgency can classify.
 * cashRunwayMonths controls the bucket; the other required fields are
 * set consistently so the scorer reaches Case 3 (bucket-by-runway).
 */
function makeSnapshot(overrides: Partial<FinancialSnapshot> = {}): FinancialSnapshot {
  const cashRunwayMonths = overrides.cashRunwayMonths ?? 2;
  // operatingCashFlow must be negative and cashAndEquivalents defined
  // for scoreRunwayUrgency to reach the runway-bucket branch.
  const monthlyBurn = 100_000;
  return {
    ticker:                  'TEST',
    cik:                     '0000000001',
    accessionNumber:         undefined,
    formType:                '10-Q',
    fiscalPeriod:            undefined,
    fiscalYear:              undefined,
    periodEndDate:           undefined,
    filedAt:                 undefined,
    cashAndEquivalents:      Math.round(cashRunwayMonths * monthlyBurn),
    currentLiabilities:      undefined,
    accumulatedDeficit:      undefined,
    totalDebt:               undefined,
    totalDebtComponents:     [],
    operatingCashFlow:       -(monthlyBurn * 3),   // negative: burning cash (3-month period)
    operatingCashFlowMonths: 3,
    monthlyBurnRate:         monthlyBurn,
    cashRunwayMonths,
    goingConcernFlag:        false,
    goingConcernSentence:    undefined,
    xbrlAvailable:           true,
    missingConcepts:         [],
    extractedAt:             '2026-01-01T00:00:00.000Z',
    dataSource:              'xbrl',
    ...overrides,
  };
}

// Replicates the page wiring conditional for isolated testing.
function computeRiskScore(
  ticker: string,
  financing: ExtractedFinancingTerms | undefined,
  snapshot: FinancialSnapshot | undefined,
) {
  const base = scoreFinancingRisk(ticker, financing, undefined);
  return base && snapshot ? applyRunwayUplift(base, snapshot) : base;
}

// ─── Scenario 1: base + snapshot → applyRunwayUplift result ──────────────────

describe('page wiring — scenario 1: base score + snapshot → uplift applied', () => {
  it('returns an enhanced record when both base and snapshot exist', () => {
    const snapshot = makeSnapshot({ cashRunwayMonths: 2 }); // critical → +15
    const result   = computeRiskScore('TEST', makeFinancing(), snapshot);
    expect(result).not.toBeUndefined();
    // base score for 20% discount: discount=82*0.3 + lookback=40*0.2 + warrants=0*0.2 + reset=18*0.2 + floor=90*0.1 = 24.6+8+0+3.6+9 = 45.2 → 45
    // with +15 uplift → 60
    expect(result!.score).toBe(60);
  });

  it('result has 6 factors (5 base + Cash runway)', () => {
    const result = computeRiskScore('TEST', makeFinancing(), makeSnapshot({ cashRunwayMonths: 4 }));
    expect(result!.factors).toHaveLength(6);
    expect(result!.factors.at(-1)!.name).toBe('Cash runway');
  });
});

// ─── Scenario 2: base + no snapshot → base unchanged ─────────────────────────

describe('page wiring — scenario 2: base score + no snapshot → base returned', () => {
  it('returns base score unchanged when snapshot is undefined', () => {
    const financing = makeFinancing();
    const base      = scoreFinancingRisk('TEST', financing, undefined);
    const result    = computeRiskScore('TEST', financing, undefined);
    expect(result).toEqual(base);
    expect(result!.factors).toHaveLength(5);
  });

  it('score is not modified when snapshot is absent', () => {
    const result = computeRiskScore('TEST', makeFinancing(), undefined);
    expect(result!.score).toBe(45); // base score for 20% discount, default lookback/warrants/reset/floor
  });
});

// ─── Scenario 3: no base + snapshot → undefined ───────────────────────────────

describe('page wiring — scenario 3: no base score + snapshot → undefined', () => {
  it('returns undefined for ineligible financing type regardless of snapshot', () => {
    const financing = makeFinancing({ financingType: 'preferred_stock' });
    const result    = computeRiskScore('TEST', financing, makeSnapshot({ cashRunwayMonths: 1 }));
    expect(result).toBeUndefined();
  });

  it('returns undefined when discountRate is missing regardless of snapshot', () => {
    const financing = makeFinancing({ discountRate: undefined });
    const result    = computeRiskScore('TEST', financing, makeSnapshot({ cashRunwayMonths: 1 }));
    expect(result).toBeUndefined();
  });

  it('returns undefined when no financing at all regardless of snapshot', () => {
    const result = computeRiskScore('TEST', undefined, makeSnapshot({ cashRunwayMonths: 1 }));
    expect(result).toBeUndefined();
  });
});

// ─── Scenario 4: no base + no snapshot → undefined ───────────────────────────

describe('page wiring — scenario 4: no base + no snapshot → undefined', () => {
  it('returns undefined when both base and snapshot are absent', () => {
    const result = computeRiskScore('TEST', undefined, undefined);
    expect(result).toBeUndefined();
  });
});

// ─── Scenario 5: critical runway → +15 uplift ────────────────────────────────

describe('page wiring — scenario 5: critical runway uplift applied', () => {
  it('applies +15 to base score for critical runway (< 3 months)', () => {
    const base   = scoreFinancingRisk('TEST', makeFinancing(), undefined)!;
    const result = computeRiskScore('TEST', makeFinancing(), makeSnapshot({ cashRunwayMonths: 1 }));
    expect(result!.score).toBe(Math.min(100, base.score + 15));
  });

  it('is capped at 100', () => {
    const financing = makeFinancing({ discountRate: 0.30 }); // high base score
    const base      = scoreFinancingRisk('TEST', financing, undefined)!;
    const result    = computeRiskScore('TEST', financing, makeSnapshot({ cashRunwayMonths: 1 }));
    expect(result!.score).toBe(Math.min(100, base.score + 15));
  });
});

// ─── Scenario 6: healthy runway → no uplift ──────────────────────────────────

describe('page wiring — scenario 6: healthy runway → no uplift', () => {
  it('does not modify score when runway is healthy (> 12 months)', () => {
    const base   = scoreFinancingRisk('TEST', makeFinancing(), undefined)!;
    const result = computeRiskScore('TEST', makeFinancing(), makeSnapshot({ cashRunwayMonths: 18 }));
    expect(result!.score).toBe(base.score);
  });

  it('still appends Cash runway factor for healthy status', () => {
    const result = computeRiskScore('TEST', makeFinancing(), makeSnapshot({ cashRunwayMonths: 18 }));
    expect(result!.factors).toHaveLength(6);
    expect(result!.factors.at(-1)!.name).toBe('Cash runway');
  });
});

// ─── Scenario 7: going concern flag → GC driver appended ─────────────────────

describe('page wiring — scenario 7: going concern flag → GC driver surfaced', () => {
  it('appends going-concern driver when goingConcernFlag is true', () => {
    const result = computeRiskScore(
      'TEST',
      makeFinancing(),
      makeSnapshot({ cashRunwayMonths: 18, goingConcernFlag: true }),
    );
    const gcDriver = result!.drivers.find(d => d.text.includes('going concern'));
    expect(gcDriver).toBeDefined();
    expect(gcDriver!.dotColor).toBe('var(--red)');
  });

  it('GC driver does not contribute to the numeric score', () => {
    const withGc    = computeRiskScore('TEST', makeFinancing(), makeSnapshot({ cashRunwayMonths: 18, goingConcernFlag: true }));
    const withoutGc = computeRiskScore('TEST', makeFinancing(), makeSnapshot({ cashRunwayMonths: 18, goingConcernFlag: false }));
    expect(withGc!.score).toBe(withoutGc!.score);
  });
});
