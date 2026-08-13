import { describe, it, expect } from 'vitest';
import { inspect } from '../detector';
import type { InspectionContext, SourceFilingContext } from '../detector';
import type { ExtractedFinancingTerms } from '../../ingestion/types';
import type { FinancialSnapshot } from '../../ingestion/parsers/financials/snapshot';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CURRENT_VERSION = '1.0.4';

function financing(overrides: Partial<ExtractedFinancingTerms> = {}): ExtractedFinancingTerms {
  return {
    financingType:              'convertible_note',
    confidence:                 'high',
    hasFloorPrice:              false,
    hasFloorPriceDetermined:    false,  // bridge default — undetermined
    hasResetProvisions:         false,
    hasResetProvisionsDetermined: false, // bridge default
    matchedPhrases:             [],
    ...overrides,
  };
}

function source(overrides: Partial<SourceFilingContext> = {}): SourceFilingContext {
  return {
    accessionNumber:       '0001477932-26-000001',
    formType:              '8-K',
    filedAt:               '2026-01-01',
    parserVersion:         CURRENT_VERSION,
    isActiveScoringSource: true,
    ...overrides,
  };
}

function snapshot(overrides: Partial<FinancialSnapshot> = {}): FinancialSnapshot {
  return {
    ticker:                  'TEST',
    cik:                     '0001234567',
    accessionNumber:         '0001477932-26-000001',
    formType:                '10-K',
    fiscalPeriod:            'FY',
    fiscalYear:              2025,
    periodEndDate:           '2025-12-31',
    filedAt:                 '2026-03-01',
    cashAndEquivalents:      5_000_000,
    currentLiabilities:      undefined,
    accumulatedDeficit:      undefined,
    totalDebt:               undefined,
    totalDebtComponents:     [],
    operatingCashFlow:       -2_400_000,
    operatingCashFlowMonths: 12,
    monthlyBurnRate:         200_000,
    cashRunwayMonths:        25,
    goingConcernFlag:        false,
    goingConcernSentence:    undefined,
    xbrlAvailable:           true,
    missingConcepts:         [],
    extractedAt:             '2026-03-01T00:00:00Z',
    dataSource:              'xbrl',
    ...overrides,
  };
}

function ctx(overrides: Partial<InspectionContext> = {}): InspectionContext {
  return {
    ticker:                    'TEST',
    cik:                       '0001234567',
    hasFinancingClassification: true,
    activeFinancing:            financing({ discountRate: 0.22, financingType: 'convertible_note' }),
    sourceFiling:               source(),
    snapshot:                  snapshot(),
    riskScore:                 undefined,
    currentParserVersion:      CURRENT_VERSION,
    ...overrides,
  };
}

// ─── Rule 1: unknown_financing_type ──────────────────────────────────────────

describe('rule: unknown_financing_type', () => {
  it('fires when financingType=unknown AND hasFinancingClassification=true', () => {
    const result = inspect(ctx({
      activeFinancing: financing({ financingType: 'unknown', discountRate: undefined }),
    }));
    const item = result.find(r => r.anomalyType === 'unknown_financing_type');
    expect(item).toBeDefined();
    expect(item!.severity).toBe('high');
    expect(item!.category).toBe('financing_extraction');
  });

  it('does NOT fire when there is no financing classification at all', () => {
    const result = inspect(ctx({
      hasFinancingClassification: false,
      activeFinancing:            undefined,
    }));
    expect(result.find(r => r.anomalyType === 'unknown_financing_type')).toBeUndefined();
  });

  it('does NOT fire for a non-financing company with no activeFinancing', () => {
    const result = inspect(ctx({
      hasFinancingClassification: false,
      activeFinancing:            undefined,
      sourceFiling:               undefined,
    }));
    expect(result.find(r => r.anomalyType === 'unknown_financing_type')).toBeUndefined();
  });

  it('does NOT fire for convertible_note with valid discountRate', () => {
    const result = inspect(ctx());
    expect(result.find(r => r.anomalyType === 'unknown_financing_type')).toBeUndefined();
  });

  it('GOVX / RKDA pattern: classified financing but unknown type → fires', () => {
    const result = inspect(ctx({
      ticker:          'GOVX',
      activeFinancing: financing({ financingType: 'unknown', discountRate: undefined }),
    }));
    const item = result.find(r => r.anomalyType === 'unknown_financing_type');
    expect(item).toBeDefined();
    expect(item!.ticker).toBe('GOVX');
  });
});

