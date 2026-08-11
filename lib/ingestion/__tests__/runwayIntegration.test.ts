import { describe, it, expect } from 'vitest';
import { applyRunwayUplift, RUNWAY_UPLIFT } from '../runwayIntegration';
import type { RiskScoreRecord } from '../../types';
import type { FinancialSnapshot } from '../parsers/financials/snapshot';

// ─── Fixture factories ────────────────────────────────────────────────────────

function makeBase(overrides: Partial<RiskScoreRecord> = {}): RiskScoreRecord {
  return {
    ticker:            'TEST',
    score:             55,
    level:             'med',
    color:             'amber',
    barWidth:          55,
    bannerVariant:     'amber-risk',
    bannerDotColor:    'var(--amber)',
    bannerPillVariant: 'amber',
    bannerMessage:     '<strong>Medium financing risk detected.</strong> Active convertible note.',
    factors: [
      { name: 'Discount depth', fillWidth: 82, fillColor: 'var(--red)', label: 'High', labelColor: 'var(--red)' },
    ],
    drivers: [
      { dotColor: 'var(--red)', text: '<strong>22% discount to VWAP</strong>.' },
    ],
    scoreBasis:     'valid',
    knownFactors:   ['discountRate', 'lookbackDays'],
    unknownFactors: ['warrantShares'],
    dataWarnings:   ['floorPrice: scored conservatively'],
    ...overrides,
  };
}

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
    cashRunwayMonths:     30,           // healthy by default
    goingConcernFlag:     false,
    goingConcernSentence: undefined,
    xbrlAvailable:        true,
    missingConcepts:      [],
    extractedAt:          '2026-05-15T00:00:00.000Z',
    dataSource:           'xbrl',
    ...overrides,
  };
}

// ─── RUNWAY_UPLIFT table ──────────────────────────────────────────────────────

describe('RUNWAY_UPLIFT table', () => {
  it('critical → 15', () => expect(RUNWAY_UPLIFT.critical).toBe(15));
  it('high → 10',     () => expect(RUNWAY_UPLIFT.high).toBe(10));
  it('moderate → 5',  () => expect(RUNWAY_UPLIFT.moderate).toBe(5));
  it('healthy → 0',   () => expect(RUNWAY_UPLIFT.healthy).toBe(0));
  it('not_applicable → 0',   () => expect(RUNWAY_UPLIFT.not_applicable).toBe(0));
  it('insufficient_data → 0', () => expect(RUNWAY_UPLIFT.insufficient_data).toBe(0));
});

// ─── Uplift amounts ───────────────────────────────────────────────────────────

describe('applyRunwayUplift — uplift amounts', () => {
  it('critical runway adds 15 points', () => {
    const r = applyRunwayUplift(makeBase({ score: 55 }), makeSnapshot({ cashRunwayMonths: 1 }));
    expect(r.score).toBe(70);
  });

  it('high runway adds 10 points', () => {
    const r = applyRunwayUplift(makeBase({ score: 55 }), makeSnapshot({ cashRunwayMonths: 4 }));
    expect(r.score).toBe(65);
  });

  it('moderate runway adds 5 points', () => {
    const r = applyRunwayUplift(makeBase({ score: 55 }), makeSnapshot({ cashRunwayMonths: 8 }));
    expect(r.score).toBe(60);
  });

  it('healthy runway adds 0 points', () => {
    const r = applyRunwayUplift(makeBase({ score: 55 }), makeSnapshot({ cashRunwayMonths: 18 }));
    expect(r.score).toBe(55);
  });

  it('not_applicable adds 0 points', () => {
    const r = applyRunwayUplift(
      makeBase({ score: 55 }),
      makeSnapshot({ operatingCashFlow: 50_000, monthlyBurnRate: undefined, cashRunwayMonths: undefined }),
    );
    expect(r.score).toBe(55);
  });

  it('insufficient_data adds 0 points', () => {
    const r = applyRunwayUplift(
      makeBase({ score: 55 }),
      makeSnapshot({ operatingCashFlow: undefined, monthlyBurnRate: undefined, cashRunwayMonths: undefined }),
    );
    expect(r.score).toBe(55);
  });
});

// ─── Level reclassification ───────────────────────────────────────────────────

