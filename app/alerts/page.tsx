import Nav from '@/components/Nav';
import Footer from '@/components/Footer';

export const metadata = { title: 'Alerts — OTCIntel' };

export default function AlertsPage() {
  return (
    <>
      <Nav />
      <div className="page-wide">

        {/* PAGE HEADER */}
        <div className="page-header">
          <div>
            <div className="page-eyebrow">OTCIntel</div>
            <h1 className="page-title">Alerts</h1>
            <p className="page-subtitle">Track new filings, financing events, dilution signals, and watchlist changes across OTC and microcap companies.</p>
          </div>
          <div className="page-date">
            Last updated<br />April 22, 2026 &nbsp;·&nbsp; 16:42 EST
          </div>
        </div>

        {/* ALERT SUMMARY */}
        <div className="section-divider no-top">
          <span className="section-divider-label">Alert summary</span>
          <div className="section-divider-line" />
        </div>

        <div className="snapshot-grid">
          <div className="snapshot-cell total">
            <div className="snap-label">Total alerts</div>
            <div className="snap-val white">14</div>
            <div className="snap-sub">Past 30 days</div>
          </div>
          <div className="snapshot-cell high">
            <div className="snap-label">High priority</div>
            <div className="snap-val red">4</div>
            <div className="snap-sub">Require review</div>
          </div>
          <div className="snapshot-cell financing">
            <div className="snap-label">Financing alerts</div>
            <div className="snap-val amber">6</div>
            <div className="snap-sub">New or amended</div>
          </div>
          <div className="snapshot-cell filing">
            <div className="snap-label">Filing alerts</div>
            <div className="snap-val accent">8</div>
            <div className="snap-sub">SEC disclosures</div>
          </div>
        </div>

        {/* MAIN LAYOUT */}
        <div className="section-divider">
          <span className="section-divider-label">Recent alerts</span>
          <div className="section-divider-line" />
        </div>

        <div className="main-layout">

          {/* LEFT: ALERTS TABLE */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <div className="card">
              <div className="card-head">
                <span className="card-title">All alerts</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: '0.65rem', color: 'var(--text-muted)', letterSpacing: '0.06em' }}>14 total · past 30 days</span>
              </div>
              <table>
                <thead>
                  <tr>
                    <th style={{ width: '80px' }}>Ticker</th>
                    <th>Company</th>
                    <th style={{ width: '200px' }}>Alert type</th>
                    <th style={{ width: '100px' }}>Date</th>
                    <th style={{ width: '100px' }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { ticker: 'ALTX', company: 'Altex Resources Corp.', sub: 'OTC · Pink Sheets', type: 'financing', typeLabel: 'Convertible financing announced', date: 'Apr 3, 2026', status: 'new' },
                    { ticker: 'NVST', company: 'Novesta Capital Inc.', sub: 'OTC · Pink Sheets', type: 'registration', typeLabel: 'S-1 registration filed', date: 'Apr 2, 2026', status: 'new' },
                    { ticker: 'QRIX', company: 'Qurix Holdings Inc.', sub: 'OTC · Pink Sheets', type: 'risk', typeLabel: 'Risk score increase', date: 'Apr 2, 2026', status: 'flagged' },
                    { ticker: 'BLDR', company: 'Balder Energy Corp.', sub: 'OTC · Pink Sheets', type: 'financing', typeLabel: 'Equity line amendment', date: 'Mar 31, 2026', status: 'flagged' },
                    { ticker: 'XMDF', company: 'Xomed Financial Group', sub: 'OTC · Expert Market', type: 'filing', typeLabel: 'Late filing notice (NT 10-Q)', date: 'Mar 29, 2026', status: 'reviewed' },
                    { ticker: 'VTRX', company: 'Vortex Capital Group', sub: 'OTC · Pink Sheets', type: 'financing', typeLabel: 'Convertible financing announced', date: 'Mar 28, 2026', status: 'reviewed' },
                    { ticker: 'PHNX', company: 'Phoenix Biotech Inc.', sub: 'OTC · Pink Sheets', type: 'filing', typeLabel: 'Annual report filed (10-K)', date: 'Mar 28, 2026', status: 'cleared' },
                    { ticker: 'ALTX', company: 'Altex Resources Corp.', sub: 'OTC · Pink Sheets', type: 'risk', typeLabel: 'Warrant exercise disclosure', date: 'Mar 26, 2026', status: 'reviewed' },
                    { ticker: 'MRXQ', company: 'Meraxo Pharma Group', sub: 'OTC · Pink Sheets', type: 'financing', typeLabel: 'Equity line draw notice', date: 'Mar 24, 2026', status: 'cleared' },
                    { ticker: 'QRIX', company: 'Qurix Holdings Inc.', sub: 'OTC · Pink Sheets', type: 'filing', typeLabel: 'Quarterly report filed (10-Q)', date: 'Mar 22, 2026', status: 'cleared' },
                  ].map((a, i) => (
                    <tr key={i}>
                      <td className="td-ticker">{a.ticker}</td>
                      <td>
                        <div className="td-company">{a.company}</div>
                        <div className="td-company-sub">{a.sub}</div>
                      </td>
                      <td><span className={`alert-type ${a.type}`}>{a.typeLabel}</span></td>
                      <td className="td-date">{a.date}</td>
                      <td><span className={`status ${a.status}`}>{a.status.charAt(0).toUpperCase() + a.status.slice(1)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="table-footer">
                <span className="table-footer-note">Sourced from SEC EDGAR public filings &nbsp;·&nbsp; Delayed data</span>
                <span className="table-footer-note">Showing 10 of 14 alerts</span>
              </div>
            </div>
          </div>

          {/* RIGHT: WATCHLIST + SETTINGS */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

            {/* WATCHLIST ALERTS */}
            <div className="card">
              <div className="card-head">
                <span className="card-title">Watchlist alerts</span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: '0.65rem', color: 'var(--text-muted)' }}>5 companies</span>
              </div>
              <div>
                {[
                  { dotClass: 'red', ticker: 'ALTX', desc: '$1.5M convertible note filed via 8-K. Conversion at 20% discount to 10-day VWAP. Est. dilution exposure: 28.4%. Risk score: 83.', time: 'Apr 3, 2026 · 8-K · Convertible financing' },
                  { dotClass: 'red', ticker: 'NVST', desc: 'S-1 registration filed covering 18.5M resale shares. Underlying convertible note at 15% discount. Risk score updated: 54 → 79.', time: 'Apr 2, 2026 · S-1 · Share registration' },
                  { dotClass: 'amber', ticker: 'QRIX', desc: 'Risk score increased 54 → 67 following 8-K disclosing financing amendment. Lookback extended from 5 to 10 days. No floor price stated.', time: 'Apr 2, 2026 · 8-K · Risk score change' },
                  { dotClass: 'amber', ticker: 'BLDR', desc: 'Equity line facility amended. Maximum draw increased from $2M to $3M. Variable pricing at 12% discount to prior-day close. Risk score: 61.', time: 'Mar 31, 2026 · 8-K · Equity line amendment' },
                  { dotClass: 'green', ticker: 'PHNX', desc: '10-K annual report filed. No new financing disclosed. Shares outstanding unchanged at 42.1M. Risk score unchanged: 18.', time: 'Mar 28, 2026 · 10-K · Annual filing' },
                ].map((w, i) => (
                  <div className="watchlist-item" key={i}>
                    <div className={`wl-dot ${w.dotClass}`} />
                    <div className="wl-body">
                      <div className="wl-ticker">{w.ticker}</div>
                      <div className="wl-desc">{w.desc}</div>
                      <div className="wl-time">{w.time}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* ALERT PREFERENCES */}
            <div className="card">
              <div className="card-head">
                <span className="card-title">Alert preferences</span>
              </div>
              <div>
                {[
                  { label: 'Convertible financing', sub: 'New notes and amendments', on: true },
                  { label: 'Risk score changes', sub: 'Increases of 10 points or more', on: true },
                  { label: 'S-1 registrations', sub: 'New share registration filings', on: true },
                  { label: 'Late filing notices', sub: 'NT 10-Q and NT 10-K filings', on: false },
                  { label: 'Warrant exercises', sub: 'Reported warrant conversions', on: false },
                ].map((s, i) => (
                  <div className="settings-row" key={i}>
                    <div>
                      <div className="settings-label">{s.label}</div>
                      <div className="settings-sub">{s.sub}</div>
                    </div>
                    <div className={`toggle${s.on ? ' on' : ''}`} />
                  </div>
                ))}
              </div>
            </div>

          </div>
        </div>

        <Footer disclaimer="All alerts are based on publicly available SEC filings and OTC Markets disclosures. Alert signals are analytical outputs provided for informational purposes only. Nothing on this page constitutes investment advice." />
      </div>
    </>
  );
}
