import { describe, it, expect } from 'vitest';
import { buildDedupKey } from '../dedup';

describe('buildDedupKey', () => {
  // ── Stability: same inputs → same key ──────────────────────────────────────

  it('produces the same key for identical inputs', () => {
    const a = buildDedupKey({ ticker: 'AITX', anomalyType: 'extreme_discount_rate', accessionNumber: '0001477932-26-003416', sourcePath: 'financing_raw.discountRate' });
    const b = buildDedupKey({ ticker: 'AITX', anomalyType: 'extreme_discount_rate', accessionNumber: '0001477932-26-003416', sourcePath: 'financing_raw.discountRate' });
    expect(a).toBe(b);
  });

  it('produces the same key when called twice with no accession', () => {
    const a = buildDedupKey({ ticker: 'NTRB', anomalyType: 'going_concern_healthy_runway', sourcePath: 'financial_snapshots.goingConcernFlag' });
    const b = buildDedupKey({ ticker: 'NTRB', anomalyType: 'going_concern_healthy_runway', sourcePath: 'financial_snapshots.goingConcernFlag' });
    expect(a).toBe(b);
  });

  // ── Different accession → different key ────────────────────────────────────

  it('produces different keys for different accession numbers', () => {
    const a = buildDedupKey({ ticker: 'CUEN', anomalyType: 'unknown_financing_type', accessionNumber: '0001477932-26-000001', sourcePath: 'financing_raw.financingType' });
    const b = buildDedupKey({ ticker: 'CUEN', anomalyType: 'unknown_financing_type', accessionNumber: '0001477932-26-000002', sourcePath: 'financing_raw.financingType' });
    expect(a).not.toBe(b);
  });

  it('produces different keys when accession is present vs absent', () => {
    const withAcc    = buildDedupKey({ ticker: 'GOVX', anomalyType: 'unknown_financing_type', accessionNumber: '0001477932-26-000001', sourcePath: 'financing_raw.financingType' });
    const withoutAcc = buildDedupKey({ ticker: 'GOVX', anomalyType: 'unknown_financing_type', sourcePath: 'financing_raw.financingType' });
    expect(withAcc).not.toBe(withoutAcc);
  });

  // ── Ticker normalization ───────────────────────────────────────────────────

  it('uppercases ticker', () => {
    const lower = buildDedupKey({ ticker: 'aitx', anomalyType: 'extreme_discount_rate', sourcePath: 'financing_raw.discountRate' });
    const upper = buildDedupKey({ ticker: 'AITX', anomalyType: 'extreme_discount_rate', sourcePath: 'financing_raw.discountRate' });
    expect(lower).toBe(upper);
  });

  it('trims ticker whitespace', () => {
    const padded = buildDedupKey({ ticker: '  AITX  ', anomalyType: 'extreme_discount_rate', sourcePath: 'x' });
    const clean  = buildDedupKey({ ticker: 'AITX',     anomalyType: 'extreme_discount_rate', sourcePath: 'x' });
    expect(padded).toBe(clean);
  });

  // ── sourcePath normalization ───────────────────────────────────────────────

  it('lowercases sourcePath', () => {
    const upper = buildDedupKey({ ticker: 'AITX', anomalyType: 'stale_active_source', sourcePath: 'FILINGS.PARSER_VERSION' });
    const lower = buildDedupKey({ ticker: 'AITX', anomalyType: 'stale_active_source', sourcePath: 'filings.parser_version' });
    expect(upper).toBe(lower);
  });

  it('uses "none" for absent sourcePath', () => {
    const absent = buildDedupKey({ ticker: 'TEST', anomalyType: 'x' });
    expect(absent).toMatch(/:none$/);
  });

  // ── Accession normalization ────────────────────────────────────────────────

  it('strips whitespace from accession number', () => {
    const spaced = buildDedupKey({ ticker: 'TEST', anomalyType: 'x', accessionNumber: '0001477932 26 003416', sourcePath: 'y' });
    const clean  = buildDedupKey({ ticker: 'TEST', anomalyType: 'x', accessionNumber: '000147793226003416',   sourcePath: 'y' });
    expect(spaced).toBe(clean);
  });

  it('uses "none" for null accession', () => {
    const nullAcc  = buildDedupKey({ ticker: 'TEST', anomalyType: 'x', accessionNumber: null,      sourcePath: 'y' });
    const undefAcc = buildDedupKey({ ticker: 'TEST', anomalyType: 'x', accessionNumber: undefined,  sourcePath: 'y' });
    expect(nullAcc).toBe(undefAcc);
    expect(nullAcc).toContain(':none:');
  });

  // ── Key format ────────────────────────────────────────────────────────────

  it('key has exactly four colon-separated segments', () => {
    const k = buildDedupKey({ ticker: 'GOVX', anomalyType: 'unknown_financing_type', accessionNumber: '0001234567-26-000001', sourcePath: 'financing_raw.financingType' });
    const parts = k.split(':');
    expect(parts).toHaveLength(4);
  });

  it('first segment is uppercase ticker', () => {
    const k = buildDedupKey({ ticker: 'govx', anomalyType: 'x', sourcePath: 'y' });
    expect(k.split(':')[0]).toBe('GOVX');
  });
});
