import { describe, it, expect } from 'vitest';
import { scoreFinancingRisk } from '../scoring';
import type { ExtractedFinancingTerms, ExtractedShareStructure } from '../types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function financing(overrides: Partial<ExtractedFinancingTerms> = {}): ExtractedFinancingTerms {
  return {
    financingType: 'convertible_note',
    confidence: 'high',
    hasFloorPrice: false,
    hasFloorPriceDetermined: true,    // default: treat fixture floor state as explicitly known
    hasResetProvisions: false,
    hasResetProvisionsDetermined: true, // default: treat fixture reset state as explicitly known
    matchedPhrases: [],
    ...overrides,
  };
}

function shareStructure(overrides: Partial<ExtractedShareStructure> = {}): ExtractedShareStructure {
  return {
    sharesOutstanding: 100_000_000,
    confidence: 'high',
    matchedPhrases: [],
    ...overrides,
  };
}

// ─── Return undefined for unknown/missing financing ───────────────────────────

describe('scoreFinancingRisk — no score cases', () => {
  it('returns undefined when financing is undefined', () => {
    expect(scoreFinancingRisk('TEST', undefined)).toBeUndefined();
  });

  it('returns undefined when financingType is unknown', () => {
    expect(scoreFinancingRisk('TEST', financing({ financingType: 'unknown' }))).toBeUndefined();
  });
});

// ─── Score level classification ───────────────────────────────────────────────

describe('scoreFinancingRisk — level classification', () => {
  it('classifies as med risk with 22% discount but no resets and no lookback', () => {
    // discount 82×0.30=24.6, lookback 40×0.20=8, warrants 0, reset 18×0.20=3.6, floor 90×0.10=9 → 45
    const result = scoreFinancingRisk('TEST', financing({
      discountRate: 0.22,
      hasFloorPrice: false,
      hasResetProvisions: false,
    }));
    expect(result).toBeDefined();
    expect(result!.level).toBe('med');
    expect(result!.score).toBeGreaterThanOrEqual(40);
    expect(result!.score).toBeLessThan(70);
  });

  it('classifies as high risk when large discount combines with reset and long lookback', () => {
    // discount 90×0.30=27, lookback 90×0.20=18, warrants 0, reset 90×0.20=18, floor 90×0.10=9 → 72
    const result = scoreFinancingRisk('TEST', financing({
      discountRate: 0.25,
      lookbackDays: 20,
      hasFloorPrice: false,
      hasResetProvisions: true,
    }));
    expect(result).toBeDefined();
    expect(result!.level).toBe('high');
    expect(result!.score).toBeGreaterThanOrEqual(70);
  });

  it('classifies as low risk with a small discount, floor price, no resets', () => {
    const result = scoreFinancingRisk('TEST', financing({
      discountRate: 0.10,
      hasFloorPrice: true,
      floorPrice: 0.05,
      hasResetProvisions: false,
      warrantShares: 0,
    }));
    expect(result).toBeDefined();
    expect(result!.level).toBe('low');
    expect(result!.score).toBeLessThan(40);
  });

  it('classifies as med risk with 15% discount and reset provisions present', () => {
    // discount 60×0.30=18, lookback 40×0.20=8, warrants 0, reset 90×0.20=18, floor 90×0.10=9 → 53
    const result = scoreFinancingRisk('TEST', financing({
      discountRate: 0.15,
      hasResetProvisions: true,
      hasFloorPrice: false,
    }));
    expect(result).toBeDefined();
    expect(result!.level).toBe('med');
    expect(result!.score).toBe(53);
  });
});

// ─── Score components ─────────────────────────────────────────────────────────

