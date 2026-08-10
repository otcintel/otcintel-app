/**
 * Mock SEC filing records.
 * Simulates the `filings` database table.
 *
 * Only companies with full intelligence pages have filing records here.
 * In a real app this would include all filings for all tracked companies,
 * with the most recent one surfaced via a query.
 */

import type { FilingRecord } from '../types';

export const filingRecords: Record<string, FilingRecord> = {

  WXYZ: {
    ticker: 'WXYZ',
    type: '8-K',
    date: 'March 18, 2026',
    cik: '0001876543',
    eventType: 'financing',
    eventSummary:
      'The company entered into a $1,500,000 convertible note agreement with Northfield Capital Group LLC, with conversion priced at a 22% discount to the 10-day VWAP and no stated floor price.',
    summary:
      'The company entered into a <strong>$1,500,000 convertible note</strong> with Northfield Capital Group LLC. Conversion is priced at a <strong>22% discount to the 10-day VWAP</strong> with no stated floor and includes anti-dilution reset provisions. The note matures on <strong>February 12, 2027</strong>. Warrants covering <strong>12,000,000 shares</strong> at $0.10 per share were issued alongside and expire February 2028. At the current price of $0.07, the estimated conversion price is <strong>$0.0546</strong>, yielding approximately 27,472,527 conversion shares. Including warrants, total potential new issuance is <strong>39,472,527 shares</strong> — an estimated post-dilution ownership reduction of <strong>26.1%</strong> on a fully diluted basis.',
    terms: [
      { label: 'Principal',        value: '$1,500,000',       className: ''        },
      { label: 'Discount',         value: '22% to VWAP',      className: 'danger'  },
      { label: 'Lookback',         value: '10-day VWAP',      className: 'warning' },
      { label: 'Floor price',      value: 'Not stated',       className: 'warning' },
      { label: 'Warrants',         value: '12,000,000 shares', className: 'danger' },
      { label: 'Maturity',         value: 'February 12, 2027', className: ''       },
      { label: 'Reset provisions', value: 'Present',          className: 'danger'  },
      { label: 'Est. dilution',    value: '26.1%',            className: 'danger'  },
    ],
    tags: [
      'Convertible note', '22% discount', '10-day VWAP',
      'Warrants issued', 'Reset provisions', 'No floor price', 'Est. 26.1% dilution',
    ],
  },

  EFGH: {
    ticker: 'EFGH',
    type: '8-K/A',
    date: 'March 22, 2026',
    cik: '0002134567',
    eventType: 'financing',
    eventSummary:
      'The company filed an amendment modifying the terms of its existing $500,000 convertible note with Silverton Funding Partners LLC, extending maturity to November 30, 2026 and confirming a $0.18 floor price.',
    summary:
      'The company filed an amended 8-K disclosing a modification to the terms of its existing <strong>$500,000 convertible note</strong> with Silverton Funding Partners LLC. The amendment extended the maturity date to <strong>November 30, 2026</strong> and confirmed the <strong>12% discount to the 5-day VWAP</strong> with a floor price of <strong>$0.18</strong>. No new warrants were issued in connection with the amendment. No reset provisions are present. At the current price of $0.24, the estimated conversion price is <strong>$0.2112</strong>, yielding approximately 2,367,424 conversion shares. Including 3,000,000 outstanding warrants from the original issuance, total potential new issuance is <strong>5,367,424 shares</strong> — an estimated post-dilution ownership reduction of <strong>8.9%</strong> on a fully diluted basis.',
    terms: [
      { label: 'Principal',        value: '$500,000',          className: ''         },
      { label: 'Discount',         value: '12% to VWAP',       className: ''         },
      { label: 'Lookback',         value: '5-day VWAP',        className: 'positive' },
      { label: 'Floor price',      value: '$0.18',             className: 'positive' },
      { label: 'Warrants',         value: 'None (amendment)',  className: ''         },
      { label: 'Maturity',         value: 'November 30, 2026', className: ''         },
      { label: 'Reset provisions', value: 'None stated',       className: 'positive' },
      { label: 'Est. dilution',    value: '8.9%',              className: ''         },
    ],
    tags: [
      'Note amendment', '12% discount', '5-day VWAP',
      'Floor price $0.18', 'No reset provisions', 'Maturity extended', 'Est. 8.9% dilution',
    ],
  },

  ABCD: {
    ticker: 'ABCD',
    type: '8-K',
    date: 'April 3, 2026',
    cik: '0001654321',
    eventType: 'financing',
    eventSummary:
      'The company entered into a $2,000,000 convertible note agreement with Westbridge Capital LLC, with conversion priced at a 20% discount to the 10-day VWAP, anti-dilution reset provisions, and no stated floor price.',
    summary:
      'The company entered into a <strong>$2,000,000 convertible note</strong> with Westbridge Capital LLC. Conversion is priced at a <strong>20% discount to the 10-day VWAP</strong> with no stated floor and includes anti-dilution reset provisions. The note matures on <strong>March 15, 2027</strong>. Warrants covering <strong>8,000,000 shares</strong> at $0.22 per share were issued alongside and expire March 2028. At the current price of $0.18, the estimated conversion price is <strong>$0.1440</strong>, yielding approximately 13,888,889 conversion shares. Including warrants, total potential new issuance is <strong>21,888,889 shares</strong> — an estimated post-dilution ownership reduction of <strong>30.9%</strong> on a fully diluted basis.',
    terms: [
      { label: 'Principal',        value: '$2,000,000',        className: ''        },
      { label: 'Discount',         value: '20% to VWAP',       className: 'danger'  },
      { label: 'Lookback',         value: '10-day VWAP',       className: 'warning' },
      { label: 'Floor price',      value: 'Not stated',        className: 'warning' },
      { label: 'Warrants',         value: '8,000,000 shares',  className: 'danger'  },
      { label: 'Maturity',         value: 'March 15, 2027',    className: ''        },
      { label: 'Reset provisions', value: 'Present',           className: 'danger'  },
      { label: 'Est. dilution',    value: '30.9%',             className: 'danger'  },
    ],
    tags: [
      'Convertible note', '20% discount', '10-day VWAP',
      'Warrants issued', 'Reset provisions', 'No floor price', 'Est. 30.9% dilution',
    ],
  },

};
