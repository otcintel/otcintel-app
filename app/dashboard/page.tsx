import Link from 'next/link';
import Nav from '@/components/Nav';
import Footer from '@/components/Footer';

export const metadata = { title: 'Dashboard — OTCIntel' };

export default function DashboardPage() {
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
            Last updated<br />April 22, 2026 &nbsp;·&nbsp; 16:42 EST
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
            <div className="snap-val green">8</div>
            <div className="snap-sub">OTC and microcap</div>
          </div>
          <div className="snapshot-cell risk">
            <div className="snap-label">Active dilution risk</div>
            <div className="snap-val red">3</div>
            <div className="snap-sub">Risk score above 75</div>
          </div>
          <div className="snapshot-cell filings">
            <div className="snap-label">Recent filings</div>
            <div className="snap-val amber">6</div>
            <div className="snap-sub">Filed in past 7 days</div>
          </div>
          <div className="snapshot-cell flags">
            <div className="snap-label">High risk flags</div>
            <div className="snap-val red">2</div>
            <div className="snap-sub">New financing detected</div>
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
          <table>
            <thead>
              <tr>
                <th style={{ width: '80px' }}>Ticker</th>
                <th>Company</th>
                <th style={{ width: '90px' }}>Type</th>
                <th style={{ width: '90px' }}>Date</th>
                <th style={{ width: '200px' }}>Signal</th>
              </tr>
            </thead>
            <tbody>
              <tr className="clickable">
                <td className="td-ticker"><Link href="/company/ABCD">ABCD</Link></td>
                <td><div className="td-company">Alpha Bio Corp.</div><div className="td-company-sub">OTC · Pink Sheets</div></td>
                <td><span className="filing-type-badge">8-K</span></td>
                <td className="td-date">Apr 3, 2026</td>
                <td><span className="signal high">Convertible note filed</span></td>
              </tr>
              <tr className="clickable">
                <td className="td-ticker"><Link href="/company/WXYZ">WXYZ</Link></td>
                <td><div className="td-company">Westyx Industries Inc.</div><div className="td-company-sub">OTC · Pink Sheets</div></td>
                <td><span className="filing-type-badge">S-1</span></td>
                <td className="td-date">Apr 2, 2026</td>
                <td><span className="signal high">Share registration filed</span></td>
              </tr>
              <tr className="clickable">
                <td className="td-ticker"><Link href="/company/EFGH">EFGH</Link></td>
                <td><div className="td-company">EFG Holdings Group</div><div className="td-company-sub">OTC · Pink Sheets</div></td>
                <td><span className="filing-type-badge">10-Q</span></td>
                <td className="td-date">Apr 1, 2026</td>
                <td><span className="signal neutral">Quarterly results</span></td>
              </tr>
              <tr className="clickable">
                <td className="td-ticker"><Link href="/company/MNOP">MNOP</Link></td>
                <td><div className="td-company">Monarch Pharma Inc.</div><div className="td-company-sub">OTC · Pink Sheets</div></td>
                <td><span className="filing-type-badge">8-K</span></td>
                <td className="td-date">Mar 31, 2026</td>
                <td><span className="signal med">Equity line draw notice</span></td>
              </tr>
              <tr className="clickable">
                <td className="td-ticker"><Link href="/company/QRST">QRST</Link></td>
                <td><div className="td-company">Quantum Resource Tech.</div><div className="td-company-sub">OTC · Expert Market</div></td>
                <td><span className="filing-type-badge">NT 10-Q</span></td>
                <td className="td-date">Mar 29, 2026</td>
                <td><span className="signal med">Filing delay disclosed</span></td>
              </tr>
              <tr className="clickable">
                <td className="td-ticker"><Link href="/company/UVWX">UVWX</Link></td>
                <td><div className="td-company">United Ventures Exchange</div><div className="td-company-sub">OTC · Pink Sheets</div></td>
                <td><span className="filing-type-badge">10-K</span></td>
                <td className="td-date">Mar 28, 2026</td>
                <td><span className="signal low">Annual report filed</span></td>
              </tr>
            </tbody>
          </table>
          <div className="table-footer">
            <span className="table-footer-note">Sourced from SEC EDGAR public filings &nbsp;·&nbsp; Delayed data</span>
            <span className="table-footer-note">Showing 6 of 6 recent filings</span>
          </div>
        </div>

        {/* LOWER GRID */}
        <div className="lower-grid">

          {/* HIGH DILUTION RISK */}
          <div>
            <div className="section-divider">
              <span className="section-divider-label">High dilution risk</span>
              <div className="section-divider-line" />
            </div>
            <div className="card">
              <div className="card-head">
                <span className="card-title">Risk flags</span>
                <Link href="/companies" className="card-action">View all →</Link>
              </div>
              <div className="risk-list">
                <div className="risk-item">
                  <div className="risk-item-left">
                    <div className="risk-ticker">ABCD</div>
                    <div className="risk-desc">High dilution exposure from active convertible note. Estimated conversion shares exceed 30% of current float.</div>
                  </div>
                  <span className="risk-score-badge high">Score 83</span>
                </div>
                <div className="risk-item">
                  <div className="risk-item-left">
                    <div className="risk-ticker">WXYZ</div>
                    <div className="risk-desc">Active $1.5M convertible note at 22% discount. No floor price. S-1 registration filed for resale shares.</div>
                  </div>
                  <span className="risk-score-badge high">Score 87</span>
                </div>
                <div className="risk-item">
                  <div className="risk-item-left">
                    <div className="risk-ticker" style={{ color: 'var(--amber)' }}>QRIX</div>
                    <div className="risk-desc">Convertible financing announced via 8-K. Discount rate and lookback window under review.</div>
                  </div>
                  <span className="risk-score-badge med">Score 61</span>
                </div>
              </div>
            </div>
          </div>

          {/* RECENTLY ADDED */}
          <div>
            <div className="section-divider">
              <span className="section-divider-label">Recently added</span>
              <div className="section-divider-line" />
            </div>
            <div className="card">
              <div className="card-head">
                <span className="card-title">New companies</span>
                <Link href="/companies" className="card-action">View all →</Link>
              </div>
              <table className="recent-table">
                <tbody>
                  <tr>
                    <td><span className="recent-ticker">ABCD</span></td>
                    <td><span className="recent-name">Alpha Bio Corp.</span></td>
                    <td className="recent-added">Apr 3</td>
                  </tr>
                  <tr>
                    <td><span className="recent-ticker">WXYZ</span></td>
                    <td><span className="recent-name">Westyx Industries Inc.</span></td>
                    <td className="recent-added">Apr 1</td>
                  </tr>
                  <tr>
                    <td><span className="recent-ticker">QRIX</span></td>
                    <td><span className="recent-name">Qurix Holdings Inc.</span></td>
                    <td className="recent-added">Mar 30</td>
                  </tr>
                  <tr>
                    <td><span className="recent-ticker">EFGH</span></td>
                    <td><span className="recent-name">EFG Holdings Group</span></td>
                    <td className="recent-added">Mar 28</td>
                  </tr>
                  <tr>
                    <td><span className="recent-ticker">MNOP</span></td>
                    <td><span className="recent-name">Monarch Pharma Inc.</span></td>
                    <td className="recent-added">Mar 25</td>
                  </tr>
                </tbody>
              </table>
              <div className="table-footer">
                <span className="table-footer-note">Showing 5 most recently added</span>
              </div>
            </div>
          </div>

        </div>

        <Footer disclaimer="All data sourced from publicly available SEC filings and OTC Markets disclosures. Risk scores and signals are analytical outputs provided for informational purposes only. Nothing on this page constitutes investment advice." />
      </div>
    </>
  );
}
