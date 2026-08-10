/**
 * SEC EDGAR filing fetcher
 *
 * Implements IFilingFetcher against the real SEC EDGAR public data API.
 * This is a production-ready scaffold — wire it up by switching the fetcher
 * mode to 'edgar' in createFilingFetcher().
 *
 * SEC EDGAR data API docs: https://www.sec.gov/developer
 *
 * Rate limits:
 *   - EDGAR requires a User-Agent header identifying the requester
 *   - Max 10 requests/second per the EDGAR fair-access policy
 *   - Default rateLimitMs is 110ms (slightly above the 100ms minimum)
 */

import type {
  IFilingFetcher,
  RawFiling,
  FilingIndexResult,
  FetchOptions,
  FilingFetcherConfig,
  SecFormType,
} from '../types';
import { TIER_1_FORM_TYPES, TIER_2_FORM_TYPES } from '../types';

/** EDGAR submissions API response shape (partial) */
interface EdgarSubmissionsResponse {
  cik: string;
  name: string;
  tickers: string[];
  filings: {
    recent: {
      accessionNumber: string[];
      filingDate: string[];
      /** Period of report — EDGAR returns this as "reportDate", not "periodOfReport" */
      reportDate: string[];
      form: string[];
      primaryDocument: string[];
      /** 8-K item numbers, e.g. "1.01,9.01" — empty string for non-8-K forms */
      items: string[];
    };
  };
}

const EDGAR_DATA_BASE_URL    = 'https://data.sec.gov';
const EDGAR_WWW_BASE_URL     = 'https://www.sec.gov';   // company_tickers.json lives here
const EDGAR_ARCHIVE_BASE_URL = 'https://www.sec.gov/Archives/edgar/data';
const DEFAULT_RATE_LIMIT_MS  = 110;
const DEFAULT_MAX_FILINGS    = 20;

/**
 * How many entries to scan from EDGAR's recent list when building the
 * prioritized result set.  EDGAR returns filings in strict reverse-chronological
 * order, so high-volume filers (e.g. large-caps) can have 50-100 Form 4 /
 * insider entries before the first 8-K.  Scanning 100 ensures Tier 1/2 filings
 * are found even for those tickers without making the result set unmanageably
 * large (we still slice to resultLimit after sorting).
 */
const SCAN_WINDOW = 100;

/**
 * Pad a CIK to 10 digits, as required by the EDGAR submissions endpoint.
 * e.g. "1876543" or 1876543 → "0001876543"
 *
 * Note: the company_tickers.json file returns cik_str as a number, not a
 * string, despite the field name.  Coerce to string defensively.
 */
function padCik(cik: string | number): string {
  return String(cik).replace(/^CIK/i, '').trim().padStart(10, '0');
}

/**
 * Convert an accession number to the path format used in EDGAR archive URLs.
 * e.g. "0001876543-26-000001" → "0001876543/26/000001" → "000187654326000001"
 */
function accessionToPath(accessionNumber: string): string {
  return accessionNumber.replace(/-/g, '');
}

export class EdgarFilingFetcher implements IFilingFetcher {
  readonly mode = 'edgar' as const;

  private readonly baseUrl: string;
  private readonly archiveUrl: string;
  private readonly rateLimitMs: number;
  private readonly maxFilings: number;
  private readonly userAgent: string;
  private lastRequestAt = 0;

  /**
   * Per-instance caches so multiple fetchFilingsIndex calls for the same ticker
   * within a single pipeline run (recent scan + extended scans) only hit EDGAR
   * once for the CIK lookup and once for the submissions JSON.
   * All subsequent calls do in-memory filtering on the cached response.
   */
  private readonly cikCache         = new Map<string, string>();
  private readonly submissionsCache  = new Map<string, EdgarSubmissionsResponse>();