// ─── Rule 2: variable_pricing_missing_discount ────────────────────────────────

describe('rule: variable_pricing_missing_discount', () => {
  it('fires when convertible_note + no discount + VWAP in matchedPhrases', () => {
    const result = inspect(ctx({
      activeFinancing: financing({
        financingType:  'convertible_note',
        discountRate:   undefined,
        matchedPhrases: ['conversion price equal to 75% of the lowest VWAP for 10 trading days'],
      }),
    }));
    const item = result.find(r => r.anomalyType === 'variable_pricing_missing_discount');
    expect(item).toBeDefined();
    expect(item!.severity).toBe('high');
  });

  it('fires when equity_line + no discount + pricingFormula evidence', () => {
    const result = inspect(ctx({
      activeFinancing: financing({
        financingType:  'equity_line',
        discountRate:   undefined,
        matchedPhrases: ['at a 5% discount to the market price on the purchase date'],
      }),
    }));
    const item = result.find(r => r.anomalyType === 'variable_pricing_missing_discount');
    expect(item).toBeDefined();
  });

  it('fires on "lowest trading price" evidence', () => {
    const result = inspect(ctx({
      activeFinancing: financing({
        financingType:  'convertible_note',
        discountRate:   undefined,
        matchedPhrases: ['conversion at the lowest trading price during the 10 days prior'],
      }),
    }));
    const item = result.find(r => r.anomalyType === 'variable_pricing_missing_discount');
    expect(item).toBeDefined();
  });

  it('fires on "average price" evidence', () => {
    const result = inspect(ctx({
      activeFinancing: financing({
        financingType:  'convertible_note',
        discountRate:   undefined,
        matchedPhrases: ['90% of the average closing price for 5 trading days'],
      }),
    }));
    const item = result.find(r => r.anomalyType === 'variable_pricing_missing_discount');
    expect(item).toBeDefined();
  });

  it('CUEN-style: convertible_note + no discount + NO evidence of variable pricing → does NOT fire', () => {
    const result = inspect(ctx({
      ticker:          'CUEN',
      activeFinancing: financing({
        financingType:  'convertible_note',
        discountRate:   undefined,
        matchedPhrases: ['The Company entered into a convertible promissory note for $50,000'],
      }),
    }));
    expect(result.find(r => r.anomalyType === 'variable_pricing_missing_discount')).toBeUndefined();
  });

  it('does NOT fire when discountRate is present', () => {
    const result = inspect(ctx({
      activeFinancing: financing({
        financingType:  'convertible_note',
        discountRate:   0.22,
        matchedPhrases: ['22% discount to VWAP'],
      }),
    }));
    expect(result.find(r => r.anomalyType === 'variable_pricing_missing_discount')).toBeUndefined();
  });

  it('does NOT fire for preferred_stock (ineligible type)', () => {
    const result = inspect(ctx({
      activeFinancing: financing({
        financingType:  'preferred_stock',
        discountRate:   undefined,
        matchedPhrases: ['Series A preferred stock converted at 75% of VWAP'],
      }),
    }));
    expect(result.find(r => r.anomalyType === 'variable_pricing_missing_discount')).toBeUndefined();
  });
});

// ─── Rule 3: extreme_discount_rate ───────────────────────────────────────────

