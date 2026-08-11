/**
 * Tests for lib/ingestion/parsers/financials/xbrlConcepts.ts
 *
 * Pure-function tests — no network, no DB, no mocked modules.
 * All test inputs are constructed as typed CompanyFacts objects.
 */

import { describe, it, expect } from 'vitest';
import {
  extractXbrlConcepts,
  CASH_CONCEPTS,
  OPERATING_CF_CONCEPTS,
  CURRENT_LIABILITIES_CONCEPTS,
  ACCUMULATED_DEFICIT_CONCEPTS,
  DEBT_CONCEPTS,
} from '../xbrlConcepts';
import type { CompanyFacts, XbrlConceptValue } from '../../../fetchers/edgar/companyFacts';
import { buildFinancialSnapshot } from '../snapshot';
import { scoreRunwayUrgency } from '../runwayUrgency';
import { applyRunwayUplift } from '../../../runwayIntegration';
import type { RiskScoreRecord, RiskFactor } from '../../../../types';

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeValue(overrides: Partial<XbrlConceptValue> & Pick<XbrlConceptValue, 'end' | 'val'>): XbrlConceptValue {
  return {
    accn:  '0001234567-26-000001',
    fy:    2026,
    fp:    'Q1',
    form:  '10-Q',
    filed: '2026-05-15',
    ...overrides,
  };
}

/** Build a minimal CompanyFacts with arbitrary us-gaap concepts. */
function makeFacts(concepts: Record<string, { instant?: XbrlConceptValue[]; duration?: XbrlConceptValue[] }>): CompanyFacts {
  const usgaap: Record<string, { label: string; units: { USD: XbrlConceptValue[] } }> = {};
  for (const [name, { instant = [], duration = [] }] of Object.entries(concepts)) {
    usgaap[name] = { label: name, units: { USD: [...instant, ...duration] } };
  }
  return { cik: 1234567, entityName: 'Test Corp', facts: { 'us-gaap': usgaap } };
}

// Standard Q1-2026 balance sheet context
const Q1_2026 = { fp: 'Q1', fy: 2026, end: '2026-03-31' };
const Q1_VALUE = (val: number, overrides?: Partial<XbrlConceptValue>) =>
  makeValue({ ...Q1_2026, val, ...overrides });
const Q1_DURATION = (val: number, overrides?: Partial<XbrlConceptValue>) =>
  makeValue({ ...Q1_2026, start: '2026-01-01', val, ...overrides });

// ─── 1. Empty / malformed input ───────────────────────────────────────────────

describe('extractXbrlConcepts — malformed / empty input', () => {
  it('returns xbrlAvailable:false when us-gaap is missing', () => {
    const facts: CompanyFacts = { cik: 1, entityName: 'X', facts: {} };
    const result = extractXbrlConcepts(facts);
    expect(result.xbrlAvailable).toBe(false);
  });

  it('returns xbrlAvailable:false when us-gaap is empty', () => {
    const facts: CompanyFacts = { cik: 1, entityName: 'X', facts: { 'us-gaap': {} } };
    const result = extractXbrlConcepts(facts);
    expect(result.xbrlAvailable).toBe(false);
  });

  it('lists all attempted concepts in missingConcepts when us-gaap is empty', () => {
    const facts: CompanyFacts = { cik: 1, entityName: 'X', facts: { 'us-gaap': {} } };
    const result = extractXbrlConcepts(facts);
    const allConcepts = [
      ...CASH_CONCEPTS, ...OPERATING_CF_CONCEPTS,
      ...CURRENT_LIABILITIES_CONCEPTS, ...ACCUMULATED_DEFICIT_CONCEPTS, ...DEBT_CONCEPTS,
    ];
    for (const c of allConcepts) {
      expect(result.missingConcepts).toContain(c);
    }
  });

  it('returns all financial fields undefined when no period is found', () => {
    const facts: CompanyFacts = { cik: 1, entityName: 'X', facts: { 'us-gaap': {} } };
    const result = extractXbrlConcepts(facts);
    expect(result.cashAndEquivalents).toBeUndefined();
    expect(result.operatingCashFlow).toBeUndefined();
    expect(result.totalDebt).toBeUndefined();
    expect(result.fiscalPeriod).toBeUndefined();
  });

  it('returns xbrlAvailable:true when at least one concept is found', () => {
    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue: { instant: [Q1_VALUE(500_000)] },
    });
    const result = extractXbrlConcepts(facts);
    expect(result.xbrlAvailable).toBe(true);
  });

  it('ignores values from non-financial forms (e.g. 8-K)', () => {
    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue: {
        instant: [Q1_VALUE(999, { form: '8-K' })],
      },
    });
    const result = extractXbrlConcepts(facts);
    expect(result.xbrlAvailable).toBe(false);
  });

  it('ignores values with null fp', () => {
    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue: {
        instant: [Q1_VALUE(999, { fp: null as unknown as string })],
      },
    });
    const result = extractXbrlConcepts(facts);
    expect(result.xbrlAvailable).toBe(false);
  });
});

