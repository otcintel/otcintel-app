/**
 * SEC EDGAR XBRL Company Facts fetcher
 *
 * Fetches the full XBRL company facts document for a single company:
 *   https://data.sec.gov/api/xbrl/companyfacts/CIK{10-digit-padded}.json
 *
 * The response contains every XBRL-tagged financial concept ever filed by the
 * company, organized by taxonomy (us-gaap, dei, etc.) and concept name. Each
 * concept carries a list of time-series values with period metadata, accession
 * numbers, and filed dates — the inputs for Phase 7 financial extraction.
 *
 * Design decisions:
 *   - 404 is treated as "XBRL unavailable", not an error. Many OTC companies
 *     file HTML-only without XBRL tagging; this is a valid state.
 *   - Any other non-2xx response is a network/server error and is thrown.
 *   - Results are cached in a module-level Map keyed by zero-padded CIK so
 *     repeated calls within a single ingestion run make only one network request.
 *   - Rate limiting matches the existing EDGAR fetcher (110 ms between requests).
 *   - No financial concept parsing is done here — raw structure only.
 */

const EDGAR_XBRL_BASE_URL = 'https://data.sec.gov';
const USER_AGENT          = 'OTCIntel/1.0 (contact: alec@otcintel.com)';
const RATE_LIMIT_MS       = 110;

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A single filed value for a XBRL concept.
 *
 * Instant values (balance sheet) have `end` but no `start`.
 * Duration values (income/cash flow) have both `start` and `end`.
 */
export interface XbrlConceptValue {
  /** Period end date (ISO date string: YYYY-MM-DD) */
  end: string;
  /** Period start date — present only for duration values (income statement, cash flow) */
  start?: string;
  /** Reported value in the concept's unit (USD for financial figures) */
  val: number;
  /** Accession number of the filing that reported this value */
  accn: string;
  /** Fiscal year */
  fy: number | null;
  /** Fiscal period: Q1 | Q2 | Q3 | FY */
  fp: string | null;
  /** Form type: 10-K | 10-Q | 10-K/A | 10-Q/A | 8-K | etc. */
  form: string;
  /** Date the filing was submitted to EDGAR (ISO date string) */
  filed: string;
  /** EDGAR frame identifier — e.g. CY2026Q1I (optional, absent for some filings) */
  frame?: string;
}

/** One XBRL concept with its full value history. */
export interface XbrlConceptData {
  label: string;
  description?: string;
  units: {
    /** USD-denominated values — the primary unit for financial statement concepts */
    USD?: XbrlConceptValue[];
    /** Share counts — present on equity-related concepts */
    shares?: XbrlConceptValue[];
    /** Dimensionless ratios */
    pure?: XbrlConceptValue[];
    /** Any other unit (days, months, etc.) */
    [unit: string]: XbrlConceptValue[] | undefined;
  };
}

/** Typed shape of the EDGAR XBRL company facts JSON response. */
export interface CompanyFacts {
  /** Numeric CIK (not zero-padded) */
  cik: number;
  entityName: string;
  facts: {
    /** US GAAP taxonomy — primary source for financial statement concepts */
    'us-gaap'?: Record<string, XbrlConceptData>;
    /** SEC disclosure elements — entity name, fiscal year end, etc. */
    'dei'?: Record<string, XbrlConceptData>;
    /** Any other taxonomy filed by this company */
    [namespace: string]: Record<string, XbrlConceptData> | undefined;
  };
}

/** Successful fetch result — XBRL data is present and parsed. */
export interface CompanyFactsAvailable {
  available: true;
  facts: CompanyFacts;
}

/**
 * XBRL unavailable result — company has not filed XBRL-tagged documents.
 * This is not an error; it is a valid state for OTC filers.
 */
export interface CompanyFactsUnavailable {
  available: false;
  /** Human-readable reason: typically "404 Not Found" or similar. */
  reason: string;
}

export type CompanyFactsResult = CompanyFactsAvailable | CompanyFactsUnavailable;

// ─── Module-level state ───────────────────────────────────────────────────────

/**
 * Per-run cache keyed by zero-padded CIK.
 * One ingestion run → one request per company, regardless of how many times
 * fetchCompanyFacts is called with the same CIK.
 */
const _cache = new Map<string, CompanyFactsResult>();

/** Timestamp of the last EDGAR request — enforces rate limiting. */
let _lastRequestAt = 0;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Pad a CIK to exactly 10 digits, as required by the EDGAR XBRL endpoint.
 * Accepts numeric CIKs, string CIKs, and strings with a leading "CIK" prefix.
 */
export function padCik(cik: string | number): string {
  return String(cik).replace(/^CIK/i, '').trim().padStart(10, '0');
}

function edgarHeaders(): Record<string, string> {
  return {
    'User-Agent': USER_AGENT,
    'Accept':     'application/json',
  };
}

async function rateLimit(): Promise<void> {
  const elapsed = Date.now() - _lastRequestAt;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise<void>(resolve => setTimeout(resolve, RATE_LIMIT_MS - elapsed));
  }
  _lastRequestAt = Date.now();
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch the XBRL company facts document for a single company.
 *
 * @param cik - The company's CIK. May be numeric, unpadded, or prefixed with "CIK".
 *              Zero-padded to 10 digits internally.
 * @returns CompanyFactsAvailable when XBRL data exists, CompanyFactsUnavailable
 *          when the company has no XBRL filing history (404).
 * @throws  Error on network failures or non-404 HTTP errors.
 */
export async function fetchCompanyFacts(cik: string | number): Promise<CompanyFactsResult> {
  const paddedCik = padCik(cik);

  if (_cache.has(paddedCik)) {
    return _cache.get(paddedCik)!;
  }

  await rateLimit();

  const url = `${EDGAR_XBRL_BASE_URL}/api/xbrl/companyfacts/CIK${paddedCik}.json`;
  const res = await fetch(url, { headers: edgarHeaders() });

  if (res.status === 404) {
    const result: CompanyFactsUnavailable = {
      available: false,
      reason:    `XBRL company facts not found for CIK ${paddedCik} (404)`,
    };
    _cache.set(paddedCik, result);
    return result;
  }

  if (!res.ok) {
    throw new Error(
      `EDGAR company facts fetch failed for CIK ${paddedCik}: ${res.status} ${res.statusText}`,
    );
  }

  const facts = await res.json() as CompanyFacts;
  const result: CompanyFactsAvailable = { available: true, facts };
  _cache.set(paddedCik, result);
  return result;
}

/**
 * Clear the in-process cache and reset rate-limit state.
 * Call at the start of each ingestion run to ensure stale data from a previous
 * run does not carry over. Also used in tests to isolate test cases.
 */
export function resetCompanyFactsCache(): void {
  _cache.clear();
  _lastRequestAt = 0;
}

/** Expose cache size for observability / tests. */
export function companyFactsCacheSize(): number {
  return _cache.size;
}
