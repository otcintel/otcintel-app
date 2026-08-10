import Link from 'next/link';
import Nav from '@/components/Nav';
import Footer from '@/components/Footer';
import { getCompanyRecord, getCompanyFilings } from '@/lib/server-data';
import { scoreFinancingRisk, generateCompanyIntelligence } from '@/lib/ingestion';
import type { NormalizedFiling, OtcShareStructure, ExtractionConfidence } from '@/lib/ingestion';

/** Banner variant → CSS class mapping for intelligence-derived dilution risk levels. */
const DILUTION_RISK_BANNER: Record<string, { variant: string; dotColor: string; label: string }> = {
  severe:   { variant: 'red-risk',   dotColor: 'var(--red)',   label: 'Severe Dilution Risk' },
  high:     { variant: 'red-risk',   dotColor: 'var(--red)',   label: 'High Dilution Risk' },
  moderate: { variant: 'amber-risk', dotColor: 'var(--amber)', label: 'Moderate Dilution Risk' },
  low:      { variant: 'green-risk', dotColor: 'var(--green)', label: 'Low Dilution Risk' },
};

/** Display labels for financing types returned by the parser. */
const FINANCING_TYPE_LABELS: Record<string, string> = {
  convertible_note: 'Convertible Note',
  equity_line:      'Equity Line of Credit',
  preferred_stock:  'Preferred Stock',
  warrant_only:     'Warrants Only',
  unknown:          'Unknown',
};

/** Human-readable labels for event type badges. */
const EVENT_TYPE_LABELS: Record<string, string> = {
  financing:          'Financing',
  partnership:        'Partnership',
  product_launch:     'Product',
  management_change:  'Management',
  operational_update: 'Operational',
  other:              'Other',
};

/** Background / foreground color pairs per event type. */
const EVENT_TYPE_COLORS: Record<string, { bg: string; fg: string }> = {
  financing:          { bg: 'rgba(220,38,38,0.13)',   fg: '#f87171' },
  partnership:        { bg: 'rgba(59,130,246,0.13)',  fg: '#60a5fa' },
  product_launch:     { bg: 'rgba(34,197,94,0.13)',   fg: '#4ade80' },
  management_change:  { bg: 'rgba(167,139,250,0.13)', fg: '#a78bfa' },
  operational_update: { bg: 'rgba(251,146,60,0.13)',  fg: '#fb923c' },
  other:              { bg: 'rgba(156,163,175,0.10)', fg: '#9ca3af' },
};

// ─── Share structure aggregation ──────────────────────────────────────────────

const STRUCTURE_FORM_PRIORITY: Record<string, number> = {
  '10-K': 1, '10-K/A': 1,
  '10-Q': 2, '10-Q/A': 2,
  'S-1':  3, 'S-1/A':  3,
  'S-3':  4, 'S-3/A':  4,
  '8-K':  5, '8-K/A':  5,
};

const CONFIDENCE_RANK: Record<string, number> = { high: 1, medium: 2, low: 3 };

interface StructureField {
  value:  number;
  source: string;
}

interface AggregatedStructure {
  sharesAuthorized?:           StructureField;
  sharesOutstanding?:          StructureField;
  sharesFloat?:                StructureField;
  preferredSharesOutstanding?: StructureField;
  worstConfidence: ExtractionConfidence;
  fieldCount: number;
}

function aggregateShareStructure(filings: NormalizedFiling[]): AggregatedStructure | undefined {
  const candidates = filings
    .filter(f => f.shareStructure)
    .sort((a, b) => {
      const pa = STRUCTURE_FORM_PRIORITY[a.formType] ?? 9;
      const pb = STRUCTURE_FORM_PRIORITY[b.formType] ?? 9;
      if (pa !== pb) return pa - pb;
      return b.filedAt.localeCompare(a.filedAt);
    });

  if (candidates.length === 0) return undefined;

  let sharesAuthorized:           StructureField | undefined;
  let sharesOutstanding:          StructureField | undefined;
  let sharesFloat:                StructureField | undefined;
  let preferredSharesOutstanding: StructureField | undefined;
  let worstConfidence: ExtractionConfidence = 'high';

  for (const filing of candidates) {
    const s   = filing.shareStructure!;
    const src = `${filing.formType} · ${filing.filedAt}`;
    if (s.sharesAuthorized   !== undefined && s.sharesAuthorized   !== null && !sharesAuthorized)
      sharesAuthorized   = { value: s.sharesAuthorized,   source: src };
    if (s.sharesOutstanding  !== undefined && s.sharesOutstanding  !== null && !sharesOutstanding)
      sharesOutstanding  = { value: s.sharesOutstanding,  source: src };
    if (s.sharesFloat        !== undefined && s.sharesFloat        !== null && !sharesFloat)
      sharesFloat        = { value: s.sharesFloat,        source: src };
    if (s.preferredSharesOutstanding !== undefined && s.preferredSharesOutstanding !== null && !preferredSharesOutstanding)
      preferredSharesOutstanding = { value: s.preferredSharesOutstanding, source: src };
    if (CONFIDENCE_RANK[s.confidence] > CONFIDENCE_RANK[worstConfidence])
      worstConfidence = s.confidence;
  }

  const fieldCount = [sharesAuthorized, sharesOutstanding, sharesFloat, preferredSharesOutstanding]
    .filter(Boolean).length;
  if (fieldCount === 0) return undefined;

  return { sharesAuthorized, sharesOutstanding, sharesFloat, preferredSharesOutstanding, worstConfidence, fieldCount };
}