describe('applyRunwayUplift — level reclassification', () => {
  it('55 (med) + critical (+15) → 70 high, red, red-risk banner', () => {
    const r = applyRunwayUplift(makeBase({ score: 55 }), makeSnapshot({ cashRunwayMonths: 1 }));
    expect(r.score).toBe(70);
    expect(r.level).toBe('high');
    expect(r.color).toBe('red');
    expect(r.barWidth).toBe(70);
    expect(r.bannerVariant).toBe('red-risk');
    expect(r.bannerPillVariant).toBe('red');
    expect(r.bannerDotColor).toBe('var(--red)');
  });

  it('90 (high) + critical (+15) → capped at 100, still high', () => {
    const r = applyRunwayUplift(makeBase({ score: 90 }), makeSnapshot({ cashRunwayMonths: 1 }));
    expect(r.score).toBe(100);
    expect(r.level).toBe('high');
  });

  it('35 (low) + high (+10) → 45, level=med', () => {
    const r = applyRunwayUplift(makeBase({ score: 35, level: 'low', color: 'green' }), makeSnapshot({ cashRunwayMonths: 4 }));
    expect(r.score).toBe(45);
    expect(r.level).toBe('med');
    expect(r.color).toBe('amber');
    expect(r.bannerVariant).toBe('amber-risk');
  });

  it('65 (med) + moderate (+5) → 70, level=high', () => {
    const r = applyRunwayUplift(makeBase({ score: 65 }), makeSnapshot({ cashRunwayMonths: 8 }));
    expect(r.score).toBe(70);
    expect(r.level).toBe('high');
  });

  it('55 + healthy (+0) → 55, level unchanged', () => {
    const r = applyRunwayUplift(makeBase({ score: 55 }), makeSnapshot({ cashRunwayMonths: 18 }));
    expect(r.score).toBe(55);
    expect(r.level).toBe('med');
    expect(r.color).toBe('amber');
  });
});

// ─── Exact boundary values ────────────────────────────────────────────────────

describe('applyRunwayUplift — exact boundary behavior', () => {
  it('cashRunwayMonths=2.99 → critical, +15', () => {
    const r = applyRunwayUplift(makeBase({ score: 50 }), makeSnapshot({ cashRunwayMonths: 2.99 }));
    expect(r.score).toBe(65);
  });

  it('cashRunwayMonths=3.00 → high, +10', () => {
    const r = applyRunwayUplift(makeBase({ score: 50 }), makeSnapshot({ cashRunwayMonths: 3 }));
    expect(r.score).toBe(60);
  });

  it('cashRunwayMonths=5.99 → high, +10', () => {
    const r = applyRunwayUplift(makeBase({ score: 50 }), makeSnapshot({ cashRunwayMonths: 5.99 }));
    expect(r.score).toBe(60);
  });

  it('cashRunwayMonths=6.00 → moderate, +5', () => {
    const r = applyRunwayUplift(makeBase({ score: 50 }), makeSnapshot({ cashRunwayMonths: 6 }));
    expect(r.score).toBe(55);
  });

  it('cashRunwayMonths=11.99 → moderate, +5', () => {
    const r = applyRunwayUplift(makeBase({ score: 50 }), makeSnapshot({ cashRunwayMonths: 11.99 }));
    expect(r.score).toBe(55);
  });

  it('cashRunwayMonths=12.00 → healthy, +0', () => {
    const r = applyRunwayUplift(makeBase({ score: 50 }), makeSnapshot({ cashRunwayMonths: 12 }));
    expect(r.score).toBe(50);
  });
});

// ─── Going-concern behavior ───────────────────────────────────────────────────