// ─── 2. Cash concept fallback priority ───────────────────────────────────────

describe('extractXbrlConcepts — cash concept priority', () => {
  it('uses CashAndCashEquivalentsAtCarryingValue when present', () => {
    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue: { instant: [Q1_VALUE(1_000_000)] },
    });
    expect(extractXbrlConcepts(facts).cashAndEquivalents).toBe(1_000_000);
  });

  it('falls back to Cash when primary concept is absent', () => {
    const facts = makeFacts({
      Cash: { instant: [Q1_VALUE(2_000_000)] },
    });
    expect(extractXbrlConcepts(facts).cashAndEquivalents).toBe(2_000_000);
  });

  it('falls back to CashCashEquivalentsAndShortTermInvestments as fourth priority', () => {
    const facts = makeFacts({
      CashCashEquivalentsAndShortTermInvestments: { instant: [Q1_VALUE(3_000_000)] },
    });
    expect(extractXbrlConcepts(facts).cashAndEquivalents).toBe(3_000_000);
  });

  it('uses the primary concept and ignores lower-priority ones when multiple present', () => {
    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue: { instant: [Q1_VALUE(1_000)] },
      Cash:                                  { instant: [Q1_VALUE(9_999)] },
    });
    expect(extractXbrlConcepts(facts).cashAndEquivalents).toBe(1_000);
  });

  it('tracks missing cash concepts when fallback is used', () => {
    const facts = makeFacts({
      Cash: { instant: [Q1_VALUE(500)] },
    });
    const result = extractXbrlConcepts(facts);
    expect(result.missingConcepts).toContain('CashAndCashEquivalentsAtCarryingValue');
    expect(result.missingConcepts).not.toContain('Cash');
  });
});

// ─── 3. Operating cash flow extraction ───────────────────────────────────────

describe('extractXbrlConcepts — operating cash flow', () => {
  it('extracts operating cash flow from the duration concept', () => {
    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue: { instant: [Q1_VALUE(100)] },
      NetCashProvidedByUsedInOperatingActivities: { duration: [Q1_DURATION(-80_000)] },
    });
    const result = extractXbrlConcepts(facts);
    expect(result.operatingCashFlow).toBe(-80_000);
  });

  it('does not use an instant value for operating cash flow', () => {
    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue: { instant: [Q1_VALUE(100)] },
      // Same concept but supplied as instant (no start) — must be ignored
      NetCashProvidedByUsedInOperatingActivities: {
        instant: [Q1_VALUE(-99_999)],
      },
    });
    const result = extractXbrlConcepts(facts);
    expect(result.operatingCashFlow).toBeUndefined();
  });

  it('preserves negative operating cash flow exactly', () => {
    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue: { instant: [Q1_VALUE(1)] },
      NetCashProvidedByUsedInOperatingActivities: { duration: [Q1_DURATION(-1_234_567)] },
    });
    expect(extractXbrlConcepts(facts).operatingCashFlow).toBe(-1_234_567);
  });

  it('preserves positive operating cash flow for cash-flow-positive companies', () => {
    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue: { instant: [Q1_VALUE(1)] },
      NetCashProvidedByUsedInOperatingActivities: { duration: [Q1_DURATION(500_000)] },
    });
    expect(extractXbrlConcepts(facts).operatingCashFlow).toBe(500_000);
  });

  it('tracks missing operating CF concept when absent', () => {
    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue: { instant: [Q1_VALUE(1)] },
    });
    const result = extractXbrlConcepts(facts);
    expect(result.operatingCashFlow).toBeUndefined();
    expect(result.missingConcepts).toContain('NetCashProvidedByUsedInOperatingActivities');
  });
});

