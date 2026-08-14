import Link from 'next/link';
import Nav from '@/components/Nav';
import Footer from '@/components/Footer';
import { requireAdminCookie } from '@/lib/admin/cookieAuth';
import { sortBySeverity, buildListFilters, UNRESOLVED_STATUSES } from '@/lib/admin/reviewUtils';
import { getReviewItemsRepo } from '@/lib/db/repositories';
import type { ReviewItem, AnomalySeverity, ReviewStatus } from '@/lib/anomaly/types';

export const metadata = { title: 'Anomaly Review — OTCIntel Admin' };

const SEVERITY_COLORS: Record<AnomalySeverity, string> = {
  critical: 'var(--red)',
  high:     'var(--amber)',
  medium:   'var(--text)',
  low:      'var(--text-dim)',
};

const STATUS_LABELS: Record<ReviewStatus, string> = {
  open:               'Open',
  investigating:      'Investigating',
  confirmed_bug:      'Confirmed Bug',
  expected_behavior:  'Expected',
  resolved:           'Resolved',
  ignored:            'Ignored',
};

export default async function ReviewQueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminCookie();

  const sp     = new URLSearchParams();
  const raw    = await searchParams;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') sp.set(k, v);
  }

  const filters  = buildListFilters(sp);
  const showAll  = sp.get('showAll') === 'true';
  const repo     = await getReviewItemsRepo();
  const items    = sortBySeverity(await repo.list(filters));

  const counts = {
    total:    items.length,
    critical: items.filter(i => i.severity === 'critical').length,
    high:     items.filter(i => i.severity === 'high').length,
    medium:   items.filter(i => i.severity === 'medium').length,
    low:      items.filter(i => i.severity === 'low').length,
  };

  function filterLink(params: Record<string, string | undefined>): string {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) next.delete(k);
      else next.set(k, v);
    }
    return `/admin/review?${next.toString()}`;
  }

  return (
    <>
      <Nav />
      <div className="page-wide">
        <div className="page-header">
          <div>
            <div className="page-eyebrow">Admin</div>
            <h1 className="page-title">Anomaly Review Queue</h1>
            <p className="page-subtitle">
              {showAll ? 'All statuses' : 'Unresolved items only'} &mdash;{' '}
              {showAll
                ? <Link href="/admin/review">Show unresolved only</Link>
                : <Link href={filterLink({ showAll: 'true' })}>Show all</Link>
              }
            </p>
          </div>
        </div>

        {/* Summary counts */}
        <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
          {(['total', 'critical', 'high', 'medium', 'low'] as const).map(k => (
            <div key={k} className="card" style={{ padding: '0.75rem 1.25rem', minWidth: 100 }}>
              <div style={{ fontSize: '1.5rem', fontWeight: 700, color: k === 'total' ? 'var(--text)' : SEVERITY_COLORS[k as AnomalySeverity] }}>
                {counts[k]}
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)', textTransform: 'capitalize' }}>{k}</div>
            </div>
          ))}
        </div>

        {/* Active filters */}
        {(sp.get('ticker') || sp.get('severity') || sp.get('anomalyType') || sp.get('category')) && (
          <div style={{ marginBottom: '1rem', fontSize: '0.875rem', color: 'var(--text-dim)' }}>
            Filtering by:{' '}
            {sp.get('ticker') && <span>ticker=<strong>{sp.get('ticker')}</strong> </span>}
            {sp.get('severity') && <span>severity=<strong>{sp.get('severity')}</strong> </span>}
            {sp.get('anomalyType') && <span>anomalyType=<strong>{sp.get('anomalyType')}</strong> </span>}
            {sp.get('category') && <span>category=<strong>{sp.get('category')}</strong> </span>}
            <Link href={showAll ? '/admin/review?showAll=true' : '/admin/review'} style={{ marginLeft: '0.5rem' }}>Clear</Link>
          </div>
        )}

        {items.length === 0 ? (
          <div className="card" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-dim)' }}>
            No unresolved review items.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', color: 'var(--text-dim)' }}>
                  <th style={thStyle}>Severity</th>
                  <th style={thStyle}>Ticker</th>
                  <th style={thStyle}>Anomaly Type</th>
                  <th style={thStyle}>Title</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Parser</th>
                  <th style={thStyle}>Count</th>
                  <th style={thStyle}>Last Seen</th>
                  <th style={thStyle}></th>
                </tr>
              </thead>
              <tbody>
                {items.map((item: ReviewItem) => (
                  <tr key={item.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={tdStyle}>
                      <span style={{ color: SEVERITY_COLORS[item.severity], fontWeight: 600, textTransform: 'uppercase', fontSize: '0.75rem' }}>
                        {item.severity}
                      </span>
                    </td>
                    <td style={tdStyle}>
                      <Link href={filterLink({ ticker: item.ticker })} style={{ color: 'var(--accent)' }}>
                        {item.ticker}
                      </Link>
                    </td>
                    <td style={tdStyle}>
                      <Link href={filterLink({ anomalyType: item.anomalyType })} style={{ color: 'var(--text-dim)', fontSize: '0.8rem' }}>
                        {item.anomalyType}
                      </Link>
                    </td>
                    <td style={tdStyle}>{item.title}</td>
                    <td style={tdStyle}>{STATUS_LABELS[item.status]}</td>
                    <td style={tdStyle} aria-label="Parser version">{item.parserVersion ?? '—'}</td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>{item.recurrenceCount}</td>
                    <td style={tdStyle}>{item.lastSeenAt.slice(0, 10)}</td>
                    <td style={tdStyle}>
                      <Link href={`/admin/review/${item.id}`} style={{ color: 'var(--accent)' }}>
                        Review &rarr;
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <Footer />
    </>
  );
}

const thStyle: React.CSSProperties = {
  textAlign:   'left',
  padding:     '0.5rem 0.75rem',
  fontWeight:  500,
  whiteSpace:  'nowrap',
};

const tdStyle: React.CSSProperties = {
  padding:    '0.625rem 0.75rem',
  whiteSpace: 'nowrap',
};
