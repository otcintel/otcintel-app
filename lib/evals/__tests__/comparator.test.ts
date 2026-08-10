import { describe, it, expect } from 'vitest';
import {
  normalizeDate,
  normalizeFraction,
  normalizeValue,
  compareField,
  compareFields,
  casePassedFromResults,
} from '../comparator';
import type { FieldExpectation } from '../types';

// ─── normalizeDate ────────────────────────────────────────────────────────────

describe('normalizeDate', () => {
  it('returns ISO date string unchanged', () => {
    expect(normalizeDate('2027-02-12')).toBe('2027-02-12');
  });

  it('parses "Month DD, YYYY" format', () => {
    expect(normalizeDate('February 12, 2027')).toBe('2027-02-12');
    expect(normalizeDate('June 3, 2027')).toBe('2027-06-03');
    expect(normalizeDate('March 15, 2027')).toBe('2027-03-15');
    expect(normalizeDate('January 1, 2026')).toBe('2026-01-01');
  });

  it('pads single-digit day to two digits', () => {
    expect(normalizeDate('June 3, 2027')).toBe('2027-06-03');
  });

  it('handles abbreviated month names', () => {
    expect(normalizeDate('Feb 12, 2027')).toBe('2027-02-12');
  });

  it('returns original string when parsing fails', () => {
    expect(normalizeDate('unknown date')).toBe('unknown date');
    expect(normalizeDate('Q3 2026')).toBe('Q3 2026');
  });

  it('trims whitespace', () => {
    expect(normalizeDate('  2027-02-12  ')).toBe('2027-02-12');
  });
});

// ─── normalizeFraction ────────────────────────────────────────────────────────

describe('normalizeFraction', () => {
  it('rounds to 4 decimal places', () => {
    expect(normalizeFraction(0.22)).toBe(0.22);
    expect(normalizeFraction(0.333333)).toBe(0.3333);
    expect(normalizeFraction(0.19999)).toBe(0.2);
  });

  it('handles zero', () => {
    expect(normalizeFraction(0)).toBe(0);
  });

  it('handles 1.0', () => {
    expect(normalizeFraction(1.0)).toBe(1.0);
  });
});

// ─── normalizeValue ───────────────────────────────────────────────────────────

describe('normalizeValue', () => {
  it('normalizes fraction fields to 4 decimal places', () => {
    expect(normalizeValue('discountRate', 0.2200001)).toBe(0.22);
    expect(normalizeValue('interestRate', 0.0800001)).toBe(0.08);
  });

  it('does not treat non-fraction numeric fields as fractions', () => {
    expect(normalizeValue('principalAmount', 1500000)).toBe(1500000);
    expect(normalizeValue('lookbackDays', 10)).toBe(10);
  });

  it('normalizes date fields', () => {
    expect(normalizeValue('maturityDate', 'February 12, 2027')).toBe('2027-02-12');
    expect(normalizeValue('executionDate', 'June 3, 2026')).toBe('2026-06-03');
  });

  it('normalizes integer fields by rounding', () => {
    expect(normalizeValue('lookbackDays', 10.0)).toBe(10);
    expect(normalizeValue('sharesAuthorized', 1000000000.0)).toBe(1000000000);
  });

  it('normalizes dollar fields to 2 decimal places', () => {
    expect(normalizeValue('floorPrice', 0.18)).toBe(0.18);
    expect(normalizeValue('warrantExercisePrice', 0.10)).toBe(0.1);
  });

  it('trims string values', () => {
    expect(normalizeValue('investorName', '  Northfield Capital Group LLC  ')).toBe('Northfield Capital Group LLC');
  });

  it('returns null/undefined unchanged', () => {
    expect(normalizeValue('discountRate', null)).toBeNull();
    expect(normalizeValue('discountRate', undefined)).toBeUndefined();
  });

  it('returns booleans unchanged', () => {
    expect(normalizeValue('hasFloorPrice', false)).toBe(false);
    expect(normalizeValue('hasResetProvisions', true)).toBe(true);
  });
});

// ─── compareField ─────────────────────────────────────────────────────────────