// ─── 4. Fiscal period month mapping ──────────────────────────────────────────

describe('extractXbrlConcepts — fiscal period month mapping', () => {
  function factsWithCf(fp: string, fy: number, end: string, start: string, val: number): CompanyFacts {
    const balanceValue = makeValue({ fp, fy, end, val: 1, form: '10-Q', filed: '2026-05-15' });
    const cfValue      = makeValue({ fp, fy, end, start, val, form: '10-Q', filed: '2026-05-15' });
    return makeFacts({
      CashAndCashEquivalentsAtCarryingValue:       { instant:  [balanceValue] },
      NetCashProvidedByUsedInOperatingActivities:  { duration: [cfValue] },
    });
  }

  it('maps Q1 → 3 months', () => {
    const facts = factsWithCf('Q1', 2026, '2026-03-31', '2026-01-01', -30_000);
    expect(extractXbrlConcepts(facts).operatingCashFlowMonths).toBe(3);
  });

  it('maps Q2 → 6 months', () => {
    const facts = factsWithCf('Q2', 2026, '2026-06-30', '2026-01-01', -60_000);
    expect(extractXbrlConcepts(facts).operatingCashFlowMonths).toBe(6);
  });

  it('maps Q3 → 9 months', () => {
    const facts = factsWithCf('Q3', 2026, '2026-09-30', '2026-01-01', -90_000);
    expect(extractXbrlConcepts(facts).operatingCashFlowMonths).toBe(9);
  });

  it('maps FY → 12 months', () => {
    const balVal = makeValue({ fp: 'FY', fy: 2025, end: '2025-12-31', val: 1, form: '10-K', filed: '2026-03-30' });
    const cfVal  = makeValue({ fp: 'FY', fy: 2025, end: '2025-12-31', start: '2025-01-01', val: -120_000, form: '10-K', filed: '2026-03-30' });
    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue:      { instant:  [balVal] },
      NetCashProvidedByUsedInOperatingActivities: { duration: [cfVal] },
    });
    expect(extractXbrlConcepts(facts).operatingCashFlowMonths).toBe(12);
  });

  it('derives months from start/end dates when fp is unknown', () => {
    const balVal = makeValue({ fp: 'XX', fy: 2026, end: '2026-03-31', val: 1, form: '10-Q', filed: '2026-05-15' });
    const cfVal  = makeValue({ fp: 'XX', fy: 2026, end: '2026-03-31', start: '2026-01-01', val: -10, form: '10-Q', filed: '2026-05-15' });
    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue:      { instant:  [balVal] },
      NetCashProvidedByUsedInOperatingActivities: { duration: [cfVal] },
    });
    // Jan-01 to Mar-31 = 3 months → maps to Q1 duration
    expect(extractXbrlConcepts(facts).operatingCashFlowMonths).toBe(3);
  });
});

// ─── 5. Amendment: latest-filed value wins ────────────────────────────────────

