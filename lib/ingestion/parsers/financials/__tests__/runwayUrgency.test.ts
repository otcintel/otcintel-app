import { describe, it, expect } from 'vitest';
import { scoreRunwayUrgency } from '../runwayUrgency';
import type { FinancialSnapshot } from '../snapshot';

// ─── Fixture factory ──────────────────────────────────────────────────────────

function makeSnapshot(overrides: Partial<FinancialSnapshot> = {}): FinancialSnapshot {
  return {
    ticker:               'TEST',
    cik:                  '0000000001',
    accessionNumber:      '0000000001-26-000001',
    formType:             '10-Q',
    fiscalPeriod:         'Q1',
    fiscalYear:           2026,
    periodEndDate:        '2026-03-31',
    filedAt:              '2026-05-15',
    cashAndEquivalents:   1_000_000,
    currentLiabilities:   500_000,
    accumulatedDeficit:   -5_000_000,
    totalDebt:            undefined,
    totalDebtComponents:  [],
    operatingCashFlow:    -100_000,
    operatingCashFlowMonths: 3,
    monthlyBurnRate:      33_333.33,
    cashRunwayMonths:     30,             // 1_000_000 / 33_333.33
    goingConcernFlag:     false,
    goingConcernSentence: undefined,
    xbrlAvailable:        true,
    missingConcepts:      [],
    extractedAt:          '2026-05-15T00:00:00.000Z',
    dataSource:           'xbrl',
    ...overrides,
  };
}

// ─── Boundary tests ───────────────────────────────────────────────────────────

describe('scoreRunwayUrgency — boundary behavior', () => {
  it('0 months → critical, urgencyScore=1.0', () => {
    const r = scoreRunwayUrgency(makeSnapshot({ cashRunwayMonths: 0, cashAndEquivalents: 0 }));
    expect(r.runwayStatus).toBe('critical');
    expect(r.urgencyScore).toBe(1.0);
    expect(r.cashRunwayMonths).toBe(0);
  });

  it('2.99 months → critical', () => {
    const r = scoreRunwayUrgency(makeSnapshot({ cashRunwayMonths: 2.99 }));
    expect(r.runwayStatus).toBe('critical');
    expect(r.urgencyScore).toBe(1.0);
  });

  it('exactly 3 months → high (not critical)', () => {
    const r = scoreRunwayUrgency(makeSnapshot({ cashRunwayMonths: 3 }));
    expect(r.runwayStatus).toBe('high');
    expect(r.urgencyScore).toBe(0.75);
  });

  it('5.99 months → high', () => {
    const r = scoreRunwayUrgency(makeSnapshot({ cashRunwayMonths: 5.99 }));
    expect(r.runwayStatus).toBe('high');
    expect(r.urgencyScore).toBe(0.75);
  });

  it('exactly 6 months → moderate (not high)', () => {
    const r = scoreRunwayUrgency(makeSnapshot({ cashRunwayMonths: 6 }));
    expect(r.runwayStatus).toBe('moderate');
    expect(r.urgencyScore).toBe(0.40);
  });

  it('11.99 months → moderate', () => {
    const r = scoreRunwayUrgency(makeSnapshot({ cashRunwayMonths: 11.99 }));
    expect(r.runwayStatus).toBe('moderate');
    expect(r.urgencyScore).toBe(0.40);
  });

  it('exactly 12 months → healthy (not moderate)', () => {
    const r = scoreRunwayUrgency(makeSnapshot({ cashRunwayMonths: 12 }));
    expect(r.runwayStatus).toBe('healthy');
    expect(r.urgencyScore).toBe(0.10);
  });

  it('very large runway (100 months) → healthy', () => {
    const r = scoreRunwayUrgency(makeSnapshot({ cashRunwayMonths: 100 }));
    expect(r.runwayStatus).toBe('healthy');
    expect(r.urgencyScore).toBe(0.10);
    expect(r.cashRunwayMonths).toBe(100);
  });
});

// ─── Not-applicable cases ─────────────────────────────────────────────────────

describe('scoreRunwayUrgency — not_applicable (non-negative operating CF)', () => {
  it('positive operating cash flow → not_applicable, urgencyScore=0', () => {
    const r = scoreRunwayUrgency(makeSnapshot({
      operatingCashFlow:    50_000,
      monthlyBurnRate:      undefined,
      cashRunwayMonths:     undefined,
    }));
    expect(r.runwayStatus).toBe('not_applicable');
    expect(r.urgencyScore).toBe(0);
    expect(r.cashRunwayMonths).toBeUndefined();
  });

  it('zero operating cash flow → not_applicable (not insufficient_data)', () => {
    const r = scoreRunwayUrgency(makeSnapshot({
      operatingCashFlow:    0,
      monthlyBurnRate:      undefined,
      cashRunwayMonths:     undefined,
    }));
    expect(r.runwayStatus).toBe('not_applicable');
    expect(r.urgencyScore).toBe(0);
  });
});

// ─── Insufficient data cases ──────────────────────────────────────────────────

