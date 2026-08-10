/**
 * Tests for lib/ingestion/parsers/financials/snapshot.ts
 *
 * Coverage:
 *   1.  Negative operating cash flow → monthlyBurnRate computed
 *   2.  Cash runway derivation from burn rate and cash
 *   3.  Positive operating cash flow → no burn rate, no runway
 *   4.  Zero operating cash flow → no burn rate, no runway
 *   5.  Zero cash with valid burn → runway = 0
 *   6.  Missing cash → no runway (even with burn rate)
 *   7.  Missing operating cash flow → no burn rate, no runway
 *   8.  Q1 / Q2 / Q3 / FY period month divisors
 *   9.  Going concern flag true — sentence preserved verbatim
 *  10.  Going concern flag false — still stored, not treated as missing
 *  11.  dataSource 'xbrl' — XBRL available, no GC parameter
 *  12.  dataSource 'text' — XBRL unavailable, GC parameter provided
 *  13.  dataSource 'xbrl+text' — both available
 *  14.  Missing XBRL with valid text result — identity/period fields undefined
 *  15.  Sign preservation — accumulated deficit kept negative
 *  16.  Debt component list preserved exactly
 *  17.  Provenance — accessionNumber from XBRL, sentence from GC verbatim
 *  18.  No Infinity / NaN outputs under any valid inputs
 *  19.  totalDebt undefined when no debt components were found
 *  20.  missingConcepts list forwarded unchanged
 */

import { describe, it, expect } from 'vitest';
import { buildFinancialSnapshot } from '../snapshot';
import type { FinancialSnapshot }  from '../snapshot';
import type { XbrlConceptsResult } from '../xbrlConcepts';
import type { GoingConcernResult }  from '../goingConcern';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FIXED_AT = '2026-05-20T12:00:00.000Z';

/** Full, healthy XBRL result — negative operating cash flow (burning cash). */
const BASE_XBRL: XbrlConceptsResult = {
  fiscalPeriod:            'Q1',
  fiscalYear:              2026,
  periodEndDate:           '2026-03-31',
  filedAt:                 '2026-05-15',
  accessionNumber:         '0001655050-26-000001',
  cashAndEquivalents:      600_000,
  currentLiabilities:      1_200_000,
  accumulatedDeficit:      -8_500_000,
  operatingCashFlow:       -300_000,
  operatingCashFlowMonths: 3,
  totalDebt:               2_000_000,
  totalDebtComponents:     ['ConvertibleNotesPayable', 'LongTermDebt'],
  xbrlAvailable:           true,
  missingConcepts:         [],
};

/** XBRL result when the company has no XBRL filing (all financial fields absent). */
const EMPTY_XBRL: XbrlConceptsResult = {
  fiscalPeriod:            undefined,
  fiscalYear:              undefined,
  periodEndDate:           undefined,
  filedAt:                 undefined,
  accessionNumber:         undefined,
  cashAndEquivalents:      undefined,
  currentLiabilities:      undefined,
  accumulatedDeficit:      undefined,
  operatingCashFlow:       undefined,
  operatingCashFlowMonths: undefined,
  totalDebt:               undefined,
  totalDebtComponents:     [],
  xbrlAvailable:           false,
  missingConcepts:         [
    'CashAndCashEquivalentsAtCarryingValue', 'Cash',
    'CashCashEquivalentsAndShortTermInvestments',
    'NetCashProvidedByUsedInOperatingActivities',
    'LiabilitiesCurrent', 'RetainedEarningsAccumulatedDeficit',
    'NotesPayableCurrent', 'LongTermDebt',
    'ConvertibleNotesPayable', 'ConvertibleDebtCurrent',
  ],
};

const GC_TRUE: GoingConcernResult = {
  goingConcernFlag: true,
  matchedSentence:
    "These conditions raise substantial doubt about the Company's ability to continue as a going concern.",
  matchedPhrase:
    "raise substantial doubt about the Company's ability to continue as a going concern",
  confidence:  'high',
  sourceType:  'filing_text',
};

const GC_FALSE: GoingConcernResult = {
  goingConcernFlag: false,
  confidence:  'low',
  sourceType:  'filing_text',
};

const BASE_META = { ticker: 'ABVC', cik: '0001655050', formType: '10-Q', extractedAt: FIXED_AT };

