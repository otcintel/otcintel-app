import { describe, it, expect } from 'vitest';
import { computeMetrics } from '../metrics';
import type { CaseResult, GoldenCase, FieldResult } from '../types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeGoldenCase(overrides: Partial<GoldenCase> = {}): GoldenCase {
  return {
    $schema: '1.0.0',
    id: 'TEST-8K-001',
    description: 'Test case',
    ticker: 'TEST',
    cik: '0001234567',
    formType: '8-K',
    filedAt: '2026-01-01',
    accessionNumber: '0001234567-26-000001',
    fixtureSource: 'mock_rawFilings',
    evaluationTarget: 'ExtractedFinancingTerms',
    expected: {},
    ...overrides,
  };
}

function makeFieldResult(overrides: Partial<FieldResult>): FieldResult {
  return {
    fieldName: 'principalAmount',
    verificationStatus: 'verified',
    status: 'match',
    expectedValue: 1000000,
    actualValue: 1000000,
    ...overrides,
  };
}

function makeCaseResult(overrides: Partial<CaseResult>): CaseResult {
  return {
    case: makeGoldenCase(),
    fieldResults: [],
    passed: true,
    verifiedMatched: 0,
    verifiedTotal: 0,
    reviewWarnings: [],
    ...overrides,
  };
}

// ─── computeMetrics ───────────────────────────────────────────────────────────

describe('computeMetrics', () => {
  it('returns zero metrics for empty results', () => {
    const m = computeMetrics([]);
    expect(m.totalCases).toBe(0);
    expect(m.casesPassed).toBe(0);
    expect(m.casesFailed).toBe(0);
    expect(m.casesErrored).toBe(0);
    expect(m.casePassRate).toBe(0);
    expect(m.verifiedFieldAccuracy).toBe(0);
  });

  it('counts passed cases correctly', () => {
    const results = [
      makeCaseResult({ passed: true }),
      makeCaseResult({ passed: true }),
      makeCaseResult({ passed: false }),
    ];
    const m = computeMetrics(results);
    expect(m.casesPassed).toBe(2);
    expect(m.casesFailed).toBe(1);
    expect(m.casePassRate).toBeCloseTo(2 / 3);
  });

  it('counts errored cases correctly', () => {
    const results = [
      makeCaseResult({ passed: false, error: 'fixture not found' }),
      makeCaseResult({ passed: true }),
    ];
    const m = computeMetrics(results);
    expect(m.casesErrored).toBe(1);
    expect(m.casesPassed).toBe(1);
  });

  it('counts verified field results correctly', () => {
    const fieldResults: FieldResult[] = [
      makeFieldResult({ verificationStatus: 'verified', status: 'match' }),
      makeFieldResult({ verificationStatus: 'verified', status: 'mismatch' }),
      makeFieldResult({ verificationStatus: 'verified', status: 'missing' }),
      makeFieldResult({ verificationStatus: 'needs_domain_review', status: 'match' }),
      makeFieldResult({ verificationStatus: 'needs_domain_review', status: 'mismatch' }),
    ];
    const results = [makeCaseResult({ fieldResults })];
    const m = computeMetrics(results);
    expect(m.totalVerifiedFields).toBe(3);
    expect(m.verifiedFieldsMatched).toBe(1);
    expect(m.verifiedFieldsMismatched).toBe(1);
    expect(m.verifiedFieldsMissing).toBe(1);
    expect(m.totalReviewFields).toBe(2);
    expect(m.reviewFieldsMatched).toBe(1);
    expect(m.reviewFieldsMismatched).toBe(1);
  });

  it('computes verifiedFieldAccuracy correctly', () => {
    const fieldResults: FieldResult[] = [
      makeFieldResult({ verificationStatus: 'verified', status: 'match' }),
      makeFieldResult({ verificationStatus: 'verified', status: 'match' }),
      makeFieldResult({ verificationStatus: 'verified', status: 'mismatch' }),
    ];
    const m = computeMetrics([makeCaseResult({ fieldResults })]);
    expect(m.verifiedFieldAccuracy).toBeCloseTo(2 / 3);
  });

  it('aggregates field results across multiple cases', () => {
    const case1 = makeCaseResult({
      fieldResults: [
        makeFieldResult({ verificationStatus: 'verified', status: 'match' }),
        makeFieldResult({ verificationStatus: 'verified', status: 'match' }),
      ],
    });
    const case2 = makeCaseResult({
      fieldResults: [
        makeFieldResult({ verificationStatus: 'verified', status: 'mismatch' }),
      ],
    });
    const m = computeMetrics([case1, case2]);
    expect(m.totalVerifiedFields).toBe(3);
    expect(m.verifiedFieldsMatched).toBe(2);
    expect(m.verifiedFieldsMismatched).toBe(1);
  });

  it('groups fields by category in byCategory', () => {
    const fieldResults: FieldResult[] = [
      makeFieldResult({ fieldName: 'principalAmount', verificationStatus: 'verified', status: 'match' }),
      makeFieldResult({ fieldName: 'discountRate', verificationStatus: 'verified', status: 'match' }),
      makeFieldResult({ fieldName: 'financingType', verificationStatus: 'verified', status: 'mismatch' }),
    ];
    const m = computeMetrics([makeCaseResult({ fieldResults })]);

    const financial = m.byCategory.find(c => c.category === 'FINANCIAL_TERMS');
    const conversion = m.byCategory.find(c => c.category === 'CONVERSION_TERMS');
    const identity = m.byCategory.find(c => c.category === 'IDENTITY');

    expect(financial?.fieldsEvaluated).toBe(1);
    expect(financial?.fieldsMatched).toBe(1);
    expect(conversion?.fieldsEvaluated).toBe(1);
    expect(conversion?.fieldsMatched).toBe(1);
    expect(identity?.fieldsEvaluated).toBe(1);
    expect(identity?.fieldsMatched).toBe(0);
  });

  it('excludes categories with zero evaluated fields', () => {
    const m = computeMetrics([makeCaseResult({ fieldResults: [] })]);
    expect(m.byCategory).toHaveLength(0);
  });

  it('sets evaluatedAt to a recent ISO timestamp', () => {
    const before = Date.now();
    const m = computeMetrics([]);
    const after = Date.now();
    const ts = new Date(m.evaluatedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('sets casePassRate to 1 when all cases pass', () => {
    const results = [
      makeCaseResult({ passed: true }),
      makeCaseResult({ passed: true }),
    ];
    expect(computeMetrics(results).casePassRate).toBe(1);
  });

  it('sets casePassRate to 0 when no cases pass', () => {
    const results = [
      makeCaseResult({ passed: false }),
    ];
    expect(computeMetrics(results).casePassRate).toBe(0);
  });
});