describe('extractXbrlConcepts — amendment resolution (latest-filed wins)', () => {
  it('prefers 10-Q/A amendment value over original 10-Q for same period', () => {
    const original  = Q1_VALUE(500_000, { form: '10-Q',   filed: '2026-05-15', accn: 'ORIG' });
    const amendment = Q1_VALUE(450_000, { form: '10-Q/A', filed: '2026-06-01', accn: 'AMND' });
    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue: { instant: [original, amendment] },
    });
    expect(extractXbrlConcepts(facts).cashAndEquivalents).toBe(450_000);
  });

  it('prefers 10-K/A amendment value over original 10-K for same period', () => {
    const fy = { fp: 'FY', fy: 2025, end: '2025-12-31' };
    const original  = makeValue({ ...fy, val: 1_000_000, form: '10-K',   filed: '2026-03-01', accn: 'ORIG' });
    const amendment = makeValue({ ...fy, val: 900_000,   form: '10-K/A', filed: '2026-04-01', accn: 'AMND' });
    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue: { instant: [original, amendment] },
    });
    expect(extractXbrlConcepts(facts).cashAndEquivalents).toBe(900_000);
  });

  it('preserves the accession number of the winning amendment', () => {
    const original  = Q1_VALUE(500_000, { form: '10-Q',   filed: '2026-05-15', accn: 'ORIG' });
    const amendment = Q1_VALUE(450_000, { form: '10-Q/A', filed: '2026-06-01', accn: 'AMND' });
    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue: { instant: [original, amendment] },
    });
    expect(extractXbrlConcepts(facts).accessionNumber).toBe('AMND');
  });

  it('uses the later-filed entry when two entries share the same form and period', () => {
    const older = Q1_VALUE(800_000, { filed: '2026-05-01', accn: 'OLD' });
    const newer = Q1_VALUE(750_000, { filed: '2026-05-15', accn: 'NEW' });
    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue: { instant: [older, newer] },
    });
    expect(extractXbrlConcepts(facts).cashAndEquivalents).toBe(750_000);
    expect(extractXbrlConcepts(facts).accessionNumber).toBe('NEW');
  });
});

// ─── 6. Instant vs duration filtering ────────────────────────────────────────

describe('extractXbrlConcepts — instant vs duration filtering', () => {
  it('does not use a duration value for the cash balance (balance sheet is instant-only)', () => {
    const facts = makeFacts({
      // Only a duration (start present) — must not be used for cash
      CashAndCashEquivalentsAtCarryingValue: {
        duration: [Q1_DURATION(1_000_000)],
      },
    });
    const result = extractXbrlConcepts(facts);
    expect(result.cashAndEquivalents).toBeUndefined();
  });

  it('does not use an instant value for operating cash flow (cash flow is duration-only)', () => {
    // Balance sheet needs a real instant to anchor the period
    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue: { instant: [Q1_VALUE(100)] },
      // instant CF value — must be ignored
      NetCashProvidedByUsedInOperatingActivities: { instant: [Q1_VALUE(-50_000)] },
    });
    const result = extractXbrlConcepts(facts);
    expect(result.operatingCashFlow).toBeUndefined();
  });

  it('accepts a 10-K instant value', () => {
    const annualVal = makeValue({ fp: 'FY', fy: 2025, end: '2025-12-31', val: 2_000_000, form: '10-K', filed: '2026-03-30' });
    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue: { instant: [annualVal] },
    });
    expect(extractXbrlConcepts(facts).cashAndEquivalents).toBe(2_000_000);
  });
});

// ─── 7. Accumulated deficit sign preservation ─────────────────────────────────

describe('extractXbrlConcepts — accumulated deficit sign', () => {
  it('preserves a negative value (accumulated deficit)', () => {
    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue:  { instant: [Q1_VALUE(1)] },
      RetainedEarningsAccumulatedDeficit:     { instant: [Q1_VALUE(-15_000_000)] },
    });
    expect(extractXbrlConcepts(facts).accumulatedDeficit).toBe(-15_000_000);
  });

  it('preserves a positive value (retained earnings)', () => {
    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue: { instant: [Q1_VALUE(1)] },
      RetainedEarningsAccumulatedDeficit:    { instant: [Q1_VALUE(3_000_000)] },
    });
    expect(extractXbrlConcepts(facts).accumulatedDeficit).toBe(3_000_000);
  });

  it('preserves zero exactly', () => {
    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue: { instant: [Q1_VALUE(1)] },
      RetainedEarningsAccumulatedDeficit:    { instant: [Q1_VALUE(0)] },
    });
    expect(extractXbrlConcepts(facts).accumulatedDeficit).toBe(0);
  });
});

// ─── 8. Partial debt composition ─────────────────────────────────────────────

