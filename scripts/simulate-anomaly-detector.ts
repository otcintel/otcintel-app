/**
 * OTCIntel — Anomaly detector simulation (24-company universe)
 *
 * Runs the Phase 1A detector against production-shaped fixtures for all 24
 * companies. Does NOT write to Postgres, does NOT call EDGAR, does NOT touch
 * the ingestion pipeline.
 *
 * Run: npx tsx --env-file=.env.local scripts/simulate-anomaly-detector.ts
 *
 * Fixtures are based on post-1.0.4 production audit data. Fields not known
 * from the audit are left at safe defaults (no false anomaly generated).
 */

import { inspect } from '../lib/anomaly/detector';
import type { InspectionContext } from '../lib/anomaly/detector';
import type { ExtractedFinancingTerms } from '../lib/ingestion/types';
import type { FinancialSnapshot } from '../lib/ingestion/parsers/financials/snapshot';
import { PARSER_VERSION } from '../lib/universe/types';

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function f(overrides: Partial<ExtractedFinancingTerms>): ExtractedFinancingTerms {
  return {
    financingType:                'convertible_note',
    confidence:                   'high',
    hasFloorPrice:                false,
    hasFloorPriceDetermined:      false,
    hasResetProvisions:           false,
    hasResetProvisionsDetermined: false,
    matchedPhrases:               [],
    ...overrides,
  };
}

function snap(overrides: Partial<FinancialSnapshot>): FinancialSnapshot {
  return {
    ticker:                  'TEST',
    cik:                     '0000000000',
    accessionNumber:         undefined,
    formType:                '10-K',
    fiscalPeriod:            'FY',
    fiscalYear:              2025,
    periodEndDate:           '2025-09-30',
    filedAt:                 '2026-01-15',
    cashAndEquivalents:      undefined,
    currentLiabilities:      undefined,
    accumulatedDeficit:      undefined,
    totalDebt:               undefined,
    totalDebtComponents:     [],
    operatingCashFlow:       undefined,
    operatingCashFlowMonths: undefined,
    monthlyBurnRate:         undefined,
    cashRunwayMonths:        undefined,
    goingConcernFlag:        false,
    goingConcernSentence:    undefined,
    xbrlAvailable:           false,
    missingConcepts:         [],
    extractedAt:             '2026-08-01T00:00:00Z',
    dataSource:              'xbrl',
    ...overrides,
  };
}

// ─── 24-company fixtures ──────────────────────────────────────────────────────
//
// Data sourced from post-1.0.4 production audit. Companies with no financing
// classification and no snapshot are given minimal contexts.

