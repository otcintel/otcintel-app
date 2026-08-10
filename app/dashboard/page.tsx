import Link from 'next/link';
import Nav from '@/components/Nav';
import Footer from '@/components/Footer';
import { getDashboardStats } from '@/lib/server-data';

export const metadata = { title: 'Dashboard — OTCIntel' };

export default async function DashboardPage() {
  const stats = await getDashboardStats();

  const lastUpdatedDisplay = stats.lastUpdated
    ? new Date(stats.lastUpdated).toLocaleString('en-US', {
        month: 'long', day: 'numeric', year: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
      })
    : 'No data yet';

  return (
    <>
      <Nav />
      <div className="page-wide">

        {/* PAGE HEADER */}
        <div className="page-header">
          <div>
            <div className="page-eyebrow">OTCIntel</div>
            <h1 className="page-title">Dashboard</h1>
            <p className="page-subtitle">Overview of tracked OTC companies and recent intelligence signals.</p>
          </div>
          <div className="page-date">
            Last updated<br />{lastUpdatedDisplay}
          </div>
        </div>

        {/* MARKET SNAPSHOT */}
        <div className="section-divider no-top">
          <span className="section-divider-label">Market snapshot</span>
          <div className="section-divider-line" />
        </div>

        <div className="snapshot-grid">
          <div className="snapshot-cell all">
            <div className="snap-label">Tracked companies</div>
            <div className="snap-val green">{stats.companiesTracked}</div>
            <div className="snap-sub">OTC and microcap</div>
          </div>
          <div className="snapshot-cell risk">
            <div className="snap-label">Filings ingested</div>
            <div className="snap-val amber">{stats.totalFilingsParsed}</div>
            <div className="snap-sub">From SEC EDGAR</div>
          </div>
          <div className="snapshot-cell filings">
            <div className="snap-label">With intelligence</div>
            <div className="snap-val green">{stats.companiesWithIntelligence}</div>
            <div className="snap-sub">Usable confidence or above</div>
          </div>
          <div className="snapshot-cell flags">
            <div className="snap-label">Insufficient data</div>
            <div className="snap-val" style={{ color: 'var(--text-muted)' }}>{stats.companiesInsufficient}</div>
            <div className="snap-sub">Needs more filings</div>
          </div>
        </div>

        {/* RECENT FILINGS */}
        <div className="section-divider">
          <span className="section-divider-label">Recent filings</span>
          <div className="section-divider-line" />
        </div>

        <div className="card">
          <div className="card-head">
            <span className="card-title">Filing activity</span>
            <Link href="/companies" className="card-action">View all companies →</Link>
          </div>
          {stats.recentFilings.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th style={{ width: '80px' }}>Ticker</th>
                  <th>Company</th>
                  <th style={{ width: '90px' }}>Type</th>
                  <th style={{ width: '110px' }}>Date</th>
                  <th style={{ width: '220px' }}>Source</th>
                </tr>
              </thead>
              <tbody>
                {stats.recentFilings.map(f => (
                  <tr key={f.accessionNumber} className="clickable">
                    <td className="td-ticker">
                      <Link href={`/company/${f.ticker}`}>{f.ticker}</Link>
                    </td>
                    <td>
                      <div className="td-company">{f.companyName}</div>
                      <div className="td-company-sub">{f.accessionNumber}</div>
                    </td>
                    <td><span className="filing-type-badge">{f.formType}</span></td>
                    <td className="td-date">
                      {new Date(f.filedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </td>
                    <td>
                      <a
                        href={f.documentUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="card-action"
                        style={{ fontSize: '0.72rem' }}
                      >
                        SEC EDGAR →
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ padding: '2rem', textAlign: 'center', fontFamily: 'var(--mono)', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              No filings ingested yet. Run the ingestion pipeline to populate this dashboard.
            </div>
          )}
          <div className="table-footer">
            <span className="table-footer-note">Sourced from SEC EDGAR public filings · Real ingested data</span>
            <span className="table-footer-note">Showing {stats.recentFilings.length} most recent</span>
          </div>
        </div>

        {/* LOWER GRID */}
        <div className="lower-grid">

          {/* NEEDS REVIEW */}
          <div>
            <div className="section-divider">
              <span className="section-divider-label">Needs review</span>
              <div className="section-divider-line" />
            </div>
            <div className="card">
              <div className="card-head">
                <span className="card-title">Review queue</span>
                <Link href="/companies" className="card-action">View all →</Link>
              </div>
              <div style={{ padding: '0.25rem 0' }}>
                {stats.companiesNeedingReview > 0 ? (
                  <div style={{ padding: '1rem', fontSize: '0.82rem', color: 'var(--text-dim)', lineHeight: '1.6' }}>
                    <span style={{ color: 'var(--amber)', fontFamily: 'var(--mono)', fontSize: '1.2rem', fontWeight: 700 }}>
                      {stats.companiesNeedingReview}
                    </span>
                    {' '}
                    {stats.companiesNeedingReview === 1 ? 'company' : 'companies'} flagged for review.
                    Visit the{' '}
                    <Link href="/companies" style={{ color: 'var(--accent)', textDecoration: 'none' }}>
                      companies page
                    </Link>
                    {' '}and filter by &ldquo;Needs review&rdquo; to see which tickers require attention.
                  </div>
                ) : (
                  <div style={{ padding: '1.5rem', textAlign: 'center' }}>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: '0.7rem', color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '0.5rem' }}>
                      No items pending
                    </div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-dim)' }}>
                      All ingested companies have a resolved confidence status.
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* DATA COVERAGE */}
          <div>
            <div className="section-divider">
              <span className="section-divider-label">Coverage summary</span>
              <div className="section-divider-line" />
            </div>
            <div className="card">
              <div className="card-head">
                <span className="card-title">Ingestion status</span>
                <Link href="/companies" className="card-action">View all →</Link>
              </div>
              <div className="card-body" style={{ padding: '1rem' }}>
                <div className="data-row">
                  <span className="data-label">Total companies</span>
                  <span className="data-val">{stats.companiesTracked}</span>
                </div>
                <div className="data-row">
                  <span className="data-label">With intelligence</span>
                  <span className="data-val positive">{stats.companiesWithIntelligence}</span>
                </div>
                <div className="data-row">
                  <span className="data-label">Needing review</span>
                  <span className={`data-val ${stats.companiesNeedingReview > 0 ? 'warning' : ''}`}>{stats.companiesNeedingReview}</span>
                </div>
                <div className="data-row" style={{ borderBottom: 'none' }}>
                  <span className="data-label">Insufficient data</span>
                  <span className="data-val" style={{ color: 'var(--text-muted)' }}>{stats.companiesInsufficient}</span>
                </div>
                <div style={{ marginTop: '1rem', paddingTop: '0.75rem', borderTop: '1px solid var(--rule)', fontSize: '0.72rem', color: 'var(--text-muted)', lineHeight: '1.55' }}>
                  All data sourced from SEC EDGAR via the OTCIntel ingestion pipeline.
                  Market price and volume data are not currently ingested.
                </div>
              </div>
            </div>
          </div>

        </div>

        <Footer disclaimer="All data sourced from publicly available SEC EDGAR filings. Risk scores and signals are analytical outputs provided for informational purposes only. Nothing on this page constitutes investment advice." />
      </div>
    </>
  );
}
