/**
 * OTCIntel — Evaluation Field Comparator
 *
 * Field-aware comparison and normalization for golden eval cases.
 *
 * Design principles:
 * - Financial values require exact match (no fuzzy matching for dollar amounts).
 * - Percentage fraction fields (discountRate, interestRate) compared at 4 decimal places.
 * - Date fields normalized to ISO format before comparison.
 * - String fields: trimmed for whitespace; case preserved (financing terminology is case-sensitive).
 * - Boolean fields: exact match.
 */

import type { FieldExpectation, FieldResult } from './types';

// ─── Field type classification ────────────────────────────────────────────────

/** Fields that store rates as 0–1 fractions (e.g. 0.22 = 22%) */
const FRACTION_FIELDS = new Set([
  'discountRate',
  'interestRate',
  'defaultInterestRate',
  'penaltyRate',
  'originalIssueDiscountPercent',
]);

/** Fields that contain date strings */
const DATE_FIELDS = new Set([
  'maturityDate',
  'executionDate',
  'expirationDate',
  'filedAt',
  'periodOfReport',
]);

/** Fields where exact integer equality is required (no tolerance) */
const INTEGER_FIELDS = new Set([
  'lookbackDays',
  'sharesAuthorized',
  'sharesOutstanding',
  'sharesFloat',
  'preferredSharesOutstanding',
  'warrantShares',
  'noteIndex',
]);

/** Fields where dollar amounts are compared (exact) */
const DOLLAR_FIELDS = new Set([
  'principalAmount',
  'outstandingBalance',
  'originalIssueDiscount',
  'netProceeds',
  'purchasePrice',
  'floorPrice',
  'ceilingPrice',
  'warrantExercisePrice',
  'fixedConversionPrice',
  'exchangeCap',
]);

// ─── Month name → number map (for date parsing) ───────────────────────────────

const MONTH_NAMES: Record<string, string> = {
  january: '01', february: '02', march: '03',    april: '04',
  may:     '05', june:     '06', july:   '07',   august:   '08',
  september: '09', october: '10', november: '11', december: '12',
  jan: '01', feb: '02', mar: '03', apr: '04',
  jun: '06', jul: '07', aug: '08', sep: '09',
  oct: '10', nov: '11', dec: '12',
};

// ─── Normalization ────────────────────────────────────────────────────────────

/**
 * Attempt to parse a human-readable date string to ISO YYYY-MM-DD.
 * Returns the original string if parsing fails (no error thrown).
 */
export function normalizeDate(value: string): string {
  const trimmed = value.trim();

  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  // "Month DD, YYYY" — e.g. "February 12, 2027" or "June 3, 2027"
  const mdy = trimmed.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (mdy) {
    const month = MONTH_NAMES[mdy[1].toLowerCase()];
    if (month) {
      const day = mdy[2].padStart(2, '0');
      return `${mdy[3]}-${month}-${day}`;
    }
  }

  // "DD Month YYYY" — e.g. "12 February 2027"
  const dmy = trimmed.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (dmy) {
    const month = MONTH_NAMES[dmy[2].toLowerCase()];
    if (month) {
      const day = dmy[1].padStart(2, '0');
      return `${dmy[3]}-${month}-${day}`;
    }
  }

  return trimmed;
}

/**
 * Normalize a fraction field value to 4 decimal places.
 * Handles values stored as 0–1 fractions (e.g. 0.22 for 22% discount).
 */
export function normalizeFraction(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * Normalize a field value for comparison.
 * Returns the value in canonical form for the given field name.
 */
export function normalizeValue(fieldName: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (FRACTION_FIELDS.has(fieldName) && typeof value === 'number') {
    return normalizeFraction(value);
  }

  if (DATE_FIELDS.has(fieldName) && typeof value === 'string') {
    return normalizeDate(value);
  }

  if (INTEGER_FIELDS.has(fieldName) && typeof value === 'number') {
    return Math.round(value);
  }

  if (DOLLAR_FIELDS.has(fieldName) && typeof value === 'number') {
    return Math.round(value * 100) / 100;  // 2 decimal places for dollar amounts
  }

  if (typeof value === 'string') {
    return value.trim();
  }

  return value;
}

// ─── Deep equality for normalized values ─────────────────────────────────────

function normalizedEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

// ─── Field comparison ─────────────────────────────────────────────────────────

/**
 * Compare a single expected field against the actual extracted value.
 *
 * @param fieldName  - Name of the field being compared
 * @param expectation - Golden expected value and verification status
 * @param actual     - Actual value from the parser output (may be undefined)
 * @returns FieldResult describing the comparison outcome
 */
export function compareField(
  fieldName: string,
  expectation: FieldExpectation,
  actual: unknown,
): FieldResult {
  const normalizedExpected = normalizeValue(fieldName, expectation.value);

  if (actual === undefined || actual === null) {
    return {
      fieldName,
      verificationStatus: expectation.status,
      status: 'missing',
      expectedValue: expectation.value,
      actualValue: actual,
      normalizedExpected,
      normalizedActual: actual,
      note: expectation.note,
    };
  }

  const normalizedActual = normalizeValue(fieldName, actual);
  const matched = normalizedEqual(normalizedExpected, normalizedActual);

  return {
    fieldName,
    verificationStatus: expectation.status,
    status: matched ? 'match' : 'mismatch',
    expectedValue: expectation.value,
    actualValue: actual,
    normalizedExpected,
    normalizedActual,
    note: expectation.note,
  };
}

/**
 * Compare all expected fields from a golden case against an actual extraction object.
 *
 * @param expected - Record of field expectations from the golden case
 * @param actual   - The parser output object (e.g. ExtractedFinancingTerms)
 * @returns Array of FieldResult for each expected field
 */
export function compareFields(
  expected: Record<string, FieldExpectation>,
  actual: Record<string, unknown>,
): FieldResult[] {
  return Object.entries(expected).map(([fieldName, expectation]) =>
    compareField(fieldName, expectation, actual[fieldName]),
  );
}

/**
 * Determine whether an eval case passes based on its field results.
 * Only "verified" field failures (status=mismatch|missing) cause a case to fail.
 */
export function casePassedFromResults(results: FieldResult[]): boolean {
  return results.every(
    r => r.verificationStatus !== 'verified' || r.status === 'match',
  );
}