describe('applyRunwayUplift — going concern', () => {
  it('goingConcernFlag=true appends a GC driver with no score points', () => {
    const baseScore = 55;
    const r = applyRunwayUplift(
      makeBase({ score: baseScore }),
      makeSnapshot({ cashRunwayMonths: 1, goingConcernFlag: true }),
    );
    // Score change comes only from runway uplift (critical=+15), not from GC
    expect(r.score).toBe(baseScore + 15);
    // GC driver is present
    const gcDriver = r.drivers.find(d => d.text.includes('going concern') || d.text.includes('Going-concern'));
    expect(gcDriver).toBeDefined();
    // GC driver explicitly states it does not add to the score
    expect(gcDriver!.text).toMatch(/does not add to/i);
    expect(gcDriver!.dotColor).toBe('var(--red)');
  });

  it('goingConcernFlag=false does not add a GC driver', () => {
    const r = applyRunwayUplift(
      makeBase({ score: 55 }),
      makeSnapshot({ cashRunwayMonths: 1, goingConcernFlag: false }),
    );
    const gcDriver = r.drivers.find(d => d.text.includes('going concern') || d.text.includes('Going-concern'));
    expect(gcDriver).toBeUndefined();
  });

  it('goingConcernFlag=true + not_applicable runway: GC driver present, score unchanged', () => {
    const base = makeBase({ score: 55 });
    const r = applyRunwayUplift(
      base,
      makeSnapshot({ operatingCashFlow: 50_000, monthlyBurnRate: undefined, cashRunwayMonths: undefined, goingConcernFlag: true }),
    );
    expect(r.score).toBe(55); // no uplift (not_applicable)
    const gcDriver = r.drivers.find(d => d.text.includes('Going-concern'));
    expect(gcDriver).toBeDefined();
  });
});

// ─── Provenance preservation ──────────────────────────────────────────────────

describe('applyRunwayUplift — provenance fields preserved', () => {
  it('scoreBasis is preserved from base', () => {
    const r = applyRunwayUplift(makeBase(), makeSnapshot({ cashRunwayMonths: 1 }));
    expect(r.scoreBasis).toBe('valid');
  });

  it('knownFactors are preserved from base', () => {
    const base = makeBase({ knownFactors: ['discountRate', 'lookbackDays'] });
    const r = applyRunwayUplift(base, makeSnapshot({ cashRunwayMonths: 1 }));
    expect(r.knownFactors).toEqual(['discountRate', 'lookbackDays']);
  });

  it('unknownFactors are preserved from base', () => {
    const base = makeBase({ unknownFactors: ['warrantShares', 'floorPrice'] });
    const r = applyRunwayUplift(base, makeSnapshot({ cashRunwayMonths: 1 }));
    expect(r.unknownFactors).toEqual(['warrantShares', 'floorPrice']);
  });

  it('dataWarnings are preserved from base', () => {
    const base = makeBase({ dataWarnings: ['floorPrice: scored conservatively'] });
    const r = applyRunwayUplift(base, makeSnapshot({ cashRunwayMonths: 1 }));
    expect(r.dataWarnings).toEqual(['floorPrice: scored conservatively']);
  });

  it('ticker is preserved from base', () => {
    const base = makeBase({ ticker: 'VNRX' });
    const r = applyRunwayUplift(base, makeSnapshot({ cashRunwayMonths: 1 }));
    expect(r.ticker).toBe('VNRX');
  });
});

// ─── Base object immutability ─────────────────────────────────────────────────

describe('applyRunwayUplift — base object not mutated', () => {
  it('base.score is unchanged after call', () => {
    const base = makeBase({ score: 55 });
    applyRunwayUplift(base, makeSnapshot({ cashRunwayMonths: 1 }));
    expect(base.score).toBe(55);
  });

  it('base.factors array is unchanged after call', () => {
    const base = makeBase();
    const originalFactorCount = base.factors.length;
    applyRunwayUplift(base, makeSnapshot({ cashRunwayMonths: 1 }));
    expect(base.factors).toHaveLength(originalFactorCount);
  });

  it('base.drivers array is unchanged after call', () => {
    const base = makeBase();
    const originalDriverCount = base.drivers.length;
    applyRunwayUplift(base, makeSnapshot({ cashRunwayMonths: 1 }));
    expect(base.drivers).toHaveLength(originalDriverCount);
  });
});

// ─── Factor row appended ──────────────────────────────────────────────────────