describe('extractXbrlConcepts — debt aggregation', () => {
  it('sums all four debt concepts when all are present', () => {
    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue: { instant: [Q1_VALUE(1)] },
      NotesPayableCurrent:    { instant: [Q1_VALUE(100_000)] },
      LongTermDebt:           { instant: [Q1_VALUE(200_000)] },
      ConvertibleNotesPayable:{ instant: [Q1_VALUE(300_000)] },
      ConvertibleDebtCurrent: { instant: [Q1_VALUE(400_000)] },
    });
    const result = extractXbrlConcepts(facts);
    expect(result.totalDebt).toBe(1_000_000);
    expect(result.totalDebtComponents).toHaveLength(4);
  });

  it('sums only the debt concepts actually found (partial composition)', () => {
    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue: { instant: [Q1_VALUE(1)] },
      LongTermDebt:                          { instant: [Q1_VALUE(500_000)] },
      ConvertibleNotesPayable:               { instant: [Q1_VALUE(250_000)] },
    });
    const result = extractXbrlConcepts(facts);
    expect(result.totalDebt).toBe(750_000);
    expect(result.totalDebtComponents).toContain('LongTermDebt');
    expect(result.totalDebtComponents).toContain('ConvertibleNotesPayable');
    expect(result.totalDebtComponents).not.toContain('NotesPayableCurrent');
    expect(result.totalDebtComponents).not.toContain('ConvertibleDebtCurrent');
  });

  it('returns totalDebt:undefined (not zero) when no debt concepts are found', () => {
    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue: { instant: [Q1_VALUE(1)] },
    });
    const result = extractXbrlConcepts(facts);
    expect(result.totalDebt).toBeUndefined();
    expect(result.totalDebtComponents).toHaveLength(0);
  });

  it('missing debt components are listed in missingConcepts', () => {
    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue: { instant: [Q1_VALUE(1)] },
      LongTermDebt:                          { instant: [Q1_VALUE(100_000)] },
    });
    const result = extractXbrlConcepts(facts);
    expect(result.missingConcepts).toContain('NotesPayableCurrent');
    expect(result.missingConcepts).toContain('ConvertibleNotesPayable');
    expect(result.missingConcepts).toContain('ConvertibleDebtCurrent');
    expect(result.missingConcepts).not.toContain('LongTermDebt');
  });

  it('a single debt concept still produces a valid totalDebt', () => {
    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue: { instant: [Q1_VALUE(1)] },
      ConvertibleNotesPayable:               { instant: [Q1_VALUE(75_000)] },
    });
    const result = extractXbrlConcepts(facts);
    expect(result.totalDebt).toBe(75_000);
    expect(result.totalDebtComponents).toEqual(['ConvertibleNotesPayable']);
  });
});

// ─── 9. Missing concept tracking ─────────────────────────────────────────────

describe('extractXbrlConcepts — missing concept tracking', () => {
  it('records all missing balance sheet concepts in missingConcepts', () => {
    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue: { instant: [Q1_VALUE(1)] },
    });
    const result = extractXbrlConcepts(facts);
    expect(result.missingConcepts).toContain('LiabilitiesCurrent');
    expect(result.missingConcepts).toContain('RetainedEarningsAccumulatedDeficit');
  });

  it('does not list a found concept in missingConcepts', () => {
    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue: { instant: [Q1_VALUE(1)] },
      LiabilitiesCurrent:                   { instant: [Q1_VALUE(500_000)] },
    });
    const result = extractXbrlConcepts(facts);
    expect(result.missingConcepts).not.toContain('CashAndCashEquivalentsAtCarryingValue');
    expect(result.missingConcepts).not.toContain('LiabilitiesCurrent');
  });

  it('records lower-priority cash fallbacks that were tried before the hit', () => {
    // Cash found via second priority — first priority is recorded as missing
    const facts = makeFacts({
      Cash: { instant: [Q1_VALUE(1)] },
    });
    const result = extractXbrlConcepts(facts);
    expect(result.missingConcepts).toContain('CashAndCashEquivalentsAtCarryingValue');
    expect(result.missingConcepts).not.toContain('Cash');
  });
});