describe('scoreFinancingRisk — score components', () => {
  it('reset provisions present produces higher score than absent, all else equal', () => {
    const base = financing({ discountRate: 0.15, hasFloorPrice: true, floorPrice: 0.05 });
    const withReset    = scoreFinancingRisk('TEST', { ...base, hasResetProvisions: true });
    const withoutReset = scoreFinancingRisk('TEST', { ...base, hasResetProvisions: false });
    expect(withReset!.score).toBeGreaterThan(withoutReset!.score);
  });

  it('no floor price produces higher score than floor present, all else equal', () => {
    const base = financing({ discountRate: 0.15, hasResetProvisions: false });
    const noFloor   = scoreFinancingRisk('TEST', { ...base, hasFloorPrice: false });
    const withFloor = scoreFinancingRisk('TEST', { ...base, hasFloorPrice: true, floorPrice: 0.05 });
    expect(noFloor!.score).toBeGreaterThan(withFloor!.score);
  });

  it('larger discount rate produces higher score than smaller, all else equal', () => {
    const base = financing({ hasResetProvisions: false, hasFloorPrice: true });
    const highDiscount = scoreFinancingRisk('TEST', { ...base, discountRate: 0.25 });
    const lowDiscount  = scoreFinancingRisk('TEST', { ...base, discountRate: 0.10 });
    expect(highDiscount!.score).toBeGreaterThan(lowDiscount!.score);
  });

  it('longer lookback window produces higher score than shorter', () => {
    const base = financing({ discountRate: 0.15, hasResetProvisions: false, hasFloorPrice: true });
    const longLookback  = scoreFinancingRisk('TEST', { ...base, lookbackDays: 20 });
    const shortLookback = scoreFinancingRisk('TEST', { ...base, lookbackDays: 3 });
    expect(longLookback!.score).toBeGreaterThan(shortLookback!.score);
  });

  it('warrants with large overhang increase score vs no warrants', () => {
    const base = financing({ discountRate: 0.15, hasResetProvisions: false, hasFloorPrice: true });
    const withWarrants    = scoreFinancingRisk('TEST', { ...base, warrantShares: 40_000_000 }, shareStructure({ sharesOutstanding: 100_000_000 }));
    const withoutWarrants = scoreFinancingRisk('TEST', { ...base, warrantShares: 0 }, shareStructure({ sharesOutstanding: 100_000_000 }));
    expect(withWarrants!.score).toBeGreaterThan(withoutWarrants!.score);
  });
});

// ─── Score structure ──────────────────────────────────────────────────────────

describe('scoreFinancingRisk — output structure', () => {
  it('returns all required fields', () => {
    const result = scoreFinancingRisk('WXYZ', financing({
      discountRate: 0.22,
      lookbackDays: 10,
      hasResetProvisions: true,
      hasFloorPrice: false,
      warrantShares: 12_000_000,
      principalAmount: 1_500_000,
    }));

    expect(result).toBeDefined();
    expect(result!.ticker).toBe('WXYZ');
    expect(typeof result!.score).toBe('number');
    expect(['high', 'med', 'low']).toContain(result!.level);
    expect(['red', 'amber', 'green']).toContain(result!.color);
    expect(result!.factors).toBeInstanceOf(Array);
    expect(result!.drivers).toBeInstanceOf(Array);
    expect(result!.bannerMessage).toBeTruthy();
    expect(['red-risk', 'amber-risk', 'green-risk']).toContain(result!.bannerVariant);
  });

  it('produces a score between 0 and 100', () => {
    const worstCase = scoreFinancingRisk('TEST', financing({
      discountRate: 0.35,
      lookbackDays: 20,
      hasResetProvisions: true,
      hasFloorPrice: false,
      warrantShares: 500_000_000,
    }), shareStructure({ sharesOutstanding: 100_000_000 }));
    expect(worstCase!.score).toBeGreaterThanOrEqual(0);
    expect(worstCase!.score).toBeLessThanOrEqual(100);
  });

  it('produces 5 factor rows', () => {
    const result = scoreFinancingRisk('TEST', financing({
      discountRate: 0.20,
      lookbackDays: 10,
      hasResetProvisions: false,
      hasFloorPrice: true,
    }));
    expect(result!.factors).toHaveLength(5);
  });
});

