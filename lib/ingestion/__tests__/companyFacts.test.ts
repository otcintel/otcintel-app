/**
 * Tests for lib/ingestion/fetchers/edgar/companyFacts.ts
 *
 * Coverage:
 *   1. CIK zero-padding
 *   2. Correct SEC Company Facts URL construction
 *   3. Correct EDGAR request headers (User-Agent, Accept)
 *   4. Successful JSON response → CompanyFactsAvailable
 *   5. 404 → CompanyFactsUnavailable (not an error throw)
 *   6. Non-404 HTTP error → throws Error
 *   7. Request deduplication — second call for same CIK hits cache, not network
 *   8. Malformed JSON → throws SyntaxError
 *   9. Cache isolation between test cases via resetCompanyFactsCache()
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  fetchCompanyFacts,
  resetCompanyFactsCache,
  companyFactsCacheSize,
  padCik,
} from '../fetchers/edgar/companyFacts';
import type { CompanyFacts } from '../fetchers/edgar/companyFacts';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_CIK_RAW    = '1655050';
const MOCK_CIK_PADDED = '0001655050';

const MOCK_COMPANY_FACTS: CompanyFacts = {
  cik: 1655050,
  entityName: 'ABVC BioPharma Inc.',
  facts: {
    'us-gaap': {
      CashAndCashEquivalentsAtCarryingValue: {
        label: 'Cash and Cash Equivalents',
        units: {
          USD: [
            {
              end:    '2026-03-31',
              val:    1234567,
              accn:   '0001655050-26-000001',
              fy:     2026,
              fp:     'Q1',
              form:   '10-Q',
              filed:  '2026-05-15',
              frame:  'CY2026Q1I',
            },
          ],
        },
      },
    },
    dei: {},
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockFetchSuccess(body: unknown, status = 200): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok:     status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : String(status),
    json:   vi.fn().mockResolvedValue(body),
  }));
}

function mockFetchHttpError(status: number, statusText: string): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok:         false,
    status,
    statusText,
    json:       vi.fn().mockRejectedValue(new Error('should not parse on error')),
  }));
}

function mockFetchMalformedJson(): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok:         true,
    status:     200,
    statusText: 'OK',
    json:       vi.fn().mockRejectedValue(new SyntaxError('Unexpected token < in JSON')),
  }));
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  // resetCompanyFactsCache also resets _lastRequestAt so each test starts
  // with no rate-limit debt — at most one 110 ms pause per test.
  resetCompanyFactsCache();
  vi.unstubAllGlobals();
});

// ─── 1. CIK zero-padding ──────────────────────────────────────────────────────

describe('padCik', () => {
  it('pads a short numeric string to 10 digits', () => {
    expect(padCik('1655050')).toBe('0001655050');
  });

  it('leaves a 10-digit string unchanged', () => {
    expect(padCik('0001655050')).toBe('0001655050');
  });

  it('accepts a numeric CIK', () => {
    expect(padCik(1655050)).toBe('0001655050');
  });

  it('strips leading CIK prefix (case-insensitive)', () => {
    expect(padCik('CIK1655050')).toBe('0001655050');
    expect(padCik('cik1655050')).toBe('0001655050');
  });

  it('handles a CIK that is already zero-padded', () => {
    expect(padCik('0001655050')).toBe('0001655050');
  });

  it('pads a single-digit CIK', () => {
    expect(padCik('1')).toBe('0000000001');
  });
});

// ─── 2. Correct SEC Company Facts URL ─────────────────────────────────────────

describe('fetchCompanyFacts — URL construction', () => {
  it('builds the correct EDGAR XBRL company facts URL with padded CIK', async () => {
    mockFetchSuccess(MOCK_COMPANY_FACTS);

    await fetchCompanyFacts(MOCK_CIK_RAW);

    const calledUrl = (vi.mocked(fetch).mock.calls[0][0] as string);
    expect(calledUrl).toBe(
      `https://data.sec.gov/api/xbrl/companyfacts/CIK${MOCK_CIK_PADDED}.json`,
    );
  });

  it('uses the padded CIK in the URL even when called with an unpadded numeric CIK', async () => {
    mockFetchSuccess(MOCK_COMPANY_FACTS);

    await fetchCompanyFacts(1655050);

    const calledUrl = (vi.mocked(fetch).mock.calls[0][0] as string);
    expect(calledUrl).toContain('CIK0001655050');
  });
});

// ─── 3. Correct EDGAR headers ─────────────────────────────────────────────────

describe('fetchCompanyFacts — request headers', () => {
  it('sends the OTCIntel User-Agent header', async () => {
    mockFetchSuccess(MOCK_COMPANY_FACTS);

    await fetchCompanyFacts(MOCK_CIK_RAW);

    const headers = (vi.mocked(fetch).mock.calls[0][1] as RequestInit)?.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('OTCIntel/1.0 (contact: alec@otcintel.com)');
  });

  it('requests JSON via the Accept header', async () => {
    mockFetchSuccess(MOCK_COMPANY_FACTS);

    await fetchCompanyFacts(MOCK_CIK_RAW);

    const headers = (vi.mocked(fetch).mock.calls[0][1] as RequestInit)?.headers as Record<string, string>;
    expect(headers['Accept']).toBe('application/json');
  });
});

// ─── 4. Successful JSON response ──────────────────────────────────────────────

describe('fetchCompanyFacts — success', () => {
  it('returns available:true with the parsed CompanyFacts on a 200 response', async () => {
    mockFetchSuccess(MOCK_COMPANY_FACTS);

    const result = await fetchCompanyFacts(MOCK_CIK_RAW);

    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.facts.entityName).toBe('ABVC BioPharma Inc.');
      expect(result.facts.cik).toBe(1655050);
      expect(result.facts.facts['us-gaap']).toBeDefined();
    }
  });

  it('preserves the full us-gaap concept structure in the returned facts', async () => {
    mockFetchSuccess(MOCK_COMPANY_FACTS);

    const result = await fetchCompanyFacts(MOCK_CIK_RAW);

    expect(result.available).toBe(true);
    if (result.available) {
      const values = result.facts.facts['us-gaap']
        ?.CashAndCashEquivalentsAtCarryingValue
        ?.units.USD;
      expect(values).toHaveLength(1);
      expect(values![0].val).toBe(1234567);
      expect(values![0].fp).toBe('Q1');
    }
  });
});

// ─── 5. 404 → XBRL unavailable ───────────────────────────────────────────────

describe('fetchCompanyFacts — 404 handling', () => {
  it('returns available:false (not a throw) when EDGAR returns 404', async () => {
    mockFetchHttpError(404, 'Not Found');

    const result = await fetchCompanyFacts(MOCK_CIK_RAW);

    expect(result.available).toBe(false);
  });

  it('includes a descriptive reason string in the unavailable result', async () => {
    mockFetchHttpError(404, 'Not Found');

    const result = await fetchCompanyFacts(MOCK_CIK_RAW);

    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toContain(MOCK_CIK_PADDED);
      expect(result.reason).toContain('404');
    }
  });

  it('does not throw on 404', async () => {
    mockFetchHttpError(404, 'Not Found');

    await expect(fetchCompanyFacts(MOCK_CIK_RAW)).resolves.not.toThrow();
  });
});

// ─── 6. Non-404 HTTP errors ───────────────────────────────────────────────────

describe('fetchCompanyFacts — non-404 HTTP errors', () => {
  it('throws on 500 Internal Server Error', async () => {
    mockFetchHttpError(500, 'Internal Server Error');

    await expect(fetchCompanyFacts(MOCK_CIK_RAW)).rejects.toThrow(
      /500.*Internal Server Error|Internal Server Error.*500/,
    );
  });

  it('throws on 429 Too Many Requests', async () => {
    mockFetchHttpError(429, 'Too Many Requests');

    await expect(fetchCompanyFacts(MOCK_CIK_RAW)).rejects.toThrow('429');
  });

  it('throws on 503 Service Unavailable', async () => {
    mockFetchHttpError(503, 'Service Unavailable');

    await expect(fetchCompanyFacts(MOCK_CIK_RAW)).rejects.toThrow(/503|Service Unavailable/);
  });

  it('includes the CIK in non-404 error messages for debuggability', async () => {
    mockFetchHttpError(500, 'Internal Server Error');

    await expect(fetchCompanyFacts(MOCK_CIK_RAW)).rejects.toThrow(MOCK_CIK_PADDED);
  });
});

// ─── 7. Caching / deduplication ──────────────────────────────────────────────

describe('fetchCompanyFacts — caching and deduplication', () => {
  it('makes exactly one network request for two calls with the same CIK', async () => {
    mockFetchSuccess(MOCK_COMPANY_FACTS);

    await fetchCompanyFacts(MOCK_CIK_RAW);
    await fetchCompanyFacts(MOCK_CIK_RAW);

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('makes exactly one request when the same CIK is passed in different formats', async () => {
    mockFetchSuccess(MOCK_COMPANY_FACTS);

    await fetchCompanyFacts('1655050');           // unpadded string
    await fetchCompanyFacts('0001655050');         // padded string
    await fetchCompanyFacts(1655050);              // numeric

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('returns the cached result on subsequent calls', async () => {
    mockFetchSuccess(MOCK_COMPANY_FACTS);

    const first  = await fetchCompanyFacts(MOCK_CIK_RAW);
    const second = await fetchCompanyFacts(MOCK_CIK_RAW);

    expect(second).toBe(first); // same object reference — not a copy
  });

  it('caches a 404 result so the unavailable company is not re-requested', async () => {
    mockFetchHttpError(404, 'Not Found');

    await fetchCompanyFacts(MOCK_CIK_RAW);
    await fetchCompanyFacts(MOCK_CIK_RAW);

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('makes separate requests for different CIKs', async () => {
    mockFetchSuccess(MOCK_COMPANY_FACTS);

    await fetchCompanyFacts('1655050');
    await fetchCompanyFacts('1782430');

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it('resetCompanyFactsCache() clears the cache so subsequent calls hit the network', async () => {
    mockFetchSuccess(MOCK_COMPANY_FACTS);

    await fetchCompanyFacts(MOCK_CIK_RAW);
    expect(companyFactsCacheSize()).toBe(1);

    resetCompanyFactsCache();
    expect(companyFactsCacheSize()).toBe(0);

    await fetchCompanyFacts(MOCK_CIK_RAW);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
});

// ─── 8. Malformed JSON ────────────────────────────────────────────────────────

describe('fetchCompanyFacts — malformed JSON', () => {
  it('throws a SyntaxError when the response body is not valid JSON', async () => {
    mockFetchMalformedJson();

    await expect(fetchCompanyFacts(MOCK_CIK_RAW)).rejects.toThrow(SyntaxError);
  });

  it('does not cache a malformed-JSON result — next call retries the network', async () => {
    mockFetchMalformedJson();

    await expect(fetchCompanyFacts(MOCK_CIK_RAW)).rejects.toThrow();
    expect(companyFactsCacheSize()).toBe(0);

    // Second call should retry (fetch called twice)
    await expect(fetchCompanyFacts(MOCK_CIK_RAW)).rejects.toThrow();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
});