describe('applyRunwayUplift — Cash runway factor appended', () => {
  it('appends exactly one Cash runway factor', () => {
    const base = makeBase();
    const r = applyRunwayUplift(base, makeSnapshot({ cashRunwayMonths: 1 }));
    expect(r.factors).toHaveLength(base.factors.length + 1);
    const runwayFactor = r.factors[r.factors.length - 1];
    expect(runwayFactor.name).toBe('Cash runway');
  });

  it('critical runway factor has red fill (urgencyScore=1.0 → fillWidth=100)', () => {
    const r = applyRunwayUplift(makeBase(), makeSnapshot({ cashRunwayMonths: 1 }));
    const runwayFactor = r.factors[r.factors.length - 1];
    expect(runwayFactor.fillWidth).toBe(100);
    expect(runwayFactor.fillColor).toBe('var(--red)');
    expect(runwayFactor.label).toBe('High');
  });

  it('healthy runway factor has green fill (urgencyScore=0.1 → fillWidth=10)', () => {
    const r = applyRunwayUplift(makeBase(), makeSnapshot({ cashRunwayMonths: 18 }));
    const runwayFactor = r.factors[r.factors.length - 1];
    expect(runwayFactor.fillWidth).toBe(10);
    expect(runwayFactor.fillColor).toBe('var(--green)');
  });

  it('not_applicable runway factor has green fill (fillWidth=0)', () => {
    const r = applyRunwayUplift(
      makeBase(),
      makeSnapshot({ operatingCashFlow: 50_000, monthlyBurnRate: undefined, cashRunwayMonths: undefined }),
    );
    const runwayFactor = r.factors[r.factors.length - 1];
    expect(runwayFactor.fillWidth).toBe(0);
    expect(runwayFactor.name).toBe('Cash runway');
  });
});

// ─── Driver appended ──────────────────────────────────────────────────────────

describe('applyRunwayUplift — runway driver appended', () => {
  it('appends at least one driver for critical runway', () => {
    const base = makeBase();
    const r = applyRunwayUplift(base, makeSnapshot({ cashRunwayMonths: 1 }));
    expect(r.drivers.length).toBeGreaterThan(base.drivers.length);
  });

  it('critical driver mentions uplift amount', () => {
    const r = applyRunwayUplift(makeBase(), makeSnapshot({ cashRunwayMonths: 1 }));
    const runwayDriver = r.drivers[r.drivers.length - 1];
    expect(runwayDriver.text).toMatch(/15 points/);
  });

  it('moderate driver mentions uplift amount', () => {
    const r = applyRunwayUplift(makeBase(), makeSnapshot({ cashRunwayMonths: 8 }));
    const runwayDriver = r.drivers[r.drivers.length - 1];
    expect(runwayDriver.text).toMatch(/5 points/);
  });

  it('healthy driver states no uplift applied', () => {
    const r = applyRunwayUplift(makeBase(), makeSnapshot({ cashRunwayMonths: 18 }));
    const runwayDriver = r.drivers[r.drivers.length - 1];
    expect(runwayDriver.text).toMatch(/No uplift applied/i);
  });

  it('not_applicable driver states no uplift applied', () => {
    const r = applyRunwayUplift(
      makeBase(),
      makeSnapshot({ operatingCashFlow: 50_000, monthlyBurnRate: undefined, cashRunwayMonths: undefined }),
    );
    const runwayDriver = r.drivers[r.drivers.length - 1];
    expect(runwayDriver.text).toMatch(/No uplift applied/i);
  });

  it('insufficient_data driver states no uplift applied', () => {
    const r = applyRunwayUplift(
      makeBase(),
      makeSnapshot({ operatingCashFlow: undefined, monthlyBurnRate: undefined, cashRunwayMonths: undefined }),
    );
    const runwayDriver = r.drivers[r.drivers.length - 1];
    expect(runwayDriver.text).toMatch(/No uplift applied/i);
  });
});

// ─── Banner message ───────────────────────────────────────────────────────────

describe('applyRunwayUplift — banner message', () => {
  it('banner reflects new level when uplift crosses a threshold', () => {
    // 55 (med) + 15 (critical) = 70 (high)
    const r = applyRunwayUplift(makeBase({ score: 55 }), makeSnapshot({ cashRunwayMonths: 1 }));
    expect(r.bannerMessage).toMatch(/High financing risk/);
  });

  it('banner includes runway months when present and uplift > 0', () => {
    const r = applyRunwayUplift(makeBase({ score: 55 }), makeSnapshot({ cashRunwayMonths: 1.5 }));
    expect(r.bannerMessage).toMatch(/Cash runway: 1\.5 months/);
  });

  it('banner is unchanged in content when uplift=0 and level unchanged', () => {
    const base = makeBase({ score: 55 });
    const r = applyRunwayUplift(base, makeSnapshot({ cashRunwayMonths: 18 }));
    // Level stays med, no runway note appended
    expect(r.bannerMessage).toMatch(/Medium financing risk/);
    expect(r.bannerMessage).not.toMatch(/Cash runway/);
  });
});
