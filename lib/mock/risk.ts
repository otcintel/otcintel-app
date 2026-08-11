/**
 * Mock risk score records.
 * Simulates the `risk_scores` database table.
 *
 * All 8 tracked companies have risk score records — these are needed
 * for both the companies list table and the full intelligence pages.
 */

import type { RiskScoreRecord } from '../types';

export const riskScoreRecords: Record<string, RiskScoreRecord> = {

  WXYZ: {
    ticker: 'WXYZ',
    score: 87,
    level: 'high',
    color: 'red',
    barWidth: 87,
    bannerVariant: 'red-risk',
    bannerDotColor: 'var(--red)',
    bannerPillVariant: 'red',
    bannerMessage:
      '<strong>High financing risk detected.</strong> Active $1.5M convertible note at 22% discount to 10-day VWAP. No floor price. Estimated dilution: 26.1% fully diluted.',
    factors: [
      { name: 'Discount depth',   fillWidth: 90, fillColor: 'var(--red)',   label: 'High', labelColor: 'var(--red)'   },
      { name: 'Lookback window',  fillWidth: 72, fillColor: 'var(--amber)', label: 'Med',  labelColor: 'var(--amber)' },
      { name: 'Warrant coverage', fillWidth: 82, fillColor: 'var(--red)',   label: 'High', labelColor: 'var(--red)'   },
      { name: 'Reset provisions', fillWidth: 90, fillColor: 'var(--red)',   label: 'High', labelColor: 'var(--red)'   },
      { name: 'Floor price',      fillWidth: 90, fillColor: 'var(--red)',   label: 'High', labelColor: 'var(--red)'   },
    ],
    drivers: [
      {
        dotColor: 'var(--red)',
        text: '<strong>22% discount to VWAP</strong> significantly exceeds the 15% elevated risk threshold. No floor price means conversion shares are uncapped as stock price declines.',
      },
      {
        dotColor: 'var(--red)',
        text: '<strong>Reset provisions present.</strong> Anti-dilution clauses allow the conversion price to step down if the stock trades below prior conversion levels, compounding dilution over time.',
      },
      {
        dotColor: 'var(--red)',
        text: '<strong>12,000,000 warrants outstanding</strong> at $0.10 per share — near current market price — represent a 10.7% overhang with elevated near-term exercise risk.',
      },
      {
        dotColor: 'var(--amber)',
        text: '<strong>10-day VWAP lookback</strong> exceeds the 5-day benchmark, increasing downside sensitivity and lowering the effective conversion price in a sustained price decline.',
      },
      {
        dotColor: 'var(--red)',
        text: '<strong>No floor price stated.</strong> Absent a contractual minimum, share issuance from the note escalates without limit as stock price declines.',
      },
    ],
    scoreBasis: 'valid',
    knownFactors: ['discountRate', 'lookbackDays', 'warrantShares', 'floorPrice', 'resetProvisions'],
    unknownFactors: [],
    dataWarnings: [],
  },

  EFGH: {
    ticker: 'EFGH',
    score: 42,
    level: 'med',
    color: 'amber',
    barWidth: 42,
    bannerVariant: 'amber-risk',
    bannerDotColor: 'var(--amber)',
    bannerPillVariant: 'amber',
    bannerMessage:
      '<strong>Medium financing risk detected.</strong> Residual $500K convertible note at 12% discount to 5-day VWAP. Floor price: $0.18. Estimated dilution: 8.9% fully diluted.',
    factors: [
      { name: 'Discount depth',   fillWidth: 18, fillColor: 'var(--green)', label: 'Low', labelColor: 'var(--green)' },
      { name: 'Lookback window',  fillWidth: 18, fillColor: 'var(--green)', label: 'Low', labelColor: 'var(--green)' },
      { name: 'Warrant coverage', fillWidth: 55, fillColor: 'var(--amber)', label: 'Med', labelColor: 'var(--amber)' },
      { name: 'Reset provisions', fillWidth: 18, fillColor: 'var(--green)', label: 'Low', labelColor: 'var(--green)' },
      { name: 'Floor price',      fillWidth: 18, fillColor: 'var(--green)', label: 'Low', labelColor: 'var(--green)' },
    ],
    drivers: [
      {
        dotColor: 'var(--green)',
        text: '<strong>12% discount to VWAP</strong> is below the 15% elevated risk threshold. Conversion pricing is moderate relative to typical OTC structures and is further bounded by the stated floor.',
      },
      {
        dotColor: 'var(--green)',
        text: '<strong>5-day VWAP lookback</strong> is the tightest window commonly used in OTC convertible structures, reducing downside sensitivity and limiting the impact of short-term price volatility.',
      },
      {
        dotColor: 'var(--amber)',
        text: '<strong>3,000,000 warrants outstanding</strong> at $0.35 per share represent a 5.5% overhang. The exercise price is 46% above current market, meaningfully limiting near-term exercise probability.',
      },
      {
        dotColor: 'var(--green)',
        text: '<strong>No reset provisions.</strong> The absence of anti-dilution reset clauses fixes the conversion price, capping share issuance at current terms regardless of future price movement.',
      },
      {
        dotColor: 'var(--green)',
        text: '<strong>Floor price of $0.18 stated.</strong> A contractual conversion minimum limits share issuance from the note to approximately 2,367,424 shares regardless of how far the stock declines below $0.18.',
      },
    ],
    scoreBasis: 'valid',
    knownFactors: ['discountRate', 'lookbackDays', 'warrantShares', 'floorPrice', 'resetProvisions'],
    unknownFactors: [],
    dataWarnings: [],
  },

  ABCD: {
    ticker: 'ABCD',
    score: 83,
    level: 'high',
    color: 'red',
    barWidth: 83,
    bannerVariant: 'red-risk',
    bannerDotColor: 'var(--red)',
    bannerPillVariant: 'red',
    bannerMessage:
      '<strong>High financing risk detected.</strong> Active $2M convertible note at 20% discount to 10-day VWAP. No floor price stated. Estimated dilution: 30.9% fully diluted.',
    factors: [
      { name: 'Discount depth',   fillWidth: 85, fillColor: 'var(--red)',   label: 'High', labelColor: 'var(--red)'   },
      { name: 'Lookback window',  fillWidth: 72, fillColor: 'var(--amber)', label: 'Med',  labelColor: 'var(--amber)' },
      { name: 'Warrant coverage', fillWidth: 78, fillColor: 'var(--red)',   label: 'High', labelColor: 'var(--red)'   },
      { name: 'Reset provisions', fillWidth: 90, fillColor: 'var(--red)',   label: 'High', labelColor: 'var(--red)'   },
      { name: 'Floor price',      fillWidth: 90, fillColor: 'var(--red)',   label: 'High', labelColor: 'var(--red)'   },
    ],
    drivers: [
      {
        dotColor: 'var(--red)',
        text: '<strong>20% discount to VWAP</strong> significantly exceeds the 15% elevated risk threshold. No floor price means conversion shares are uncapped as the stock price declines.',
      },
      {
        dotColor: 'var(--red)',
        text: '<strong>Reset provisions present.</strong> Anti-dilution clauses allow the conversion price to step down if the stock trades below prior conversion levels, compounding dilution over time.',
      },
      {
        dotColor: 'var(--red)',
        text: '<strong>8,000,000 warrants outstanding</strong> at $0.22 per share represent a 17.8% overhang. Exercise price is near current market, creating elevated near-term exercise risk.',
      },
      {
        dotColor: 'var(--amber)',
        text: '<strong>10-day VWAP lookback</strong> exceeds the 5-day benchmark, increasing downside sensitivity and lowering the effective conversion price in a sustained price decline.',
      },
      {
        dotColor: 'var(--red)',
        text: '<strong>No floor price stated.</strong> Absent a contractual minimum, share issuance from the note escalates without limit as stock price declines.',
      },
    ],
    scoreBasis: 'valid',
    knownFactors: ['discountRate', 'lookbackDays', 'warrantShares', 'floorPrice', 'resetProvisions'],
    unknownFactors: [],
    dataWarnings: [],
  },

  MNOP: {
    ticker: 'MNOP',
    score: 91,
    level: 'high',
    color: 'red',
    barWidth: 91,
    bannerVariant: 'red-risk',
    bannerDotColor: 'var(--red)',
    bannerPillVariant: 'red',
    bannerMessage:
      '<strong>High financing risk detected.</strong> Active convertible note at 25% discount. Reset provisions present. No floor price stated.',
    factors: [
      { name: 'Discount depth',   fillWidth: 95, fillColor: 'var(--red)', label: 'High', labelColor: 'var(--red)' },
      { name: 'Lookback window',  fillWidth: 80, fillColor: 'var(--red)', label: 'High', labelColor: 'var(--red)' },
      { name: 'Warrant coverage', fillWidth: 88, fillColor: 'var(--red)', label: 'High', labelColor: 'var(--red)' },
      { name: 'Reset provisions', fillWidth: 90, fillColor: 'var(--red)', label: 'High', labelColor: 'var(--red)' },
      { name: 'Floor price',      fillWidth: 90, fillColor: 'var(--red)', label: 'High', labelColor: 'var(--red)' },
    ],
    drivers: [],
    scoreBasis: 'valid',
    knownFactors: ['discountRate', 'lookbackDays', 'warrantShares', 'floorPrice', 'resetProvisions'],
    unknownFactors: [],
    dataWarnings: [],
  },

  QRST: {
    ticker: 'QRST',
    score: 55,
    level: 'med',
    color: 'amber',
    barWidth: 55,
    bannerVariant: 'amber-risk',
    bannerDotColor: 'var(--amber)',
    bannerPillVariant: 'amber',
    bannerMessage:
      '<strong>Medium financing risk detected.</strong> Active equity line at variable pricing. NT 10-Q filing delay disclosed.',
    factors: [
      { name: 'Discount depth',   fillWidth: 45, fillColor: 'var(--amber)', label: 'Med', labelColor: 'var(--amber)' },
      { name: 'Lookback window',  fillWidth: 50, fillColor: 'var(--amber)', label: 'Med', labelColor: 'var(--amber)' },
      { name: 'Warrant coverage', fillWidth: 30, fillColor: 'var(--green)', label: 'Low', labelColor: 'var(--green)' },
      { name: 'Reset provisions', fillWidth: 18, fillColor: 'var(--green)', label: 'Low', labelColor: 'var(--green)' },
      { name: 'Floor price',      fillWidth: 60, fillColor: 'var(--amber)', label: 'Med', labelColor: 'var(--amber)' },
    ],
    drivers: [],
    scoreBasis: 'valid',
    knownFactors: ['discountRate', 'lookbackDays', 'warrantShares', 'floorPrice', 'resetProvisions'],
    unknownFactors: [],
    dataWarnings: [],
  },

  UVWX: {
    ticker: 'UVWX',
    score: 14,
    level: 'low',
    color: 'green',
    barWidth: 14,
    bannerVariant: 'green-risk',
    bannerDotColor: 'var(--green)',
    bannerPillVariant: 'green',
    bannerMessage:
      '<strong>Low financing risk.</strong> No active convertible notes or equity lines detected. Clean balance sheet per latest public filings.',
    factors: [
      { name: 'Discount depth',   fillWidth: 0,  fillColor: 'var(--green)', label: 'Low', labelColor: 'var(--green)' },
      { name: 'Lookback window',  fillWidth: 0,  fillColor: 'var(--green)', label: 'Low', labelColor: 'var(--green)' },
      { name: 'Warrant coverage', fillWidth: 18, fillColor: 'var(--green)', label: 'Low', labelColor: 'var(--green)' },
      { name: 'Reset provisions', fillWidth: 0,  fillColor: 'var(--green)', label: 'Low', labelColor: 'var(--green)' },
      { name: 'Floor price',      fillWidth: 0,  fillColor: 'var(--green)', label: 'Low', labelColor: 'var(--green)' },
    ],
    drivers: [],
    scoreBasis: 'valid',
    knownFactors: ['discountRate', 'lookbackDays', 'warrantShares', 'floorPrice', 'resetProvisions'],
    unknownFactors: [],
    dataWarnings: [],
  },

  GLBX: {
    ticker: 'GLBX',
    score: 87,
    level: 'high',
    color: 'red',
    barWidth: 87,
    bannerVariant: 'red-risk',
    bannerDotColor: 'var(--red)',
    bannerPillVariant: 'red',
    bannerMessage:
      '<strong>High financing risk detected.</strong> Active convertible note at aggressive discount. Preferred share overhang present.',
    factors: [
      { name: 'Discount depth',   fillWidth: 88, fillColor: 'var(--red)',   label: 'High', labelColor: 'var(--red)'   },
      { name: 'Lookback window',  fillWidth: 72, fillColor: 'var(--amber)', label: 'Med',  labelColor: 'var(--amber)' },
      { name: 'Warrant coverage', fillWidth: 85, fillColor: 'var(--red)',   label: 'High', labelColor: 'var(--red)'   },
      { name: 'Reset provisions', fillWidth: 90, fillColor: 'var(--red)',   label: 'High', labelColor: 'var(--red)'   },
      { name: 'Floor price',      fillWidth: 90, fillColor: 'var(--red)',   label: 'High', labelColor: 'var(--red)'   },
    ],
    drivers: [],
    scoreBasis: 'valid',
    knownFactors: ['discountRate', 'lookbackDays', 'warrantShares', 'floorPrice', 'resetProvisions'],
    unknownFactors: [],
    dataWarnings: [],
  },

  NEXM: {
    ticker: 'NEXM',
    score: 51,
    level: 'med',
    color: 'amber',
    barWidth: 51,
    bannerVariant: 'amber-risk',
    bannerDotColor: 'var(--amber)',
    bannerPillVariant: 'amber',
    bannerMessage:
      '<strong>Medium financing risk detected.</strong> Active convertible note with moderate discount. Share count is elevated.',
    factors: [
      { name: 'Discount depth',   fillWidth: 40, fillColor: 'var(--amber)', label: 'Med', labelColor: 'var(--amber)' },
      { name: 'Lookback window',  fillWidth: 55, fillColor: 'var(--amber)', label: 'Med', labelColor: 'var(--amber)' },
      { name: 'Warrant coverage', fillWidth: 35, fillColor: 'var(--green)', label: 'Low', labelColor: 'var(--green)' },
      { name: 'Reset provisions', fillWidth: 55, fillColor: 'var(--amber)', label: 'Med', labelColor: 'var(--amber)' },
      { name: 'Floor price',      fillWidth: 50, fillColor: 'var(--amber)', label: 'Med', labelColor: 'var(--amber)' },
    ],
    drivers: [],
    scoreBasis: 'valid',
    knownFactors: ['discountRate', 'lookbackDays', 'warrantShares', 'floorPrice', 'resetProvisions'],
    unknownFactors: [],
    dataWarnings: [],
  },

};
