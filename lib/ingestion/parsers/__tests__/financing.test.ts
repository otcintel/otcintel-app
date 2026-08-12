/**
 * Tests for parseFinancingTerms() — focusing on discount rate extraction.
 *
 * Regression suite for the inverse-form inversion fix:
 *   "X% of reference price" must produce discountRate = (100 − X) / 100
 *   "X% discount"          must produce discountRate = X / 100
 *
 * The previous implementation re-inspected the match substring with a secondary
 * regex requiring trailing whitespace after "of". When the match ended exactly at
 * "of" (pattern 3), the check silently failed and the inversion was skipped,
 * storing "90% of VWAP" as discountRate = 0.90 instead of the correct 0.10.
 */

import { describe, it, expect } from 'vitest';
import { parseFinancingTerms } from '../financing';

// ─── Shared fixture helpers ────────────────────────────────────────────────────

/** Wraps a discount phrase in minimal convertible-note context so the parser
 *  doesn't bail early due to missing financing-type language. */
function withNoteContext(discountPhrase: string): string {
  return `The Company entered into a convertible promissory note purchase agreement. ${discountPhrase}`;
}

// ─── Direct form — patterns 0 and 1 ───────────────────────────────────────────

describe('parseFinancingTerms — discount rate: direct form (NOT inverted)', () => {
  it('pattern 0: "X% discount to VWAP" → discountRate = X / 100', () => {
    const result = parseFinancingTerms(
      withNoteContext('The conversion price is a 10% discount to VWAP.'),
    );
    expect(result?.discountRate).toBeCloseTo(0.10, 10);
  });

  it('pattern 0: "35% discount to market" → discountRate = 0.35', () => {
    const result = parseFinancingTerms(
      withNoteContext('The conversion price is a 35% discount to market.'),
    );
    expect(result?.discountRate).toBeCloseTo(0.35, 10);
  });

  it('pattern 0: "22% discount to the lowest closing price" → discountRate = 0.22', () => {
    const result = parseFinancingTerms(
      withNoteContext('The notes convert at a 22% discount to the lowest closing price.'),
    );
    expect(result?.discountRate).toBeCloseTo(0.22, 10);
  });

  it('pattern 1: "discount of 15%" → discountRate = 0.15', () => {
    const result = parseFinancingTerms(
      withNoteContext('The note was issued at a discount of 15% to par.'),
    );
    expect(result?.discountRate).toBeCloseTo(0.15, 10);
  });

  it('pattern 1: "discount of 22%" → discountRate = 0.22', () => {
    const result = parseFinancingTerms(
      withNoteContext('Issued a convertible note with a discount of 22%.'),
    );
    expect(result?.discountRate).toBeCloseTo(0.22, 10);
  });

  // Regression: direct-form values must NOT be inverted
  it('direct "10% discount" is NOT inverted to 0.90', () => {
    const result = parseFinancingTerms(
      withNoteContext('The conversion price represents a 10% discount to VWAP.'),
    );
    expect(result?.discountRate).toBeCloseTo(0.10, 10);
    expect(result?.discountRate).not.toBeCloseTo(0.90, 2);
  });

  it('direct "35% discount" is NOT inverted to 0.65', () => {
    const result = parseFinancingTerms(
      withNoteContext('The conversion price is 35% discount to the market price.'),
    );
    expect(result?.discountRate).toBeCloseTo(0.35, 10);
    expect(result?.discountRate).not.toBeCloseTo(0.65, 2);
  });
});

// ─── Inverse form — pattern 2 ("X% of reference") ────────────────────────────

describe('parseFinancingTerms — discount rate: inverse form, pattern 2 ("X% of reference")', () => {
  it('"78% of the lowest VWAP" → discountRate = 0.22', () => {
    const result = parseFinancingTerms(
      withNoteContext('The conversion price equals 78% of the lowest VWAP.'),
    );
    expect(result?.discountRate).toBeCloseTo(0.22, 10);
  });

  it('"65% of the lowest trading price" → discountRate = 0.35', () => {
    // "lowest" is in the pattern list; "trading price" follows but doesn't break the match
    const result = parseFinancingTerms(
      withNoteContext(
        'The note converts at 65% of the lowest trading price 20 trading days prior to the conversion date.',
      ),
    );
    expect(result?.discountRate).toBeCloseTo(0.35, 10);
  });

  it('"90% of the average closing price" → discountRate = 0.10', () => {
    const result = parseFinancingTerms(
      withNoteContext('The conversion price shall equal 90% of the average closing price.'),
    );
    expect(result?.discountRate).toBeCloseTo(0.10, 10);
  });

  it('"85% of the market price" → discountRate = 0.15', () => {
    const result = parseFinancingTerms(
      withNoteContext('Conversion shall occur at 85% of the market price.'),
    );
    expect(result?.discountRate).toBeCloseTo(0.15, 10);
  });

  // Regression: inverse-form values must be inverted, not stored as-is
  it('"65% of lowest" is NOT stored as 0.65', () => {
    const result = parseFinancingTerms(
      withNoteContext('The note converts at 65% of the lowest trading price.'),
    );
    expect(result?.discountRate).toBeCloseTo(0.35, 10);
    expect(result?.discountRate).not.toBeCloseTo(0.65, 2);
  });
});

