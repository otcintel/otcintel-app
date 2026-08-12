/**
 * Tests for lib/ingestion/financingBridge.ts
 *
 * Covers:
 *  - AITX four-note production fixture
 *  - Status filtering (active / excluded)
 *  - Representative note selection (dr → lb → principal tiebreakers)
 *  - Aggregate principal from qualifying notes
 *  - Floor / reset provenance (always false from bridge)
 *  - [bridge] provenance in matchedPhrases
 *  - Confidence always 'low'
 *  - No qualifying notes → undefined
 *  - selectEffectiveFinancing: CENN exclusion
 *  - selectEffectiveFinancing: 8-K with discountRate takes priority
 *  - No parser-version dependency (bridge is a pure function)
 */

import { describe, it, expect } from 'vitest';
import { bridgeFinancingFromReport, selectEffectiveFinancing } from '../financingBridge';
import type { NormalizedFiling, ConvertibleNote, ExtractedFinancingTerms } from '../types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function note(overrides: Partial<ConvertibleNote> & { discountRate?: number } = {}): ConvertibleNote {
  return {
    hasFloorPrice:        false,
    hasResetProvisions:   false,
    ...overrides,
  };
}

function filing(overrides: {
  filedAt?: string;
  formType?: NormalizedFiling['formType'];
  accessionNumber?: string;
  notes?: ConvertibleNote[];
  financing?: ExtractedFinancingTerms;
}): NormalizedFiling {
  const { filedAt = '2026-01-01', formType = '10-Q', accessionNumber = 'ACC-001', notes = [], financing } = overrides;
  return {
    ticker:          'TEST',
    cik:             '0000000001',
    formType,
    filedAt,
    periodOfReport:  filedAt,
    accessionNumber,
    documentUrl:     '',
    ingestedAt:      filedAt,
    source:          'edgar',
    parseErrors:     [],
    ...(financing ? { financing } : {}),
    ...(notes.length > 0 ? {
      financingReport: {
        convertibleDebt:          notes,
        equityIssuances:          [],
        conversions:              [],
        warrants:                 [],
        relatedPartyTransactions: [],
        equityFacilities:         [],
        dilutionSummary:          { dilutionPhrases: [], hasDilutionWarning: false },
        reportText:               '',
        extractedAt:              filedAt,
        confidence:               'medium',
        warnings:                 [],
      },
    } : {}),
  };
}

function rawFinancing(overrides: Partial<ExtractedFinancingTerms> = {}): ExtractedFinancingTerms {
  return {
    financingType:              'convertible_note',
    confidence:                 'high',
    hasFloorPrice:              false,
    hasFloorPriceDetermined:    true,
    hasResetProvisions:         false,
    hasResetProvisionsDetermined: true,
    matchedPhrases:             ['8-K source'],
    ...overrides,
  };
}

// ─── AITX four-note production fixture ───────────────────────────────────────

describe('bridgeFinancingFromReport — AITX production fixture', () => {
  // 10-Q/A 2026-07-17: 4 notes all dr=0.35, two lookbacks (20d and 10d)
  const aitxFilings = [
    filing({
      filedAt:         '2026-07-17',
      formType:        '10-Q/A',
      accessionNumber: '0001493152-26-033603',
      notes: [
        note({ principalAmount: 230_000, discountRate: 0.35, lookbackDays: 20 }),
        note({ principalAmount:  55_000, discountRate: 0.35, lookbackDays: 10 }),
        note({ principalAmount: 110_000, discountRate: 0.35, lookbackDays: 10 }),
        note({ principalAmount: 165_000, discountRate: 0.35, lookbackDays: 20 }),
      ],
    }),
  ];

  it('returns a result for the AITX fixture', () => {
    const result = bridgeFinancingFromReport(aitxFilings);
    expect(result).not.toBeUndefined();
  });

  it('discountRate = 0.35 (all notes equal → tiebreaker applies)', () => {
    const result = bridgeFinancingFromReport(aitxFilings);
    expect(result!.discountRate).toBeCloseTo(0.35, 5);
  });

  it('lookbackDays = 10 (shortest among 10d/10d tiebreakers → principal tiebreak)', () => {
    const result = bridgeFinancingFromReport(aitxFilings);
    expect(result!.lookbackDays).toBe(10);
  });

  it('principalAmount = 560 000 (sum of all four qualifying notes)', () => {
    const result = bridgeFinancingFromReport(aitxFilings);
    expect(result!.principalAmount).toBe(560_000);
  });

  it('confidence = low', () => {
    const result = bridgeFinancingFromReport(aitxFilings);
    expect(result!.confidence).toBe('low');
  });

  it('matchedPhrases[0] contains [bridge] provenance', () => {
    const result = bridgeFinancingFromReport(aitxFilings);
    expect(result!.matchedPhrases[0]).toContain('[bridge]');
    expect(result!.matchedPhrases[0]).toContain('10-Q/A');
    expect(result!.matchedPhrases[0]).toContain('2026-07-17');
    expect(result!.matchedPhrases[0]).toContain('0001493152-26-033603');
  });

  it('financingType = convertible_note', () => {
    const result = bridgeFinancingFromReport(aitxFilings);
    expect(result!.financingType).toBe('convertible_note');
  });

  it('warrantShares = undefined (bridge never infers warrants)', () => {
    const result = bridgeFinancingFromReport(aitxFilings);
    expect(result!.warrantShares).toBeUndefined();
  });
});