function selectBestFinancingFiling(filings: NormalizedFiling[]): NormalizedFiling | undefined {
  const specific   = filings.filter(f => f.financing && f.financing.financingType !== 'unknown');
  const candidates = specific.length > 0 ? specific : filings.filter(f => f.financing);
  if (candidates.length === 0) return undefined;
  return [...candidates].sort((a, b) => {
    const ca = CONFIDENCE_RANK[a.financing!.confidence] ?? 9;
    const cb = CONFIDENCE_RANK[b.financing!.confidence] ?? 9;
    if (ca !== cb) return ca - cb;
    return b.filedAt.localeCompare(a.filedAt);
  })[0];
}

function selectBestStructureFiling(filings: NormalizedFiling[]): NormalizedFiling | undefined {
  const candidates = filings.filter(f => f.shareStructure);
  if (candidates.length === 0) return undefined;
  return [...candidates].sort((a, b) => {
    const pa = STRUCTURE_FORM_PRIORITY[a.formType] ?? 9;
    const pb = STRUCTURE_FORM_PRIORITY[b.formType] ?? 9;
    if (pa !== pb) return pa - pb;
    return b.filedAt.localeCompare(a.filedAt);
  })[0];
}

// ─── SEC EDGAR URL helper ─────────────────────────────────────────────────────

/**
 * Construct a deterministic SEC EDGAR filing index URL from stored fields.
 * Format: https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={cik}&type={formType}
 * Accession-level: https://www.sec.gov/Archives/edgar/data/{cik_numeric}/{acc_no_dashes}/
 */
function edgarFilingIndexUrl(cik: string, accessionNumber: string): string {
  const cikNumeric  = cik.replace(/^0+/, '');
  const accNoDashes = accessionNumber.replace(/-/g, '');
  return `https://www.sec.gov/Archives/edgar/data/${cikNumeric}/${accNoDashes}/`;
}

// ─── Metadata ─────────────────────────────────────────────────────────────────