// ─── Equity line scoring ──────────────────────────────────────────────────────

describe('scoreFinancingRisk — equity line', () => {
  it('returns a score for equity_line financing type', () => {
    const result = scoreFinancingRisk('TEST', financing({
      financingType: 'equity_line',
      discountRate: 0.10,
      hasResetProvisions: false,
      hasFloorPrice: true,
    }));
    expect(result).toBeDefined();
    expect(result!.score).toBeGreaterThanOrEqual(0);
  });
});

// ─── Eligibility gate: financing type ─────────────────────────────────────────

describe('scoreFinancingRisk — eligibility gate: financing type', () => {
  it('preferred_stock returns undefined even when other fields are populated', () => {
    // WRAP/NTRB/NVVE-style: preferred stock. Conversion mechanics (liquidation preference,
    // weighted-average anti-dilution) do not map to the 5-factor convertible-note model.
    expect(scoreFinancingRisk('WRAP', financing({
      financingType: 'preferred_stock',
      discountRate: 0.10,
      hasResetProvisions: true,
      hasFloorPrice: false,
    }))).toBeUndefined();
  });

  it('warrant_only returns undefined', () => {
    expect(scoreFinancingRisk('TEST', financing({
      financingType: 'warrant_only',
      warrantShares: 10_000_000,
    }))).toBeUndefined();
  });

  it('convertible_note with known discount remains scoreable', () => {
    // VNRX-style: disc=0.10, 20-day lookback, conv note — must still produce a score.
    const result = scoreFinancingRisk('VNRX', financing({
      financingType: 'convertible_note',
      discountRate: 0.10,
      lookbackDays: 20,
      hasResetProvisions: false,
      hasFloorPrice: false,
    }));
    expect(result).toBeDefined();
    // 20×0.30 + 90×0.20 + 0 + 18×0.20 + 90×0.10 = 6+18+0+3.6+9 = 36.6 → 37
    expect(result!.score).toBe(37);
    expect(result!.level).toBe('low');
  });

  it('equity_line with known discount remains scoreable', () => {
    const result = scoreFinancingRisk('TEST', financing({
      financingType: 'equity_line',
      discountRate: 0.05,
      hasResetProvisions: false,
      hasFloorPrice: false,
    }));
    expect(result).toBeDefined();
    expect(result!.score).toBeGreaterThan(0);
  });
});

// ─── Eligibility gate: mandatory discount ─────────────────────────────────────

describe('scoreFinancingRisk — eligibility gate: mandatory discount', () => {
  it('convertible_note with missing discount returns undefined (CANN/CENN/LIQT-style)', () => {
    // discountRate was never extracted — defaulting to 50 would fabricate a risk assertion.
    expect(scoreFinancingRisk('CANN', financing({
      financingType: 'convertible_note',
      discountRate: undefined,
      hasResetProvisions: false,
      hasFloorPrice: false,
    }))).toBeUndefined();
  });

  it('convertible_note with reset=true but no discount returns undefined (CUEN-style)', () => {
    // reset=true is a known signal but without discountRate the model cannot score.
    expect(scoreFinancingRisk('CUEN', financing({
      financingType: 'convertible_note',
      discountRate: undefined,
      hasResetProvisions: true,
      hasFloorPrice: false,
    }))).toBeUndefined();
  });

  it('equity_line with missing discount returns undefined (TUSK-style)', () => {
    expect(scoreFinancingRisk('TUSK', financing({
      financingType: 'equity_line',
      discountRate: undefined,
      hasResetProvisions: false,
      hasFloorPrice: false,
    }))).toBeUndefined();
  });

  it('preferred_stock returns undefined regardless of fields (WRAP/NTRB/NVVE-style)', () => {
    // Belt-and-suspenders: preferred_stock is type-ineligible independent of discount state.
    expect(scoreFinancingRisk('NTRB', financing({
      financingType: 'preferred_stock',
      discountRate: undefined,
      hasResetProvisions: false,
      hasFloorPrice: false,
    }))).toBeUndefined();
  });

  it('MFON-style: scorer receives discountRate=0.90 and computes the expected score', () => {
    // Scorer-level test: the scorer's behaviour with discountRate=0.90 as input.
    // The parser-level inversion bug (MFON "90% of VWAP" stored as 0.90 instead of 0.10)
    // has been fixed in financing.ts (PARSER_VERSION 1.0.2). After re-ingestion MFON will
    // produce discountRate=0.10. This test exercises the scorer independently with a 0.90
    // input and remains valid as a scorer boundary test.
    const result = scoreFinancingRisk('MFON', financing({
      financingType: 'convertible_note',
      discountRate: 0.90,
      hasResetProvisions: true,
      hasFloorPrice: false,
    }));
    expect(result).toBeDefined();
    // discountFactor(0.90): pct=90 ≥ 30 → 95
    // lookback: undefined → default 40; reset: true → 90; floor: false → 90; warrants: 0
    // 95×0.30 + 40×0.20 + 0 + 90×0.20 + 90×0.10 = 28.5+8+0+18+9 = 63.5 → 64
    expect(result!.score).toBe(64);
  });
});