// ─── 10. Provenance / accession number preservation ──────────────────────────

describe('extractXbrlConcepts — provenance', () => {
  it('returns the accession number of the winning cash entry', () => {
    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue: {
        instant: [Q1_VALUE(1_000_000, { accn: 'ACC-Q1-2026' })],
      },
    });
    expect(extractXbrlConcepts(facts).accessionNumber).toBe('ACC-Q1-2026');
  });

  it('returns filedAt from the winning cash entry', () => {
    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue: {
        instant: [Q1_VALUE(1, { filed: '2026-05-20' })],
      },
    });
    expect(extractXbrlConcepts(facts).filedAt).toBe('2026-05-20');
  });

  it('falls back to current-liabilities accession when cash is missing', () => {
    const facts = makeFacts({
      LiabilitiesCurrent: {
        instant: [Q1_VALUE(500_000, { accn: 'LIAB-ACCN' })],
      },
    });
    const result = extractXbrlConcepts(facts);
    expect(result.accessionNumber).toBe('LIAB-ACCN');
  });

  it('returns the period end date as periodEndDate', () => {
    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue: { instant: [Q1_VALUE(1)] },
    });
    expect(extractXbrlConcepts(facts).periodEndDate).toBe('2026-03-31');
  });

  it('returns fiscalPeriod and fiscalYear from the period context', () => {
    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue: {
        instant: [makeValue({ fp: 'Q3', fy: 2025, end: '2025-09-30', val: 1, form: '10-Q', filed: '2025-11-14' })],
      },
    });
    const result = extractXbrlConcepts(facts);
    expect(result.fiscalPeriod).toBe('Q3');
    expect(result.fiscalYear).toBe(2025);
  });
});

// ─── 11. Period selection (most recent wins) ──────────────────────────────────

describe('extractXbrlConcepts — period selection', () => {
  it('selects the most recent period when multiple periods are present', () => {
    const q1 = makeValue({ fp: 'Q1', fy: 2026, end: '2026-03-31', val: 100, form: '10-Q', filed: '2026-05-15' });
    const q2 = makeValue({ fp: 'Q2', fy: 2026, end: '2026-06-30', val: 200, form: '10-Q', filed: '2026-08-14' });
    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue: { instant: [q1, q2] },
    });
    const result = extractXbrlConcepts(facts);
    expect(result.cashAndEquivalents).toBe(200);
    expect(result.periodEndDate).toBe('2026-06-30');
    expect(result.fiscalPeriod).toBe('Q2');
  });

  it('correctly targets an older period when options.end is pinned', () => {
    const q1 = makeValue({ fp: 'Q1', fy: 2026, end: '2026-03-31', val: 100, form: '10-Q', filed: '2026-05-15' });
    const q2 = makeValue({ fp: 'Q2', fy: 2026, end: '2026-06-30', val: 200, form: '10-Q', filed: '2026-08-14' });
    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue: { instant: [q1, q2] },
    });
    // Explicitly target Q1
    const result = extractXbrlConcepts(facts, { fp: 'Q1', fy: 2026, end: '2026-03-31' });
    expect(result.cashAndEquivalents).toBe(100);
    expect(result.periodEndDate).toBe('2026-03-31');
  });

  it('returns filedAt from the most-recently-filed entry among the most recent period', () => {
    const later  = makeValue({ fp: 'Q1', fy: 2026, end: '2026-03-31', val: 99, form: '10-Q/A', filed: '2026-06-01', accn: 'A2' });
    const earlier = makeValue({ fp: 'Q1', fy: 2026, end: '2026-03-31', val: 100, form: '10-Q', filed: '2026-05-15', accn: 'A1' });
    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue: { instant: [earlier, later] },
    });
    expect(extractXbrlConcepts(facts).filedAt).toBe('2026-06-01');
    expect(extractXbrlConcepts(facts).accessionNumber).toBe('A2');
  });
});

// ─── 12. Full snapshot: all fields populated ──────────────────────────────────


