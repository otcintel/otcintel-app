/**
 * Tests for buildLiquidityRiskAssessment().
 *
 * Covers all 6 RunwayStatus values, going-concern flag behaviour, and the
 * hasUnquantifiedFinancing pass-through. No numeric score is ever produced —
 * the output is categorical only.
 */

import { describe, it, expect } from 'vitest';
import { buildLiquidityRiskAssessment } from '../liquidityDisplay';
import type { FinancialSnapshot } from '../parsers/financials/snapshot';

// ─── Fixture ──────────────────────────────────────────────────────────────────

function makeSnapshot(overrides: Partial<FinancialSnapshot> = {}): FinancialSnapshot {
  const cashRunwayMonths = overrides.cashRunwayMonths ?? 2;
  const monthlyBurn      = 100_000;
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
    operatingCashFlow:       -(monthlyBurn * 3),
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

// ─── Scenario 1: critical (< 3 months) ───────────────────────────────────────

describe('buildLiquidityRiskAssessment — scenario 1: critical runway', () => {
  it('returns runwayStatus critical and displayLabel Critical for < 3 months', () => {
    const result = buildLiquidityRiskAssessment(makeSnapshot({ cashRunwayMonths: 1.5 }), false);
    expect(result.runwayStatus).toBe('critical');
    expect(result.displayLabel).toBe('Critical');
    expect(result.displayColor).toBe('red');
  });

  it('cashRunwayMonths is preserved from the snapshot', () => {
    const result = buildLiquidityRiskAssessment(makeSnapshot({ cashRunwayMonths: 2.3 }), false);
    expect(result.cashRunwayMonths).toBeCloseTo(2.3, 1);
  });
});

// ─── Scenario 2: high (3–6 months) ───────────────────────────────────────────

describe('buildLiquidityRiskAssessment — scenario 2: high urgency runway', () => {
  it('returns runwayStatus high and displayLabel High for 3–6 months', () => {
    const result = buildLiquidityRiskAssessment(makeSnapshot({ cashRunwayMonths: 4.5 }), false);
    expect(result.runwayStatus).toBe('high');
    expect(result.displayLabel).toBe('High');
    expect(result.displayColor).toBe('red');
  });
});

// ─── Scenario 3: moderate (6–12 months) ──────────────────────────────────────

describe('buildLiquidityRiskAssessment — scenario 3: moderate urgency runway', () => {
  it('returns runwayStatus moderate and displayLabel Moderate for 6–12 months', () => {
    const result = buildLiquidityRiskAssessment(makeSnapshot({ cashRunwayMonths: 9 }), false);
    expect(result.runwayStatus).toBe('moderate');
    expect(result.displayLabel).toBe('Moderate');
    expect(result.displayColor).toBe('amber');
  });
});

// ─── Scenario 4: healthy (≥ 12 months) ───────────────────────────────────────

describe('buildLiquidityRiskAssessment — scenario 4: healthy runway', () => {
  it('returns runwayStatus healthy and displayLabel Healthy for ≥ 12 months', () => {
    const result = buildLiquidityRiskAssessment(makeSnapshot({ cashRunwayMonths: 18 }), false);
    expect(result.runwayStatus).toBe('healthy');
    expect(result.displayLabel).toBe('Healthy');
    expect(result.displayColor).toBe('green');
  });
});

// ─── Scenario 5: not_applicable (OCF ≥ 0) ────────────────────────────────────

describe('buildLiquidityRiskAssessment — scenario 5: cash-flow positive', () => {
  it('returns not_applicable and displayLabel Cash-Flow Positive when OCF ≥ 0', () => {
    const snapshot = makeSnapshot({
      operatingCashFlow:       500_000,  // positive
      operatingCashFlowMonths: 3,
      cashAndEquivalents:      2_000_000,
      monthlyBurnRate:         undefined,
      cashRunwayMonths:        undefined,
    });
    const result = buildLiquidityRiskAssessment(snapshot, false);
    expect(result.runwayStatus).toBe('not_applicable');
    expect(result.displayLabel).toBe('Cash-Flow Positive');
    expect(result.displayColor).toBe('green');
    expect(result.cashRunwayMonths).toBeUndefined();
  });
});

// ─── Scenario 6: insufficient_data ───────────────────────────────────────────

describe('buildLiquidityRiskAssessment — scenario 6: insufficient data', () => {
  it('returns insufficient_data and displayLabel Insufficient Data when OCF is missing', () => {
    const snapshot = makeSnapshot({
      operatingCashFlow:       undefined,
      operatingCashFlowMonths: undefined,
      monthlyBurnRate:         undefined,
      cashRunwayMonths:        undefined,
      cashAndEquivalents:      1_000_000,
    });
    const result = buildLiquidityRiskAssessment(snapshot, false);
    expect(result.runwayStatus).toBe('insufficient_data');
    expect(result.displayLabel).toBe('Insufficient Data');
    expect(result.displayColor).toBe('muted');
    expect(result.cashRunwayMonths).toBeUndefined();
  });
});

// ─── Scenario 7: going concern + critical ────────────────────────────────────

describe('buildLiquidityRiskAssessment — scenario 7: going concern with critical runway', () => {
  it('gcWarning is defined and goingConcernFlag is true', () => {
    const snapshot = makeSnapshot({
      cashRunwayMonths:     1.8,
      goingConcernFlag:     true,
      goingConcernSentence: 'There is substantial doubt about the Company\'s ability to continue as a going concern.',
    });
    const result = buildLiquidityRiskAssessment(snapshot, false);
    expect(result.runwayStatus).toBe('critical');
    expect(result.goingConcernFlag).toBe(true);
    expect(result.gcWarning).toBeDefined();
    expect(result.gcWarning).toBe(snapshot.goingConcernSentence);
  });

  it('gcWarning falls back to a standard phrase when sentence is absent', () => {
    const snapshot = makeSnapshot({
      cashRunwayMonths:     1.8,
      goingConcernFlag:     true,
      goingConcernSentence: undefined,
    });
    const result = buildLiquidityRiskAssessment(snapshot, false);
    expect(result.gcWarning).toBeDefined();
    expect(result.gcWarning!.length).toBeGreaterThan(10);
  });
});

// ─── Scenario 8: going concern with healthy runway ───────────────────────────

describe('buildLiquidityRiskAssessment — scenario 8: going concern with healthy runway', () => {
  it('gcWarning is defined even when runway is healthy', () => {
    const snapshot = makeSnapshot({
      cashRunwayMonths:     18,
      goingConcernFlag:     true,
      goingConcernSentence: 'Substantial doubt exists about the entity\'s ability to continue.',
    });
    const result = buildLiquidityRiskAssessment(snapshot, false);
    expect(result.runwayStatus).toBe('healthy');
    expect(result.goingConcernFlag).toBe(true);
    expect(result.gcWarning).toBeDefined();
  });

  it('runway status remains healthy regardless of going-concern flag', () => {
    const snapshot = makeSnapshot({ cashRunwayMonths: 18, goingConcernFlag: true });
    const result   = buildLiquidityRiskAssessment(snapshot, false);
    expect(result.runwayStatus).toBe('healthy');
    expect(result.displayLabel).toBe('Healthy');
  });
});

// ─── Scenario 9: hasUnquantifiedFinancing = true ─────────────────────────────

describe('buildLiquidityRiskAssessment — scenario 9: unquantified financing present', () => {
  it('hasUnquantifiedFinancing is true when passed true', () => {
    const result = buildLiquidityRiskAssessment(makeSnapshot({ cashRunwayMonths: 5 }), true);
    expect(result.hasUnquantifiedFinancing).toBe(true);
    expect(result.runwayStatus).toBe('high');
  });
});

// ─── Scenario 10: hasUnquantifiedFinancing = false ───────────────────────────

describe('buildLiquidityRiskAssessment — scenario 10: no unquantified financing', () => {
  it('hasUnquantifiedFinancing is false when passed false', () => {
    const result = buildLiquidityRiskAssessment(makeSnapshot({ cashRunwayMonths: 5 }), false);
    expect(result.hasUnquantifiedFinancing).toBe(false);
  });

  it('no numeric score field exists on the result', () => {
    const result = buildLiquidityRiskAssessment(makeSnapshot({ cashRunwayMonths: 5 }), false);
    const r = result as unknown as Record<string, unknown>;
    expect(r['score']).toBeUndefined();
    expect(r['liquidityScore']).toBeUndefined();
    expect(r['numericScore']).toBeUndefined();
  });
});