  constructor(config: FilingFetcherConfig) {
    this.baseUrl     = config.edgarBaseUrl ?? EDGAR_DATA_BASE_URL;
    this.archiveUrl  = EDGAR_ARCHIVE_BASE_URL;
    this.rateLimitMs = config.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS;
    this.maxFilings  = config.maxFilings ?? DEFAULT_MAX_FILINGS;
    // EDGAR requires a descriptive User-Agent — see https://www.sec.gov/os/accessing-edgar-data
    this.userAgent   = 'OTCIntel/1.0 (contact: alec@otcintel.com)';
  }

  async fetchFilingsIndex(ticker: string, options?: FetchOptions): Promise<FilingIndexResult> {
    // Step 1: resolve ticker → CIK (cached after first call for this ticker)
    const cik = await this.resolveCik(ticker);

    // Step 2: fetch the submissions JSON (cached after first call for this CIK).
    // Multiple fetchFilingsIndex calls within a single pipeline run — e.g. the
    // recent scan followed by targeted extended scans — all hit the same cached
    // response so only one network request is made per ticker per fetcher instance.
    let data: EdgarSubmissionsResponse;
    if (this.submissionsCache.has(cik)) {
      data = this.submissionsCache.get(cik)!;
    } else {
      await this.rateLimit();
      const url = `${this.baseUrl}/submissions/CIK${cik}.json`;
      const res = await fetch(url, { headers: this.headers() });
      if (!res.ok) {
        throw new Error(`EDGAR submissions fetch failed for ${ticker} (CIK ${cik}): ${res.status} ${res.statusText}`);
      }
      data = await res.json() as EdgarSubmissionsResponse;
      this.submissionsCache.set(cik, data);
    }

    const recent = data.filings.recent;

    // Step 3: zip parallel arrays into RawFiling records, then prioritize by tier.
    //
    // Strategy:
    //   1. Scan up to scanLimit entries from EDGAR's recent list.
    //      options.scanWindow overrides the default SCAN_WINDOW (100) so callers
    //      can request a deeper scan for targeted historical queries.
    //   2. Apply optional formTypes and since filters.
    //   3. Sort by tier (Tier 1 → 2 → 3) then newest-first within tier.
    //   4. Slice to resultLimit.
    //
    //   Fallback: if the formTypes filter eliminated every candidate but EDGAR
    //   has filings in the scan window, do a second pass ignoring the form type
    //   filter (keeping the since filter) so we never return zero when filings
    //   exist.  The fallback result is still tier-sorted.
    const scanLimit   = Math.min(recent.accessionNumber.length, options?.scanWindow ?? SCAN_WINDOW);
    const resultLimit = options?.limit ?? this.maxFilings;
    const cidStripped = cik.replace(/^0+/, '');

    /** Assign a tier number (lower = higher priority). */
    function tierOf(form: SecFormType): 1 | 2 | 3 {
      if ((TIER_1_FORM_TYPES as string[]).includes(form)) return 1;
      if ((TIER_2_FORM_TYPES as string[]).includes(form)) return 2;
      return 3;
    }

    /** Build a RawFiling record from the parallel EDGAR arrays at index i. */
    const buildFiling = (i: number): RawFiling => {
      const accessionNumber = recent.accessionNumber[i];
      const accessionPath   = accessionToPath(accessionNumber);
      const primaryDoc      = recent.primaryDocument[i];
      return {
        accessionNumber,
        ticker:         ticker.toUpperCase(),
        cik,
        formType:       recent.form[i] as SecFormType,
        filedAt:        recent.filingDate[i],
        periodOfReport: recent.reportDate[i] ?? recent.filingDate[i],
        documentUrl:    `${this.archiveUrl}/${cidStripped}/${accessionPath}/${primaryDoc}`,
        fullTextUrl:    `${this.archiveUrl}/${cidStripped}/${accessionPath}/${accessionNumber}.txt`,
        items:          recent.items[i] || undefined,
      };
    };

    /** Sort an array of RawFilings by tier asc then date desc (mutates in place). */
    function tierSort(arr: RawFiling[]): void {
      arr.sort((a, b) => {
        const tierDiff = tierOf(a.formType) - tierOf(b.formType);
        if (tierDiff !== 0) return tierDiff;
        return b.filedAt.localeCompare(a.filedAt);
      });
    }

    // Primary pass — collect candidates that pass both filters.
    const candidates: RawFiling[] = [];

    for (let i = 0; i < scanLimit; i++) {
      const formType = recent.form[i] as SecFormType;
      if (options?.formTypes?.length && !options.formTypes.includes(formType)) continue;
      const filedAt = recent.filingDate[i];
      if (options?.since && filedAt < options.since) continue;
      candidates.push(buildFiling(i));
    }

    // Fallback pass — if formTypes filter produced zero results, retry without
    // the form type constraint so we always return something when EDGAR has data.
    // The since filter is kept so the date boundary is still respected.
    if (candidates.length === 0 && options?.formTypes?.length) {
      for (let i = 0; i < scanLimit; i++) {
        const filedAt = recent.filingDate[i];
        if (options?.since && filedAt < options.since) continue;
        candidates.push(buildFiling(i));
      }
    }

    tierSort(candidates);
    const filings = candidates.slice(0, resultLimit);

    return {
      ticker: ticker.toUpperCase(),
      cik,
      filings,
      fetchedAt: new Date().toISOString(),
      source: 'edgar',
    };
  }