const UNIVERSE: InspectionContext[] = [
  // ── AITX ─────────────────────────────────────────────────────────────────
  // Bridge-sourced: dr=0.35, lb=10, floor/reset undetermined. Score=71 HIGH.
  {
    ticker: 'AITX', cik: '0001801170',
    hasFinancingClassification: true,
    activeFinancing: f({
      financingType: 'convertible_note',
      discountRate:  0.35, lookbackDays: 10,
      principalAmount: 3_000_000,
      hasFloorPriceDetermined: false, hasResetProvisionsDetermined: false,
      confidence: 'low',
      matchedPhrases: ['[bridge] representative note: 35% discount to 10-day VWAP'],
    }),
    sourceFiling: { accessionNumber: '0001477932-26-003416', formType: '8-K', filedAt: '2026-01-01', parserVersion: PARSER_VERSION, isActiveScoringSource: true },
    snapshot: snap({ ticker: 'AITX', cashRunwayMonths: 3, goingConcernFlag: true }),
    riskScore: undefined,
    currentParserVersion: PARSER_VERSION,
  },

  // ── MFON ─────────────────────────────────────────────────────────────────
  // Bridge-sourced: dr=0.22, final=56 MED.
  {
    ticker: 'MFON', cik: '0001559201',
    hasFinancingClassification: true,
    activeFinancing: f({
      financingType: 'convertible_note',
      discountRate: 0.22, lookbackDays: 10,
      hasFloorPriceDetermined: false, hasResetProvisionsDetermined: false,
      confidence: 'low',
      matchedPhrases: ['[bridge] representative note: 22% discount to market'],
    }),
    sourceFiling: { accessionNumber: '0001477932-26-000500', formType: '8-K', filedAt: '2026-02-01', parserVersion: PARSER_VERSION, isActiveScoringSource: true },
    snapshot: snap({ ticker: 'MFON', cashRunwayMonths: 4 }),
    riskScore: undefined,
    currentParserVersion: PARSER_VERSION,
  },

  // ── VNRX ─────────────────────────────────────────────────────────────────
  // 8-K parsed: dr=0.10, 90% of avg VWAP. Score=52 MED.
  {
    ticker: 'VNRX', cik: '0001522767',
    hasFinancingClassification: true,
    activeFinancing: f({
      financingType: 'convertible_note',
      discountRate: 0.10, lookbackDays: 10,
      hasFloorPrice: false, hasFloorPriceDetermined: true,
      hasResetProvisions: false, hasResetProvisionsDetermined: true,
      confidence: 'high',
      matchedPhrases: ['90% of the average closing price for 10 trading days'],
    }),
    sourceFiling: { accessionNumber: '0001477932-26-003416', formType: '8-K', filedAt: '2026-01-15', parserVersion: PARSER_VERSION, isActiveScoringSource: true },
    snapshot: snap({ ticker: 'VNRX', cashRunwayMonths: 6 }),
    riskScore: undefined,
    currentParserVersion: PARSER_VERSION,
  },

  // ── GOVX ─────────────────────────────────────────────────────────────────
  // financingType=unknown → HIGH: unknown_financing_type
  {
    ticker: 'GOVX', cik: '0001411690',
    hasFinancingClassification: true,
    activeFinancing: f({ financingType: 'unknown', discountRate: undefined, matchedPhrases: [] }),
    sourceFiling: { accessionNumber: '0001477932-26-001100', formType: '8-K', filedAt: '2026-03-01', parserVersion: PARSER_VERSION, isActiveScoringSource: false },
    snapshot: snap({ ticker: 'GOVX' }),
    riskScore: undefined,
    currentParserVersion: PARSER_VERSION,
  },

  // ── RKDA ─────────────────────────────────────────────────────────────────
  // financingType=unknown → HIGH: unknown_financing_type
  {
    ticker: 'RKDA', cik: '0001680139',
    hasFinancingClassification: true,
    activeFinancing: f({ financingType: 'unknown', discountRate: undefined, matchedPhrases: [] }),
    sourceFiling: { accessionNumber: '0001477932-26-001200', formType: '8-K', filedAt: '2026-03-01', parserVersion: PARSER_VERSION, isActiveScoringSource: false },
    snapshot: snap({ ticker: 'RKDA' }),
    riskScore: undefined,
    currentParserVersion: PARSER_VERSION,
  },

  // ── CUEN ─────────────────────────────────────────────────────────────────
  // convertible_note, discountRate=undefined, matchedPhrases has no variable pricing evidence
  // → rule 2 should NOT fire (no variable-pricing text)
  {
    ticker: 'CUEN', cik: '0001689730',
    hasFinancingClassification: true,
    activeFinancing: f({
      financingType: 'convertible_note',
      discountRate: undefined,
      matchedPhrases: ['the Company issued a convertible note in the principal amount of $75,000'],
    }),
    sourceFiling: { accessionNumber: '0001477932-26-001300', formType: '8-K', filedAt: '2026-02-15', parserVersion: PARSER_VERSION, isActiveScoringSource: false },
    snapshot: snap({ ticker: 'CUEN' }),
    riskScore: undefined,
    currentParserVersion: PARSER_VERSION,
  },

  // ── CANN ─────────────────────────────────────────────────────────────────
  // Similar to CUEN — classified but no discount, no variable pricing evidence
  {
    ticker: 'CANN', cik: '0001726445',
    hasFinancingClassification: true,
    activeFinancing: f({
      financingType: 'convertible_note',
      discountRate: undefined,
      matchedPhrases: ['entered into a convertible promissory note for $50,000 at 8% interest'],
    }),
    sourceFiling: { accessionNumber: '0001477932-26-001400', formType: '8-K', filedAt: '2026-02-20', parserVersion: PARSER_VERSION, isActiveScoringSource: false },
    snapshot: snap({ ticker: 'CANN' }),
    riskScore: undefined,
    currentParserVersion: PARSER_VERSION,
  },

  // ── NVVE ─────────────────────────────────────────────────────────────────
  // classified but no discount; include variable-pricing text to see rule 2 fire
  {
    ticker: 'NVVE', cik: '0001758058',
    hasFinancingClassification: true,
    activeFinancing: f({
      financingType: 'convertible_note',
      discountRate: undefined,
      matchedPhrases: ['conversion price equal to 90% of the VWAP for the 5 lowest trading days'],
    }),
    sourceFiling: { accessionNumber: '0001477932-26-001500', formType: '8-K', filedAt: '2026-03-10', parserVersion: PARSER_VERSION, isActiveScoringSource: false },
    snapshot: snap({ ticker: 'NVVE' }),
    riskScore: undefined,
    currentParserVersion: PARSER_VERSION,
  },

  // ── NTRB ─────────────────────────────────────────────────────────────────
  // GC=true + runway=21.3mo → does NOT fire (threshold > 24)
  {
    ticker: 'NTRB', cik: '0001502152',
    hasFinancingClassification: false,
    activeFinancing: undefined,
    sourceFiling: undefined,
    snapshot: snap({ ticker: 'NTRB', goingConcernFlag: true, cashRunwayMonths: 21.3, cashAndEquivalents: 4_200_000 }),
    riskScore: undefined,
    currentParserVersion: PARSER_VERSION,
  },

  // ── WRAP ─────────────────────────────────────────────────────────────────
  // preferred_stock at parser 1.0.0 → MEDIUM: stale_active_source
  {
    ticker: 'WRAP', cik: '0001713539',
    hasFinancingClassification: true,
    activeFinancing: f({
      financingType: 'preferred_stock',
      discountRate: undefined,
      matchedPhrases: ['Series A Preferred Stock'],
      confidence: 'medium',
    }),
    sourceFiling: { accessionNumber: '0001477932-26-001033', formType: '8-K', filedAt: '2025-06-01', parserVersion: '1.0.0', isActiveScoringSource: true },
    snapshot: snap({ ticker: 'WRAP' }),
    riskScore: undefined,
    currentParserVersion: PARSER_VERSION,
  },

  // ── MITI ─────────────────────────────────────────────────────────────────
  {
    ticker: 'MITI', cik: '0001766617',
    hasFinancingClassification: false,
    activeFinancing: undefined,
    sourceFiling: undefined,
    snapshot: snap({ ticker: 'MITI' }),
    riskScore: undefined,
    currentParserVersion: PARSER_VERSION,
  },

  // ── PSTV ─────────────────────────────────────────────────────────────────
  {
    ticker: 'PSTV', cik: '0001419600',
    hasFinancingClassification: false,
    activeFinancing: undefined,
    sourceFiling: undefined,
    snapshot: snap({ ticker: 'PSTV', cashRunwayMonths: 14 }),
    riskScore: undefined,
    currentParserVersion: PARSER_VERSION,
  },

  // ── ABIO ─────────────────────────────────────────────────────────────────
  {
    ticker: 'ABIO', cik: '0001326583',
    hasFinancingClassification: false,
    activeFinancing: undefined,
    sourceFiling: undefined,
    snapshot: snap({ ticker: 'ABIO' }),
    riskScore: undefined,
    currentParserVersion: PARSER_VERSION,
  },

  // ── MFON (already above), remaining companies with no known anomalies ────
  // Use minimal clean contexts for the remaining 10 companies.
  ...['BKYI', 'BPSR', 'CODA', 'DIGP', 'DPLS', 'INFU', 'LIQT', 'NURO', 'PULM', 'RELI'].map(ticker => ({
    ticker,
    cik: '0000000000',
    hasFinancingClassification: false as const,
    activeFinancing: undefined as ExtractedFinancingTerms | undefined,
    sourceFiling: undefined,
    snapshot: snap({ ticker }),
    riskScore: undefined,
    currentParserVersion: PARSER_VERSION,
  })),
];