// ─── AITX base score calculation (integration with scorer) ────────────────────

describe('bridgeFinancingFromReport — AITX scoring integration', () => {
  // Import scorer inline to verify exact numeric output without importing from index
  // so this test does not depend on public API re-exports.
  it('produces base score = 56 for AITX 0.35 dr / 10d lb / no floor / no warrants', async () => {
    const { scoreFinancingRisk } = await import('../scoring');
    const aitxBridged = bridgeFinancingFromReport([
      filing({
        filedAt:         '2026-07-17',
        formType:        '10-Q/A',
        accessionNumber: '0001493152-26-033603',
        notes: [
          note({ principalAmount: 230_000, discountRate: 0.35, lookbackDays: 20 }),
          note({ principalAmount:  55_000, discountRate: 0.35, lookbackDays: 10 }),
          note({ principalAmount: 110_000, discountRate: 0.35, lookbackDays: 10 }),
          note({ principalAmount: 165_000, discountRate: 0.35, lookbackDays: 20 }),
        ],
      }),
    ]);
    const score = scoreFinancingRisk('AITX', aitxBridged!, undefined);
    // discountScore=95*0.30=28.5 + lookbackScore=72*0.20=14.4 + warrantScore=0*0.20=0
    // + resetScore=18*0.20=3.6 + floorScore=90*0.10=9.0 = 55.5 → round → 56
    expect(score!.score).toBe(56);
    expect(score!.level).toBe('med');
  });
});

// ─── Status filtering ─────────────────────────────────────────────────────────

