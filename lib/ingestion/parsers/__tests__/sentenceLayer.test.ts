/**
 * Regression tests for discount rate normalization in sentenceLayer.ts.
 *
 * OTCIntel invariant: discountRate ALWAYS represents the ECONOMIC discount from
 * market price. Two pattern forms exist:
 *
 *   Direct:  "X% discount to VWAP/market"  → stored = X / 100
 *   Inverse: "X% of [reference price]"     → stored = (100 − X) / 100
 *
 * Patterns [1] and [2] in DISCOUNT_PATTERNS are inverse forms. Before the fix
 * they called parsePct() directly and stored the conversion factor rather than
 * the economic discount — matching the same bug that was fixed in financing.ts
 * (parser version 1.0.2).
 *
 * Root-cause evidence:
 *   AITX 10-Q/A 2026-07-17: "converts at 65 % of the lowest trading price"
 *     → pattern [2] fired → stored 0.65 → should be 0.35
 *   CENN 10-Q 2026-05-14: "conversion price equal to 85 % of the 10-day VWAP"
 *     → pattern [1] fired → stored 0.85 → should be 0.15
 */

import { describe, it, expect } from 'vitest';
import { buildInstrumentLayer } from '../sentenceLayer';

/**
 * Wraps a conversion phrase in minimal note context so the instrument layer
 * creates a 'note' instrument rather than returning an empty set.
 *
 * Uses "principal amount of $X" which reliably triggers the note_issuance
 * sentence tag without depending on the type-adjective ordering that can
 * confuse the issuance detector for multi-word forms like "convertible
 * promissory note".
 */
function withNoteContext(phrase: string): string {
  return `principal amount of $500,000 convertible note. ${phrase}`;
}

// ─── Direct form — patterns [0] and [3] ───────────────────────────────────────

describe('sentenceLayer discountRate — direct form (must NOT be inverted)', () => {
  it('[0] "35% discount to VWAP" → 0.35', () => {
    const insts = buildInstrumentLayer(
      withNoteContext('Converts at a 35% discount to VWAP.'),
    );
    const note = insts.find(i => i.type === 'note');
    expect(note?.fields.discountRate?.value).toBeCloseTo(0.35, 5);
  });

  it('[0] "10% discount to market" → 0.10', () => {
    const insts = buildInstrumentLayer(
      withNoteContext('The note is convertible at a 10% discount to market.'),
    );
    const note = insts.find(i => i.type === 'note');
    expect(note?.fields.discountRate?.value).toBeCloseTo(0.10, 5);
  });

  it('[3] "discount of 20%" → 0.20', () => {
    const insts = buildInstrumentLayer(
      withNoteContext('The note carries a discount of 20%.'),
    );
    const note = insts.find(i => i.type === 'note');
    expect(note?.fields.discountRate?.value).toBeCloseTo(0.20, 5);
  });

  it('"35% discount to VWAP" must NOT be stored as 0.65', () => {
    const insts = buildInstrumentLayer(
      withNoteContext('Converts at a 35% discount to VWAP.'),
    );
    const note = insts.find(i => i.type === 'note');
    expect(note?.fields.discountRate?.value).not.toBeCloseTo(0.65, 2);
  });

  it('"10% discount to closing" must NOT be stored as 0.90', () => {
    const insts = buildInstrumentLayer(
      withNoteContext('Converts at a 10% discount to closing price.'),
    );
    const note = insts.find(i => i.type === 'note');
    expect(note?.fields.discountRate?.value).not.toBeCloseTo(0.90, 2);
  });
});

// ─── Inverse form — pattern [2] ("at X% of [reference]") ─────────────────────

describe('sentenceLayer discountRate — inverse form, pattern [2] ("at X% of [reference]")', () => {
  it('"at 65% of the lowest trading price" → 0.35', () => {
    const insts = buildInstrumentLayer(
      withNoteContext(
        'The note converts at 65% of the lowest trading price 20 trading days prior.',
      ),
    );
    const note = insts.find(i => i.type === 'note');
    expect(note?.fields.discountRate?.value).toBeCloseTo(0.35, 5);
  });

  it('"at 85% of the lowest closing price" → 0.15', () => {
    const insts = buildInstrumentLayer(
      withNoteContext(
        'Converts after 180 days at 85% of the lowest closing price 10 trading days prior.',
      ),
    );
    const note = insts.find(i => i.type === 'note');
    expect(note?.fields.discountRate?.value).toBeCloseTo(0.15, 5);
  });

  it('"at 90% of the market price" → 0.10', () => {
    const insts = buildInstrumentLayer(
      withNoteContext('The conversion price is at 90% of the market price.'),
    );
    const note = insts.find(i => i.type === 'note');
    expect(note?.fields.discountRate?.value).toBeCloseTo(0.10, 5);
  });

  it('"at 70% of the lowest closing price" → 0.30', () => {
    const insts = buildInstrumentLayer(
      withNoteContext(
        'Converts at 70% of the lowest closing price during the preceding 20 trading days.',
      ),
    );
    const note = insts.find(i => i.type === 'note');
    expect(note?.fields.discountRate?.value).toBeCloseTo(0.30, 5);
  });

  it('"at 65% of lowest" must NOT be stored as 0.65', () => {
    const insts = buildInstrumentLayer(
      withNoteContext('The note converts at 65% of the lowest trading price.'),
    );
    const note = insts.find(i => i.type === 'note');
    expect(note?.fields.discountRate?.value).not.toBeCloseTo(0.65, 2);
  });

  it('"at 85% of the average price" must NOT be stored as 0.85', () => {
    const insts = buildInstrumentLayer(
      withNoteContext('Converts at 85% of the average closing price over 10 days.'),
    );
    const note = insts.find(i => i.type === 'note');
    expect(note?.fields.discountRate?.value).not.toBeCloseTo(0.85, 2);
  });
});

