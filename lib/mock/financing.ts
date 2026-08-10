/**
 * Mock financing deal, dilution estimate, and warrant records.
 * Simulates three related database tables:
 *   - financing_deals  (active convertible/equity financing terms)
 *   - dilution_estimates (computed dilution exposure at current price)
 *   - warrants (warrants issued in connection with financing deals)
 *
 * Only companies with full intelligence pages have records here.
 * Companies that appear only in the list table (MNOP, QRST, etc.) do not.
 */

import type { FinancingDeal, DilutionEstimate, WarrantRecord } from '../types';

// ─── Financing deals ──────────────────────────────────────────────────────────

export const financingDeals: Record<string, FinancingDeal> = {

  WXYZ: {
    ticker: 'WXYZ',
    type: 'Convertible note',
    tagVariant: 'danger',
    principal: '$1,500,000',
    discount: '22%',
    discountClass: 'danger',
    lookback: '10-day VWAP',
    floorPrice: 'Not stated',
    floorPriceClass: 'warning',
    resetProvisions: 'Present',
    resetClass: 'warning',
    maturityDate: 'February 12, 2027',
    investor: 'Northfield Capital Group LLC',
  },

  EFGH: {
    ticker: 'EFGH',
    type: 'Convertible note (residual)',
    tagVariant: 'warning',
    principal: '$500,000',
    discount: '12%',
    discountClass: 'warning',
    lookback: '5-day VWAP',
    floorPrice: '$0.18',
    floorPriceClass: 'positive',
    resetProvisions: 'None stated',
    resetClass: 'positive',
    maturityDate: 'November 30, 2026',
    investor: 'Silverton Funding Partners LLC',
  },

  ABCD: {
    ticker: 'ABCD',
    type: 'Convertible note',
    tagVariant: 'danger',
    principal: '$2,000,000',
    discount: '20%',
    discountClass: 'danger',
    lookback: '10-day VWAP',
    floorPrice: 'Not stated',
    floorPriceClass: 'warning',
    resetProvisions: 'Present',
    resetClass: 'warning',
    maturityDate: 'March 15, 2027',
    investor: 'Westbridge Capital LLC',
  },

};

// ─── Dilution estimates ───────────────────────────────────────────────────────

export const dilutionEstimates: Record<string, DilutionEstimate> = {

  WXYZ: {
    ticker: 'WXYZ',
    conversionPrice: '$0.0546',
    sharesFromNote: '27,472,527',
    sharesFromNoteClass: 'danger',
    sharesFromWarrants: '12,000,000',
    sharesFromWarrantsClass: 'danger',
    totalNewShares: '39,472,527',
    totalNewSharesClass: 'danger',
    fullyDiluted: '151,472,527',
    dilutionPct: '26.1%',
    dilutionPctClass: 'danger',
    disclaimer:
      'Expressed as new shares / fully diluted total. No floor price — share issuance uncapped on downside. Based on current price and public data.',
  },

  EFGH: {
    ticker: 'EFGH',
    conversionPrice: '$0.2112',
    sharesFromNote: '2,367,424',
    sharesFromNoteClass: '',
    sharesFromWarrants: '3,000,000',
    sharesFromWarrantsClass: '',
    totalNewShares: '5,367,424',
    totalNewSharesClass: '',
    fullyDiluted: '60,367,424',
    dilutionPct: '8.9%',
    dilutionPctClass: 'positive',
    disclaimer:
      'Expressed as new shares / fully diluted total. Floor price of $0.18 limits conversion at current levels. Based on current price and public data.',
  },

  ABCD: {
    ticker: 'ABCD',
    conversionPrice: '$0.1440',
    sharesFromNote: '13,888,889',
    sharesFromNoteClass: 'danger',
    sharesFromWarrants: '8,000,000',
    sharesFromWarrantsClass: 'danger',
    totalNewShares: '21,888,889',
    totalNewSharesClass: 'danger',
    fullyDiluted: '66,888,889',
    dilutionPct: '30.9%',
    dilutionPctClass: 'danger',
    disclaimer:
      'Expressed as new shares / fully diluted total. No floor price — share issuance uncapped on downside. Based on current price and public data.',
  },

};

// ─── Warrant records ──────────────────────────────────────────────────────────

export const warrantRecords: Record<string, WarrantRecord> = {

  WXYZ: {
    ticker: 'WXYZ',
    shares: '12,000,000',
    sharesClass: 'danger',
    exercisePrice: '$0.10',
    expiration: 'February 12, 2028',
    overhangPct: '10.7%',
    overhangPctClass: 'danger',
    issuedWith: '$1.5M convertible note · Feb 2026',
    status: 'Unexercised',
    statusClass: 'warning',
    lastFieldLabel: 'Coverage ratio',
    lastFieldValue: '80% of note principal',
    lastFieldClass: 'warning',
  },

  EFGH: {
    ticker: 'EFGH',
    shares: '3,000,000',
    sharesClass: '',
    exercisePrice: '$0.35',
    expiration: 'November 30, 2027',
    overhangPct: '5.5%',
    overhangPctClass: '',
    issuedWith: '$1.2M convertible note · Nov 2024',
    status: 'Unexercised',
    statusClass: 'muted',
    lastFieldLabel: 'Exercise price vs. market',
    lastFieldValue: '46% above current price',
    lastFieldClass: 'positive',
  },

  ABCD: {
    ticker: 'ABCD',
    shares: '8,000,000',
    sharesClass: 'danger',
    exercisePrice: '$0.22',
    expiration: 'March 15, 2028',
    overhangPct: '17.8%',
    overhangPctClass: 'danger',
    issuedWith: '$2M convertible note · Jan 2026',
    status: 'Unexercised',
    statusClass: 'warning',
    lastFieldLabel: 'Coverage ratio',
    lastFieldValue: '40% of note principal',
    lastFieldClass: 'warning',
  },

};