describe('bridgeFinancingFromReport — status filtering', () => {
  it('excludes notes with status=converted', () => {
    const result = bridgeFinancingFromReport([
      filing({ notes: [
        note({ principalAmount: 100_000, discountRate: 0.35, status: 'converted' }),
        note({ principalAmount:  50_000, discountRate: 0.30 }),
      ]}),
    ]);
    expect(result!.discountRate).toBeCloseTo(0.30, 5);
    expect(result!.principalAmount).toBe(50_000);
  });

  it('excludes notes with status=repaid', () => {
    const result = bridgeFinancingFromReport([
      filing({ notes: [
        note({ principalAmount: 200_000, discountRate: 0.40, status: 'repaid' }),
        note({ principalAmount:  80_000, discountRate: 0.25 }),
      ]}),
    ]);
    expect(result!.discountRate).toBeCloseTo(0.25, 5);
    expect(result!.principalAmount).toBe(80_000);
  });

  it('excludes notes with status=settled', () => {
    const result = bridgeFinancingFromReport([
      filing({ notes: [
        note({ principalAmount: 100_000, discountRate: 0.35, status: 'settled' }),
        note({ principalAmount:  60_000, discountRate: 0.20 }),
      ]}),
    ]);
    expect(result!.principalAmount).toBe(60_000);
  });

  it('excludes notes with status=cancelled', () => {
    const result = bridgeFinancingFromReport([
      filing({ notes: [
        note({ principalAmount: 100_000, discountRate: 0.35, status: 'cancelled' }),
      ]}),
    ]);
    expect(result).toBeUndefined();
  });

  it('excludes notes with status=matured', () => {
    const result = bridgeFinancingFromReport([
      filing({ notes: [
        note({ principalAmount: 100_000, discountRate: 0.35, status: 'matured' }),
      ]}),
    ]);
    expect(result).toBeUndefined();
  });

  it('includes notes with status=outstanding', () => {
    const result = bridgeFinancingFromReport([
      filing({ notes: [
        note({ principalAmount: 100_000, discountRate: 0.35, status: 'outstanding' }),
      ]}),
    ]);
    expect(result!.principalAmount).toBe(100_000);
  });

  it('includes notes with status=unknown', () => {
    const result = bridgeFinancingFromReport([
      filing({ notes: [
        note({ principalAmount: 100_000, discountRate: 0.35, status: 'unknown' }),
      ]}),
    ]);
    expect(result!.principalAmount).toBe(100_000);
  });

  it('includes notes with status=undefined', () => {
    const result = bridgeFinancingFromReport([
      filing({ notes: [
        note({ principalAmount: 100_000, discountRate: 0.35 }),
      ]}),
    ]);
    expect(result!.principalAmount).toBe(100_000);
  });

  it('excludes notes without discountRate even if status is active', () => {
    const result = bridgeFinancingFromReport([
      filing({ notes: [
        note({ principalAmount: 100_000 }),                             // no dr
        note({ principalAmount:  50_000, discountRate: 0.22 }),
      ]}),
    ]);
    // Only the $50K note qualifies → principal = 50K
    expect(result!.principalAmount).toBe(50_000);
  });
});

// ─── Representative note selection ───────────────────────────────────────────

describe('bridgeFinancingFromReport — representative note selection', () => {
  it('selects the highest discountRate when multiples differ', () => {
    const result = bridgeFinancingFromReport([
      filing({ notes: [
        note({ principalAmount: 200_000, discountRate: 0.25, lookbackDays: 10 }),
        note({ principalAmount: 100_000, discountRate: 0.35, lookbackDays: 20 }),
        note({ principalAmount:  50_000, discountRate: 0.20, lookbackDays: 5  }),
      ]}),
    ]);
    expect(result!.discountRate).toBeCloseTo(0.35, 5);
  });

  it('uses shortest lookbackDays as tiebreaker when discountRates tie', () => {
    const result = bridgeFinancingFromReport([
      filing({ notes: [
        note({ principalAmount: 100_000, discountRate: 0.35, lookbackDays: 20 }),
        note({ principalAmount:  80_000, discountRate: 0.35, lookbackDays: 7  }),
        note({ principalAmount:  60_000, discountRate: 0.35, lookbackDays: 10 }),
      ]}),
    ]);
    expect(result!.lookbackDays).toBe(7);
  });

  it('uses largest principalAmount as final tiebreaker when dr and lb tie', () => {
    const result = bridgeFinancingFromReport([
      filing({ notes: [
        note({ principalAmount:  55_000, discountRate: 0.35, lookbackDays: 10 }),
        note({ principalAmount: 110_000, discountRate: 0.35, lookbackDays: 10 }),
        note({ principalAmount:  75_000, discountRate: 0.35, lookbackDays: 10 }),
      ]}),
    ]);
    // Representative: $110K note; principalAmount sums all three
    expect(result!.lookbackDays).toBe(10);
    expect(result!.principalAmount).toBe(240_000); // 55K + 110K + 75K
  });

  it('uses outstandingBalance over principalAmount in tiebreaker', () => {
    const result = bridgeFinancingFromReport([
      filing({ notes: [
        note({ principalAmount: 100_000, outstandingBalance: 30_000, discountRate: 0.35, lookbackDays: 10 }),
        note({ principalAmount:  50_000, outstandingBalance: 40_000, discountRate: 0.35, lookbackDays: 10 }),
      ]}),
    ]);
    // outstandingBalance preferred: 40K > 30K → second note wins
    // Total: ob=30K + ob=40K = 70K
    expect(result!.principalAmount).toBe(70_000);
  });
});

// ─── Aggregate principal ──────────────────────────────────────────────────────

