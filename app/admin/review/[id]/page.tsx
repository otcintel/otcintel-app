import Link from 'next/link';
import { notFound } from 'next/navigation';
import Nav from '@/components/Nav';
import Footer from '@/components/Footer';
import { requireAdminCookie } from '@/lib/admin/cookieAuth';
import { getReviewItemsRepo } from '@/lib/db/repositories';
import { updateItemStatus } from '../actions';
import type { ReviewItem } from '@/lib/anomaly/types';

export const metadata = { title: 'Review Item — OTCIntel Admin' };

function edgarFilingUrl(cik: string | undefined, accessionNumber: string): string | undefined {
  if (!cik) return undefined;
  const cikStripped    = cik.replace(/^0+/, '');
  const accessionPath  = accessionNumber.replace(/-/g, '');
  return `https://www.sec.gov/Archives/edgar/data/${cikStripped}/${accessionPath}/${accessionNumber}-index.htm`;
}

export default async function ReviewDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdminCookie();

  const { id } = await params;
  const repo   = await getReviewItemsRepo();
  const item   = await repo.getById(id);

  if (!item) notFound();

  const secUrl = item.accessionNumber ? edgarFilingUrl(item.cik, item.accessionNumber) : undefined;

  return (
    <>
      <Nav />
      <div className="page-wide">
        <div className="page-header">
          <div>
            <div className="page-eyebrow">
              <Link href="/admin/review">&larr; Review Queue</Link>
            </div>
            <h1 className="page-title">{item.title}</h1>
            <p className="page-subtitle">{item.ticker} &mdash; {item.anomalyType}</p>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
          <Field label="ID"             value={item.id} mono />
          <Field label="Status"         value={item.status} />
          <Field label="Severity"       value={item.severity} />
          <Field label="Category"       value={item.category} />
          <Field label="Ticker"         value={item.ticker} />
          <Field label="CIK"            value={item.cik} />
          <Field label="Accession"      value={item.accessionNumber} />
          <Field label="Parser version" value={item.parserVersion} />
          <Field label="Confidence"     value={item.confidence} />
          <Field label="Recurrences"    value={String(item.recurrenceCount)} />
          <Field label="First seen"     value={item.firstSeenAt} />
          <Field label="Last seen"      value={item.lastSeenAt} />
          {item.resolvedAt && <Field label="Resolved at" value={item.resolvedAt} />}
          {item.resolutionNote && <Field label="Resolution note" value={item.resolutionNote} />}
        </div>

        <div className="card" style={{ padding: '1.25rem', marginBottom: '1rem' }}>
          <div style={{ fontWeight: 600, marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-dim)' }}>Description</div>
          <p style={{ margin: 0 }}>{item.description}</p>
        </div>

        {item.currentValue !== undefined && (
          <div className="card" style={{ padding: '1.25rem', marginBottom: '1rem' }}>
            <div style={{ fontWeight: 600, marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-dim)' }}>Current value</div>
            <pre style={{ margin: 0, fontSize: '0.8rem', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {JSON.stringify(item.currentValue, null, 2)}
            </pre>
          </div>
        )}

        {item.expectedBehavior !== undefined && (
          <div className="card" style={{ padding: '1.25rem', marginBottom: '1rem' }}>
            <div style={{ fontWeight: 600, marginBottom: '0.5rem', fontSize: '0.875rem', color: 'var(--text-dim)' }}>Expected behavior</div>
            <pre style={{ margin: 0, fontSize: '0.8rem', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {JSON.stringify(item.expectedBehavior, null, 2)}
            </pre>
          </div>
        )}

        {secUrl && (
          <div style={{ marginTop: '1rem' }}>
            <a href={secUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>
              View SEC filing on EDGAR &rarr;
            </a>
          </div>
        )}

        <div style={{ marginTop: '2rem', paddingTop: '1rem', borderTop: '1px solid var(--border)' }}>
          <StatusUpdateForm item={item} />
        </div>
      </div>
      <Footer />
    </>
  );
}

function Field({ label, value, mono }: { label: string; value: string | undefined; mono?: boolean }) {
  if (value === undefined) return null;
  return (
    <div>
      <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginBottom: '0.125rem' }}>{label}</div>
      <div style={{ fontFamily: mono ? 'monospace' : undefined, fontSize: '0.875rem', wordBreak: 'break-all' }}>{value}</div>
    </div>
  );
}

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'open',               label: 'Open' },
  { value: 'investigating',      label: 'Investigating' },
  { value: 'confirmed_bug',      label: 'Confirmed Bug' },
  { value: 'expected_behavior',  label: 'Expected Behavior' },
  { value: 'resolved',           label: 'Resolved' },
  { value: 'ignored',            label: 'Ignored' },
];

function StatusUpdateForm({ item }: { item: ReviewItem }) {
  return (
    <form action={updateItemStatus}>
      <input type="hidden" name="id" value={item.id} />

      <h2 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '1rem' }}>Update status</h2>

      <div style={{ marginBottom: '1rem' }}>
        <label style={labelStyle}>Status</label>
        <select
          name="status"
          defaultValue={item.status}
          style={inputStyle}
        >
          {STATUS_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      <div style={{ marginBottom: '1rem' }}>
        <label style={labelStyle}>Resolution note <span style={{ color: 'var(--text-dim)' }}>(optional)</span></label>
        <textarea
          name="resolutionNote"
          defaultValue={item.resolutionNote ?? ''}
          rows={3}
          style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
          placeholder="e.g. Fixed in parser 1.0.5, expected from SEC form structure, …"
        />
      </div>

      <button type="submit" style={buttonStyle}>
        Save
      </button>
    </form>
  );
}

const labelStyle: React.CSSProperties = {
  display:      'block',
  fontSize:     '0.875rem',
  color:        'var(--text-dim)',
  marginBottom: '0.375rem',
};

const inputStyle: React.CSSProperties = {
  display:     'block',
  width:       '100%',
  maxWidth:    420,
  padding:     '0.5rem 0.625rem',
  background:  'var(--card-bg)',
  border:      '1px solid var(--border)',
  borderRadius: 4,
  color:       'var(--text)',
  fontSize:    '0.875rem',
  boxSizing:   'border-box',
};

const buttonStyle: React.CSSProperties = {
  padding:      '0.5rem 1.5rem',
  background:   'var(--accent)',
  color:        '#fff',
  border:       'none',
  borderRadius: 4,
  fontSize:     '0.875rem',
  cursor:       'pointer',
};