describe('extractXbrlConcepts — complete snapshot', () => {
  it('extracts a complete Q3 snapshot with all fields', () => {
    const period = { fp: 'Q3', fy: 2026, end: '2026-09-30' };
    const inst = (val: number) => makeValue({ ...period, val, form: '10-Q', filed: '2026-11-14', accn: 'FULL-ACCN' });
    const dur  = (val: number) => makeValue({ ...period, start: '2026-01-01', val, form: '10-Q', filed: '2026-11-14', accn: 'FULL-ACCN' });

    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue:       { instant:  [inst(3_500_000)] },
      LiabilitiesCurrent:                          { instant:  [inst(2_000_000)] },
      RetainedEarningsAccumulatedDeficit:           { instant:  [inst(-45_000_000)] },
      NetCashProvidedByUsedInOperatingActivities:  { duration: [dur(-2_700_000)] },
      LongTermDebt:                                { instant:  [inst(1_200_000)] },
      ConvertibleNotesPayable:                     { instant:  [inst(800_000)] },
    });

    const result = extractXbrlConcepts(facts);

    expect(result.xbrlAvailable).toBe(true);
    expect(result.fiscalPeriod).toBe('Q3');
    expect(result.fiscalYear).toBe(2026);
    expect(result.periodEndDate).toBe('2026-09-30');
    expect(result.accessionNumber).toBe('FULL-ACCN');
    expect(result.cashAndEquivalents).toBe(3_500_000);
    expect(result.currentLiabilities).toBe(2_000_000);
    expect(result.accumulatedDeficit).toBe(-45_000_000);
    expect(result.operatingCashFlow).toBe(-2_700_000);
    expect(result.operatingCashFlowMonths).toBe(9);
    expect(result.totalDebt).toBe(2_000_000);
    expect(result.totalDebtComponents).toContain('LongTermDebt');
    expect(result.totalDebtComponents).toContain('ConvertibleNotesPayable');
  });
});

// ─── 13. CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents fallback ─

describe('extractXbrlConcepts — restricted-cash fallback (CASH_CONCEPTS[2])', () => {
  it('scenario 1: uses restricted-cash concept when narrow cash concepts are absent for the period', () => {
    const facts = makeFacts({
      CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents: { instant: [Q1_VALUE(3_102_817)] },
      LiabilitiesCurrent: { instant: [Q1_VALUE(13_567_421)] },
    });
    const result = extractXbrlConcepts(facts);
    expect(result.cashAndEquivalents).toBe(3_102_817);
    expect(result.xbrlAvailable).toBe(true);
  });

  it('scenario 2: CashAndCashEquivalentsAtCarryingValue wins over restricted-cash concept when both present', () => {
    const facts = makeFacts({
      CashAndCashEquivalentsAtCarryingValue:                        { instant: [Q1_VALUE(1_000_000)] },
      CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents: { instant: [Q1_VALUE(1_250_000)] },
    });
    expect(extractXbrlConcepts(facts).cashAndEquivalents).toBe(1_000_000);
  });

  it('scenario 3: Cash wins over restricted-cash concept when present', () => {
    const facts = makeFacts({
      Cash:                                                          { instant: [Q1_VALUE(800_000)] },
      CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents: { instant: [Q1_VALUE(1_000_000)] },
    });
    expect(extractXbrlConcepts(facts).cashAndEquivalents).toBe(800_000);
  });
});

// ─── 14. VNRX Q1 2026: restricted cash → snapshot → runway → uplift ─────────