describe('scoreRunwayUrgency — insufficient_data', () => {
  it('missing operatingCashFlow → insufficient_data', () => {
    const r = scoreRunwayUrgency(makeSnapshot({
      operatingCashFlow:    undefined,
      monthlyBurnRate:      undefined,
      cashRunwayMonths:     undefined,
    }));
    expect(r.runwayStatus).toBe('insufficient_data');
    expect(r.urgencyScore).toBe(0);
    expect(r.cashRunwayMonths).toBeUndefined();
  });

  it('missing cashAndEquivalents (with negative CF) → insufficient_data', () => {
    const r = scoreRunwayUrgency(makeSnapshot({
      cashAndEquivalents:   undefined,
      operatingCashFlow:    -50_000,
      monthlyBurnRate:      undefined,
      cashRunwayMonths:     undefined,
    }));
    expect(r.runwayStatus).toBe('insufficient_data');
    expect(r.urgencyScore).toBe(0);
  });

  it('non-finite cashRunwayMonths (Infinity) → insufficient_data', () => {
    const r = scoreRunwayUrgency(makeSnapshot({
      cashRunwayMonths: Infinity,
    }));
    expect(r.runwayStatus).toBe('insufficient_data');
    expect(r.urgencyScore).toBe(0);
  });

  it('non-finite cashRunwayMonths (NaN) → insufficient_data', () => {
    const r = scoreRunwayUrgency(makeSnapshot({
      cashRunwayMonths: NaN,
    }));
    expect(r.runwayStatus).toBe('insufficient_data');
    expect(r.urgencyScore).toBe(0);
  });

  it('negative cashRunwayMonths (defensive) → insufficient_data', () => {
    // Negative runway should never come from buildFinancialSnapshot (which guards
    // cashAndEquivalents >= 0), but the helper defends against it explicitly.
    const r = scoreRunwayUrgency(makeSnapshot({
      cashRunwayMonths: -1,
    }));
    expect(r.runwayStatus).toBe('insufficient_data');
    expect(r.urgencyScore).toBe(0);
  });
});

// ─── Going concern signal ─────────────────────────────────────────────────────

describe('scoreRunwayUrgency — going concern is a separate signal', () => {
  it('goingConcernFlag is passed through unchanged and does not modify urgencyScore', () => {
    const withGC = scoreRunwayUrgency(makeSnapshot({ cashRunwayMonths: 2, goingConcernFlag: true }));
    const withoutGC = scoreRunwayUrgency(makeSnapshot({ cashRunwayMonths: 2, goingConcernFlag: false }));

    // urgencyScore must be identical regardless of GC flag
    expect(withGC.urgencyScore).toBe(withoutGC.urgencyScore);
    expect(withGC.runwayStatus).toBe(withoutGC.runwayStatus);

    // GC flag is preserved on the result for downstream consumers
    expect(withGC.goingConcernFlag).toBe(true);
    expect(withoutGC.goingConcernFlag).toBe(false);
  });

  it('not_applicable case preserves goingConcernFlag', () => {
    const r = scoreRunwayUrgency(makeSnapshot({
      operatingCashFlow: 100_000,
      monthlyBurnRate: undefined,
      cashRunwayMonths: undefined,
      goingConcernFlag: true,
    }));
    expect(r.runwayStatus).toBe('not_applicable');
    expect(r.goingConcernFlag).toBe(true);
  });
});

// ─── Result shape ─────────────────────────────────────────────────────────────

describe('scoreRunwayUrgency — result shape', () => {
  it('scoreable result includes cashRunwayMonths and non-empty reason', () => {
    const r = scoreRunwayUrgency(makeSnapshot({ cashRunwayMonths: 4 }));
    expect(typeof r.cashRunwayMonths).toBe('number');
    expect(r.reason.length).toBeGreaterThan(0);
  });

  it('not_applicable result omits cashRunwayMonths', () => {
    const r = scoreRunwayUrgency(makeSnapshot({
      operatingCashFlow: 1,
      monthlyBurnRate: undefined,
      cashRunwayMonths: undefined,
    }));
    expect(r.cashRunwayMonths).toBeUndefined();
  });

  it('urgencyScore is always a finite number in [0, 1]', () => {
    const cases = [
      makeSnapshot({ cashRunwayMonths: 1 }),
      makeSnapshot({ cashRunwayMonths: 4 }),
      makeSnapshot({ cashRunwayMonths: 8 }),
      makeSnapshot({ cashRunwayMonths: 24 }),
      makeSnapshot({ operatingCashFlow: 100, monthlyBurnRate: undefined, cashRunwayMonths: undefined }),
      makeSnapshot({ operatingCashFlow: undefined, monthlyBurnRate: undefined, cashRunwayMonths: undefined }),
    ];
    for (const snap of cases) {
      const r = scoreRunwayUrgency(snap);
      expect(Number.isFinite(r.urgencyScore)).toBe(true);
      expect(r.urgencyScore).toBeGreaterThanOrEqual(0);
      expect(r.urgencyScore).toBeLessThanOrEqual(1);
    }
  });
});