// ─── Helper ───────────────────────────────────────────────────────────────────

function build(
  xbrl: Partial<XbrlConceptsResult> = {},
  gc?: GoingConcernResult,
  meta: Partial<typeof BASE_META> = {},
): FinancialSnapshot {
  return buildFinancialSnapshot({
    ...BASE_META,
    ...meta,
    xbrl: { ...BASE_XBRL, ...xbrl },
    gc,
  });
}

// ─── 1. Negative operating cash flow → burn rate ──────────────────────────────

describe('buildFinancialSnapshot — monthly burn rate', () => {
  it('computes monthlyBurnRate from negative operatingCashFlow / months', () => {
    const result = build({ operatingCashFlow: -300_000, operatingCashFlowMonths: 3 });

    expect(result.monthlyBurnRate).toBe(100_000);
  });

  it('monthlyBurnRate is always positive (absolute value of cash flow)', () => {
    const result = build({ operatingCashFlow: -900_000, operatingCashFlowMonths: 9 });

    expect(result.monthlyBurnRate).toBe(100_000);
    expect(result.monthlyBurnRate).toBeGreaterThan(0);
  });

  it('uses exact operatingCashFlowMonths as the divisor', () => {
    const result = build({ operatingCashFlow: -240_000, operatingCashFlowMonths: 6 });

    expect(result.monthlyBurnRate).toBe(40_000);
  });
});

// ─── 2. Cash runway derivation ────────────────────────────────────────────────

describe('buildFinancialSnapshot — cash runway', () => {
  it('computes cashRunwayMonths = cash / monthlyBurnRate', () => {
    const result = build({
      cashAndEquivalents:      600_000,
      operatingCashFlow:       -300_000,
      operatingCashFlowMonths: 3,
    });

    // burn = 300_000 / 3 = 100_000/mo; runway = 600_000 / 100_000 = 6
    expect(result.cashRunwayMonths).toBe(6);
  });

  it('preserves fractional runway without rounding', () => {
    const result = build({
      cashAndEquivalents:      550_000,
      operatingCashFlow:       -300_000,
      operatingCashFlowMonths: 3,
    });

    // burn = 100_000/mo; runway = 550_000 / 100_000 = 5.5
    expect(result.cashRunwayMonths).toBeCloseTo(5.5, 10);
  });
});

// ─── 3. Positive operating cash flow → no burn/runway ─────────────────────────

describe('buildFinancialSnapshot — positive cash flow', () => {
  it('monthlyBurnRate is undefined when operatingCashFlow > 0', () => {
    const result = build({ operatingCashFlow: 400_000, operatingCashFlowMonths: 3 });

    expect(result.monthlyBurnRate).toBeUndefined();
  });

  it('cashRunwayMonths is undefined when operatingCashFlow > 0', () => {
    const result = build({ operatingCashFlow: 400_000, operatingCashFlowMonths: 3 });

    expect(result.cashRunwayMonths).toBeUndefined();
  });
});

// ─── 4. Zero operating cash flow → no burn/runway ─────────────────────────────

describe('buildFinancialSnapshot — zero cash flow', () => {
  it('monthlyBurnRate is undefined when operatingCashFlow === 0', () => {
    const result = build({ operatingCashFlow: 0, operatingCashFlowMonths: 3 });

    expect(result.monthlyBurnRate).toBeUndefined();
  });

  it('cashRunwayMonths is undefined when operatingCashFlow === 0', () => {
    const result = build({ operatingCashFlow: 0, operatingCashFlowMonths: 3 });

    expect(result.cashRunwayMonths).toBeUndefined();
  });
});

// ─── 5. Zero cash with valid burn → runway = 0 ────────────────────────────────

describe('buildFinancialSnapshot — zero cash balance', () => {
  it('cashRunwayMonths is 0 when cash is 0 and burn rate is valid', () => {
    const result = build({
      cashAndEquivalents:      0,
      operatingCashFlow:       -300_000,
      operatingCashFlowMonths: 3,
    });

    expect(result.monthlyBurnRate).toBe(100_000);
    expect(result.cashRunwayMonths).toBe(0);
  });
});

// ─── 6. Missing cash → no runway ─────────────────────────────────────────────