// ─── Banner message: principal amount formatting ──────────────────────────────

describe('scoreFinancingRisk — bannerMessage: principalAmount unit normalization', () => {
  it('principalAmount=3_850_000 → banner contains "$3.9M" not "$0M"', () => {
    // Regression for MFON: before the parser fix, "$3.85 million" was stored as 3.85.
    // scoring.ts divides principalAmount by 1e6 to format the banner:
    //   3.85 / 1e6       → 0.000... → "$0M"   (old, broken)
    //   3_850_000 / 1e6  → 3.85     → "$3.9M"  (correct, post-fix)
    const result = scoreFinancingRisk('MFON', financing({
      financingType:      'convertible_note',
      discountRate:       0.10,
      principalAmount:    3_850_000,
      hasResetProvisions: true,
      hasFloorPrice:      false,
    }));
    expect(result).toBeDefined();
    expect(result!.bannerMessage).toContain('$3.9M');
    expect(result!.bannerMessage).not.toContain('$0M');
  });

  it('no principalAmount → banner omits the principal string entirely', () => {
    const result = scoreFinancingRisk('MFON', financing({
      financingType: 'convertible_note',
      discountRate:  0.10,
    }));
    expect(result).toBeDefined();
    // principalStr is empty string when principalAmount is undefined
    expect(result!.bannerMessage).toContain('convertible note');
    expect(result!.bannerMessage).not.toMatch(/\$[\d.]+M /);
  });
});

// ─── Scoring provenance ───────────────────────────────────────────────────────

describe('scoreFinancingRisk — scoreBasis', () => {
  it('always returns scoreBasis="valid" for any scoreable record', () => {
    const result = scoreFinancingRisk('TEST', financing({ discountRate: 0.15 }));
    expect(result!.scoreBasis).toBe('valid');
  });
});