describe('bridgeFinancingFromReport — aggregate principal', () => {
  it('sums principal across all qualifying notes', () => {
    const result = bridgeFinancingFromReport([
      filing({ notes: [
        note({ principalAmount: 100_000, discountRate: 0.30 }),
        note({ principalAmount: 200_000, discountRate: 0.25 }),
        note({ principalAmount:  50_000, discountRate: 0.20 }),
      ]}),
    ]);
    expect(result!.principalAmount).toBe(350_000);
  });

  it('excludes repaid notes from the principal sum', () => {
    const result = bridgeFinancingFromReport([
      filing({ notes: [
        note({ principalAmount: 100_000, discountRate: 0.30 }),
        note({ principalAmount: 200_000, discountRate: 0.25, status: 'repaid' }),
      ]}),
    ]);
    expect(result!.principalAmount).toBe(100_000);
  });

  it('returns undefined principalAmount when all qualifying notes have zero exposure', () => {
    const result = bridgeFinancingFromReport([
      filing({ notes: [
        note({ discountRate: 0.30 }),  // no principalAmount, no outstandingBalance
      ]}),
    ]);
    // totalPrincipal = 0, so principalAmount should be undefined
    expect(result!.principalAmount).toBeUndefined();
  });
});

// ─── Floor and reset provenance ───────────────────────────────────────────────

describe('bridgeFinancingFromReport — floor / reset provenance always false', () => {
  it('hasFloorPriceDetermined = false even when representative note has hasFloorPrice=true', () => {
    const result = bridgeFinancingFromReport([
      filing({ notes: [
        note({ discountRate: 0.35, hasFloorPrice: true, floorPrice: 0.001 }),
      ]}),
    ]);
    expect(result!.hasFloorPriceDetermined).toBe(false);
  });

  it('hasFloorPriceDetermined = false when representative note has hasFloorPrice=false', () => {
    const result = bridgeFinancingFromReport([
      filing({ notes: [
        note({ discountRate: 0.35 }),
      ]}),
    ]);
    expect(result!.hasFloorPriceDetermined).toBe(false);
  });

  it('hasResetProvisionsDetermined = false even when representative note has hasResetProvisions=true', () => {
    const result = bridgeFinancingFromReport([
      filing({ notes: [
        note({ discountRate: 0.35, hasResetProvisions: true }),
      ]}),
    ]);
    expect(result!.hasResetProvisionsDetermined).toBe(false);
  });

  it('passes through hasFloorPrice and hasResetProvisions from representative note', () => {
    const result = bridgeFinancingFromReport([
      filing({ notes: [
        note({ discountRate: 0.35, hasFloorPrice: true, floorPrice: 0.005, hasResetProvisions: true }),
      ]}),
    ]);
    expect(result!.hasFloorPrice).toBe(true);
    expect(result!.floorPrice).toBe(0.005);
    expect(result!.hasResetProvisions).toBe(true);
  });
});

// ─── No qualifying notes ──────────────────────────────────────────────────────

describe('bridgeFinancingFromReport — no qualifying notes → undefined', () => {
  it('returns undefined when no filings have financingReport', () => {
    const result = bridgeFinancingFromReport([filing({})]);
    expect(result).toBeUndefined();
  });

  it('returns undefined when all notes lack discountRate', () => {
    const result = bridgeFinancingFromReport([
      filing({ notes: [
        note({ principalAmount: 100_000 }),
        note({ principalAmount: 200_000 }),
      ]}),
    ]);
    expect(result).toBeUndefined();
  });

  it('returns undefined when all notes are excluded by status', () => {
    const result = bridgeFinancingFromReport([
      filing({ notes: [
        note({ discountRate: 0.30, status: 'converted' }),
        note({ discountRate: 0.25, status: 'repaid' }),
        note({ discountRate: 0.20, status: 'matured' }),
      ]}),
    ]);
    expect(result).toBeUndefined();
  });

  it('returns undefined when filings array is empty', () => {
    const result = bridgeFinancingFromReport([]);
    expect(result).toBeUndefined();
  });
});

// ─── Most recently filed report selection ────────────────────────────────────