export async function generateMetadata({ params }: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await params;
  const symbol     = ticker.toUpperCase();
  const record     = await getCompanyRecord(symbol);
  if (record) return { title: `${symbol} · ${record.companyName} — OTCIntel` };
  return { title: `${symbol} — OTCIntel` };
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function CompanyPage({ params }: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await params;
  const symbol     = ticker.toUpperCase();

  const [record, filings] = await Promise.all([
    getCompanyRecord(symbol),
    getCompanyFilings(symbol),
  ]);

  // ── Unknown ticker — not in the ingested universe ───────────────────────────
  if (!record && filings.length === 0) {
    return (
      <>
        <Nav />
        <div className="page">
          <div className="breadcrumb">
            <Link href="/companies">Companies</Link>
            <span className="breadcrumb-sep">/</span>
            <span>{symbol}</span>
          </div>
          <div style={{ padding: '4rem 0', textAlign: 'center' }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: '0.72rem', letterSpacing: '0.1em', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '1rem' }}>
              Company not found
            </div>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-dim)', marginBottom: '1.5rem', maxWidth: '420px', margin: '0 auto 1.5rem' }}>
              <strong style={{ color: 'var(--white)' }}>{symbol}</strong> is not in the OTCIntel ingested universe.
              Companies are added through the admin ingestion pipeline.
            </p>
            <Link href="/companies" style={{ fontFamily: 'var(--mono)', fontSize: '0.75rem', color: 'var(--accent)', textDecoration: 'none' }}>
              ← Back to Companies
            </Link>
          </div>
        </div>
      </>
    );
  }

  // ── Known company, pending ingestion (record exists but no filings yet) ─────
  if (record && filings.length === 0) {
    return (
      <>
        <Nav />
        <div className="page">
          <div className="breadcrumb">
            <Link href="/companies">Companies</Link>
            <span className="breadcrumb-sep">/</span>
            <span>{symbol}</span>
          </div>
          <div className="company-header">
            <div className="company-header-left">
              <div className="ticker-badge">{symbol}</div>
              <div>
                <div className="company-ticker">{symbol}</div>
                <div className="company-fullname">{record.companyName}</div>
                <div className="company-market">CIK {record.cik} · SEC EDGAR</div>
              </div>
            </div>
          </div>
          <div style={{ padding: '3rem 0', textAlign: 'center' }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: '0.72rem', letterSpacing: '0.1em', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '1rem' }}>
              Pending ingestion
            </div>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-dim)', maxWidth: '420px', margin: '0 auto 1.5rem' }}>
              {record.companyName} is registered but no filings have been ingested yet.
              Run the ingestion pipeline to populate this company.
            </p>
            <Link href="/companies" style={{ fontFamily: 'var(--mono)', fontSize: '0.75rem', color: 'var(--accent)', textDecoration: 'none' }}>
              ← Back to Companies
            </Link>
          </div>
        </div>
      </>
    );
  }

  // ── Full intelligence page ────────────────────────────────────────────────

  const companyName = record?.companyName ?? symbol;
  const cik         = record?.cik ?? filings[0]?.cik ?? '';

  const financingFiling        = selectBestFinancingFiling(filings);
  const activeFinancing        = financingFiling?.financing;
  const activeFinancingSource  = financingFiling
    ? `${financingFiling.formType} · ${financingFiling.filedAt}`
    : undefined;
  const structureFiling        = selectBestStructureFiling(filings);
  const activeStructure        = structureFiling?.shareStructure;
  const aggregatedStructure    = aggregateShareStructure(filings);
  const otcStructureFiling     = !aggregatedStructure ? filings.find(f => f.otcShareStructure) : undefined;
  const activeOtcStructure: OtcShareStructure | undefined = otcStructureFiling?.otcShareStructure;
  const riskScore              = scoreFinancingRisk(symbol, activeFinancing, activeStructure);
  const intelligence           = generateCompanyIntelligence(symbol, filings);

  return (
    <>
      <Nav />
      <div className="page">

        {/* BREADCRUMB */}
        <div className="breadcrumb">
          <Link href="/companies">Companies</Link>
          <span className="breadcrumb-sep">/</span>
          <span>{symbol}</span>
          <span className="breadcrumb-sep">/</span>
          <span>Filing intelligence</span>
        </div>

        {/* COMPANY HEADER */}
        <div className="company-header">
          <div className="company-header-left">
            <div className="ticker-badge">{symbol}</div>
            <div>
              <div className="company-ticker">{symbol}</div>
              <div className="company-fullname">{companyName}</div>
              {cik && (
                <div className="company-market">
                  CIK {cik} &nbsp;·&nbsp; SEC EDGAR
                  {record?.confidenceStatus && (
                    <> &nbsp;·&nbsp; {record.confidenceStatus.replace(/_/g, ' ')}</>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* RISK BANNER */}
        {riskScore ? (
          <div className={`risk-banner ${riskScore.bannerVariant}`}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <div className="risk-dot" style={{ background: riskScore.bannerDotColor }} />
              <div className="risk-banner-text" dangerouslySetInnerHTML={{ __html: riskScore.bannerMessage }} />
            </div>
            <div className={`risk-score-pill ${riskScore.bannerPillVariant}`}>
              Risk Score: {riskScore.score} / 100
            </div>
          </div>
        ) : (() => {
          const dr = intelligence.overview.dilutionRisk;
          const b  = DILUTION_RISK_BANNER[dr] ?? DILUTION_RISK_BANNER.moderate;
          return (
            <div className={`risk-banner ${b.variant}`}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <div className="risk-dot" style={{ background: b.dotColor }} />
                <div className="risk-banner-text">
                  <strong>{b.label}.</strong>{' '}
                  {intelligence.overview.financingProfile}
                  {intelligence.financingProfile.extractionWarningCount > 0 && (
                    <> · {intelligence.financingProfile.extractionWarningCount} extraction warning{intelligence.financingProfile.extractionWarningCount > 1 ? 's' : ''} in the analyzed filings — some data may be incomplete.</>
                  )}
                </div>
              </div>
            </div>
          );
        })()}

        {/* CAPITAL STRUCTURE */}
        <div className="section-divider" style={{ marginTop: 0 }}>
          <span className="section-divider-label">Capital structure</span>
          <div className="section-divider-line" />
        </div>

        <div className="two-col" style={{ marginBottom: '1.5rem' }}>

          {/* Share structure */}
          <div className="card">
            <div className="card-head">
              <span className="card-title">Share structure</span>
              <span className="tag neutral">
                {aggregatedStructure ? 'SEC Filing' : activeOtcStructure ? 'OTC Markets' : 'No data'}
              </span>
            </div>
            {aggregatedStructure ? (
              <div className="card-body">
                {aggregatedStructure.sharesAuthorized && (
                  <div className="data-row">
                    <span className="data-label">Authorized shares</span>
                    <span className="data-val">{aggregatedStructure.sharesAuthorized.value.toLocaleString()}</span>
                  </div>
                )}
                {aggregatedStructure.sharesOutstanding && (
                  <div className="data-row">
                    <span className="data-label">Shares outstanding</span>
                    <span className="data-val">{aggregatedStructure.sharesOutstanding.value.toLocaleString()}</span>
                  </div>
                )}
                {aggregatedStructure.sharesFloat && (
                  <div className="data-row">
                    <span className="data-label">Float</span>
                    <span className="data-val">{aggregatedStructure.sharesFloat.value.toLocaleString()}</span>
                  </div>
                )}
                {aggregatedStructure.preferredSharesOutstanding && (
                  <div className="data-row">
                    <span className="data-label">Preferred outstanding</span>
                    <span className="data-val warning">{aggregatedStructure.preferredSharesOutstanding.value.toLocaleString()}</span>
                  </div>
                )}
                {(aggregatedStructure.worstConfidence === 'low' || aggregatedStructure.fieldCount < 2) && (
                  <div className="data-row" style={{ borderBottom: 'none', paddingBottom: 0 }}>
                    <span style={{ fontSize: '0.72rem', color: 'var(--amber)', fontFamily: 'var(--mono)', letterSpacing: '0.04em' }}>
                      ⚠ Partial data — not all fields were reported in the available filings
                    </span>
                  </div>
                )}
                <div className="data-row" style={{ borderBottom: 'none', paddingTop: '0.5rem' }}>
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                    Source: SEC Filing &nbsp;·&nbsp; Confidence: {aggregatedStructure.worstConfidence}
                  </span>
                </div>
              </div>
            ) : activeOtcStructure ? (
              <div className="card-body">
                {activeOtcStructure.authorizedShares !== undefined && (
                  <div className="data-row">
                    <span className="data-label">Authorized shares</span>
                    <span className="data-val">{activeOtcStructure.authorizedShares.toLocaleString()}</span>
                  </div>
                )}
                {activeOtcStructure.sharesOutstanding !== undefined && (
                  <div className="data-row">
                    <span className="data-label">Shares outstanding</span>
                    <span className="data-val">{activeOtcStructure.sharesOutstanding.toLocaleString()}</span>
                  </div>
                )}
                {activeOtcStructure.sharesFloat !== undefined && (
                  <div className="data-row">
                    <span className="data-label">Float</span>
                    <span className="data-val">{activeOtcStructure.sharesFloat.toLocaleString()}</span>
                  </div>
                )}
                <div className="data-row" style={{ borderBottom: 'none', paddingTop: '0.5rem' }}>
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                    Source: OTC Markets &nbsp;·&nbsp; As of {new Date(activeOtcStructure.fetchedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </span>
                </div>
              </div>
            ) : (
              <div className="card-body">
                <div style={{ padding: '1.5rem 0', textAlign: 'center' }}>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: '0.7rem', color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
                    No data
                  </div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>
                    Share structure data was not found in the stored filings.
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Active financing */}
          <div className="card">
            <div className="card-head">
              <span className="card-title">Active financing</span>
              {activeFinancing ? (
                <span className={`tag ${activeFinancing.financingType !== 'unknown' ? 'danger' : 'neutral'}`}>
                  {FINANCING_TYPE_LABELS[activeFinancing.financingType] ?? 'Detected'}
                </span>
              ) : intelligence.financingProfile.hasActiveEloc ? (
                <span className="tag warning">ELOC Active</span>
              ) : intelligence.financingProfile.totalEquityFacilityCommitment > 0 ? (
                <span className="tag warning">Equity Facility</span>
              ) : intelligence.financingProfile.totalConvertiblePrincipal > 0 ? (
                <span className="tag danger">Convertible</span>
              ) : (
                <span className="tag neutral">No data</span>
              )}
            </div>
            {(() => {
              if (activeFinancing) {
                return (
                  <div className="card-body">
                    <div className="data-row">
                      <span className="data-label">Financing type</span>
                      <span className="data-val">{FINANCING_TYPE_LABELS[activeFinancing.financingType] ?? activeFinancing.financingType}</span>
                    </div>
                    {activeFinancing.principalAmount !== undefined && (
                      <div className="data-row">
                        <span className="data-label">Principal amount</span>
                        <span className="data-val">${activeFinancing.principalAmount.toLocaleString()}</span>
                      </div>
                    )}
                    {activeFinancing.discountRate !== undefined && (
                      <div className="data-row">
                        <span className="data-label">Discount to market</span>
                        <span className="data-val danger">{(activeFinancing.discountRate * 100).toFixed(0)}% to VWAP</span>
                      </div>
                    )}
                    {activeFinancing.lookbackDays !== undefined && (
                      <div className="data-row">
                        <span className="data-label">Lookback window</span>
                        <span className="data-val">{activeFinancing.lookbackDays}-day VWAP</span>
                      </div>
                    )}
                    <div className="data-row">
                      <span className="data-label">Floor price</span>
                      <span className={`data-val ${activeFinancing.hasFloorPrice ? 'positive' : 'warning'}`}>
                        {activeFinancing.hasFloorPrice && activeFinancing.floorPrice
                          ? `$${activeFinancing.floorPrice}`
                          : 'Not stated'}
                      </span>
                    </div>
                    <div className="data-row">
                      <span className="data-label">Reset provisions</span>
                      <span className={`data-val ${activeFinancing.hasResetProvisions ? 'danger' : 'positive'}`}>
                        {activeFinancing.hasResetProvisions ? 'Present' : 'None stated'}
                      </span>
                    </div>
                    {activeFinancing.warrantShares !== undefined && activeFinancing.warrantShares > 0 && (
                      <div className="data-row">
                        <span className="data-label">Warrants issued</span>
                        <span className="data-val danger">{activeFinancing.warrantShares.toLocaleString()} shares</span>
                      </div>
                    )}
                    {activeFinancing.maturityDate && (
                      <div className="data-row">
                        <span className="data-label">Maturity date</span>
                        <span className="data-val">{activeFinancing.maturityDate}</span>
                      </div>
                    )}
                    {activeFinancing.investorName && (
                      <div className="data-row">
                        <span className="data-label">Investor</span>
                        <span className="data-val muted">{activeFinancing.investorName}</span>
                      </div>
                    )}
                    <div className="data-row" style={{ borderBottom: 'none', paddingTop: '0.5rem' }}>
                      <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                        Extracted from {activeFinancingSource} &nbsp;·&nbsp; Confidence: {activeFinancing.confidence}
                      </span>
                    </div>
                  </div>
                );
              }

              const fp         = intelligence.financingProfile;
              const bestFacility = filings
                .flatMap(f => f.financingReport?.equityFacilities ?? [])
                .sort((a, b) => (b.facilitySize ?? 0) - (a.facilitySize ?? 0))[0];
              const bestNote = filings
                .flatMap(f => f.financingReport?.convertibleDebt ?? [])
                .filter(n => (n.outstandingBalance ?? n.principalAmount ?? 0) >= 25_000)
                .sort((a, b) => (b.outstandingBalance ?? b.principalAmount ?? 0) - (a.outstandingBalance ?? a.principalAmount ?? 0))[0];

              if (!bestFacility && !bestNote) {
                return (
                  <div className="card-body">
                    <div style={{ padding: '1.5rem 0', textAlign: 'center' }}>
                      <div style={{ fontFamily: 'var(--mono)', fontSize: '0.7rem', color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
                        No data
                      </div>
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>
                        No active financing detected in the stored filings.
                      </div>
                    </div>
                  </div>
                );
              }

              const fmt$ = (n: number) => n >= 1_000_000
                ? `$${(n / 1_000_000).toFixed(2)}M`
                : n >= 1_000 ? `$${(n / 1_000).toFixed(0)}K` : `$${n.toLocaleString()}`;

              return (
                <div className="card-body">
                  {bestFacility && (
                    <>
                      <div className="data-row">
                        <span className="data-label">Facility type</span>
                        <span className="data-val">
                          {bestFacility.facilityType === 'eloc' ? 'Equity Line of Credit (ELOC)'
                            : bestFacility.facilityType === 'efa' ? 'Equity Facility Agreement'
                            : fp.hasActiveEloc ? 'Equity Line of Credit (ELOC)'
                            : 'Equity Facility'}
                        </span>
                      </div>
                      {bestFacility.facilitySize !== undefined && (
                        <div className="data-row">
                          <span className="data-label">Committed amount</span>
                          <span className="data-val">{fmt$(bestFacility.facilitySize)}</span>
                        </div>
                      )}
                      {bestFacility.drawnAmount !== undefined && bestFacility.drawnAmount > 0 && (
                        <div className="data-row">
                          <span className="data-label">Drawn to date</span>
                          <span className="data-val warning">{fmt$(bestFacility.drawnAmount)}</span>
                        </div>
                      )}
                      {bestFacility.counterpartyName && (
                        <div className="data-row">
                          <span className="data-label">Counterparty</span>
                          <span className="data-val muted">{bestFacility.counterpartyName}</span>
                        </div>
                      )}
                      {bestFacility.pricingFormula && (
                        <div className="data-row" style={{ borderBottom: bestNote ? undefined : 'none' }}>
                          <span className="data-label">Pricing formula</span>
                          <span className="data-val">{bestFacility.pricingFormula}</span>
                        </div>
                      )}
                    </>
                  )}
                  {bestNote && (
                    <>
                      {bestFacility && (
                        <div style={{ margin: '0.5rem 0', fontSize: '0.72rem', color: 'var(--text-muted)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                          Convertible note
                        </div>
                      )}
                      {(bestNote.outstandingBalance ?? bestNote.principalAmount) !== undefined && (
                        <div className="data-row">
                          <span className="data-label">Outstanding balance</span>
                          <span className="data-val">{fmt$(bestNote.outstandingBalance ?? bestNote.principalAmount!)}</span>
                        </div>
                      )}
                      {bestNote.interestRate !== undefined && (
                        <div className="data-row">
                          <span className="data-label">Interest rate</span>
                          <span className="data-val">{(bestNote.interestRate * 100).toFixed(0)}%</span>
                        </div>
                      )}
                      {bestNote.maturityDate && (
                        <div className="data-row">
                          <span className="data-label">Maturity date</span>
                          <span className="data-val">{bestNote.maturityDate}</span>
                        </div>
                      )}
                      {bestNote.investorName && (
                        <div className="data-row">
                          <span className="data-label">Investor</span>
                          <span className="data-val muted">{bestNote.investorName}</span>
                        </div>
                      )}
                    </>
                  )}
                  <div className="data-row" style={{ borderBottom: 'none', paddingTop: '0.5rem' }}>
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                      Source: intelligence layer · {fp.extractionWarningCount > 0 ? `${fp.extractionWarningCount} warning(s)` : 'high confidence'}
                    </span>
                  </div>
                </div>
              );
            })()}
          </div>

        </div>

        {/* RISK SCORE */}
        <div className="section-divider">
          <span className="section-divider-label">OTCIntel risk score</span>
          <div className="section-divider-line" />
        </div>

        {riskScore ? (
          <div className="two-col" style={{ marginBottom: '1.5rem' }}>
            <div className="card">
              <div className="card-body" style={{ padding: '1.5rem' }}>
                <div className="risk-score-display">
                  <span className={`risk-score-num ${riskScore.color}`}>{riskScore.score}</span>
                  <span className="risk-score-denom">/ 100</span>
                </div>
                <div className={`risk-score-label-badge ${riskScore.color}`}>
                  {riskScore.level === 'high' ? 'High Risk' : riskScore.level === 'med' ? 'Medium Risk' : 'Low Risk'}
                </div>
                <div className="risk-bar-track">
                  <div className="risk-bar-fill" style={{ width: `${riskScore.score}%` }} />
                </div>
                <div className="risk-bar-labels">
                  <span>0 &nbsp;Low</span><span>25</span><span>50</span><span>75</span><span>High &nbsp;100</span>
                </div>
                {riskScore.factors.length > 0 && (
                  <div className="risk-factors">
                    {riskScore.factors.map((f, i) => (
                      <div className="risk-factor-row" key={i}>
                        <span className="risk-factor-name">{f.name}</span>
                        <div className="risk-factor-bar-wrap">
                          <div className="risk-factor-fill" style={{ width: `${f.fillWidth}%`, background: f.fillColor, height: '100%', borderRadius: '2px' }} />
                        </div>
                        <span className="risk-factor-score" style={{ color: f.labelColor }}>{f.label}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="card">
              <div className="card-head"><span className="card-title">Score drivers</span></div>
              <div className="card-body">
                {riskScore.drivers.map((d, i) => (
                  <div className="risk-driver" key={i}>
                    <div className="risk-driver-dot" style={{ background: d.dotColor }} />
                    <div className="risk-driver-text" dangerouslySetInnerHTML={{ __html: d.text }} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="two-col" style={{ marginBottom: '1.5rem' }}>
            <div className="card">
              <div className="card-body" style={{ padding: '1.5rem' }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '140px', gap: '0.75rem', textAlign: 'center' }}>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: '0.6rem', letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                    OTCIntel Risk Score
                  </div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: '1.4rem', fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.04em' }}>
                    Insufficient Data
                  </div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-dim)', lineHeight: 1.6, maxWidth: '260px' }}>
                    A quantitative score requires structured financing terms extracted from an 8-K filing.
                    Those terms were not found in the available filings for this company.
                  </div>
                </div>
              </div>
            </div>
            <div className="card">
              <div className="card-head">
                <span className="card-title">Qualitative classification</span>
                <span className="tag neutral">Intelligence only</span>
              </div>
              <div className="card-body">
                {intelligence.keyRisks.length > 0 ? (
                  intelligence.keyRisks.map((risk, i) => (
                    <div className="risk-driver" key={i}>
                      <div className="risk-driver-dot" style={{
                        background: risk.severity === 'critical' || risk.severity === 'high'
                          ? 'var(--red)' : risk.severity === 'moderate' ? 'var(--amber)' : 'var(--text-muted)',
                      }} />
                      <div className="risk-driver-text">
                        <strong>{risk.label}:</strong> {risk.detail}
                      </div>
                    </div>
                  ))
                ) : (
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)', padding: '0.5rem 0' }}>
                    No risk signals identified in the analyzed filings.
                  </div>
                )}
                <div style={{ marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid var(--rule)', fontSize: '0.7rem', color: 'var(--text-muted)', lineHeight: 1.55 }}>
                  This classification is derived from the intelligence layer, not the quantitative scoring engine.
                  It does not constitute an OTCIntel risk score.
                </div>
              </div>
            </div>
          </div>
        )}

        {/* COMPANY INTELLIGENCE SUMMARY */}
        <div className="section-divider">
          <span className="section-divider-label">Company intelligence</span>
          <div className="section-divider-line" />
        </div>

        <div className="card" style={{ marginBottom: '1rem' }}>
          <div className="card-head">
            <span className="card-title">Executive Summary</span>
            <span className={`tag ${
              intelligence.overview.dilutionRisk === 'severe' ? 'danger' :
              intelligence.overview.dilutionRisk === 'high'   ? 'danger' :
              intelligence.overview.dilutionRisk === 'moderate' ? 'warning' : 'positive'
            }`}>
              {intelligence.overview.dilutionRisk.charAt(0).toUpperCase() + intelligence.overview.dilutionRisk.slice(1)} Dilution Risk
            </span>
          </div>
          <div className="card-body">
            <p style={{ fontSize: '0.875rem', lineHeight: '1.65', color: 'var(--text)', margin: '0 0 1rem 0' }}>
              {intelligence.executiveSummary}
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.75rem', paddingTop: '0.5rem', borderTop: '1px solid var(--border)' }}>
              <div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: '0.6rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>Financing profile</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text)' }}>{intelligence.overview.financingProfile}</div>
              </div>
              {intelligence.overview.latestSharesOutstanding && (
                <div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: '0.6rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>Shares outstanding</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text)' }}>{intelligence.overview.latestSharesOutstanding.toLocaleString()}</div>
                </div>
              )}
              {intelligence.overview.latestAuthorizedShares && (
                <div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: '0.6rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>Authorized shares</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text)' }}>{intelligence.overview.latestAuthorizedShares.toLocaleString()}</div>
                </div>
              )}
              <div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: '0.6rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>Filings analyzed</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text)' }}>{intelligence.filingsAnalyzed}</div>
              </div>
            </div>
          </div>
        </div>

        {(intelligence.keyRisks.length > 0 || intelligence.positiveSignals.length > 0) && (
          <div className="two-col" style={{ marginBottom: '1rem' }}>
            <div className="card">
              <div className="card-head">
                <span className="card-title">Key Risks</span>
                <span className="tag danger">{intelligence.keyRisks.length} identified</span>
              </div>
              <div className="card-body">
                {intelligence.keyRisks.map((risk, i) => (
                  <div key={i} style={{ marginBottom: i < intelligence.keyRisks.length - 1 ? '0.85rem' : 0, paddingBottom: i < intelligence.keyRisks.length - 1 ? '0.85rem' : 0, borderBottom: i < intelligence.keyRisks.length - 1 ? '1px solid var(--border)' : 'none' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
                      <span style={{
                        fontFamily: 'var(--mono)', fontSize: '0.55rem', fontWeight: 700,
                        letterSpacing: '0.07em', textTransform: 'uppercase', padding: '0.1rem 0.35rem', borderRadius: '3px',
                        background: risk.severity === 'critical' ? 'rgba(220,38,38,0.18)' : risk.severity === 'high' ? 'rgba(220,38,38,0.10)' : risk.severity === 'moderate' ? 'rgba(251,191,36,0.13)' : 'rgba(156,163,175,0.10)',
                        color: risk.severity === 'critical' ? '#f87171' : risk.severity === 'high' ? '#f87171' : risk.severity === 'moderate' ? 'var(--amber)' : 'var(--text-muted)',
                      }}>{risk.severity}</span>
                      <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text)' }}>{risk.label}</span>
                    </div>
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-dim)', margin: 0, lineHeight: '1.55' }}>{risk.detail}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="card">
              <div className="card-head">
                <span className="card-title">Positive Signals</span>
                <span className={`tag ${intelligence.positiveSignals.length > 0 ? 'positive' : 'neutral'}`}>
                  {intelligence.positiveSignals.length > 0 ? `${intelligence.positiveSignals.length} detected` : 'None detected'}
                </span>
              </div>
              <div className="card-body">
                {intelligence.positiveSignals.length > 0 ? intelligence.positiveSignals.map((sig, i) => (
                  <div key={i} style={{ marginBottom: i < intelligence.positiveSignals.length - 1 ? '0.85rem' : 0, paddingBottom: i < intelligence.positiveSignals.length - 1 ? '0.85rem' : 0, borderBottom: i < intelligence.positiveSignals.length - 1 ? '1px solid var(--border)' : 'none' }}>
                    <div style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text)', marginBottom: '0.25rem' }}>✓ {sig.label}</div>
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-dim)', margin: 0, lineHeight: '1.55' }}>{sig.detail}</p>
                  </div>
                )) : (
                  <div style={{ padding: '1rem 0', textAlign: 'center' }}>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>No positive signals detected in the analyzed filings.</div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {intelligence.shareStructureTrend.periods.length >= 2 && (
          <div className="card" style={{ marginBottom: '1rem' }}>
            <div className="card-head">
              <span className="card-title">Share Structure Trend</span>
              {intelligence.shareStructureTrend.totalGrowthPct !== undefined && (
                <span className={`tag ${Math.abs(intelligence.shareStructureTrend.totalGrowthPct) < 5 ? 'positive' : intelligence.shareStructureTrend.totalGrowthPct > 25 ? 'danger' : 'warning'}`}>
                  {intelligence.shareStructureTrend.totalGrowthPct >= 0 ? '+' : ''}{intelligence.shareStructureTrend.totalGrowthPct.toFixed(0)}% total
                </span>
              )}
            </div>
            <div className="card-body">
              <p style={{ fontSize: '0.8rem', color: 'var(--text-dim)', margin: '0 0 0.75rem 0', lineHeight: '1.55' }}>
                {intelligence.shareStructureTrend.narrative}
              </p>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem', fontFamily: 'var(--mono)' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)' }}>
                      <th style={{ textAlign: 'left', padding: '0.3rem 0.5rem', color: 'var(--text-muted)', fontWeight: 500 }}>Filing</th>
                      <th style={{ textAlign: 'left', padding: '0.3rem 0.5rem', color: 'var(--text-muted)', fontWeight: 500 }}>Date</th>
                      <th style={{ textAlign: 'right', padding: '0.3rem 0.5rem', color: 'var(--text-muted)', fontWeight: 500 }}>Shares Outstanding</th>
                      <th style={{ textAlign: 'right', padding: '0.3rem 0.5rem', color: 'var(--text-muted)', fontWeight: 500 }}>Δ Period</th>
                    </tr>
                  </thead>
                  <tbody>
                    {intelligence.shareStructureTrend.periods.map((p, i) => {
                      const growthRate = intelligence.shareStructureTrend.periodicGrowthRates[i - 1];
                      return (
                        <tr key={i} style={{ borderBottom: i < intelligence.shareStructureTrend.periods.length - 1 ? '1px solid var(--border)' : 'none' }}>
                          <td style={{ padding: '0.3rem 0.5rem', color: 'var(--text-muted)' }}>{p.formType}</td>
                          <td style={{ padding: '0.3rem 0.5rem', color: 'var(--text-muted)' }}>{p.filedAt}</td>
                          <td style={{ padding: '0.3rem 0.5rem', color: 'var(--text)', textAlign: 'right' }}>{p.sharesOutstanding.toLocaleString()}</td>
                          <td style={{ padding: '0.3rem 0.5rem', textAlign: 'right', color: growthRate === undefined ? 'var(--text-muted)' : growthRate > 10 ? '#f87171' : growthRate > 0 ? 'var(--amber)' : '#4ade80' }}>
                            {growthRate !== undefined ? `${growthRate >= 0 ? '+' : ''}${growthRate.toFixed(1)}%` : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* FILING INTELLIGENCE */}
        <div className="section-divider">
          <span className="section-divider-label">Filing intelligence</span>
          <div className="section-divider-line" />
        </div>

        {filings.map((filing) => {
          const isQuarterlyOrAnnual = ['10-Q','10-Q/A','10-K','10-K/A'].includes(filing.formType);
          const report              = isQuarterlyOrAnnual ? filing.financingReport : undefined;
          const fs                  = report?.financialStatements;
          const reportWarnings      = report?.warnings ?? [];
          const validationWarnings  = reportWarnings.filter(w => w.startsWith('VALIDATION:'));
          const otherWarnings       = reportWarnings.filter(w => !w.startsWith('VALIDATION:'));
          const indexUrl            = edgarFilingIndexUrl(filing.cik, filing.accessionNumber);

          return (
            <div className="card" key={filing.accessionNumber} style={{ marginBottom: '1rem' }}>
              <div className="card-head">
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span className="card-title">{filing.formType}</span>
                  {filing.eventType && (() => {
                    const c = EVENT_TYPE_COLORS[filing.eventType!] ?? EVENT_TYPE_COLORS.other;
                    return (
                      <span style={{ background: c.bg, color: c.fg, fontFamily: 'var(--mono)', fontSize: '0.6rem', fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', padding: '0.15rem 0.45rem', borderRadius: '3px' }}>
                        {EVENT_TYPE_LABELS[filing.eventType!] ?? filing.eventType}
                      </span>
                    );
                  })()}
                  {report && (
                    <span style={{ background: 'rgba(99,102,241,0.12)', color: '#818cf8', fontFamily: 'var(--mono)', fontSize: '0.6rem', fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', padding: '0.15rem 0.45rem', borderRadius: '3px' }}>
                      Report
                    </span>
                  )}
                </div>
                <span style={{ fontFamily: 'var(--mono)', fontSize: '0.65rem', color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
                  Filed {filing.filedAt} &nbsp;·&nbsp; {filing.accessionNumber}
                </span>
              </div>
              <div className="card-body">
                {filing.eventSummary && (
                  <p className="filing-event-summary">{filing.eventSummary}</p>
                )}
                {filing.summary && (
                  <div className="filing-summary-text" dangerouslySetInnerHTML={{ __html: filing.summary }} />
                )}
                {filing.terms && filing.terms.length > 0 && (
                  <div className="filing-terms">
                    {filing.terms.map((t, i) => (
                      <div className="filing-term" key={i}>
                        <div className="filing-term-label">{t.label}</div>
                        <div className={`filing-term-val${t.className ? ' ' + t.className : ''}`}>{t.value}</div>
                      </div>
                    ))}
                  </div>
                )}
                {filing.tags && filing.tags.length > 0 && (
                  <div className="filing-tags">
                    {filing.tags.map((tag, i) => <span className="filing-tag" key={i}>{tag}</span>)}
                  </div>
                )}

                {report && (
                  <details className="filing-report-details">
                    <summary>
                      <span>Financing Report &nbsp;·&nbsp; {filing.periodOfReport ?? filing.filedAt}</span>
                      <span className="filing-report-chevron">▶</span>
                    </summary>
                    <div className="filing-report-body">
                      <div className="report-meta-row">
                        {filing.periodOfReport && <span className="report-meta-chip">Period: {filing.periodOfReport}</span>}
                        <span className="report-meta-chip">Filed: {filing.filedAt}</span>
                        <span className="report-meta-chip">{filing.formType}</span>
                        {report.confidence && (
                          <span className={`report-meta-chip${report.confidence === 'high' ? ' accent' : ''}`}>
                            Confidence: {report.confidence}
                          </span>
                        )}
                      </div>

                      {fs && (
                        <div>
                          <div style={{ fontFamily: 'var(--mono)', fontSize: '0.6rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
                            Financial highlights
                          </div>
                          <div className="report-fin-highlights">
                            {fs.revenue !== undefined && (
                              <div className="report-fin-cell">
                                <div className="report-fin-label">Revenue</div>
                                <div className="report-fin-val">${(fs.revenue / 1e6).toFixed(2)}M</div>
                              </div>
                            )}
                            {fs.netLoss !== undefined && (
                              <div className="report-fin-cell">
                                <div className="report-fin-label">Net loss</div>
                                <div className="report-fin-val" style={{ color: '#f87171' }}>${(Math.abs(fs.netLoss) / 1e6).toFixed(2)}M</div>
                              </div>
                            )}
                            {fs.totalAssets !== undefined && (
                              <div className="report-fin-cell">
                                <div className="report-fin-label">Total assets</div>
                                <div className="report-fin-val">${(fs.totalAssets / 1e6).toFixed(2)}M</div>
                              </div>
                            )}
                            {fs.totalLiabilities !== undefined && (
                              <div className="report-fin-cell">
                                <div className="report-fin-label">Total liabilities</div>
                                <div className="report-fin-val">${(fs.totalLiabilities / 1e6).toFixed(2)}M</div>
                              </div>
                            )}
                            {fs.cashAndEquivalents !== undefined && (
                              <div className="report-fin-cell">
                                <div className="report-fin-label">Cash</div>
                                <div className="report-fin-val">${(fs.cashAndEquivalents / 1e6).toFixed(2)}M</div>
                              </div>
                            )}
                            {fs.cashFromOperations !== undefined && (
                              <div className="report-fin-cell">
                                <div className="report-fin-label">Op. cash flow</div>
                                <div className="report-fin-val" style={{ color: fs.cashFromOperations < 0 ? '#f87171' : '#4ade80' }}>
                                  {fs.cashFromOperations < 0 ? '-' : ''}${(Math.abs(fs.cashFromOperations) / 1e6).toFixed(2)}M
                                </div>
                              </div>
                            )}
                            {fs.hasGoingConcern && (
                              <div className="report-fin-cell">
                                <div className="report-fin-label">Going concern</div>
                                <div className="report-fin-val" style={{ color: '#f87171' }}>Yes — disclosed</div>
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {(validationWarnings.length > 0 || otherWarnings.length > 0) && (
                        <div>
                          <div style={{ fontFamily: 'var(--mono)', fontSize: '0.6rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
                            Parser warnings ({reportWarnings.length})
                          </div>
                          <div className="report-warnings">
                            {validationWarnings.map((w, i) => (
                              <div className="report-warning-item validation" key={`v${i}`}>
                                <span style={{ flexShrink: 0 }}>⚠</span>
                                <span>{w.replace(/^VALIDATION:\s*/i, '')}</span>
                              </div>
                            ))}
                            {otherWarnings.map((w, i) => (
                              <div className="report-warning-item error" key={`e${i}`}>
                                <span style={{ flexShrink: 0 }}>⚠</span>
                                <span>{w}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {report.reportText && report.reportText !== 'No financing activity detected in this filing.' && (
                        <div>
                          <div style={{ fontFamily: 'var(--mono)', fontSize: '0.6rem', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
                            Analyst report
                          </div>
                          <div className="report-text">{report.reportText}</div>
                        </div>
                      )}

                      <div style={{ paddingTop: '0.25rem', borderTop: '1px solid var(--rule)', display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
                        <a href={filing.documentUrl} target="_blank" rel="noopener noreferrer"
                          style={{ fontFamily: 'var(--mono)', fontSize: '0.72rem', color: 'var(--accent)', textDecoration: 'none' }}>
                          Open primary document →
                        </a>
                        <a href={indexUrl} target="_blank" rel="noopener noreferrer"
                          style={{ fontFamily: 'var(--mono)', fontSize: '0.72rem', color: 'var(--text-muted)', textDecoration: 'none' }}>
                          SEC filing index →
                        </a>
                      </div>
                    </div>
                  </details>
                )}

                {!report && (
                  <div style={{ marginTop: '1rem', paddingTop: '0.75rem', borderTop: '1px solid var(--rule)', display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
                    <a href={filing.documentUrl} target="_blank" rel="noopener noreferrer"
                      style={{ fontFamily: 'var(--mono)', fontSize: '0.72rem', color: 'var(--accent)', textDecoration: 'none' }}>
                      View on SEC EDGAR →
                    </a>
                    <a href={indexUrl} target="_blank" rel="noopener noreferrer"
                      style={{ fontFamily: 'var(--mono)', fontSize: '0.72rem', color: 'var(--text-muted)', textDecoration: 'none' }}>
                      Filing index →
                    </a>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        <Footer disclaimer="All data sourced from publicly available SEC EDGAR filings. Provided for informational purposes only. Not investment advice." />
      </div>
    </>
  );
}