// ─── Inverse form — pattern 3 ("conversion price equal to X% of") ────────────

describe('parseFinancingTerms — discount rate: inverse form, pattern 3 ("conversion price equal to X% of")', () => {
  it('"conversion price equal to 90% of the lowest VWAP" → discountRate = 0.10', () => {
    const result = parseFinancingTerms(
      withNoteContext(
        'The conversion price equal to 90% of the lowest VWAP during the preceding 20 trading days.',
      ),
    );
    expect(result?.discountRate).toBeCloseTo(0.10, 10);
  });

  it('"conversion price equal to 85% of the market price" → discountRate = 0.15', () => {
    const result = parseFinancingTerms(
      withNoteContext('The conversion price equal to 85% of the market price.'),
    );
    expect(result?.discountRate).toBeCloseTo(0.15, 10);
  });

  it('"conversion price of 80% of VWAP" → discountRate = 0.20', () => {
    const result = parseFinancingTerms(
      withNoteContext('The conversion price of 80% of the closing price of our common stock.'),
    );
    expect(result?.discountRate).toBeCloseTo(0.20, 10);
  });

  // MFON regression — the exact bug scenario:
  // "conversion price equal to 90% of the volume-weighted average price"
  // Pattern 3 matches (pattern 2 cannot because "volume" is not in its word list).
  // Before the fix: isInverseForm regex required trailing whitespace after "of"; match[0]
  // ended exactly at "of" with no whitespace → isInverseForm = false → 0.90 stored.
  // After the fix:  pattern 3 is unconditionally inverse → (100-90)/100 = 0.10 stored.
  it('MFON regression: "conversion price equal to 90% of the volume-weighted average price" → 0.10', () => {
    const result = parseFinancingTerms(
      // Mirrors the actual 8-K language that triggered the bug.
      // "volume-weighted" is deliberately NOT in DISCOUNT_PATTERNS[2]'s word list,
      // so only pattern 3 fires — the previously broken code path.
      withNoteContext(
        'The conversion price equal to 90% of the volume-weighted average price ' +
        'during the 20 consecutive trading days ending on the trading day immediately ' +
        'prior to the applicable conversion date, subject to full ratchet anti-dilution adjustment.',
      ),
    );
    expect(result?.discountRate).toBeCloseTo(0.10, 10);
    // Belt-and-suspenders: must NOT be stored as the un-inverted 0.90
    expect(result?.discountRate).not.toBeCloseTo(0.90, 2);
  });

  it('MFON regression: full ratchet is detected alongside the corrected discount', () => {
    const result = parseFinancingTerms(
      withNoteContext(
        'The conversion price equal to 90% of the volume-weighted average price ' +
        'during the 20 trading days, subject to full ratchet anti-dilution adjustment.',
      ),
    );
    expect(result?.discountRate).toBeCloseTo(0.10, 10);
    expect(result?.hasResetProvisions).toBe(true);
  });

  // Regression: pattern 3 values must be inverted
  it('"conversion price equal to 90% of..." is NOT stored as 0.90', () => {
    const result = parseFinancingTerms(
      withNoteContext(
        'The conversion price equal to 90% of the volume-weighted average price.',
      ),
    );
    expect(result?.discountRate).not.toBeCloseTo(0.90, 2);
  });
});

// ─── Principal amount: unit-suffix normalization ──────────────────────────────