describe('buildFinancialSnapshot — missing cash', () => {
  it('cashRunwayMonths is undefined when cashAndEquivalents is undefined', () => {
    const result = build({
      cashAndEquivalents:      undefined,
      operatingCashFlow:       -300_000,
      operatingCashFlowMonths: 3,
    });

    expect(result.monthlyBurnRate).toBe(100_000); // burn still computed
    expect(result.cashRunwayMonths).toBeUndefined();
  });
});

// ─── 7. Missing operating cash flow → no burn/runway ─────────────────────────

describe('buildFinancialSnapshot — missing operating cash flow', () => {
  it('monthlyBurnRate is undefined when operatingCashFlow is undefined', () => {
    const result = build({ operatingCashFlow: undefined, operatingCashFlowMonths: 3 });

    expect(result.monthlyBurnRate).toBeUndefined();
  });

  it('cashRunwayMonths is undefined when operatingCashFlow is undefined', () => {
    const result = build({ operatingCashFlow: undefined, operatingCashFlowMonths: 3 });

    expect(result.cashRunwayMonths).toBeUndefined();
  });

  it('monthlyBurnRate is undefined when operatingCashFlowMonths is undefined', () => {
    const result = build({ operatingCashFlow: -300_000, operatingCashFlowMonths: undefined });

    expect(result.monthlyBurnRate).toBeUndefined();
  });
});

// ─── 8. Q1/Q2/Q3/FY period month divisors ────────────────────────────────────

describe('buildFinancialSnapshot — period month divisors', () => {
  it('Q1 (3 months) divides correctly', () => {
    const result = build({ operatingCashFlow: -300_000, operatingCashFlowMonths: 3 });

    expect(result.monthlyBurnRate).toBe(100_000);
  });

  it('Q2 (6 months) divides correctly', () => {
    const result = build({
      fiscalPeriod:            'Q2',
      operatingCashFlow:       -600_000,
      operatingCashFlowMonths: 6,
    });

    expect(result.monthlyBurnRate).toBe(100_000);
  });

  it('Q3 (9 months) divides correctly', () => {
    const result = build({
      fiscalPeriod:            'Q3',
      operatingCashFlow:       -900_000,
      operatingCashFlowMonths: 9,
    });

    expect(result.monthlyBurnRate).toBe(100_000);
  });

  it('FY (12 months) divides correctly', () => {
    const result = build({
      fiscalPeriod:            'FY',
      operatingCashFlow:       -1_200_000,
      operatingCashFlowMonths: 12,
    });

    expect(result.monthlyBurnRate).toBe(100_000);
  });
});

// ─── 9. Going concern true ────────────────────────────────────────────────────

describe('buildFinancialSnapshot — going concern true', () => {
  it('sets goingConcernFlag true when GC result has flag true', () => {
    const result = build({}, GC_TRUE);

    expect(result.goingConcernFlag).toBe(true);
  });

  it('preserves the matched sentence verbatim', () => {
    const result = build({}, GC_TRUE);

    expect(result.goingConcernSentence).toBe(GC_TRUE.matchedSentence);
  });
});

// ─── 10. Going concern false ──────────────────────────────────────────────────

describe('buildFinancialSnapshot — going concern false', () => {
  it('goingConcernFlag is false when GC result has flag false', () => {
    const result = build({}, GC_FALSE);

    expect(result.goingConcernFlag).toBe(false);
  });

  it('goingConcernSentence is undefined when GC result has no matched sentence', () => {
    const result = build({}, GC_FALSE);

    expect(result.goingConcernSentence).toBeUndefined();
  });

  it('goingConcernFlag defaults to false when GC parameter is omitted', () => {
    const result = build({}, undefined);

    expect(result.goingConcernFlag).toBe(false);
  });
});

// ─── 11. dataSource: 'xbrl' ──────────────────────────────────────────────────

describe('buildFinancialSnapshot — dataSource xbrl', () => {
  it("dataSource is 'xbrl' when XBRL is available and no GC parameter provided", () => {
    const result = build({ xbrlAvailable: true }, undefined);

    expect(result.dataSource).toBe('xbrl');
  });
});

// ─── 12. dataSource: 'text' ──────────────────────────────────────────────────