describe('scoreFinancingRisk — knownFactors / unknownFactors', () => {
  it('full convertible note: all factors known', () => {
    // Explicit floor, explicit no-reset, known lookback, known warrants
    const result = scoreFinancingRisk('TEST', financing({
      discountRate: 0.22,
      lookbackDays: 10,
      warrantShares: 5_000_000,
      hasFloorPrice: true,
      hasFloorPriceDetermined: true,
      hasResetProvisions: false,
      hasResetProvisionsDetermined: true,
    }));
    expect(result!.knownFactors).toContain('discountRate');
    expect(result!.knownFactors).toContain('lookbackDays');
    expect(result!.knownFactors).toContain('warrantShares');
    expect(result!.knownFactors).toContain('floorPrice');
    expect(result!.knownFactors).toContain('resetProvisions');
    expect(result!.unknownFactors).toHaveLength(0);
    expect(result!.dataWarnings).toHaveLength(0);
  });

  it('VNRX-style partial: lookback known, warrants unknown, floor/reset determined', () => {
    // disc=0.10, lkb=20, no warrants extracted, explicit no-floor, explicit no-reset
    const result = scoreFinancingRisk('VNRX', financing({
      discountRate: 0.10,
      lookbackDays: 20,
      warrantShares: undefined,
      hasFloorPrice: false,
      hasFloorPriceDetermined: true,   // explicit no-floor phrase found
      hasResetProvisions: false,
      hasResetProvisionsDetermined: true, // explicit no-reset phrase found
    }));
    expect(result!.knownFactors).toContain('discountRate');
    expect(result!.knownFactors).toContain('lookbackDays');
    expect(result!.knownFactors).toContain('floorPrice');
    expect(result!.knownFactors).toContain('resetProvisions');
    expect(result!.unknownFactors).toContain('warrantShares');
    expect(result!.unknownFactors).not.toContain('floorPrice');
    expect(result!.unknownFactors).not.toContain('resetProvisions');
    expect(result!.dataWarnings).toHaveLength(0);
  });

  it('lookbackDays missing → unknownFactors includes lookbackDays', () => {
    const result = scoreFinancingRisk('TEST', financing({
      discountRate: 0.15,
      lookbackDays: undefined,
      hasFloorPriceDetermined: true,
      hasResetProvisionsDetermined: true,
    }));
    expect(result!.unknownFactors).toContain('lookbackDays');
    expect(result!.knownFactors).not.toContain('lookbackDays');
  });

  it('warrantShares missing → unknownFactors includes warrantShares', () => {
    const result = scoreFinancingRisk('TEST', financing({
      discountRate: 0.15,
      warrantShares: undefined,
      hasFloorPriceDetermined: true,
      hasResetProvisionsDetermined: true,
    }));
    expect(result!.unknownFactors).toContain('warrantShares');
    expect(result!.knownFactors).not.toContain('warrantShares');
  });

  it('hasFloorPriceDetermined=false → unknownFactors includes floorPrice', () => {
    const result = scoreFinancingRisk('TEST', financing({
      discountRate: 0.15,
      hasFloorPrice: false,
      hasFloorPriceDetermined: false,  // silence — neither pattern matched
      hasResetProvisionsDetermined: true,
    }));
    expect(result!.unknownFactors).toContain('floorPrice');
    expect(result!.knownFactors).not.toContain('floorPrice');
  });

  it('hasResetProvisionsDetermined=false → unknownFactors includes resetProvisions', () => {
    const result = scoreFinancingRisk('TEST', financing({
      discountRate: 0.15,
      hasResetProvisions: false,
      hasFloorPriceDetermined: true,
      hasResetProvisionsDetermined: false, // silence — neither pattern matched
    }));
    expect(result!.unknownFactors).toContain('resetProvisions');
    expect(result!.knownFactors).not.toContain('resetProvisions');
  });

  it('explicit floor (hasFloorPriceDetermined=true) → knownFactors includes floorPrice, no warning', () => {
    const withFloor = scoreFinancingRisk('TEST', financing({
      discountRate: 0.15,
      hasFloorPrice: true,
      hasFloorPriceDetermined: true,
      hasResetProvisionsDetermined: true,
    }));
    expect(withFloor!.knownFactors).toContain('floorPrice');
    expect(withFloor!.dataWarnings.some(w => w.includes('floorPrice'))).toBe(false);
  });

  it('explicit no-floor (determined=true, hasFloorPrice=false) → known, no warning', () => {
    const noFloor = scoreFinancingRisk('TEST', financing({
      discountRate: 0.15,
      hasFloorPrice: false,
      hasFloorPriceDetermined: true,   // explicit "no floor price stated"
      hasResetProvisionsDetermined: true,
    }));
    expect(noFloor!.knownFactors).toContain('floorPrice');
    expect(noFloor!.dataWarnings.some(w => w.includes('floorPrice'))).toBe(false);
  });

  it('silent floor (determined=false) → unknown + dataWarning about conservative inference', () => {
    const silentFloor = scoreFinancingRisk('TEST', financing({
      discountRate: 0.15,
      hasFloorPrice: false,
      hasFloorPriceDetermined: false,  // silence — no pattern matched
      hasResetProvisionsDetermined: true,
    }));
    expect(silentFloor!.unknownFactors).toContain('floorPrice');
    expect(silentFloor!.dataWarnings.some(w => w.includes('floorPrice'))).toBe(true);
  });

  it('explicit reset (determined=true, hasResetProvisions=true) → known, no warning', () => {
    const withReset = scoreFinancingRisk('TEST', financing({
      discountRate: 0.15,
      hasResetProvisions: true,
      hasFloorPriceDetermined: true,
      hasResetProvisionsDetermined: true,
    }));
    expect(withReset!.knownFactors).toContain('resetProvisions');
    expect(withReset!.dataWarnings.some(w => w.includes('resetProvisions'))).toBe(false);
  });

  it('explicit no-reset (determined=true, hasResetProvisions=false) → known, no warning', () => {
    const noReset = scoreFinancingRisk('TEST', financing({
      discountRate: 0.15,
      hasResetProvisions: false,
      hasFloorPriceDetermined: true,
      hasResetProvisionsDetermined: true,  // explicit "no reset provisions stated"
    }));
    expect(noReset!.knownFactors).toContain('resetProvisions');
    expect(noReset!.dataWarnings.some(w => w.includes('resetProvisions'))).toBe(false);
  });

  it('silent reset (determined=false) → unknown + dataWarning', () => {
    const silentReset = scoreFinancingRisk('TEST', financing({
      discountRate: 0.15,
      hasResetProvisions: false,
      hasFloorPriceDetermined: true,
      hasResetProvisionsDetermined: false, // silence
    }));
    expect(silentReset!.unknownFactors).toContain('resetProvisions');
    expect(silentReset!.dataWarnings.some(w => w.includes('resetProvisions'))).toBe(true);
  });

  it('all unknown except discountRate → four unknownFactors and two dataWarnings', () => {
    // Worst-case extraction: only type and discount found
    const result = scoreFinancingRisk('TEST', financing({
      discountRate: 0.20,
      lookbackDays: undefined,
      warrantShares: undefined,
      hasFloorPrice: false,
      hasFloorPriceDetermined: false,
      hasResetProvisions: false,
      hasResetProvisionsDetermined: false,
    }));
    expect(result!.knownFactors).toEqual(['discountRate']);
    expect(result!.unknownFactors).toHaveLength(4);
    expect(result!.dataWarnings).toHaveLength(2);
  });
});

// ─── Exact score verification for known inputs ────────────────────────────────

describe('scoreFinancingRisk — exact score for WXYZ mock data', () => {
  // WXYZ 8-K: 22% discount, 10-day lookback, no floor, reset provisions, 12M warrants on 112M outstanding
  // Expected factor scores:
  //   discount  22% → 82  (weight 0.30 → 24.6)
  //   lookback  10d → 72  (weight 0.20 → 14.4)
  //   warrants  12M/112M = 10.7% overhang → 60 (weight 0.20 → 12.0)
  //   reset     present → 90 (weight 0.20 → 18.0)
  //   floor     absent → 90 (weight 0.10 → 9.0)
  //   total = 78.0 → 78
  it('produces score of 78 for WXYZ-like parameters', () => {
    const result = scoreFinancingRisk('WXYZ', financing({
      discountRate: 0.22,
      lookbackDays: 10,
      hasResetProvisions: true,
      hasFloorPrice: false,
      warrantShares: 12_000_000,
    }), shareStructure({ sharesOutstanding: 112_000_000 }));

    expect(result).toBeDefined();
    expect(result!.score).toBe(78);
    expect(result!.level).toBe('high');
  });
});