describe('rule: extreme_discount_rate', () => {
  it('fires when discountRate is 0.65 (> 0.50)', () => {
    const result = inspect(ctx({
      activeFinancing: financing({ discountRate: 0.65 }),
    }));
    const item = result.find(r => r.anomalyType === 'extreme_discount_rate');
    expect(item).toBeDefined();
    expect(item!.severity).toBe('high');
    expect((item!.currentValue as { discountRate: number }).discountRate).toBe(0.65);
  });

  it('fires at exactly 0.51', () => {
    const result = inspect(ctx({ activeFinancing: financing({ discountRate: 0.51 }) }));
    expect(result.find(r => r.anomalyType === 'extreme_discount_rate')).toBeDefined();
  });

  it('does NOT fire for discountRate = 0.35 (AITX production value)', () => {
    const result = inspect(ctx({ activeFinancing: financing({ discountRate: 0.35 }) }));
    expect(result.find(r => r.anomalyType === 'extreme_discount_rate')).toBeUndefined();
  });

  it('does NOT fire at exactly 0.50', () => {
    const result = inspect(ctx({ activeFinancing: financing({ discountRate: 0.50 }) }));
    expect(result.find(r => r.anomalyType === 'extreme_discount_rate')).toBeUndefined();
  });

  it('does NOT fire when discountRate is undefined', () => {
    const result = inspect(ctx({ activeFinancing: financing({ discountRate: undefined }) }));
    expect(result.find(r => r.anomalyType === 'extreme_discount_rate')).toBeUndefined();
  });
});

// ─── Rule 4: implausible_principal_low ───────────────────────────────────────

describe('rule: implausible_principal_low', () => {
  it('fires when principalAmount = 3.85 (unit-scaling error)', () => {
    const result = inspect(ctx({
      activeFinancing: financing({ discountRate: 0.22, principalAmount: 3.85 }),
    }));
    const item = result.find(r => r.anomalyType === 'implausible_principal_low');
    expect(item).toBeDefined();
    expect(item!.severity).toBe('high');
  });

  it('fires at principalAmount = 999', () => {
    const result = inspect(ctx({ activeFinancing: financing({ discountRate: 0.22, principalAmount: 999 }) }));
    expect(result.find(r => r.anomalyType === 'implausible_principal_low')).toBeDefined();
  });

  it('does NOT fire at principalAmount = 1_000 (threshold boundary)', () => {
    const result = inspect(ctx({ activeFinancing: financing({ discountRate: 0.22, principalAmount: 1_000 }) }));
    expect(result.find(r => r.anomalyType === 'implausible_principal_low')).toBeUndefined();
  });

  it('does NOT fire for principalAmount = 3_850_000 (correct value)', () => {
    const result = inspect(ctx({ activeFinancing: financing({ discountRate: 0.22, principalAmount: 3_850_000 }) }));
    expect(result.find(r => r.anomalyType === 'implausible_principal_low')).toBeUndefined();
  });

  it('does NOT fire when principalAmount is undefined', () => {
    const result = inspect(ctx({ activeFinancing: financing({ discountRate: 0.22, principalAmount: undefined }) }));
    expect(result.find(r => r.anomalyType === 'implausible_principal_low')).toBeUndefined();
  });
});

// ─── Rule 5: stale_active_source ─────────────────────────────────────────────

describe('rule: stale_active_source', () => {
  it('fires when active source is at older parser version', () => {
    const result = inspect(ctx({
      sourceFiling: source({ parserVersion: '1.0.0', isActiveScoringSource: true }),
    }));
    const item = result.find(r => r.anomalyType === 'stale_active_source');
    expect(item).toBeDefined();
    expect(item!.severity).toBe('medium');
  });

  it('WRAP-style: stale parser at 1.0.0 when current is 1.0.4 → fires', () => {
    const result = inspect(ctx({
      ticker:        'WRAP',
      sourceFiling:  source({ parserVersion: '1.0.0', isActiveScoringSource: true }),
    }));
    expect(result.find(r => r.anomalyType === 'stale_active_source')).toBeDefined();
  });

  it('does NOT fire when source is at current parser version', () => {
    const result = inspect(ctx({
      sourceFiling: source({ parserVersion: CURRENT_VERSION, isActiveScoringSource: true }),
    }));
    expect(result.find(r => r.anomalyType === 'stale_active_source')).toBeUndefined();
  });

  it('does NOT fire for historical / non-active source at old version', () => {
    const result = inspect(ctx({
      sourceFiling: source({ parserVersion: '1.0.0', isActiveScoringSource: false }),
    }));
    expect(result.find(r => r.anomalyType === 'stale_active_source')).toBeUndefined();
  });

  it('does NOT fire when parserVersion is undefined', () => {
    const result = inspect(ctx({
      sourceFiling: source({ parserVersion: undefined, isActiveScoringSource: true }),
    }));
    expect(result.find(r => r.anomalyType === 'stale_active_source')).toBeUndefined();
  });
});

