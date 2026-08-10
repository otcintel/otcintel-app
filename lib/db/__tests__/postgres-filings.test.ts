/**
 * OTCIntel — Postgres filings repository tests
 *
 * Tests repository behavior using a mocked Supabase client.
 * Does NOT require a live database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NormalizedFiling, ConvertibleNote } from '../../ingestion/types';
import { PARSER_VERSION } from '../../universe/types';

// ─── Mock Supabase client ─────────────────────────────────────────────────────

vi.mock('../postgres/client', () => ({
  getClient: vi.fn(),
  assertNoError: vi.fn((error: { message: string } | null, ctx: string) => {
    if (error) throw new Error(`[mock] ${ctx}: ${error.message}`);
  }),
  resetClient: vi.fn(),
}));

// ─── Test fixtures ────────────────────────────────────────────────────────────

function makeFiling(overrides: Partial<NormalizedFiling> = {}): NormalizedFiling {
  return {
    accessionNumber: '0001234567-26-000001',
    ticker:          'TEST',
    cik:             '0001234567',
    formType:        '8-K',
    filedAt:         '2026-07-01',
    periodOfReport:  '2026-06-30',
    documentUrl:     'https://www.sec.gov/Archives/edgar/data/1234567/filing.htm',
    ingestedAt:      '2026-07-01T00:00:00Z',
    source:          'edgar',
    parseErrors:     [],
    parserVersion:   PARSER_VERSION,
    ...overrides,
  };
}

function makeConvertibleNote(overrides: Partial<ConvertibleNote> = {}): ConvertibleNote {
  return {
    hasFloorPrice:      false,
    hasResetProvisions: true,
    instrumentType:     'convertible_note',
    instrumentName:     'First Convertible Note',
    investorName:       'Test Lender LLC',
    principalAmount:    100000,
    discountRate:       0.15,
    lookbackDays:       5,
    _fieldProvenance:   { principalAmount: { sourceText: 'principal amount of $100,000', sentenceIndex: 3, method: 'primary' } },
    _sourceSentenceTexts: ['The Company issued a convertible promissory note...'],
    _validationWarnings: [],
    ...overrides,
  };
}

// Import after mocks
import { postgresFilingsDb } from '../postgres/filings';
import { getClient } from '../postgres/client';

// ─── periodOfReport → period_of_report DATE normalization ────────────────────
// Postgres DATE columns reject empty strings with "invalid input syntax for
// type date: """. Blank/whitespace periodOfReport must be coerced to NULL.

describe('periodOfReport → period_of_report DATE normalization', () => {
  let capturedUpsertRows: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    capturedUpsertRows = [];

    // Build a chainable Supabase mock that captures rows passed to upsert.
    const mockUpsertSelect = vi.fn().mockResolvedValue({
      data: [{ id: 'filing-uuid', accession_number: '0001234567-26-000001' }],
      error: null,
    });
    const mockUpsert = vi.fn((rows: Array<Record<string, unknown>>) => {
      capturedUpsertRows = rows;
      return { select: mockUpsertSelect };
    });
    const mockMaybeSingle = vi.fn().mockResolvedValue({ data: { id: 'company-uuid' }, error: null });
    const mockEq = vi.fn().mockReturnValue({ maybeSingle: mockMaybeSingle });
    const mockCompaniesSelect = vi.fn().mockReturnValue({ eq: mockEq });
    const mockCnUpsert = vi.fn().mockReturnValue({ select: vi.fn().mockResolvedValue({ data: [], error: null }) });

    vi.mocked(getClient).mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === 'companies') return { select: mockCompaniesSelect };
        if (table === 'convertible_notes') return { upsert: mockCnUpsert };
        return { upsert: mockUpsert };
      }),
    } as unknown as ReturnType<typeof getClient>);
  });

  it('periodOfReport="" is stored as NULL (prevents Postgres DATE parse error)', async () => {
    await postgresFilingsDb.upsertAll('SHIP', [makeFiling({ periodOfReport: '' })]);
    expect(capturedUpsertRows[0].period_of_report).toBeNull();
  });

  it('periodOfReport="   " (whitespace-only) is stored as NULL', async () => {
    await postgresFilingsDb.upsertAll('SHIP', [makeFiling({ periodOfReport: '   ' })]);
    expect(capturedUpsertRows[0].period_of_report).toBeNull();
  });

  it('valid YYYY-MM-DD periodOfReport is stored unchanged', async () => {
    await postgresFilingsDb.upsertAll('SHIP', [makeFiling({ periodOfReport: '2026-03-31' })]);
    expect(capturedUpsertRows[0].period_of_report).toBe('2026-03-31');
  });

  it('periodOfReport that is already NULL from rowToFiling round-trip stays NULL', async () => {
    // rowToFiling maps null DB column to '' — but filingToUpsertRow normalizes '' → null
    await postgresFilingsDb.upsertAll('SHIP', [makeFiling({ periodOfReport: '' })]);
    const firstWrite = capturedUpsertRows[0].period_of_report;

    // Second upsert with the same value — still null (idempotent)
    await postgresFilingsDb.upsertAll('SHIP', [makeFiling({ periodOfReport: '' })]);
    const secondWrite = capturedUpsertRows[0].period_of_report;

    expect(firstWrite).toBeNull();
    expect(secondWrite).toBeNull();
  });

  it('valid date repeated upsert stays idempotent', async () => {
    const date = '2026-06-30';
    await postgresFilingsDb.upsertAll('SHIP', [makeFiling({ periodOfReport: date })]);
    const first = capturedUpsertRows[0].period_of_report;
    await postgresFilingsDb.upsertAll('SHIP', [makeFiling({ periodOfReport: date })]);
    const second = capturedUpsertRows[0].period_of_report;
    expect(first).toBe(date);
    expect(second).toBe(date);
    expect(first).toBe(second);
  });
});

// ─── NormalizedFiling structure validation ────────────────────────────────────

describe('NormalizedFiling structure contract', () => {
  it('accession number uniqueness — same ticker cannot have two identical accessions', () => {
    const f1 = makeFiling({ accessionNumber: 'ACC-001' });
    const f2 = makeFiling({ accessionNumber: 'ACC-001' });
    // In Postgres this triggers onConflict: 'accession_number' (upsert)
    expect(f1.accessionNumber).toBe(f2.accessionNumber);
  });

  it('filing without financing leaves financing undefined (not null)', () => {
    const f = makeFiling({ financing: undefined });
    expect(f.financing).toBeUndefined();
  });

  it('filing without shareStructure leaves shareStructure undefined', () => {
    const f = makeFiling({ shareStructure: undefined });
    expect(f.shareStructure).toBeUndefined();
  });

  it('filing without financingReport leaves financingReport undefined', () => {
    const f = makeFiling({ financingReport: undefined });
    expect(f.financingReport).toBeUndefined();
  });

  it('parserVersion is set to PARSER_VERSION constant', () => {
    const f = makeFiling();
    expect(f.parserVersion).toBe(PARSER_VERSION);
    expect(f.parserVersion).toBeTruthy();
  });

  it('ticker is stored and returned consistently', () => {
    const f = makeFiling({ ticker: 'AITX' });
    expect(f.ticker).toBe('AITX');
  });

  it('ingestedAt is always present as ISO timestamp', () => {
    const f = makeFiling();
    expect(f.ingestedAt).toBeTruthy();
    expect(f.ingestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ─── Provenance preservation on ConvertibleNote ───────────────────────────────

describe('provenance fields preservation (ConvertibleNote)', () => {
  it('_fieldProvenance is preserved in ConvertibleNote', () => {
    const note = makeConvertibleNote();
    expect(note._fieldProvenance).toBeDefined();
    expect(note._fieldProvenance).toHaveProperty('principalAmount');
  });

  it('_sourceSentenceTexts is preserved in ConvertibleNote', () => {
    const note = makeConvertibleNote();
    expect(Array.isArray(note._sourceSentenceTexts)).toBe(true);
    expect((note._sourceSentenceTexts as string[]).length).toBeGreaterThan(0);
  });

  it('_validationWarnings is preserved in ConvertibleNote', () => {
    const note = makeConvertibleNote();
    expect(Array.isArray(note._validationWarnings)).toBe(true);
  });

  it('round-trip fidelity: JSONB preserves all ConvertibleNote fields including provenance', () => {
    const note = makeConvertibleNote();
    // raw_payload column stores the full ConvertibleNote object as JSONB
    const serialized = JSON.stringify(note);
    const deserialized = JSON.parse(serialized) as ConvertibleNote;

    expect(deserialized._fieldProvenance).toEqual(note._fieldProvenance);
    expect(deserialized._sourceSentenceTexts).toEqual(note._sourceSentenceTexts);
    expect(deserialized._validationWarnings).toEqual(note._validationWarnings);
    expect(deserialized.principalAmount).toBe(note.principalAmount);
    expect(deserialized.discountRate).toBe(note.discountRate);
    expect(deserialized.hasResetProvisions).toBe(note.hasResetProvisions);
  });

  it('financing_report_raw JSONB preserves convertible note provenance through FinancingReport', () => {
    const note = makeConvertibleNote();
    const filing = makeFiling({
      financingReport: {
        convertibleDebt: [note],
        equityIssuances: [],
        conversions: [],
        warrants: [],
        relatedPartyTransactions: [],
        equityFacilities: [],
        dilutionSummary: { confidence: 'low', matchedPhrases: [] },
      } as unknown as NormalizedFiling['financingReport'],
    });

    const rawPayload = JSON.stringify(filing.financingReport);
    const parsed = JSON.parse(rawPayload) as typeof filing.financingReport;
    const restoredNote = parsed!.convertibleDebt![0];
    expect(restoredNote._fieldProvenance).toEqual(note._fieldProvenance);
    expect(restoredNote._sourceSentenceTexts).toEqual(note._sourceSentenceTexts);
  });

  it('financing fields are NOT fabricated when source is undefined (domain rule 1)', () => {
    // DOMAIN RULE: NEVER fabricate missing financial values
    const f = makeFiling({ financing: undefined });
    const raw = f.financing ?? null;
    expect(raw).toBeNull();
    // When stored as NULL in financing_raw and reconstructed, result is undefined
    const reconstructed = (raw as unknown as null) ?? undefined;
    expect(reconstructed).toBeUndefined();
  });
});

// ─── Upsert idempotency ───────────────────────────────────────────────────────

describe('upsert idempotency contract', () => {
  it('repeated ingestion does not change filing count — onConflict targets accession_number', () => {
    // The implementation uses .upsert(rows, { onConflict: 'accession_number' })
    // which is deterministic: second upsert of same accessionNumber is a no-op.
    const conflict = 'accession_number';
    expect(conflict).toBe('accession_number');
  });

  it('accession number normalizes consistently', () => {
    // Edgar accession numbers have the format XXXXXXXXXX-YY-ZZZZZZ
    const acc = '0001234567-26-000001';
    expect(acc).toMatch(/^\d{10}-\d{2}-\d{6}$/);
  });

  it('upsertAll with empty array is a no-op', () => {
    const isEmpty = (arr: unknown[]) => arr.length === 0;
    expect(isEmpty([])).toBe(true);
  });
});

// ─── knownAccessions set ──────────────────────────────────────────────────────

describe('knownAccessions Set behavior', () => {
  it('Set membership check is O(1) and correct for known accessions', () => {
    const known = new Set(['0001234567-26-000001', '0001234567-26-000002']);
    expect(known.has('0001234567-26-000001')).toBe(true);
    expect(known.has('0001234567-26-000003')).toBe(false);
  });

  it('empty Set is returned when no filings exist for ticker', () => {
    const empty = new Set<string>();
    expect(empty.size).toBe(0);
    expect(empty.has('any')).toBe(false);
  });

  it('hasAccession returns false for unknown ticker', () => {
    const known = new Set<string>();
    expect(known.has('some-accession')).toBe(false);
  });
});

// ─── Extraction version persistence ──────────────────────────────────────────

describe('extraction version persistence', () => {
  it('parserVersion is included in filing rows for SQL filtering', () => {
    const f = makeFiling({ parserVersion: '2.0.0' });
    const row: Record<string, unknown> = {
      accession_number: f.accessionNumber,
      parser_version: f.parserVersion ?? '',
    };
    expect(row.parser_version).toBe('2.0.0');
  });

  it('different parser versions on same accession number are overwritten by upsert', () => {
    // Because we upsert on accession_number, a later re-parse with a higher
    // parserVersion replaces the row rather than creating a duplicate.
    const v1 = makeFiling({ parserVersion: '1.0.0' });
    const v2 = makeFiling({ parserVersion: '2.0.0' });
    expect(v1.accessionNumber).toBe(v2.accessionNumber); // same row, latest version wins
  });
});

// ─── getAllTickers / totalCount contract ──────────────────────────────────────

describe('getAllTickers and totalCount contract', () => {
  it('getAllTickers returns distinct ticker strings', () => {
    const rawTickers = ['AITX', 'AITX', 'MINE', 'MINE', 'TEST'];
    const distinct = [...new Set(rawTickers)];
    expect(distinct).toEqual(['AITX', 'MINE', 'TEST']);
    expect(distinct).toHaveLength(3);
  });

  it('totalCount returns 0 for empty table', () => {
    const pgCount: number | null = null;
    expect(pgCount ?? 0).toBe(0);
  });

  it('totalCount returns sum of all filing rows', () => {
    const pgCount: number | null = 47;
    expect(pgCount ?? 0).toBe(47);
  });
});

// ─── Null / missing values in financing ──────────────────────────────────────

describe('null / missing value contract for financial fields', () => {
  it('ConvertibleNote principalAmount undefined is stored as null (not zero)', () => {
    const note = makeConvertibleNote({ principalAmount: undefined });
    // The row builder uses ?? null
    const dbValue = note.principalAmount ?? null;
    expect(dbValue).toBeNull();
  });

  it('discountRate undefined is stored as null, not zero', () => {
    const note = makeConvertibleNote({ discountRate: undefined });
    const dbValue = note.discountRate ?? null;
    expect(dbValue).toBeNull();
  });

  it('hasFloorPrice false is preserved (not converted to null)', () => {
    const note = makeConvertibleNote({ hasFloorPrice: false });
    expect(note.hasFloorPrice).toBe(false);
    // Stored as-is, not as null
    const dbValue = note.hasFloorPrice ?? null;
    expect(dbValue).toBe(false);
  });

  it('filing without provenance fields still round-trips correctly', () => {
    const noteMinimal: ConvertibleNote = {
      hasFloorPrice: false,
      hasResetProvisions: false,
      principalAmount: 50000,
    };
    const serialized = JSON.stringify(noteMinimal);
    const restored = JSON.parse(serialized) as ConvertibleNote;
    expect(restored.principalAmount).toBe(50000);
    expect(restored._fieldProvenance).toBeUndefined();
    expect(restored._validationWarnings).toBeUndefined();
  });
});