// ─── Inverse form — pattern [1] ("conversion price equal to X%") ─────────────

describe('sentenceLayer discountRate — inverse form, pattern [1] ("conversion price equal to X%")', () => {
  it('"conversion price equal to 85% of the 10-day VWAP" → 0.15', () => {
    const insts = buildInstrumentLayer(
      withNoteContext(
        'at a conversion price equal to 85% of the 10-day volume weighted average price.',
      ),
    );
    const note = insts.find(i => i.type === 'note');
    expect(note?.fields.discountRate?.value).toBeCloseTo(0.15, 5);
  });

  it('"conversion price equal to 65% of the lowest VWAP" → 0.35', () => {
    const insts = buildInstrumentLayer(
      withNoteContext('The conversion price equal to 65% of the lowest VWAP.'),
    );
    const note = insts.find(i => i.type === 'note');
    expect(note?.fields.discountRate?.value).toBeCloseTo(0.35, 5);
  });

  it('"conversion price equal to 85%" must NOT be stored as 0.85', () => {
    const insts = buildInstrumentLayer(
      withNoteContext(
        'at a conversion price equal to 85% of the 10-day volume weighted average price.',
      ),
    );
    const note = insts.find(i => i.type === 'note');
    expect(note?.fields.discountRate?.value).not.toBeCloseTo(0.85, 2);
  });

  it('"conversion price equal to 65%" must NOT be stored as 0.65', () => {
    const insts = buildInstrumentLayer(
      withNoteContext('The conversion price equal to 65% of the lowest VWAP.'),
    );
    const note = insts.find(i => i.type === 'note');
    expect(note?.fields.discountRate?.value).not.toBeCloseTo(0.65, 2);
  });
});

// ─── Production fixture regressions ───────────────────────────────────────────

describe('sentenceLayer discountRate — production fixture regressions', () => {
  // AITX 10-Q/A 2026-07-17: note to a lender for $230,000
  // Exact source sentence stored in _sourceSentenceTexts[2]:
  // "The note matures on June 3, 2027, and converts after 180 days at 65 % of the
  //  lowest trading price 20 trading days prior to the conversion date, including
  //  the conversion date."
  it('AITX fixture (pattern [2]): "at 65 % of the lowest trading price" → 0.35', () => {
    const insts = buildInstrumentLayer(
      'Company issued a $230,000 convertible, redeemable note to a lender. ' +
      'The note matures on June 3, 2027, and converts after 180 days at 65 % of the lowest trading price ' +
      '20 trading days prior to the conversion date, including the conversion date.',
    );
    const note = insts.find(i => i.type === 'note');
    expect(note?.fields.discountRate?.value).toBeCloseTo(0.35, 5);
    expect(note?.fields.discountRate?.value).not.toBeCloseTo(0.65, 2);
  });

  // AITX 10-Q/A 2026-07-17: note to a lender for $55,000 (10-day lookback)
  it('AITX fixture (pattern [2]): "at 65 % of the lowest trading price 10 trading days prior" → 0.35', () => {
    const insts = buildInstrumentLayer(
      'principal amount of $55,000 convertible note. ' +
      'The note matures on June 9, 2027, and converts after 180 days at 65 % of the lowest trading price ' +
      '10 trading days prior to the conversion date.',
    );
    const note = insts.find(i => i.type === 'note');
    expect(note?.fields.discountRate?.value).toBeCloseTo(0.35, 5);
  });

  // CENN 10-Q 2026-05-14: $61,215,000 note — discount from default conversion clause
  // Exact source sentence stored in _fieldProvenance.discountRate.sourceText:
  // "...in common stock at the mandatory default amount at a conversion price equal to
  //  85 % of the 10-day volume weighted average price."
  it('CENN fixture (pattern [1]): "conversion price equal to 85 % of the 10-day volume weighted average price" → 0.15', () => {
    const insts = buildInstrumentLayer(
      'Company issued a $61,215,000 convertible promissory note. ' +
      'in common stock at the mandatory default amount at a conversion price equal to ' +
      '85 % of the 10-day volume weighted average price.',
    );
    const note = insts.find(i => i.type === 'note');
    expect(note?.fields.discountRate?.value).toBeCloseTo(0.15, 5);
    expect(note?.fields.discountRate?.value).not.toBeCloseTo(0.85, 2);
  });
});