describe('VNRX Q1 2026 integration: restricted-cash concept → critical runway → +15 uplift', () => {
  // VNRX dropped CashAndCashEquivalentsAtCarryingValue in Q1 2026, switching to
  // the ASU 2016-18 combined concept. Reproduce that structure exactly.
  const FY2025_CASH = makeValue({ fp: 'FY', fy: 2025, end: '2025-12-31', val: 1_117_028, form: '10-K', filed: '2026-03-31' });
  const VNRX_FACTS = makeFacts({
    CashAndCashEquivalentsAtCarryingValue:                        { instant: [FY2025_CASH] },
    CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents: { instant: [Q1_VALUE(3_102_817)] },
    LiabilitiesCurrent:                         { instant:  [Q1_VALUE(13_567_421)] },
    RetainedEarningsAccumulatedDeficit:          { instant:  [Q1_VALUE(-259_566_144)] },
    NetCashProvidedByUsedInOperatingActivities:  { duration: [Q1_DURATION(-5_280_132)] },
  });

  it('scenario 4: extracts cash from restricted-cash concept when narrow concept absent for Q1 2026', () => {
    const result = extractXbrlConcepts(VNRX_FACTS);
    expect(result.cashAndEquivalents).toBe(3_102_817);
    expect(result.operatingCashFlow).toBe(-5_280_132);
    expect(result.operatingCashFlowMonths).toBe(3);
    expect(result.fiscalPeriod).toBe('Q1');
    expect(result.fiscalYear).toBe(2026);
    expect(result.periodEndDate).toBe('2026-03-31');
  });

  it('scenario 5: FinancialSnapshot computes correct monthly burn and runway', () => {
    const xbrl = extractXbrlConcepts(VNRX_FACTS);
    const snapshot = buildFinancialSnapshot({
      ticker: 'VNRX', cik: '0000093314', formType: '10-Q', xbrl,
      extractedAt: '2026-08-11T00:00:00.000Z',
    });
    expect(snapshot.cashAndEquivalents).toBe(3_102_817);
    expect(snapshot.operatingCashFlow).toBe(-5_280_132);
    expect(snapshot.monthlyBurnRate).toBe(1_760_044);
    expect(snapshot.cashRunwayMonths).toBeCloseTo(1.76, 1);
  });

  it('scenario 6: scoreRunwayUrgency classifies the snapshot as critical', () => {
    const xbrl = extractXbrlConcepts(VNRX_FACTS);
    const snapshot = buildFinancialSnapshot({
      ticker: 'VNRX', cik: '0000093314', formType: '10-Q', xbrl,
      extractedAt: '2026-08-11T00:00:00.000Z',
    });
    const urgency = scoreRunwayUrgency(snapshot);
    expect(urgency.runwayStatus).toBe('critical');
  });

  it('scenario 7: applyRunwayUplift raises a base score of 37 to 52', () => {
    const xbrl = extractXbrlConcepts(VNRX_FACTS);
    const snapshot = buildFinancialSnapshot({
      ticker: 'VNRX', cik: '0000093314', formType: '10-Q', xbrl,
      extractedAt: '2026-08-11T00:00:00.000Z',
    });
    const baseFactors: RiskFactor[] = [
      { name: 'Discount depth',   fillWidth: 10, fillColor: 'var(--green)', label: 'Low',  labelColor: 'var(--green)' },
      { name: 'Lookback window',  fillWidth: 40, fillColor: 'var(--amber)', label: 'Med',  labelColor: 'var(--amber)' },
      { name: 'Warrant coverage', fillWidth: 0,  fillColor: 'var(--green)', label: 'Low',  labelColor: 'var(--green)' },
      { name: 'Reset provisions', fillWidth: 18, fillColor: 'var(--green)', label: 'Low',  labelColor: 'var(--green)' },
      { name: 'Floor price',      fillWidth: 50, fillColor: 'var(--amber)', label: 'Med',  labelColor: 'var(--amber)' },
    ];
    const base: RiskScoreRecord = {
      ticker: 'VNRX',
      score:  37,
      level:  'low',
      color:  'green',
      barWidth: 37,
      bannerVariant:     'green-risk',
      bannerDotColor:    'var(--green)',
      bannerPillVariant: 'green',
      bannerMessage:     '<strong>Low financing risk detected.</strong>',
      factors:       baseFactors,
      drivers:       [],
      scoreBasis:    'valid',
      knownFactors:  ['discountRate'],
      unknownFactors: [],
      dataWarnings:  [],
    };
    const enhanced = applyRunwayUplift(base, snapshot);
    expect(enhanced.score).toBe(52);
    expect(enhanced.level).toBe('med');
    expect(enhanced.color).toBe('amber');
  });
});
