export type RiskLevel = 'high' | 'med' | 'low';
export type RiskColor = 'red' | 'amber' | 'green';

export interface RiskFactor {
  name: string;
  fillWidth: number;
  fillColor: string;
  label: string;
  labelColor: string;
}

export interface RiskDriver {
  dotColor: string;
  text: string;
}

export interface FilingTerm {
  label: string;
  value: string;
  className: string;
}

export interface CompanyData {
  ticker: string;
  name: string;
  market: string;
  sector: string;
  price: number;
  priceChangeAmt: number;
  priceChangePct: number;
  priceDirection: 'up' | 'down';
  marketCap: string;
  sharesOutstanding: number;
  floatShares: number;
  riskScore: number;
  riskLevel: RiskLevel;
  riskScoreColor: RiskColor;
  financingType: string;
  financingTypeCategory: 'convertible' | 'equity' | 'none';
  // Share structure
  authorizedShares: number;
  preferredShares: number;
  reservedShares: number;
  sharesRemaining: number;
  issuedBarPct: number;
  reservedBarPct: number;
  issuedBarColor: string;
  reservedBarColor: string;
  // Banner
  bannerVariant: 'red-risk' | 'amber-risk' | 'green-risk';
  bannerDotColor: string;
  bannerPillVariant: 'red' | 'amber' | 'green';
  bannerMessage: string;
  // Active financing
  financing: {
    type: string;
    tagVariant: 'danger' | 'warning' | 'positive' | 'neutral';
    principal: string;
    discount: string;
    discountClass: string;
    lookback: string;
    floorPrice: string;
    floorPriceClass: string;
    resetProvisions: string;
    resetClass: string;
    maturityDate: string;
    investor: string;
  };
  // Dilution
  dilution: {
    conversionPrice: string;
    sharesFromNote: string;
    sharesFromNoteClass: string;
    sharesFromWarrants: string;
    sharesFromWarrantsClass: string;
    totalNewShares: string;
    totalNewSharesClass: string;
    fullyDiluted: string;
    dilutionPct: string;
    dilutionPctClass: string;
    disclaimer: string;
  };
  // Warrants
  warrants: {
    shares: string;
    sharesClass: string;
    exercisePrice: string;
    expiration: string;
    overhangPct: string;
    overhangPctClass: string;
    issuedWith: string;
    status: string;
    statusClass: string;
    lastFieldLabel: string;
    lastFieldValue: string;
    lastFieldClass: string;
  };
  // Risk score breakdown
  riskBarWidth: number;
  riskFactors: RiskFactor[];
  riskDrivers: RiskDriver[];
  // Filing
  filing: {
    type: string;
    date: string;
    cik: string;
    summary: string;
    terms: FilingTerm[];
    tags: string[];
  };
}