describe('parseFinancingTerms — principalAmount: written-out unit suffixes', () => {
  // MFON regressions — the three affected 8-K filings
  it('MFON 2025-08-05: "aggregate principal amount of $3.85 million" → 3_850_000', () => {
    const result = parseFinancingTerms(
      withNoteContext(
        'The Company entered into a convertible promissory note in the aggregate principal ' +
        'amount of $3.85 million, convertible at 90% of the volume-weighted average price.',
      ),
    );
    expect(result?.principalAmount).toBe(3_850_000);
  });

  it('MFON 2025-08-07: "aggregate principal amount of $3.35 million" → 3_350_000', () => {
    const result = parseFinancingTerms(
      withNoteContext('aggregate principal amount of $3.35 million, subject to full ratchet adjustment.'),
    );
    expect(result?.principalAmount).toBe(3_350_000);
  });

  it('MFON 2025-03-18: "aggregate principal amount of $2.0 million" → 2_000_000', () => {
    const result = parseFinancingTerms(
      withNoteContext('The aggregate principal amount of $2.0 million matures on December 30, 2027.'),
    );
    expect(result?.principalAmount).toBe(2_000_000);
  });

  // CANN regression
  it('CANN 2025-08-22: "principal amount of $6.749 million" → 6_749_000', () => {
    const result = parseFinancingTerms(
      withNoteContext('principal amount of $6.749 million matures on March 15, 2026.'),
    );
    expect(result?.principalAmount).toBe(6_749_000);
  });

  // LIQT regression
  it('LIQT 2026-05-26: "aggregate principal amount of $1.1 million" → 1_100_000', () => {
    const result = parseFinancingTerms(
      withNoteContext('aggregate principal amount of $1.1 million.'),
    );
    expect(result?.principalAmount).toBe(1_100_000);
  });

  // Integer million
  it('"aggregate principal of $2 million" → 2_000_000', () => {
    const result = parseFinancingTerms(
      withNoteContext('aggregate principal of $2 million due and payable 2027.'),
    );
    expect(result?.principalAmount).toBe(2_000_000);
  });

  // Thousand suffix
  it('"principal amount of $500 thousand" → 500_000', () => {
    const result = parseFinancingTerms(
      withNoteContext('principal amount of $500 thousand convertible promissory note.'),
    );
    expect(result?.principalAmount).toBe(500_000);
  });

  // Billion suffix
  it('"aggregate principal amount of $1.2 billion" → 1_200_000_000', () => {
    const result = parseFinancingTerms(
      withNoteContext('aggregate principal amount of $1.2 billion senior convertible note.'),
    );
    expect(result?.principalAmount).toBe(1_200_000_000);
  });
});

describe('parseFinancingTerms — principalAmount: compact M/B/K suffixes', () => {
  it('"$3.85M" → 3_850_000', () => {
    const result = parseFinancingTerms(
      withNoteContext('aggregate principal amount of $3.85M convertible promissory note.'),
    );
    expect(result?.principalAmount).toBe(3_850_000);
  });

  it('"$1.1M" → 1_100_000', () => {
    const result = parseFinancingTerms(
      withNoteContext('principal amount of $1.1M convertible note.'),
    );
    expect(result?.principalAmount).toBe(1_100_000);
  });

  it('"$500K" → 500_000', () => {
    const result = parseFinancingTerms(
      withNoteContext('principal amount of $500K convertible note.'),
    );
    expect(result?.principalAmount).toBe(500_000);
  });

  it('"$1.5B" → 1_500_000_000', () => {
    const result = parseFinancingTerms(
      withNoteContext('aggregate principal amount of $1.5B senior convertible note.'),
    );
    expect(result?.principalAmount).toBe(1_500_000_000);
  });

  // Compact suffix must not be confused with the first letter of an adjacent word
  it('"$500,000 maturity" — M in maturity does NOT multiply by 1e6', () => {
    const result = parseFinancingTerms(
      withNoteContext('principal amount of $500,000 maturity date December 31, 2026.'),
    );
    expect(result?.principalAmount).toBe(500_000);
  });
});

describe('parseFinancingTerms — principalAmount: comma-formatted full amounts (regression)', () => {
  it('"aggregate principal amount of $3,850,000" → 3_850_000', () => {
    const result = parseFinancingTerms(
      withNoteContext('aggregate principal amount of $3,850,000 convertible promissory note.'),
    );
    expect(result?.principalAmount).toBe(3_850_000);
  });

  it('"principal amount of $500,000" → 500_000', () => {
    const result = parseFinancingTerms(
      withNoteContext('principal amount of $500,000 convertible note.'),
    );
    expect(result?.principalAmount).toBe(500_000);
  });

  it('"principal amount of $260,000" → 260_000', () => {
    const result = parseFinancingTerms(
      withNoteContext('principal amount of $260,000 convertible promissory note.'),
    );
    expect(result?.principalAmount).toBe(260_000);
  });

  it('"principal amount of $1,250,000" → 1_250_000', () => {
    const result = parseFinancingTerms(
      withNoteContext('principal amount of $1,250,000 senior convertible note.'),
    );
    expect(result?.principalAmount).toBe(1_250_000);
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe('parseFinancingTerms — discount rate: edge cases', () => {
  it('returns undefined when no financing language is present', () => {
    expect(parseFinancingTerms('There is nothing relevant here.')).toBeUndefined();
  });

  it('returns undefined discountRate when no discount pattern matches', () => {
    const result = parseFinancingTerms(
      withNoteContext('Principal amount of $500,000 matures on December 31, 2026.'),
    );
    expect(result?.discountRate).toBeUndefined();
  });

  it('fractional percentage: "22.5% discount to VWAP" → discountRate ≈ 0.225', () => {
    const result = parseFinancingTerms(
      withNoteContext('The conversion price is a 22.5% discount to VWAP.'),
    );
    expect(result?.discountRate).toBeCloseTo(0.225, 5);
  });

  it('fractional inverse: "87.5% of the lowest VWAP" → discountRate ≈ 0.125', () => {
    const result = parseFinancingTerms(
      withNoteContext('The note converts at 87.5% of the lowest VWAP.'),
    );
    expect(result?.discountRate).toBeCloseTo(0.125, 5);
  });
});