  async fetchFilingText(filing: RawFiling): Promise<string> {
    await this.rateLimit();
    const res = await fetch(filing.fullTextUrl, { headers: this.headers() });

    if (!res.ok) {
      throw new Error(
        `EDGAR text fetch failed for ${filing.accessionNumber}: ${res.status} ${res.statusText}`
      );
    }

    const raw = await res.text();

    // Strip SGML submission wrapper if present (full-text EDGAR files begin with <SUBMISSION>)
    // and return just the document content for parsing.
    return extractDocumentText(raw);
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private headers(): Record<string, string> {
    return {
      'User-Agent': this.userAgent,
      'Accept': 'application/json, text/plain, */*',
    };
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestAt;
    if (elapsed < this.rateLimitMs) {
      await new Promise(resolve => setTimeout(resolve, this.rateLimitMs - elapsed));
    }
    this.lastRequestAt = Date.now();
  }

  /**
   * Resolve a ticker symbol to a zero-padded 10-digit CIK.
   * Result is cached in cikCache so repeated calls within the same fetcher
   * instance do not re-fetch company_tickers.json.
   */
  private async resolveCik(ticker: string): Promise<string> {
    const upper = ticker.toUpperCase();
    if (this.cikCache.has(upper)) return this.cikCache.get(upper)!;

    await this.rateLimit();
    // company_tickers.json is hosted on www.sec.gov, not data.sec.gov
    const res = await fetch(`${EDGAR_WWW_BASE_URL}/files/company_tickers.json`, {
      headers: this.headers(),
    });

    if (!res.ok) {
      throw new Error(`EDGAR ticker resolution failed: ${res.status} ${res.statusText}`);
    }

    // cik_str is a number in the actual JSON despite the field name
    const tickers: Record<string, { cik_str: number | string; ticker: string; title: string }> =
      await res.json();

    const entry = Object.values(tickers).find(e => e.ticker === upper);

    if (!entry) {
      throw new Error(`Ticker "${ticker}" not found in EDGAR company tickers.`);
    }

    const cik = padCik(entry.cik_str);
    this.cikCache.set(upper, cik);
    return cik;
  }
}

/**
 * Strip EDGAR SGML submission envelope from a full-text filing.
 * Real EDGAR full-text files look like:
 *   <SUBMISSION>
 *   <DOCUMENT>
 *   <TYPE>8-K
 *   <TEXT>
 *   ...actual HTML/text content...
 *   </TEXT>
 *   </DOCUMENT>
 *   </SUBMISSION>
 */
function extractDocumentText(raw: string): string {
  // Try to extract the first <TEXT>...</TEXT> block
  const textMatch = raw.match(/<TEXT>([\s\S]*?)<\/TEXT>/i);
  if (textMatch) return textMatch[1].trim();

  // If no SGML envelope, return as-is (may already be plain HTML/text)
  return raw;
}