export const companies: Record<string, CompanyData> = {
  WXYZ: {
    ticker: 'WXYZ',
    name: 'Westyx Industries Inc.',
    market: 'OTC Markets · Common Stock · Pink Sheets · Industrials',
    sector: 'Industrials',
    price: 0.07,
    priceChangeAmt: -0.007,
    priceChangePct: -9.1,
    priceDirection: 'down',
    marketCap: '$7.8M',
    sharesOutstanding: 112_000_000,
    floatShares: 88_000_000,
    riskScore: 87,
    riskLevel: 'high',
    riskScoreColor: 'red',
    financingType: 'Convertible Note',
    financingTypeCategory: 'convertible',
    authorizedShares: 1_000_000_000,
    preferredShares: 8_000_000,
    reservedShares: 39_472_527,
    sharesRemaining: 848_527_473,
    issuedBarPct: 11.2,
    reservedBarPct: 3.9,
    issuedBarColor: '#4E8C6E',
    reservedBarColor: '#E24B4A',
    bannerVariant: 'red-risk',
    bannerDotColor: 'var(--red)',
    bannerPillVariant: 'red',
    bannerMessage: '<strong>High financing risk detected.</strong> Active $1.5M convertible note at 22% discount to 10-day VWAP. No floor price. Estimated dilution: 26.1% fully diluted.',
    financing: {
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
    dilution: {
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
      disclaimer: 'Expressed as new shares / fully diluted total. No floor price — share issuance uncapped on downside. Based on current price and public data.',
    },
    warrants: {
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
    riskBarWidth: 87,
    riskFactors: [
      { name: 'Discount depth', fillWidth: 90, fillColor: 'var(--red)', label: 'High', labelColor: 'var(--red)' },
      { name: 'Lookback window', fillWidth: 72, fillColor: 'var(--amber)', label: 'Med', labelColor: 'var(--amber)' },
      { name: 'Warrant coverage', fillWidth: 82, fillColor: 'var(--red)', label: 'High', labelColor: 'var(--red)' },
      { name: 'Reset provisions', fillWidth: 90, fillColor: 'var(--red)', label: 'High', labelColor: 'var(--red)' },
      { name: 'Floor price', fillWidth: 90, fillColor: 'var(--red)', label: 'High', labelColor: 'var(--red)' },
    ],
    riskDrivers: [
      { dotColor: 'var(--red)', text: '<strong>22% discount to VWAP</strong> significantly exceeds the 15% elevated risk threshold. No floor price means conversion shares are uncapped as stock price declines.' },
      { dotColor: 'var(--red)', text: '<strong>Reset provisions present.</strong> Anti-dilution clauses allow the conversion price to step down if the stock trades below prior conversion levels, compounding dilution over time.' },
      { dotColor: 'var(--red)', text: '<strong>12,000,000 warrants outstanding</strong> at $0.10 per share — near current market price — represent a 10.7% overhang with elevated near-term exercise risk.' },
      { dotColor: 'var(--amber)', text: '<strong>10-day VWAP lookback</strong> exceeds the 5-day benchmark, increasing downside sensitivity and lowering the effective conversion price in a sustained price decline.' },
      { dotColor: 'var(--red)', text: '<strong>No floor price stated.</strong> Absent a contractual minimum, share issuance from the note escalates without limit as stock price declines.' },
    ],
    filing: {
      type: '8-K',
      date: 'March 18, 2026',
      cik: '0001876543',
      summary: 'The company entered into a <strong>$1,500,000 convertible note</strong> with Northfield Capital Group LLC. Conversion is priced at a <strong>22% discount to the 10-day VWAP</strong> with no stated floor and includes anti-dilution reset provisions. The note matures on <strong>February 12, 2027</strong>. Warrants covering <strong>12,000,000 shares</strong> at $0.10 per share were issued alongside and expire February 2028. At the current price of $0.07, the estimated conversion price is <strong>$0.0546</strong>, yielding approximately 27,472,527 conversion shares. Including warrants, total potential new issuance is <strong>39,472,527 shares</strong> — an estimated post-dilution ownership reduction of <strong>26.1%</strong> on a fully diluted basis.',
      terms: [
        { label: 'Principal', value: '$1,500,000', className: '' },
        { label: 'Discount', value: '22% to VWAP', className: 'danger' },
        { label: 'Lookback', value: '10-day VWAP', className: 'warning' },
        { label: 'Floor price', value: 'Not stated', className: 'warning' },
        { label: 'Warrants', value: '12,000,000 shares', className: 'danger' },
        { label: 'Maturity', value: 'February 12, 2027', className: '' },
        { label: 'Reset provisions', value: 'Present', className: 'danger' },
        { label: 'Est. dilution', value: '26.1%', className: 'danger' },
      ],
      tags: ['Convertible note', '22% discount', '10-day VWAP', 'Warrants issued', 'Reset provisions', 'No floor price', 'Est. 26.1% dilution'],
    },
  },

  EFGH: {
    ticker: 'EFGH',
    name: 'EFG Holdings Group',
    market: 'OTC Markets · Common Stock · Pink Sheets · Financial Services',
    sector: 'Financial Services',
    price: 0.24,
    priceChangeAmt: 0.010,
    priceChangePct: 4.3,
    priceDirection: 'up',
    marketCap: '$13.2M',
    sharesOutstanding: 55_000_000,
    floatShares: 44_000_000,
    riskScore: 42,
    riskLevel: 'med',
    riskScoreColor: 'amber',
    financingType: 'Convertible Note',
    financingTypeCategory: 'convertible',
    authorizedShares: 500_000_000,
    preferredShares: 3_000_000,
    reservedShares: 5_367_424,
    sharesRemaining: 439_632_576,
    issuedBarPct: 11.0,
    reservedBarPct: 1.1,
    issuedBarColor: '#4E8C6E',
    reservedBarColor: '#EF9F27',
    bannerVariant: 'amber-risk',
    bannerDotColor: 'var(--amber)',
    bannerPillVariant: 'amber',
    bannerMessage: '<strong>Medium financing risk detected.</strong> Residual $500K convertible note at 12% discount to 5-day VWAP. Floor price: $0.18. Estimated dilution: 8.9% fully diluted.',
    financing: {
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
    dilution: {
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
      disclaimer: 'Expressed as new shares / fully diluted total. Floor price of $0.18 limits conversion at current levels. Based on current price and public data.',
    },
    warrants: {
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
    riskBarWidth: 42,
    riskFactors: [
      { name: 'Discount depth', fillWidth: 18, fillColor: 'var(--green)', label: 'Low', labelColor: 'var(--green)' },
      { name: 'Lookback window', fillWidth: 18, fillColor: 'var(--green)', label: 'Low', labelColor: 'var(--green)' },
      { name: 'Warrant coverage', fillWidth: 55, fillColor: 'var(--amber)', label: 'Med', labelColor: 'var(--amber)' },
      { name: 'Reset provisions', fillWidth: 18, fillColor: 'var(--green)', label: 'Low', labelColor: 'var(--green)' },
      { name: 'Floor price', fillWidth: 18, fillColor: 'var(--green)', label: 'Low', labelColor: 'var(--green)' },
    ],
    riskDrivers: [
      { dotColor: 'var(--green)', text: '<strong>12% discount to VWAP</strong> is below the 15% elevated risk threshold. Conversion pricing is moderate relative to typical OTC structures and is further bounded by the stated floor.' },
      { dotColor: 'var(--green)', text: '<strong>5-day VWAP lookback</strong> is the tightest window commonly used in OTC convertible structures, reducing downside sensitivity and limiting the impact of short-term price volatility.' },
      { dotColor: 'var(--amber)', text: '<strong>3,000,000 warrants outstanding</strong> at $0.35 per share represent a 5.5% overhang. The exercise price is 46% above current market, meaningfully limiting near-term exercise probability.' },
      { dotColor: 'var(--green)', text: '<strong>No reset provisions.</strong> The absence of anti-dilution reset clauses fixes the conversion price, capping share issuance at current terms regardless of future price movement.' },
      { dotColor: 'var(--green)', text: '<strong>Floor price of $0.18 stated.</strong> A contractual conversion minimum limits share issuance from the note to approximately 2,367,424 shares regardless of how far the stock declines below $0.18.' },
    ],
    filing: {
      type: '8-K/A',
      date: 'March 22, 2026',
      cik: '0002134567',
      summary: 'The company filed an amended 8-K disclosing a modification to the terms of its existing <strong>$500,000 convertible note</strong> with Silverton Funding Partners LLC. The amendment extended the maturity date to <strong>November 30, 2026</strong> and confirmed the <strong>12% discount to the 5-day VWAP</strong> with a floor price of <strong>$0.18</strong>. No new warrants were issued in connection with the amendment. No reset provisions are present. At the current price of $0.24, the estimated conversion price is <strong>$0.2112</strong>, yielding approximately 2,367,424 conversion shares. Including 3,000,000 outstanding warrants from the original issuance, total potential new issuance is <strong>5,367,424 shares</strong> — an estimated post-dilution ownership reduction of <strong>8.9%</strong> on a fully diluted basis.',
      terms: [
        { label: 'Principal', value: '$500,000', className: '' },
        { label: 'Discount', value: '12% to VWAP', className: '' },
        { label: 'Lookback', value: '5-day VWAP', className: 'positive' },
        { label: 'Floor price', value: '$0.18', className: 'positive' },
        { label: 'Warrants', value: 'None (amendment)', className: '' },
        { label: 'Maturity', value: 'November 30, 2026', className: '' },
        { label: 'Reset provisions', value: 'None stated', className: 'positive' },
        { label: 'Est. dilution', value: '8.9%', className: '' },
      ],
      tags: ['Note amendment', '12% discount', '5-day VWAP', 'Floor price $0.18', 'No reset provisions', 'Maturity extended', 'Est. 8.9% dilution'],
    },
  },

  ABCD: {
    ticker: 'ABCD',
    name: 'Alpha Bio Corp.',
    market: 'OTC Markets · Common Stock · Pink Sheets · Biotechnology',
    sector: 'Biotechnology',
    price: 0.18,
    priceChangeAmt: -0.025,
    priceChangePct: -12.3,
    priceDirection: 'down',
    marketCap: '$8.1M',
    sharesOutstanding: 45_000_000,
    floatShares: 38_200_000,
    riskScore: 83,
    riskLevel: 'high',
    riskScoreColor: 'red',
    financingType: 'Convertible Note',
    financingTypeCategory: 'convertible',
    authorizedShares: 500_000_000,
    preferredShares: 5_000_000,
    reservedShares: 21_888_889,
    sharesRemaining: 433_111_111,
    issuedBarPct: 9.0,
    reservedBarPct: 4.4,
    issuedBarColor: '#4E8C6E',
    reservedBarColor: '#E24B4A',
    bannerVariant: 'red-risk',
    bannerDotColor: 'var(--red)',
    bannerPillVariant: 'red',
    bannerMessage: '<strong>High financing risk detected.</strong> Active $2M convertible note at 20% discount to 10-day VWAP. No floor price stated. Estimated dilution: 30.9% fully diluted.',
    financing: {
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
    dilution: {
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
      disclaimer: 'Expressed as new shares / fully diluted total. No floor price — share issuance uncapped on downside. Based on current price and public data.',
    },
    warrants: {
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
    riskBarWidth: 83,
    riskFactors: [
      { name: 'Discount depth', fillWidth: 85, fillColor: 'var(--red)', label: 'High', labelColor: 'var(--red)' },
      { name: 'Lookback window', fillWidth: 72, fillColor: 'var(--amber)', label: 'Med', labelColor: 'var(--amber)' },
      { name: 'Warrant coverage', fillWidth: 78, fillColor: 'var(--red)', label: 'High', labelColor: 'var(--red)' },
      { name: 'Reset provisions', fillWidth: 90, fillColor: 'var(--red)', label: 'High', labelColor: 'var(--red)' },
      { name: 'Floor price', fillWidth: 90, fillColor: 'var(--red)', label: 'High', labelColor: 'var(--red)' },
    ],
    riskDrivers: [
      { dotColor: 'var(--red)', text: '<strong>20% discount to VWAP</strong> significantly exceeds the 15% elevated risk threshold. No floor price means conversion shares are uncapped as the stock price declines.' },
      { dotColor: 'var(--red)', text: '<strong>Reset provisions present.</strong> Anti-dilution clauses allow the conversion price to step down if the stock trades below prior conversion levels, compounding dilution over time.' },
      { dotColor: 'var(--red)', text: '<strong>8,000,000 warrants outstanding</strong> at $0.22 per share represent a 17.8% overhang. Exercise price is near current market, creating elevated near-term exercise risk.' },
      { dotColor: 'var(--amber)', text: '<strong>10-day VWAP lookback</strong> exceeds the 5-day benchmark, increasing downside sensitivity and lowering the effective conversion price in a sustained price decline.' },
      { dotColor: 'var(--red)', text: '<strong>No floor price stated.</strong> Absent a contractual minimum, share issuance from the note escalates without limit as stock price declines.' },
    ],
    filing: {
      type: '8-K',
      date: 'April 3, 2026',
      cik: '0001654321',
      summary: 'The company entered into a <strong>$2,000,000 convertible note</strong> with Westbridge Capital LLC. Conversion is priced at a <strong>20% discount to the 10-day VWAP</strong> with no stated floor and includes anti-dilution reset provisions. The note matures on <strong>March 15, 2027</strong>. Warrants covering <strong>8,000,000 shares</strong> at $0.22 per share were issued alongside and expire March 2028. At the current price of $0.18, the estimated conversion price is <strong>$0.1440</strong>, yielding approximately 13,888,889 conversion shares. Including warrants, total potential new issuance is <strong>21,888,889 shares</strong> — an estimated post-dilution ownership reduction of <strong>30.9%</strong> on a fully diluted basis.',
      terms: [
        { label: 'Principal', value: '$2,000,000', className: '' },
        { label: 'Discount', value: '20% to VWAP', className: 'danger' },
        { label: 'Lookback', value: '10-day VWAP', className: 'warning' },
        { label: 'Floor price', value: 'Not stated', className: 'warning' },
        { label: 'Warrants', value: '8,000,000 shares', className: 'danger' },
        { label: 'Maturity', value: 'March 15, 2027', className: '' },
        { label: 'Reset provisions', value: 'Present', className: 'danger' },
        { label: 'Est. dilution', value: '30.9%', className: 'danger' },
      ],
      tags: ['Convertible note', '20% discount', '10-day VWAP', 'Warrants issued', 'Reset provisions', 'No floor price', 'Est. 30.9% dilution'],
    },
  },
};

export const companiesList = [
  {
    ticker: 'ABCD',
    name: 'Alpha Bio Corp.',
    sub: 'OTC · Pink Sheets',
    price: '$0.1800',
    priceChange: '▼ -12.3%',
    priceChangeDir: 'down',
    marketCap: '$8.1M',
    riskScore: 83,
    riskColor: 'var(--red)',
    riskClass: 'high',
    riskFillWidth: '83%',
    financingType: 'Convertible note',
    riskFilter: 'high',
    typeFilter: 'convertible',
  },
  {
    ticker: 'WXYZ',
    name: 'Westyx Industries Inc.',
    sub: 'OTC · Pink Sheets',
    price: '$0.0700',
    priceChange: '▼ -9.1%',
    priceChangeDir: 'down',
    marketCap: '$7.8M',
    riskScore: 87,
    riskColor: 'var(--red)',
    riskClass: 'high',
    riskFillWidth: '87%',
    financingType: 'Convertible Note',
    riskFilter: 'high',
    typeFilter: 'convertible',
  },
  {
    ticker: 'EFGH',
    name: 'EFG Holdings Group',
    sub: 'OTC · Expert Market',
    price: '$0.2400',
    priceChange: '▲ +4.3%',
    priceChangeDir: 'up',
    marketCap: '$13.2M',
    riskScore: 42,
    riskColor: 'var(--amber)',
    riskClass: 'med',
    riskFillWidth: '42%',
    financingType: 'Convertible note',
    riskFilter: 'med',
    typeFilter: 'convertible',
  },
  {
    ticker: 'MNOP',
    name: 'Monarch Pharma Inc.',
    sub: 'OTC · Pink Sheets',
    price: '$0.4100',
    priceChange: '▲ +3.2%',
    priceChangeDir: 'up',
    marketCap: '$15.6M',
    riskScore: 91,
    riskColor: 'var(--red)',
    riskClass: 'high',
    riskFillWidth: '91%',
    financingType: 'Convertible Note',
    riskFilter: 'high',
    typeFilter: 'convertible',
  },
  {
    ticker: 'QRST',
    name: 'Quantum Resource Tech.',
    sub: 'OTC · Pink Sheets',
    price: '$0.1900',
    priceChange: '▼ -2.8%',
    priceChangeDir: 'down',
    marketCap: '$14.1M',
    riskScore: 55,
    riskColor: 'var(--amber)',
    riskClass: 'med',
    riskFillWidth: '55%',
    financingType: 'Equity Line',
    riskFilter: 'med',
    typeFilter: 'equity',
  },
  {
    ticker: 'UVWX',
    name: 'United Ventures Exchange',
    sub: 'OTC · Pink Sheets',
    price: '$1.8500',
    priceChange: '▲ +3.4%',
    priceChangeDir: 'up',
    marketCap: '$40.7M',
    riskScore: 14,
    riskColor: 'var(--green)',
    riskClass: 'low',
    riskFillWidth: '14%',
    financingType: 'None Active',
    riskFilter: 'low',
    typeFilter: 'none',
  },
  {
    ticker: 'GLBX',
    name: 'Global Biotech Labs',
    sub: 'OTC · Pink Sheets',
    price: '$0.0400',
    priceChange: '▼ -9.1%',
    priceChangeDir: 'down',
    marketCap: '$2.2M',
    riskScore: 87,
    riskColor: 'var(--red)',
    riskClass: 'high',
    riskFillWidth: '87%',
    financingType: 'Convertible note',
    riskFilter: 'high',
    typeFilter: 'convertible',
  },
  {
    ticker: 'NEXM',
    name: 'Nexum Mining Corp.',
    sub: 'OTC · Pink Sheets',
    price: '$0.0030',
    priceChange: '▲ +1.4%',
    priceChangeDir: 'up',
    marketCap: '$11.3M',
    riskScore: 51,
    riskColor: 'var(--amber)',
    riskClass: 'med',
    riskFillWidth: '51%',
    financingType: 'Convertible note',
    riskFilter: 'med',
    typeFilter: 'convertible',
  },
];
