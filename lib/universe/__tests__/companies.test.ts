import { describe, it, expect } from 'vitest';
import { deriveConfidenceStatus, getStaleFilings, hasStaleFilings, PARSEABLE_FORMS } from '../companies';
import type { NormalizedFiling } from '../../ingestion/types';
import { PARSER_VERSION } from '../types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function mockFiling(overrides: Partial<NormalizedFiling> = {}): NormalizedFiling {
  return {
    accessionNumber: '0001234567-26-000001',
    ticker: 'TEST',
    cik: '0001234567',
    formType: '10-K',
    filedAt: '2026-01-15',
    periodOfReport: '2026-01-15',
    documentUrl: 'https://example.com/filing.htm',
    source: 'edgar',
    parseErrors: [],
    parserVersion: PARSER_VERSION,
    ingestedAt: '2026-01-15T12:00:00Z',
    ...overrides,
  };
}

// ─── deriveConfidenceStatus ───────────────────────────────────────────────────

describe('deriveConfidenceStatus', () => {
  it('returns insufficient_data when filings array is empty', () => {
    expect(deriveConfidenceStatus([])).toBe('insufficient_data');
  });

  it('returns insufficient_data when all filings are non-parseable form types', () => {
    const filings = [
      mockFiling({ formType: '6-K' as never }),
      mockFiling({ formType: '20-F' as never }),
    ];
    expect(deriveConfidenceStatus(filings)).toBe('insufficient_data');
  });

  it('returns insufficient_data when only 8-K present but no annual or 2+ quarterly', () => {
    // 8-K is parseable but does not satisfy the coverage requirement
    const filings = [mockFiling({ formType: '8-K' })];
    expect(deriveConfidenceStatus(filings)).toBe('insufficient_data');
  });

  it('returns insufficient_data when only one quarterly report present', () => {
    const filings = [mockFiling({ formType: '10-Q' })];
    expect(deriveConfidenceStatus(filings)).toBe('insufficient_data');
  });

  it('returns high_confidence with one 10-K and no warnings', () => {
    const filings = [mockFiling({ formType: '10-K' })];
    expect(deriveConfidenceStatus(filings)).toBe('high_confidence');
  });

  it('returns high_confidence with 10-K/A and no warnings', () => {
    const filings = [mockFiling({ formType: '10-K/A' })];
    expect(deriveConfidenceStatus(filings)).toBe('high_confidence');
  });

  it('returns high_confidence with two quarterly reports and no warnings', () => {
    const filings = [
      mockFiling({ formType: '10-Q', accessionNumber: 'acc-001' }),
      mockFiling({ formType: '10-Q', accessionNumber: 'acc-002' }),
    ];
    expect(deriveConfidenceStatus(filings)).toBe('high_confidence');
  });

  it('returns high_confidence with S-1 if coverage requirement met another way', () => {
    const filings = [
      mockFiling({ formType: '10-K', accessionNumber: 'acc-001' }),
      mockFiling({ formType: 'S-1', accessionNumber: 'acc-002' }),
    ];
    expect(deriveConfidenceStatus(filings)).toBe('high_confidence');
  });

  it('returns usable_with_warnings when warnings count is ≤ 2', () => {
    const noteWithWarnings = {
      _validationWarnings: ['Warning A', 'Warning B'],
    };
    const filings = [
      mockFiling({
        formType: '10-K',
        financingReport: {
          convertibleDebt: [noteWithWarnings as never],
          equityIssuances: [],
          conversions: [],
          warrants: [],
          relatedPartyTransactions: [],
          equityFacilities: [],
          dilutionSummary: { dilutionPhrases: [], hasDilutionWarning: false },
          reportText: '', extractedAt: '', confidence: 'low' as const, warnings: [],
        },
      }),
    ];
    expect(deriveConfidenceStatus(filings)).toBe('usable_with_warnings');
  });

  it('returns needs_review when warnings exceed 5', () => {
    const noteWithManyWarnings = {
      _validationWarnings: ['W1', 'W2', 'W3', 'W4', 'W5', 'W6'],
    };
    const filings = [
      mockFiling({
        formType: '10-K',
        financingReport: {
          convertibleDebt: [noteWithManyWarnings as never],
          equityIssuances: [],
          conversions: [],
          warrants: [],
          relatedPartyTransactions: [],
          equityFacilities: [],
          dilutionSummary: { dilutionPhrases: [], hasDilutionWarning: false },
          reportText: '', extractedAt: '', confidence: 'low' as const, warnings: [],
        },
      }),
    ];
    expect(deriveConfidenceStatus(filings)).toBe('needs_review');
  });

  it('returns insufficient_data for foreign filer form types even with many filings', () => {
    const filings = Array.from({ length: 10 }, (_, i) =>
      mockFiling({ formType: '6-K' as never, accessionNumber: `acc-${i}` }),
    );
    expect(deriveConfidenceStatus(filings)).toBe('insufficient_data');
  });

  it('returns insufficient_data with parse errors that push past needs_review threshold', () => {
    const filings = [
      mockFiling({
        formType: '10-K',
        parseErrors: ['Error 1', 'Error 2', 'Error 3', 'Error 4'],
      }),
    ];
    expect(deriveConfidenceStatus(filings)).toBe('needs_review');
  });
});

