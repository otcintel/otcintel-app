import { notFound } from 'next/navigation';
import Link from 'next/link';
import Nav from '@/components/Nav';
import Footer from '@/components/Footer';
import { companies } from '@/lib/data';

export async function generateMetadata({ params }: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await params;
  const co = companies[ticker.toUpperCase()];
  if (!co) return { title: 'Company Not Found — OTCIntel' };
  return { title: `${co.ticker} · ${co.name} — OTCIntel` };
}

export default async function CompanyPage({ params }: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await params;
  const co = companies[ticker.toUpperCase()];

  if (!co) {
    return (
      <>
        <Nav />
        <div className="page">
          <div className="breadcrumb">
            <Link href="/companies">Companies</Link>
            <span className="breadcrumb-sep">/</span>
            <span>{ticker.toUpperCase()}</span>
          </div>
          <div style={{ padding: '4rem 0', textAlign: 'center' }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: '0.72rem', letterSpacing: '0.1em', color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '1rem' }}>
              Company not found
            </div>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-dim)', marginBottom: '1.5rem' }}>
              No intelligence page exists for ticker <strong style={{ color: 'var(--white)' }}>{ticker.toUpperCase()}</strong>. It may not be tracked yet.
            </p>
            <Link href="/companies" style={{ fontFamily: 'var(--mono)', fontSize: '0.75rem', color: 'var(--accent)', textDecoration: 'none' }}>
              ← Back to Companies
            </Link>
          </div>
        </div>
      </>
    );
  }

  const priceFormatted = `$${co.price.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
  const priceChangeSign = co.priceDirection === 'up' ? '▲' : '▼';
  const priceChangeColor = co.priceDirection === 'up' ? 'var(--green)' : 'var(--red)';
  const sharesOutFmt = (co.sharesOutstanding / 1_000_000).toFixed(1) + 'M';
  const floatFmt = (co.floatShares / 1_000_000).toFixed(1) + 'M';

  return (
    <>
      <Nav />
      <div className="page">

        {/* BREADCRUMB */}
        <div className="breadcrumb">
          <Link href="/companies">Companies</Link>
          <span className="breadcrumb-sep">/</span>
          <span>{co.ticker}</span>
          <span className="breadcrumb-sep">/</span>
          <span>Intelligence page</span>
        </div>

        {/* COMPANY HEADER */}
        <div className="company-header">
          <div className="company-header-left">
            <div className="ticker-badge">{co.ticker}</div>
            <div>
              <div className="company-ticker">{co.ticker}</div>
              <div className="company-fullname">{co.name}</div>
              <div className="company-market">{co.market}</div>
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="price-main">{priceFormatted}</div>
            <div className="price-change" style={{ color: priceChangeColor }}>
              {priceChangeSign} {co.priceChangePct > 0 ? '+' : ''}{co.priceChangePct.toFixed(1)}% &nbsp;(${Math.abs(co.priceChangeAmt).toFixed(3)})
            </div>
            <div className="price-date">Last close &nbsp;·&nbsp; Delayed data</div>
          </div>
        </div>

        {/* RISK BANNER */}
        <div className={`risk-banner ${co.bannerVariant}`}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div className="risk-dot" style={{ background: co.bannerDotColor }} />
            <div
              className="risk-banner-text"
              dangerouslySetInnerHTML={{ __html: co.bannerMessage }}
            />
          </div>
          <div className={`risk-score-pill ${co.bannerPillVariant}`}>
            Risk Score: {co.riskScore} / 100
          </div>
        </div>

        {/* METRIC STRIP */}
        <div className="metric-strip">
          <div className="metric-cell">
            <div className="metric-label">Market cap</div>
            <div className="metric-val">{co.marketCap}</div>
            <div className="metric-sub">At last close</div>
          </div>
          <div className="metric-cell">
            <div className="metric-label">Shares outstanding</div>
            <div className="metric-val">{sharesOutFmt}</div>
            <div className="metric-sub">Latest public filing</div>
          </div>
          <div className="metric-cell">
            <div className="metric-label">Float</div>
            <div className="metric-val">{floatFmt}</div>
            <div className="metric-sub">Est. tradeable shares</div>
          </div>
          <div className="metric-cell">
            <div className="metric-label">Est. dilution exposure</div>
            <div className="metric-val" style={{ color: `var(--${co.riskScoreColor})` }}>
              {co.dilution.dilutionPct}
            </div>
            <div className="metric-sub">New shares / fully diluted</div>
          </div>
        </div>

        {/* CAPITAL STRUCTURE */}
        <div className="section-divider" style={{ marginTop: 0 }}>
          <span className="section-divider-label">Capital structure</span>
          <div className="section-divider-line" />
        </div>

        <div className="two-col" style={{ marginBottom: '1.5rem' }}>

          {/* Share structure card */}
          <div className="card">
            <div className="card-head">
              <span className="card-title">Share structure</span>
              <span className="tag neutral">Latest filing</span>
            </div>
            <div className="card-body">
              <div className="data-row">
                <span className="data-label">Authorized shares</span>
                <span className="data-val">{co.authorizedShares.toLocaleString()}</span>
              </div>
              <div className="data-row">
                <span className="data-label">Shares outstanding</span>
                <span className="data-val">{co.sharesOutstanding.toLocaleString()}</span>
              </div>
              <div className="data-row">
                <span className="data-label">Float</span>
                <span className="data-val">{co.floatShares.toLocaleString()}</span>
              </div>
              <div className="data-row">
                <span className="data-label">Preferred shares outstanding</span>
                <span className="data-val warning">{co.preferredShares.toLocaleString()}</span>
              </div>
              <div className="data-row">
                <span className="data-label">Est. reserved shares</span>
                <span className="data-val danger">{co.reservedShares.toLocaleString()}</span>
              </div>
              <div className="data-row">
                <span className="data-label">Shares remaining (authorized)</span>
                <span className="data-val">{co.sharesRemaining.toLocaleString()}</span>
              </div>
            </div>
            <div className="cap-bar-wrap">
              <div className="cap-bar-label">
                <span>Share utilization</span>
                <span>
                  {sharesOutFmt} issued &nbsp;+&nbsp; {(co.reservedShares / 1_000_000).toFixed(1)}M reserved &nbsp;/&nbsp; {(co.authorizedShares / 1_000_000).toFixed(0)}M authorized
                </span>
              </div>
              <div className="cap-bar-track">
                <div className="cap-bar-seg" style={{ width: `${co.issuedBarPct}%`, background: co.issuedBarColor }} />
                <div className="cap-bar-seg" style={{ width: `${co.reservedBarPct}%`, background: co.reservedBarColor, opacity: 0.75 }} />
                <div className="cap-bar-seg" style={{ flex: 1, background: 'rgba(255,255,255,0.04)' }} />
              </div>
              <div className="cap-bar-legend">
                <div className="cap-bar-leg-item">
                  <div className="cap-bar-leg-dot" style={{ background: co.issuedBarColor }} />
                  Issued ({sharesOutFmt})
                </div>
                <div className="cap-bar-leg-item">
                  <div className="cap-bar-leg-dot" style={{ background: co.reservedBarColor }} />
                  Reserved ({(co.reservedShares / 1_000_000).toFixed(1)}M)
                </div>
                <div className="cap-bar-leg-item">
                  <div className="cap-bar-leg-dot" style={{ background: 'rgba(255,255,255,0.1)' }} />
                  Available ({(co.sharesRemaining / 1_000_000).toFixed(1)}M)
                </div>
              </div>
            </div>
          </div>

          {/* Active financing card */}
          <div className="card">
            <div className="card-head">
              <span className="card-title">Active financing</span>
              <span className={`tag ${co.financing.tagVariant}`}>Active</span>
            </div>
            <div className="card-body">
              <div className="data-row">
                <span className="data-label">Financing type</span>
                <span className="data-val">{co.financing.type}</span>
              </div>
              <div className="data-row">
                <span className="data-label">Principal amount</span>
                <span className="data-val">{co.financing.principal}</span>
              </div>
              <div className="data-row">
                <span className="data-label">Discount to market</span>
                <span className={`data-val ${co.financing.discountClass}`}>{co.financing.discount}</span>
              </div>
              <div className="data-row">
                <span className="data-label">Lookback window</span>
                <span className="data-val">{co.financing.lookback}</span>
              </div>
              <div className="data-row">
                <span className="data-label">Floor price</span>
                <span className={`data-val ${co.financing.floorPriceClass}`}>{co.financing.floorPrice}</span>
              </div>
              <div className="data-row">
                <span className="data-label">Reset provisions</span>
                <span className={`data-val ${co.financing.resetClass}`}>{co.financing.resetProvisions}</span>
              </div>
              <div className="data-row">
                <span className="data-label">Maturity date</span>
                <span className="data-val">{co.financing.maturityDate}</span>
              </div>
              <div className="data-row">
                <span className="data-label">Investor</span>
                <span className="data-val muted">{co.financing.investor}</span>
              </div>
            </div>
          </div>

        </div>

        {/* WARRANTS & OVERHANG */}
        <div className="section-divider">
          <span className="section-divider-label">Warrants &amp; overhang</span>
          <div className="section-divider-line" />
        </div>

        <div className="two-col" style={{ marginBottom: '1.5rem' }}>

          {/* Dilution exposure card */}
          <div className="card">
            <div className="card-head">
              <span className="card-title">Dilution exposure</span>
              <span className="tag warning">Estimated</span>
            </div>
            <div className="card-body">
              <div className="data-row">
                <span className="data-label">Est. conversion price</span>
                <span className="data-val">{co.dilution.conversionPrice}</span>
              </div>
              <div className="data-row">
                <span className="data-label">Shares from note (est.)</span>
                <span className={`data-val ${co.dilution.sharesFromNoteClass}`}>{co.dilution.sharesFromNote}</span>
              </div>
              <div className="data-row">
                <span className="data-label">Shares from warrants</span>
                <span className={`data-val ${co.dilution.sharesFromWarrantsClass}`}>{co.dilution.sharesFromWarrants}</span>
              </div>
              <div className="data-row">
                <span className="data-label">Total potential new shares</span>
                <span className={`data-val ${co.dilution.totalNewSharesClass}`}>{co.dilution.totalNewShares}</span>
              </div>
              <div className="data-row">
                <span className="data-label">Fully diluted share count</span>
                <span className="data-val">{co.dilution.fullyDiluted}</span>
              </div>
              <div className="data-row">
                <span className="data-label">Est. dilution exposure</span>
                <span className={`data-val ${co.dilution.dilutionPctClass}`} style={{ fontSize: '0.95rem' }}>
                  {co.dilution.dilutionPct}
                </span>
              </div>
              <div className="data-row" style={{ paddingTop: '0.75rem', borderBottom: 'none' }}>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                  {co.dilution.disclaimer}
                </span>
              </div>
            </div>
          </div>

          {/* Warrant overhang card */}
          <div className="card">
            <div className="card-head">
              <span className="card-title">Warrant overhang</span>
              <span className={`tag ${co.warrants.sharesClass || 'neutral'}`}>Outstanding</span>
            </div>
            <div className="card-body">
              <div className="data-row">
                <span className="data-label">Warrant shares</span>
                <span className={`data-val ${co.warrants.sharesClass}`}>{co.warrants.shares}</span>
              </div>
              <div className="data-row">
                <span className="data-label">Exercise price</span>
                <span className="data-val">{co.warrants.exercisePrice}</span>
              </div>
              <div className="data-row">
                <span className="data-label">Expiration date</span>
                <span className="data-val">{co.warrants.expiration}</span>
              </div>
              <div className="data-row">
                <span className="data-label">Est. overhang %</span>
                <span className={`data-val ${co.warrants.overhangPctClass}`}>{co.warrants.overhangPct}</span>
              </div>
              <div className="data-row">
                <span className="data-label">Issued in connection with</span>
                <span className="data-val muted">{co.warrants.issuedWith}</span>
              </div>
              <div className="data-row">
                <span className="data-label">Status</span>
                <span className={`data-val ${co.warrants.statusClass}`}>{co.warrants.status}</span>
              </div>
              <div className="data-row">
                <span className="data-label">{co.warrants.lastFieldLabel}</span>
                <span className={`data-val ${co.warrants.lastFieldClass}`}>{co.warrants.lastFieldValue}</span>
              </div>
            </div>
          </div>

        </div>

        {/* RISK SCORE */}
        <div className="section-divider">
          <span className="section-divider-label">OTCIntel risk score</span>
          <div className="section-divider-line" />
        </div>

        <div className="two-col" style={{ marginBottom: '1.5rem' }}>

          {/* Score display card */}
          <div className="card">
            <div className="card-body" style={{ padding: '1.5rem' }}>
              <div className="risk-score-display">
                <span className={`risk-score-num ${co.riskScoreColor}`}>{co.riskScore}</span>
                <span className="risk-score-denom">/ 100</span>
              </div>
              <div className={`risk-score-label-badge ${co.riskScoreColor}`}>
                {co.riskLevel === 'high' ? 'High Risk' : co.riskLevel === 'med' ? 'Medium Risk' : 'Low Risk'}
              </div>
              <div className="risk-bar-track">
                <div className="risk-bar-fill" style={{ width: `${co.riskBarWidth}%` }} />
              </div>
              <div className="risk-bar-labels">
                <span>0 &nbsp;Low</span>
                <span>25</span>
                <span>50</span>
                <span>75</span>
                <span>High &nbsp;100</span>
              </div>
              <div className="risk-factors">
                {co.riskFactors.map((f, i) => (
                  <div className="risk-factor-row" key={i}>
                    <span className="risk-factor-name">{f.name}</span>
                    <div className="risk-factor-bar-wrap">
                      <div className="risk-factor-fill" style={{ width: `${f.fillWidth}%`, background: f.fillColor, height: '100%', borderRadius: '2px' }} />
                    </div>
                    <span className="risk-factor-score" style={{ color: f.labelColor }}>{f.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Score drivers card */}
          <div className="card">
            <div className="card-head">
              <span className="card-title">Score drivers</span>
            </div>
            <div className="card-body">
              {co.riskDrivers.map((d, i) => (
                <div className="risk-driver" key={i}>
                  <div className="risk-driver-dot" style={{ background: d.dotColor }} />
                  <div
                    className="risk-driver-text"
                    dangerouslySetInnerHTML={{ __html: d.text }}
                  />
                </div>
              ))}
            </div>
          </div>

        </div>

        {/* FILING INTELLIGENCE */}
        <div className="section-divider">
          <span className="section-divider-label">Filing intelligence</span>
          <div className="section-divider-line" />
        </div>

        <div className="card" style={{ marginBottom: '1.5rem' }}>
          <div className="card-head">
            <span className="card-title">Most recent filing</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: '0.65rem', color: 'var(--text-muted)', letterSpacing: '0.05em' }}>
              SEC EDGAR &nbsp;·&nbsp; CIK {co.filing.cik} &nbsp;·&nbsp; Public filing
            </span>
          </div>
          <div className="card-body">
            <div className="filing-meta">
              <span className="filing-type-tag">{co.filing.type}</span>
              <span className="filing-date-label">Filed: {co.filing.date}</span>
              <span className="filing-source">CIK {co.filing.cik} &nbsp;·&nbsp; SEC EDGAR</span>
            </div>
            <div
              className="filing-summary-text"
              dangerouslySetInnerHTML={{ __html: co.filing.summary }}
            />
            <div className="filing-terms">
              {co.filing.terms.map((t, i) => (
                <div className="filing-term" key={i}>
                  <div className="filing-term-label">{t.label}</div>
                  <div className={`filing-term-val${t.className ? ' ' + t.className : ''}`}>{t.value}</div>
                </div>
              ))}
            </div>
            <div className="filing-tags">
              {co.filing.tags.map((tag, i) => (
                <span className="filing-tag" key={i}>{tag}</span>
              ))}
            </div>
          </div>
        </div>

        <Footer disclaimer="All data sourced from publicly available SEC filings and OTC Markets disclosures. Risk scores and dilution estimates are analytical outputs based on public data. Provided for informational purposes only. Not investment advice." />
      </div>
    </>
  );
}