describe('compareField', () => {
  const verified = (value: number | string | boolean | null, note?: string): FieldExpectation => ({
    value,
    status: 'verified',
    note,
  });
  const review = (value: number | string | boolean | null): FieldExpectation => ({
    value,
    status: 'needs_domain_review',
  });

  it('returns match for equal values', () => {
    const r = compareField('principalAmount', verified(1500000), 1500000);
    expect(r.status).toBe('match');
    expect(r.verificationStatus).toBe('verified');
  });

  it('returns mismatch for differing values', () => {
    const r = compareField('principalAmount', verified(1500000), 2000000);
    expect(r.status).toBe('mismatch');
    expect(r.expectedValue).toBe(1500000);
    expect(r.actualValue).toBe(2000000);
  });

  it('returns missing when actual is undefined', () => {
    const r = compareField('discountRate', verified(0.22), undefined);
    expect(r.status).toBe('missing');
    expect(r.actualValue).toBeUndefined();
  });

  it('returns missing when actual is null', () => {
    const r = compareField('discountRate', verified(0.22), null);
    expect(r.status).toBe('missing');
  });

  it('normalizes dates before comparison', () => {
    const r = compareField('maturityDate', verified('2027-02-12'), 'February 12, 2027');
    expect(r.status).toBe('match');
  });

  it('normalizes fractions before comparison', () => {
    const r = compareField('discountRate', verified(0.22), 0.2200001);
    expect(r.status).toBe('match');
  });

  it('preserves verificationStatus on results', () => {
    const r1 = compareField('principalAmount', verified(1500000), 1500000);
    expect(r1.verificationStatus).toBe('verified');

    const r2 = compareField('investorName', review('Northfield Capital Group LLC'), 'Northfield Capital Group LLC');
    expect(r2.verificationStatus).toBe('needs_domain_review');
  });

  it('propagates note from expectation', () => {
    const r = compareField('principalAmount', verified(1500000, 'From text'), 1500000);
    expect(r.note).toBe('From text');
  });

  it('matches boolean false correctly', () => {
    const r = compareField('hasFloorPrice', verified(false), false);
    expect(r.status).toBe('match');
  });

  it('detects boolean mismatch', () => {
    const r = compareField('hasFloorPrice', verified(false), true);
    expect(r.status).toBe('mismatch');
  });
});

// ─── compareFields ────────────────────────────────────────────────────────────

describe('compareFields', () => {
  it('returns one FieldResult per expected field', () => {
    const expected: Record<string, FieldExpectation> = {
      financingType:  { value: 'convertible_note', status: 'verified' },
      principalAmount: { value: 1500000, status: 'verified' },
      hasFloorPrice:  { value: false, status: 'verified' },
    };
    const actual = {
      financingType: 'convertible_note',
      principalAmount: 1500000,
      hasFloorPrice: false,
    };
    const results = compareFields(expected, actual);
    expect(results).toHaveLength(3);
    expect(results.every(r => r.status === 'match')).toBe(true);
  });

  it('reports missing fields', () => {
    const expected: Record<string, FieldExpectation> = {
      discountRate: { value: 0.22, status: 'verified' },
    };
    const results = compareFields(expected, {});
    expect(results[0].status).toBe('missing');
  });

  it('reports mismatches on wrong values', () => {
    const expected: Record<string, FieldExpectation> = {
      lookbackDays: { value: 10, status: 'verified' },
    };
    const results = compareFields(expected, { lookbackDays: 20 });
    expect(results[0].status).toBe('mismatch');
  });

  it('does not fail on unexpected actual fields not in expected', () => {
    const expected: Record<string, FieldExpectation> = {
      principalAmount: { value: 1500000, status: 'verified' },
    };
    const actual = { principalAmount: 1500000, confidenceScore: 0.85, matchedPhrases: [] };
    const results = compareFields(expected, actual);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('match');
  });
});

// ─── casePassedFromResults ────────────────────────────────────────────────────

describe('casePassedFromResults', () => {
  it('returns true when all verified fields match', () => {
    const results = [
      { fieldName: 'a', verificationStatus: 'verified' as const, status: 'match' as const, expectedValue: 1, actualValue: 1 },
      { fieldName: 'b', verificationStatus: 'verified' as const, status: 'match' as const, expectedValue: 2, actualValue: 2 },
    ];
    expect(casePassedFromResults(results)).toBe(true);
  });

  it('returns false when a verified field is missing', () => {
    const results = [
      { fieldName: 'a', verificationStatus: 'verified' as const, status: 'missing' as const, expectedValue: 1, actualValue: undefined },
    ];
    expect(casePassedFromResults(results)).toBe(false);
  });

  it('returns false when a verified field mismatches', () => {
    const results = [
      { fieldName: 'a', verificationStatus: 'verified' as const, status: 'mismatch' as const, expectedValue: 1, actualValue: 2 },
    ];
    expect(casePassedFromResults(results)).toBe(false);
  });

  it('returns true when only needs_domain_review fields mismatch', () => {
    const results = [
      { fieldName: 'a', verificationStatus: 'verified' as const, status: 'match' as const, expectedValue: 1, actualValue: 1 },
      { fieldName: 'b', verificationStatus: 'needs_domain_review' as const, status: 'mismatch' as const, expectedValue: 'x', actualValue: 'y' },
    ];
    expect(casePassedFromResults(results)).toBe(true);
  });

  it('returns true for empty results (no expectations evaluated)', () => {
    expect(casePassedFromResults([])).toBe(true);
  });
});