// ─── Run simulation ───────────────────────────────────────────────────────────

interface SimRow {
  ticker: string;
  anomalyType: string;
  severity: string;
  reason: string;
}

const queue: SimRow[] = [];

for (const company of UNIVERSE) {
  const items = inspect(company);
  for (const item of items) {
    queue.push({
      ticker:      item.ticker,
      anomalyType: item.anomalyType,
      severity:    item.severity,
      reason:      item.title,
    });
  }
}

// ─── Print results ────────────────────────────────────────────────────────────

const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
queue.sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9) || a.ticker.localeCompare(b.ticker));

console.log('\n══════════════════════════════════════════════════════════════════════');
console.log('  OTCIntel Phase 1A — Anomaly Detector Simulation (24-company universe)');
console.log('══════════════════════════════════════════════════════════════════════\n');

const width = { ticker: 6, type: 40, sev: 8 };

console.log(
  `${'TICKER'.padEnd(width.ticker)}  ${'SEVERITY'.padEnd(width.sev)}  ${'ANOMALY TYPE'.padEnd(width.type)}  REASON`,
);
console.log('─'.repeat(120));

for (const row of queue) {
  const sev = row.severity.toUpperCase().padEnd(width.sev);
  console.log(
    `${row.ticker.padEnd(width.ticker)}  ${sev}  ${row.anomalyType.padEnd(width.type)}  ${row.reason}`,
  );
}

console.log('─'.repeat(120));
console.log(`\nTotal items: ${queue.length}`);

const bySeverity = queue.reduce<Record<string, number>>((acc, r) => {
  acc[r.severity] = (acc[r.severity] ?? 0) + 1;
  return acc;
}, {});
for (const sev of ['critical', 'high', 'medium', 'low']) {
  if (bySeverity[sev]) console.log(`  ${sev.padEnd(8)}: ${bySeverity[sev]}`);
}

const byTicker = queue.reduce<Record<string, number>>((acc, r) => {
  acc[r.ticker] = (acc[r.ticker] ?? 0) + 1;
  return acc;
}, {});
const withItems = Object.entries(byTicker).sort(([, a], [, b]) => b - a);
if (withItems.length > 0) {
  console.log(`\nCompanies with items: ${withItems.map(([t, n]) => `${t}(${n})`).join(', ')}`);
}
const clean = UNIVERSE.filter(c => inspect(c).length === 0).map(c => c.ticker);
console.log(`Companies with no items: ${clean.join(', ')}`);
console.log('');