// ─── Rule 6: going_concern_healthy_runway ────────────────────────────────────

describe('rule: going_concern_healthy_runway', () => {
  it('fires when GC=true and cashRunwayMonths=30 (> 24)', () => {
    const result = inspect(ctx({
      snapshot: snapshot({ goingConcernFlag: true, cashRunwayMonths: 30 }),
    }));
    const item = result.find(r => r.anomalyType === 'going_concern_healthy_runway');
    expect(item).toBeDefined();
    expect(item!.severity).toBe('high');
  });

  it('fires at cashRunwayMonths=24.1', () => {
    const result = inspect(ctx({
      snapshot: snapshot({ goingConcernFlag: true, cashRunwayMonths: 24.1 }),
    }));
    expect(result.find(r => r.anomalyType === 'going_concern_healthy_runway')).toBeDefined();
  });

  it('NTRB-style: GC=true + cashRunwayMonths=21.3 → does NOT fire (threshold is > 24)', () => {
    const result = inspect(ctx({
      ticker:   'NTRB',
      snapshot: snapshot({ goingConcernFlag: true, cashRunwayMonths: 21.3 }),
    }));
    expect(result.find(r => r.anomalyType === 'going_concern_healthy_runway')).toBeUndefined();
  });

  it('does NOT fire at cashRunwayMonths=24 (threshold is strictly > 24)', () => {
    const result = inspect(ctx({
      snapshot: snapshot({ goingConcernFlag: true, cashRunwayMonths: 24 }),
    }));
    expect(result.find(r => r.anomalyType === 'going_concern_healthy_runway')).toBeUndefined();
  });

  it('does NOT fire when GC=false even with high runway', () => {
    const result = inspect(ctx({
      snapshot: snapshot({ goingConcernFlag: false, cashRunwayMonths: 60 }),
    }));
    expect(result.find(r => r.anomalyType === 'going_concern_healthy_runway')).toBeUndefined();
  });

  it('does NOT fire when cashRunwayMonths is undefined', () => {
    const result = inspect(ctx({
      snapshot: snapshot({ goingConcernFlag: true, cashRunwayMonths: undefined }),
    }));
    expect(result.find(r => r.anomalyType === 'going_concern_healthy_runway')).toBeUndefined();
  });

  it('does NOT fire when cashRunwayMonths is Infinity', () => {
    const result = inspect(ctx({
      snapshot: snapshot({ goingConcernFlag: true, cashRunwayMonths: Infinity }),
    }));
    expect(result.find(r => r.anomalyType === 'going_concern_healthy_runway')).toBeUndefined();
  });

  it('does NOT fire when snapshot is absent', () => {
    const result = inspect(ctx({ snapshot: undefined }));
    expect(result.find(r => r.anomalyType === 'going_concern_healthy_runway')).toBeUndefined();
  });
});

// ─── Rule 7: asserted_but_undetermined ───────────────────────────────────────