describe('buildFinancialSnapshot — dataSource text', () => {
  it("dataSource is 'text' when XBRL is unavailable and GC is provided", () => {
    const result = buildFinancialSnapshot({
      ...BASE_META,
      xbrl: EMPTY_XBRL,
      gc:   GC_TRUE,
    });

    expect(result.dataSource).toBe('text');
  });

  it("dataSource is 'text' even when goingConcernFlag is false (extractor ran)", () => {
    const result = buildFinancialSnapshot({
      ...BASE_META,
      xbrl: EMPTY_XBRL,
      gc:   GC_FALSE,
    });

    expect(result.dataSource).toBe('text');
  });
});

// ─── 13. dataSource: 'xbrl+text' ─────────────────────────────────────────────

describe('buildFinancialSnapshot — dataSource xbrl+text', () => {
  it("dataSource is 'xbrl+text' when XBRL is available and GC is provided", () => {
    const result = build({ xbrlAvailable: true }, GC_TRUE);

    expect(result.dataSource).toBe('xbrl+text');
  });

  it("dataSource is 'xbrl+text' even when goingConcernFlag is false", () => {
    const result = build({ xbrlAvailable: true }, GC_FALSE);

    expect(result.dataSource).toBe('xbrl+text');
  });
});

// ─── 14. Missing XBRL with valid text result ──────────────────────────────────

describe('buildFinancialSnapshot — XBRL unavailable, text available', () => {
  it('financial fields are undefined when XBRL is unavailable', () => {
    const result = buildFinancialSnapshot({
      ...BASE_META,
      xbrl: EMPTY_XBRL,
      gc:   GC_TRUE,
    });

    expect(result.cashAndEquivalents).toBeUndefined();
    expect(result.currentLiabilities).toBeUndefined();
    expect(result.accumulatedDeficit).toBeUndefined();
    expect(result.operatingCashFlow).toBeUndefined();
    expect(result.monthlyBurnRate).toBeUndefined();
    expect(result.cashRunwayMonths).toBeUndefined();
  });

  it('going concern flag and sentence are set from text result even without XBRL', () => {
    const result = buildFinancialSnapshot({
      ...BASE_META,
      xbrl: EMPTY_XBRL,
      gc:   GC_TRUE,
    });

    expect(result.goingConcernFlag).toBe(true);
    expect(result.goingConcernSentence).toBe(GC_TRUE.matchedSentence);
  });
});

// ─── 15. Sign preservation ────────────────────────────────────────────────────

describe('buildFinancialSnapshot — sign preservation', () => {
  it('preserves negative accumulatedDeficit', () => {
    const result = build({ accumulatedDeficit: -8_500_000 });

    expect(result.accumulatedDeficit).toBe(-8_500_000);
  });

  it('preserves positive accumulatedDeficit (retained earnings)', () => {
    const result = build({ accumulatedDeficit: 1_200_000 });

    expect(result.accumulatedDeficit).toBe(1_200_000);
  });

  it('preserves negative operatingCashFlow on the snapshot', () => {
    const result = build({ operatingCashFlow: -300_000 });

    expect(result.operatingCashFlow).toBe(-300_000);
  });
});

// ─── 16. Debt component preservation ─────────────────────────────────────────

describe('buildFinancialSnapshot — debt', () => {
  it('preserves totalDebt value exactly', () => {
    const result = build({ totalDebt: 2_000_000, totalDebtComponents: ['ConvertibleNotesPayable', 'LongTermDebt'] });

    expect(result.totalDebt).toBe(2_000_000);
  });

  it('preserves the totalDebtComponents list in order', () => {
    const result = build({ totalDebtComponents: ['ConvertibleNotesPayable', 'LongTermDebt'] });

    expect(result.totalDebtComponents).toEqual(['ConvertibleNotesPayable', 'LongTermDebt']);
  });

  it('totalDebt is undefined when no debt components were found', () => {
    const result = build({ totalDebt: undefined, totalDebtComponents: [] });

    expect(result.totalDebt).toBeUndefined();
    expect(result.totalDebtComponents).toHaveLength(0);
  });
});

// ─── 17. Provenance preservation ─────────────────────────────────────────────