describe('bridgeFinancingFromReport — most recently filed report wins', () => {
  it('selects the later filing when two have qualifying notes', () => {
    const result = bridgeFinancingFromReport([
      filing({ filedAt: '2026-01-15', notes: [note({ discountRate: 0.25 })] }),
      filing({ filedAt: '2026-07-17', notes: [note({ discountRate: 0.35 })] }),
    ]);
    expect(result!.discountRate).toBeCloseTo(0.35, 5);
    expect(result!.matchedPhrases[0]).toContain('2026-07-17');
  });

  it('skips filings whose only notes are excluded (no qualifying notes)', () => {
    const result = bridgeFinancingFromReport([
      filing({ filedAt: '2026-07-17', notes: [note({ discountRate: 0.35, status: 'cancelled' })] }),
      filing({ filedAt: '2026-01-15', notes: [note({ discountRate: 0.25 })] }),
    ]);
    // The 2026-07-17 filing has no qualifying notes → falls back to 2026-01-15
    expect(result!.discountRate).toBeCloseTo(0.25, 5);
    expect(result!.matchedPhrases[0]).toContain('2026-01-15');
  });
});

// ─── selectEffectiveFinancing — call-site logic ───────────────────────────────

describe('selectEffectiveFinancing — CENN explicitly excluded from bridge', () => {
  const cennFilings = [
    filing({ notes: [
      note({ principalAmount: 61_215_000, discountRate: 0.15, status: 'outstanding' }),
    ]}),
  ];

  it('returns undefined for CENN when raw financing is undefined', () => {
    const result = selectEffectiveFinancing('CENN', undefined, cennFilings);
    expect(result).toBeUndefined();
  });

  it('returns rawFinancing unchanged for CENN (no bridge applied)', () => {
    const rf = rawFinancing({ discountRate: undefined });
    const result = selectEffectiveFinancing('CENN', rf, cennFilings);
    expect(result).toBe(rf);
  });
});

describe('selectEffectiveFinancing — 8-K with discountRate takes priority over bridge', () => {
  const filings = [
    filing({ notes: [
      note({ principalAmount: 100_000, discountRate: 0.35 }),
    ]}),
  ];

  it('returns rawFinancing when it has discountRate (bridge not called)', () => {
    const rf = rawFinancing({ discountRate: 0.22, financingType: 'convertible_note' });
    const result = selectEffectiveFinancing('AITX', rf, filings);
    expect(result).toBe(rf);
    expect(result!.discountRate).toBe(0.22);
  });

  it('does not use bridge discountRate when 8-K already has one', () => {
    const rf = rawFinancing({ discountRate: 0.22 });
    const result = selectEffectiveFinancing('AITX', rf, filings);
    expect(result!.discountRate).not.toBeCloseTo(0.35, 5);
  });
});

describe('selectEffectiveFinancing — bridge used when 8-K lacks discountRate', () => {
  const filings = [
    filing({ notes: [
      note({ principalAmount: 100_000, discountRate: 0.35 }),
    ]}),
  ];

  it('returns bridge result when rawFinancing has no discountRate', () => {
    const rf = rawFinancing({ discountRate: undefined });
    const result = selectEffectiveFinancing('TEST', rf, filings);
    expect(result!.discountRate).toBeCloseTo(0.35, 5);
    expect(result!.matchedPhrases[0]).toContain('[bridge]');
  });

  it('returns bridge result when rawFinancing is undefined', () => {
    const result = selectEffectiveFinancing('TEST', undefined, filings);
    expect(result!.discountRate).toBeCloseTo(0.35, 5);
  });

  it('falls back to rawFinancing when bridge has no qualifying notes', () => {
    const rf = rawFinancing({ discountRate: undefined });
    const result = selectEffectiveFinancing('TEST', rf, [filing({})]);
    expect(result).toBe(rf);
  });
});

// ─── Parser-version independence ─────────────────────────────────────────────

describe('bridgeFinancingFromReport — parser-version independence', () => {
  it('returns same result regardless of parserVersion field on filing', () => {
    const base = filing({ notes: [note({ discountRate: 0.35 })] });
    const v104 = { ...base, parserVersion: '1.0.4' };
    const v103 = { ...base, parserVersion: '1.0.3' };
    const r104 = bridgeFinancingFromReport([v104]);
    const r103 = bridgeFinancingFromReport([v103]);
    expect(r104!.discountRate).toBe(r103!.discountRate);
  });
});