describe('rule: asserted_but_undetermined', () => {
  it('fires CRITICAL when hasFloorPrice=true && hasFloorPriceDetermined=false', () => {
    const result = inspect(ctx({
      activeFinancing: financing({
        discountRate:            0.22,
        hasFloorPrice:           true,  // asserted
        hasFloorPriceDetermined: false, // but undetermined — invariant violation
      }),
    }));
    const item = result.find(r =>
      r.anomalyType === 'asserted_but_undetermined' &&
      r.sourcePath?.includes('hasFloorPrice'),
    );
    expect(item).toBeDefined();
    expect(item!.severity).toBe('critical');
  });

  it('fires CRITICAL when hasResetProvisions=true && hasResetProvisionsDetermined=false', () => {
    const result = inspect(ctx({
      activeFinancing: financing({
        discountRate:                 0.22,
        hasResetProvisions:           true,
        hasResetProvisionsDetermined: false,
      }),
    }));
    const item = result.find(r =>
      r.anomalyType === 'asserted_but_undetermined' &&
      r.sourcePath?.includes('hasResetProvisions'),
    );
    expect(item).toBeDefined();
    expect(item!.severity).toBe('critical');
  });

  it('can fire both floor and reset violations simultaneously', () => {
    const result = inspect(ctx({
      activeFinancing: financing({
        discountRate:                 0.22,
        hasFloorPrice:                true,
        hasFloorPriceDetermined:      false,
        hasResetProvisions:           true,
        hasResetProvisionsDetermined: false,
      }),
    }));
    const violating = result.filter(r => r.anomalyType === 'asserted_but_undetermined');
    expect(violating).toHaveLength(2);
    expect(violating.every(r => r.severity === 'critical')).toBe(true);
  });

  it('bridge path — false + determined=false — does NOT fire (valid conservative state)', () => {
    // hasFloorPrice=false + hasFloorPriceDetermined=false is the bridge default.
    // It is NOT a violation: silence = conservative unknown, which is valid.
    const result = inspect(ctx({
      activeFinancing: financing({
        discountRate:                 0.35,
        hasFloorPrice:                false,
        hasFloorPriceDetermined:      false,  // bridge default — NOT a violation
        hasResetProvisions:           false,
        hasResetProvisionsDetermined: false,  // bridge default — NOT a violation
      }),
    }));
    expect(result.find(r => r.anomalyType === 'asserted_but_undetermined')).toBeUndefined();
  });

  it('determined=true for both — does NOT fire', () => {
    const result = inspect(ctx({
      activeFinancing: financing({
        discountRate:                 0.22,
        hasFloorPrice:                false,
        hasFloorPriceDetermined:      true,
        hasResetProvisions:           false,
        hasResetProvisionsDetermined: true,
      }),
    }));
    expect(result.find(r => r.anomalyType === 'asserted_but_undetermined')).toBeUndefined();
  });

  it('does NOT fire when activeFinancing is absent', () => {
    const result = inspect(ctx({ activeFinancing: undefined }));
    expect(result.find(r => r.anomalyType === 'asserted_but_undetermined')).toBeUndefined();
  });
});

// ─── Multiple rules can fire simultaneously ───────────────────────────────────

describe('detector: multiple rules', () => {
  it('can emit multiple anomalies for the same company', () => {
    const result = inspect(ctx({
      activeFinancing: financing({
        financingType:   'unknown',
        discountRate:    undefined,
        principalAmount: 3.85,
      }),
      sourceFiling: source({ parserVersion: '1.0.0', isActiveScoringSource: true }),
      snapshot: snapshot({ goingConcernFlag: true, cashRunwayMonths: 30 }),
    }));
    // Should have: unknown_financing_type, implausible_principal_low, stale_active_source,
    // going_concern_healthy_runway (and variable_pricing_missing_discount won't fire —
    // no variable pricing evidence)
    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(result.find(r => r.anomalyType === 'unknown_financing_type')).toBeDefined();
    expect(result.find(r => r.anomalyType === 'implausible_principal_low')).toBeDefined();
    expect(result.find(r => r.anomalyType === 'stale_active_source')).toBeDefined();
    expect(result.find(r => r.anomalyType === 'going_concern_healthy_runway')).toBeDefined();
  });

  it('clean company with valid terms emits no anomalies', () => {
    // AITX-like: 35% discount, 10-day lookback, bridge floor/reset (false + undetermined), healthy runway
    const result = inspect(ctx({
      ticker: 'AITX',
      activeFinancing: financing({
        financingType:                'convertible_note',
        discountRate:                 0.35,
        lookbackDays:                 10,
        principalAmount:              3_000_000,
        hasFloorPrice:                false,
        hasFloorPriceDetermined:      false, // bridge — valid
        hasResetProvisions:           false,
        hasResetProvisionsDetermined: false, // bridge — valid
        confidence:                   'low',
        matchedPhrases:               ['[bridge] 35% discount to 10-day VWAP'],
      }),
      sourceFiling:  source({ parserVersion: CURRENT_VERSION }),
      snapshot:      snapshot({ goingConcernFlag: false, cashRunwayMonths: 8 }),
    }));
    expect(result).toHaveLength(0);
  });

  it('dedup keys are unique across different rules for the same company', () => {
    const result = inspect(ctx({
      activeFinancing: financing({
        discountRate:    0.65,
        principalAmount: 3.85,
      }),
    }));
    const keys = result.map(r => r.dedupKey);
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(keys.length);
  });
});
