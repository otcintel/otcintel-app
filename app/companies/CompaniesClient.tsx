'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { CompanyRow, CompanyConfidenceStatus } from '@/lib/server-data';

// ─── Confidence badge ──────────────────────────────────────────────────────────

const CONFIDENCE_LABELS: Record<string, string> = {
  high_confidence:      'High confidence',
  usable_with_warnings: 'Usable',
  needs_review:         'Needs review',
  insufficient_data:    'Insufficient data',
};

const CONFIDENCE_CSS: Record<string, string> = {
  high_confidence:      'positive',
  usable_with_warnings: 'warning',
  needs_review:         'danger',
  insufficient_data:    'neutral',
};

function ConfidenceBadge({ status }: { status: CompanyConfidenceStatus | undefined }) {
  if (!status) return <span className="tag neutral">Unknown</span>;
  return (
    <span className={`tag ${CONFIDENCE_CSS[status] ?? 'neutral'}`}>
      {CONFIDENCE_LABELS[status] ?? status}
    </span>
  );
}

// ─── Date formatting ──────────────────────────────────────────────────────────

function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Main component ───────────────────────────────────────────────────────────

type ConfidenceFilter = 'all' | CompanyConfidenceStatus;

interface Props {
  companies: CompanyRow[];
}

export default function CompaniesClient({ companies }: Props) {
  const router = useRouter();
  const [confidenceFilter, setConfidenceFilter] = useState<ConfidenceFilter>('all');
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    return companies.filter(c => {
      const confOk = confidenceFilter === 'all' || c.confidenceStatus === confidenceFilter;
      const q = search.toLowerCase();
      const searchOk = !q
        || c.ticker.toLowerCase().includes(q)
        || c.companyName.toLowerCase().includes(q)
        || c.cik.includes(q);
      return confOk && searchOk;
    });
  }, [companies, confidenceFilter, search]);

  // Summary counts
  const highCount   = companies.filter(c => c.confidenceStatus === 'high_confidence').length;
  const usableCount = companies.filter(c => c.confidenceStatus === 'usable_with_warnings').length;
  const insuffCount = companies.filter(c => c.confidenceStatus === 'insufficient_data').length;

  return (
    <>
      <div className="page-header-simple">
        <div className="page-eyebrow">OTC Intelligence</div>
        <h1 className="page-title">Company Intelligence</h1>
        <p className="page-subtitle">
          Ingested OTC and microcap companies with financing analysis and SEC filing data sourced from SEC EDGAR.
        </p>
      </div>

      <div className="summary-strip">
        <div className="summary-cell">
          <div className="summary-label">Companies tracked</div>
          <div className="summary-val white">{companies.length}</div>
        </div>
        <div className="summary-cell">
          <div className="summary-label">High confidence</div>
          <div className="summary-val green">{highCount}</div>
        </div>
        <div className="summary-cell">
          <div className="summary-label">Usable with warnings</div>
          <div className="summary-val amber">{usableCount}</div>
        </div>
        <div className="summary-cell">
          <div className="summary-label">Insufficient data</div>
          <div className="summary-val" style={{ color: 'var(--text-muted)' }}>{insuffCount}</div>
        </div>
      </div>

      <div className="filter-bar">
        <span className="filter-label">Filter</span>
        <button
          className={`filter-btn${confidenceFilter === 'all' ? ' active' : ''}`}
          onClick={() => setConfidenceFilter('all')}
        >
          All
        </button>
        <button
          className={`filter-btn${confidenceFilter === 'high_confidence' ? ' active' : ''}`}
          onClick={() => setConfidenceFilter('high_confidence')}
        >
          High confidence
        </button>
        <button
          className={`filter-btn${confidenceFilter === 'usable_with_warnings' ? ' active' : ''}`}
          onClick={() => setConfidenceFilter('usable_with_warnings')}
        >
          Usable
        </button>
        <button
          className={`filter-btn${confidenceFilter === 'insufficient_data' ? ' active' : ''}`}
          onClick={() => setConfidenceFilter('insufficient_data')}
        >
          Insufficient data
        </button>
        <div style={{ flex: 1 }} />
        <input
          type="text"
          className="nav-search"
          placeholder="Search ticker or name..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ width: 180 }}
        />
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: '88px' }}>Ticker</th>
              <th>Company</th>
              <th className="hide-mobile" style={{ width: '130px' }}>CIK</th>
              <th className="right hide-mobile" style={{ width: '80px' }}>Filings</th>
              <th style={{ width: '180px' }}>Confidence</th>
              <th className="right hide-mobile" style={{ width: '120px' }}>Latest filing</th>
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
                  <div className="td-company-name">{c.companyName}</div>
                </td>
                <td className="hide-mobile" style={{ fontFamily: 'var(--mono)', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                  {c.cik}
                </td>
                <td className="right hide-mobile" style={{ fontFamily: 'var(--mono)', fontSize: '0.8rem', color: 'var(--text-dim)' }}>
                  {c.filingsParsed}
                </td>
                <td>
                  <ConfidenceBadge status={c.confidenceStatus} />
                </td>
                <td className="right hide-mobile" style={{ fontFamily: 'var(--mono)', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                  {formatDate(c.latestFilingDate)}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  style={{
                    textAlign: 'center',
                    padding: '2rem',
                    color: 'var(--text-muted)',
                    fontFamily: 'var(--mono)',
                    fontSize: '0.8rem',
                  }}
                >
                  No companies match the current filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="table-footer">
          <span className="table-footer-note">
            Real-time data from SEC EDGAR &nbsp;·&nbsp; Ingested via the OTCIntel pipeline
          </span>
          <span className="table-footer-note">
            Showing {filtered.length} of {companies.length} companies
          </span>
        </div>
      </div>
    </>
  );
}
