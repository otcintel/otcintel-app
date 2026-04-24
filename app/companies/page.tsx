'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Nav from '@/components/Nav';
import Footer from '@/components/Footer';
import { companiesList } from '@/lib/data';

export default function CompaniesPage() {
  const router = useRouter();
  const [riskFilter, setRiskFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    return companiesList.filter(c => {
      const riskOk = riskFilter === 'all' || c.riskFilter === riskFilter;
      const typeOk = !typeFilter || c.typeFilter === typeFilter;
      const searchOk = !search || c.ticker.toLowerCase().includes(search.toLowerCase()) || c.name.toLowerCase().includes(search.toLowerCase());
      return riskOk && typeOk && searchOk;
    });
  }, [riskFilter, typeFilter, search]);

  const highCount  = companiesList.filter(c => c.riskFilter === 'high').length;
  const medCount   = companiesList.filter(c => c.riskFilter === 'med').length;
  const lowCount   = companiesList.filter(c => c.riskFilter === 'low').length;

  function toggleType(val: string) {
    setTypeFilter(prev => prev === val ? null : val);
  }

  return (
    <>
      <Nav />
      <div className="page-wide">

        <div className="page-header-simple">
          <div className="page-eyebrow">OTC Intelligence</div>
          <h1 className="page-title">Company Intelligence</h1>
          <p className="page-subtitle">Tracked OTC and microcap companies with active financing analysis, risk scores, and share structure data sourced from public SEC filings.</p>
        </div>

        <div className="summary-strip">
          <div className="summary-cell">
            <div className="summary-label">Companies tracked</div>
            <div className="summary-val white">{companiesList.length}</div>
          </div>
          <div className="summary-cell">
            <div className="summary-label">High risk</div>
            <div className="summary-val red">{highCount}</div>
          </div>
          <div className="summary-cell">
            <div className="summary-label">Medium risk</div>
            <div className="summary-val amber">{medCount}</div>
          </div>
          <div className="summary-cell">
            <div className="summary-label">Low risk</div>
            <div className="summary-val green">{lowCount}</div>
          </div>
        </div>

        <div className="filter-bar">
          <span className="filter-label">Filter</span>
          <button className={`filter-btn${riskFilter === 'all'  ? ' active' : ''}`} onClick={() => setRiskFilter('all')}>All</button>
          <button className={`filter-btn${riskFilter === 'high' ? ' active' : ''}`} onClick={() => setRiskFilter('high')}>High risk</button>
          <button className={`filter-btn${riskFilter === 'med'  ? ' active' : ''}`} onClick={() => setRiskFilter('med')}>Medium risk</button>
          <button className={`filter-btn${riskFilter === 'low'  ? ' active' : ''}`} onClick={() => setRiskFilter('low')}>Low risk</button>
          <div className="filter-sep" />
          <button className={`filter-btn${typeFilter === 'convertible' ? ' active' : ''}`} onClick={() => toggleType('convertible')}>Convertible note</button>
          <button className={`filter-btn${typeFilter === 'equity'      ? ' active' : ''}`} onClick={() => toggleType('equity')}>Equity line</button>
          <div style={{ flex: 1 }} />
          <input
            type="text"
            className="nav-search"
            placeholder="Filter by ticker..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ width: 140 }}
          />
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: '88px' }}>Ticker</th>
                <th>Company</th>
                <th className="right" style={{ width: '96px' }}>Price</th>
                <th className="right hide-mobile" style={{ width: '108px' }}>Market cap</th>
                <th style={{ width: '160px' }}>Risk score</th>
                <th className="hide-mobile" style={{ width: '160px' }}>Financing type</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => (
                <tr
                  key={c.ticker}
                  className="clickable"
                  onClick={() => router.push(`/company/${c.ticker}`)}
                >
                  <td className="td-ticker">
                    <Link href={`/company/${c.ticker}`} onClick={e => e.stopPropagation()}>
                      {c.ticker}
                    </Link>
                  </td>
                  <td>
                    <div className="td-company-name">{c.name}</div>
                    <div className="td-company-sub">{c.sub}</div>
                  </td>
                  <td className="right">
                    <div className="td-price-main">{c.price}</div>
                    <div className={`td-price-change ${c.priceChangeDir}`}>{c.priceChange}</div>
                  </td>
                  <td className="right hide-mobile">
                    <span className="td-cap">{c.marketCap}</span>
                  </td>
                  <td>
                    <div className="risk-cell">
                      <span className="risk-num" style={{ color: c.riskColor }}>{c.riskScore}</span>
                      <div className="risk-mini-track">
                        <div className="risk-mini-fill" style={{ width: c.riskFillWidth, background: c.riskColor }} />
                      </div>
                      <span className={`risk-tag ${c.riskClass}`}>{c.riskClass === 'med' ? 'Med' : c.riskClass === 'low' ? 'Low' : 'High'}</span>
                    </div>
                  </td>
                  <td className="td-type hide-mobile">{c.financingType}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)', fontFamily: 'var(--mono)', fontSize: '0.8rem' }}>
                    No companies match the current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="table-footer">
            <span className="table-footer-note">Public SEC filings and OTC Markets disclosures &nbsp;·&nbsp; Delayed pricing</span>
            <span className="table-footer-note">Showing {filtered.length} of {companiesList.length} companies</span>
          </div>
        </div>

        <Footer disclaimer="All data sourced from publicly available SEC filings and OTC Markets disclosures. Risk scores are analytical outputs based on public information and are provided for informational purposes only. Nothing on this page constitutes investment advice." />
      </div>
    </>
  );
}