describe('buildFinancialSnapshot — provenance', () => {
  it('accessionNumber is taken from XBRL result', () => {
    const result = build({ accessionNumber: '0001655050-26-000001' });

    expect(result.accessionNumber).toBe('0001655050-26-000001');
  });

  it('accessionNumber is undefined when XBRL is unavailable', () => {
    const result = buildFinancialSnapshot({
      ...BASE_META,
      xbrl: EMPTY_XBRL,
      gc:   GC_TRUE,
    });

    expect(result.accessionNumber).toBeUndefined();
  });

  it('goingConcernSentence matches exactly what the extractor returned', () => {
    const sentence = "These conditions raise substantial doubt about the Company's ability to continue as a going concern.";
    const result = build({}, { ...GC_TRUE, matchedSentence: sentence });

    expect(result.goingConcernSentence).toBe(sentence);
  });

  it('extractedAt is the injected timestamp when provided', () => {
    const result = buildFinancialSnapshot({ ...BASE_META, xbrl: BASE_XBRL, extractedAt: FIXED_AT });

    expect(result.extractedAt).toBe(FIXED_AT);
  });

  it('extractedAt is a valid ISO string when not injected', () => {
    const result = buildFinancialSnapshot({ ticker: 'X', cik: '1', formType: '10-Q', xbrl: BASE_XBRL });

    expect(result.extractedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('missingConcepts forwarded unchanged from XBRL result', () => {
    const missing = ['CashAndCashEquivalentsAtCarryingValue', 'LiabilitiesCurrent'];
    const result = build({ missingConcepts: missing });

    expect(result.missingConcepts).toEqual(missing);
  });
});

// ─── 18. No Infinity / NaN outputs ───────────────────────────────────────────

describe('buildFinancialSnapshot — no Infinity or NaN', () => {
  it('cashRunwayMonths is never Infinity (monthlyBurnRate > 0 guard prevents /0)', () => {
    const result = build({
      cashAndEquivalents:      Number.MAX_SAFE_INTEGER,
      operatingCashFlow:       -1,
      operatingCashFlowMonths: 1,
    });

    expect(result.cashRunwayMonths).not.toBe(Infinity);
    expect(Number.isFinite(result.cashRunwayMonths!)).toBe(true);
  });

  it('all numeric fields on a fully-populated snapshot are finite (not NaN, not Inf)', () => {
    const result = build({}, GC_TRUE);

    const numericFields: Array<keyof FinancialSnapshot> = [
      'cashAndEquivalents', 'currentLiabilities', 'accumulatedDeficit',
      'totalDebt', 'operatingCashFlow', 'operatingCashFlowMonths',
      'monthlyBurnRate', 'cashRunwayMonths',
    ];

    for (const field of numericFields) {
      const val = result[field];
      if (val !== undefined) {
        expect(Number.isFinite(val as number), `${field} must be finite`).toBe(true);
      }
    }
  });
});

// ─── 19. missingConcepts forwarded unchanged ──────────────────────────────────

describe('buildFinancialSnapshot — missing concepts', () => {
  it('empty missingConcepts list is preserved', () => {
    const result = build({ missingConcepts: [] });

    expect(result.missingConcepts).toEqual([]);
  });

  it('populated missingConcepts from EMPTY_XBRL is preserved', () => {
    const result = buildFinancialSnapshot({ ...BASE_META, xbrl: EMPTY_XBRL });

    expect(result.missingConcepts.length).toBeGreaterThan(0);
    expect(result.missingConcepts).toContain('CashAndCashEquivalentsAtCarryingValue');
  });
});

// ─── 20. Identity and period fields carry through ─────────────────────────────

describe('buildFinancialSnapshot — identity and period passthrough', () => {
  it('carries ticker, cik, and formType unchanged', () => {
    const result = buildFinancialSnapshot({
      ticker:   'WXYZ',
      cik:      '0001234567',
      formType: '10-K',
      xbrl:     BASE_XBRL,
      extractedAt: FIXED_AT,
    });

    expect(result.ticker).toBe('WXYZ');
    expect(result.cik).toBe('0001234567');
    expect(result.formType).toBe('10-K');
  });

  it('carries fiscalPeriod, fiscalYear, periodEndDate, filedAt from XBRL', () => {
    const result = build({
      fiscalPeriod:  'FY',
      fiscalYear:    2025,
      periodEndDate: '2025-12-31',
      filedAt:       '2026-03-15',
    });

    expect(result.fiscalPeriod).toBe('FY');
    expect(result.fiscalYear).toBe(2025);
    expect(result.periodEndDate).toBe('2025-12-31');
    expect(result.filedAt).toBe('2026-03-15');
  });
});