// ─── PARSEABLE_FORMS export ───────────────────────────────────────────────────

describe('PARSEABLE_FORMS', () => {
  it('is exported and is a Set', () => {
    expect(PARSEABLE_FORMS).toBeInstanceOf(Set);
  });

  it('contains expected domestic form types', () => {
    const expected = ['10-K', '10-K/A', '10-Q', '10-Q/A', '8-K', '8-K/A', 'S-1', 'S-1/A'];
    for (const form of expected) {
      expect(PARSEABLE_FORMS.has(form)).toBe(true);
    }
  });

  it('does not contain foreign filer forms', () => {
    expect(PARSEABLE_FORMS.has('6-K')).toBe(false);
    expect(PARSEABLE_FORMS.has('20-F')).toBe(false);
    expect(PARSEABLE_FORMS.has('40-F')).toBe(false);
  });
});

// ─── Staleness detection ──────────────────────────────────────────────────────

describe('getStaleFilings', () => {
  it('returns empty array when all filings are current version', () => {
    const filings = [
      mockFiling({ accessionNumber: 'acc-001', parserVersion: PARSER_VERSION }),
      mockFiling({ accessionNumber: 'acc-002', parserVersion: PARSER_VERSION }),
    ];
    expect(getStaleFilings(filings)).toHaveLength(0);
  });

  it('returns stale filings when parserVersion differs', () => {
    const filings = [
      mockFiling({ accessionNumber: 'acc-001', parserVersion: '0.9.0' }),
      mockFiling({ accessionNumber: 'acc-002', parserVersion: PARSER_VERSION }),
      mockFiling({ accessionNumber: 'acc-003', parserVersion: '0.8.0' }),
    ];
    const stale = getStaleFilings(filings);
    expect(stale).toHaveLength(2);
    expect(stale.map(f => f.accessionNumber)).toContain('acc-001');
    expect(stale.map(f => f.accessionNumber)).toContain('acc-003');
  });

  it('returns all filings when all are stale', () => {
    const filings = [
      mockFiling({ accessionNumber: 'acc-001', parserVersion: '0.1.0' }),
      mockFiling({ accessionNumber: 'acc-002', parserVersion: '0.1.0' }),
    ];
    expect(getStaleFilings(filings)).toHaveLength(2);
  });

  it('returns empty array when filings array is empty', () => {
    expect(getStaleFilings([])).toHaveLength(0);
  });
});

describe('hasStaleFilings', () => {
  it('returns false when all filings are current', () => {
    const filings = [mockFiling({ parserVersion: PARSER_VERSION })];
    expect(hasStaleFilings(filings)).toBe(false);
  });

  it('returns true when any filing has an old parser version', () => {
    const filings = [
      mockFiling({ accessionNumber: 'acc-001', parserVersion: PARSER_VERSION }),
      mockFiling({ accessionNumber: 'acc-002', parserVersion: '0.9.0' }),
    ];
    expect(hasStaleFilings(filings)).toBe(true);
  });

  it('returns false when filings array is empty', () => {
    expect(hasStaleFilings([])).toBe(false);
  });
});
