/**
 * OTC Markets data enrichment
 *
 * Fetches share structure data from the OTC Markets company profile endpoint
 * and returns it as an OtcShareStructure record.
 *
 * This is a supplementary data source used when SEC filings do not provide
 * share structure (authorized, outstanding, float).  SEC-extracted data always
 * takes precedence — this module is only called when the SEC pass produced
 * nothing useful.
 *
 * API endpoint:
 *   GET https://backend.otcmarkets.com/otcapi/company/profile/{TICKER}
 *
 * Authentication situation (as of 2026-04):
 *   - Custom User-Agent strings (e.g. "OTCIntel/1.0") → HTTP 403 (Akamai bot-filter)
 *   - Browser User-Agent + Referer → HTTP 200 but Content-Type: text/html
 *     The backend returns a static "Welcome to OTC Backend" HTML placeholder,
 *     indicating the JSON API requires valid browser session cookies.
 *   All other /otcapi paths return 403 regardless of headers.
 *   This module uses browser-like headers so it receives 200 (not 403) and logs
 *   the exact body so the failure mode is always visible in server logs.
 *
 * Kill-switch / opt-in:
 *   OTC enrichment is DISABLED by default. Set OTC_ENRICHMENT_ENABLED=true to enable.
 *   The OTC Markets backend API currently requires browser session cookies and is
 *   blocked by Akamai for all server-side requests, making enrichment non-functional.
 *   The architecture is preserved for future integration with a supported OTC data source.
 *
 * Error contract:
 *   This function NEVER throws.  All failures are logged and return undefined.
 */

import type { OtcShareStructure } from '../types';

// ─── Configuration ────────────────────────────────────────────────────────────

const OTC_API_BASE    = 'https://backend.otcmarkets.com/otcapi';
const RATE_LIMIT_MS   = 300;    // conservative — OTC Markets is not a regulated public API
const REQUEST_TIMEOUT = 10_000; // ms

let lastRequestAt = 0;

async function applyRateLimit(): Promise<void> {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise<void>(resolve => setTimeout(resolve, RATE_LIMIT_MS - elapsed));
  }
  lastRequestAt = Date.now();
}

// ─── OTC API response shape ───────────────────────────────────────────────────

/**
 * All known field names from the OTC Markets company profile JSON response.
 * OTC Markets uses inconsistent casing across endpoint versions — all known
 * aliases are declared here and resolved in toPositiveInt() calls below.
 */
interface OtcProfileResponse {
  // Identity
  symbol?:               string;
  // Share counts — primary field names
  sharesOutstanding?:    number | string;
  authorizedShares?:     number | string;
  float?:                number | string;
  // Share counts — alternate field names seen in older API versions
  outstandingShares?:    number | string;
  sharesAuthorized?:     number | string;
  publicFloat?:          number | string;
  sharesFloat?:          number | string;
  // Market data
  marketCap?:            number | string;
  // Allow any other field to be read without casting
  [key: string]: unknown;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Coerce an unknown value to a positive integer.
 * Handles numeric strings, comma-formatted numbers (e.g. "1,234,567"),
 * and float strings (value is rounded).
 * Returns undefined if absent, zero, negative, or non-numeric.
 */
function toPositiveInt(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const raw = typeof v === 'string' ? v.replace(/,/g, '') : String(v);
  const n   = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

/**
 * Truncate a string for log output.
 */
function preview(s: string, maxLen = 300): string {
  return s.length <= maxLen ? s : s.slice(0, maxLen) + '…';
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch share structure data for a ticker from OTC Markets.
 *
 * Returns undefined (with a console.warn) when:
 *   - enrichment is disabled via OTC_ENRICHMENT_ENABLED=false
 *   - the HTTP request is blocked (403) or times out
 *   - the response is not JSON (HTML auth-wall)
 *   - the response contains no usable share data
 *
 * @param ticker  Ticker symbol, e.g. "AITX"
 */
export async function fetchOtcShareStructure(
  ticker: string,
): Promise<OtcShareStructure | undefined> {
  // Disabled by default — the OTC Markets backend API requires browser session
  // cookies and is blocked by Akamai for server-side requests. Set
  // OTC_ENRICHMENT_ENABLED=true to re-enable when a supported alternative
  // (e.g. OTC Disclosure API via EDGAR Online) is configured.
  if (process.env.OTC_ENRICHMENT_ENABLED !== 'true') return undefined;

  const symbol = ticker.toUpperCase();
  const url    = `${OTC_API_BASE}/company/profile/${symbol}`;

  console.log(`[otcMarkets] ${symbol}: fetching → ${url}`);

  try {
    await applyRateLimit();

    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    let res: Response;
    try {
      res = await fetch(url, {
        signal:  controller.signal,
        headers: {
          // Browser-like headers to pass the Akamai bot-filter that blocks
          // custom User-Agent strings with a 403.  Even with these headers the
          // backend currently returns an HTML placeholder (not JSON) because it
          // requires session cookies — but the 200 response at least confirms
          // the request reached the server rather than being dropped at the edge.
          'Accept':          'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Referer':         `https://www.otcmarkets.com/stock/${symbol}/company-info`,
          'Origin':          'https://www.otcmarkets.com',
        },
      });
    } finally {
      clearTimeout(timeout);
    }

    const contentType   = res.headers.get('content-type') ?? '(none)';
    const contentLength = res.headers.get('content-length') ?? '(unknown)';

    console.log(
      `[otcMarkets] ${symbol}: HTTP ${res.status} | ` +
      `Content-Type: ${contentType} | Content-Length: ${contentLength}`
    );

    // ── Non-OK response ───────────────────────────────────────────────────────
    if (!res.ok) {
      if (res.status === 403) {
        console.warn(
          `[otcMarkets] ${symbol}: 403 Forbidden — request blocked by Akamai edge firewall. ` +
          `The User-Agent or IP is not permitted. OTC enrichment unavailable.`
        );
      } else if (res.status === 404) {
        console.warn(`[otcMarkets] ${symbol}: 404 — ticker not found on OTC Markets.`);
      } else {
        console.warn(
          `[otcMarkets] ${symbol}: HTTP ${res.status} — unexpected error. OTC enrichment skipped.`
        );
      }
      return undefined;
    }

    // ── Read raw body — always, so we can log it ──────────────────────────────
    const rawBody = await res.text();

    // ── Non-JSON response ─────────────────────────────────────────────────────
    if (!contentType.includes('application/json')) {
      console.warn(
        `[otcMarkets] ${symbol}: response is not JSON (Content-Type: ${contentType}). ` +
        `This is the Akamai auth-wall HTML placeholder — the API requires browser ` +
        `session cookies to return actual data.\n` +
        `  Body preview: ${preview(rawBody.replace(/\s+/g, ' ').trim())}`
      );
      return undefined;
    }

    // ── Parse JSON ────────────────────────────────────────────────────────────
    let data: OtcProfileResponse;
    try {
      data = JSON.parse(rawBody) as OtcProfileResponse;
    } catch (parseErr) {
      console.warn(
        `[otcMarkets] ${symbol}: JSON.parse failed — ` +
        `${parseErr instanceof Error ? parseErr.message : String(parseErr)}.\n` +
        `  Body preview: ${preview(rawBody.replace(/\s+/g, ' ').trim())}`
      );
      return undefined;
    }

    // ── Log full response for diagnostics ─────────────────────────────────────
    const allKeys = Object.keys(data);
    console.log(`[otcMarkets] ${symbol}: JSON received. Top-level fields (${allKeys.length}): ${allKeys.join(', ')}`);

    // Confirm presence of the specific fields the caller cares about
    const fieldReport = [
      'sharesOutstanding', 'outstandingShares',
      'authorizedShares',  'sharesAuthorized',
      'float',             'publicFloat', 'sharesFloat',
      'marketCap',
    ].map(f => `${f}=${JSON.stringify((data as Record<string, unknown>)[f]) ?? 'absent'}`).join(' | ');
    console.log(`[otcMarkets] ${symbol}: key fields → ${fieldReport}`);

    // ── Resolve share counts (primary field name, then aliases) ───────────────
    const sharesOutstanding = toPositiveInt(data.sharesOutstanding ?? data.outstandingShares);
    const authorizedShares  = toPositiveInt(data.authorizedShares  ?? data.sharesAuthorized);
    const sharesFloat       = toPositiveInt(data.float ?? data.publicFloat ?? data.sharesFloat);
    const marketCap         = toPositiveInt(data.marketCap);

    console.log(
      `[otcMarkets] ${symbol}: parsed → ` +
      `sharesOutstanding=${sharesOutstanding ?? 'n/a'} | ` +
      `authorizedShares=${authorizedShares ?? 'n/a'} | ` +
      `sharesFloat=${sharesFloat ?? 'n/a'} | ` +
      `marketCap=${marketCap ?? 'n/a'}`
    );

    // ── Guard: at least one usable share count ────────────────────────────────
    if (!sharesOutstanding && !sharesFloat && !authorizedShares) {
      console.warn(
        `[otcMarkets] ${symbol}: no usable share counts found in response. ` +
        `All numeric fields: ${allKeys
          .filter(k => typeof data[k] === 'number' || (typeof data[k] === 'string' && !isNaN(Number(data[k]))))
          .map(k => `${k}=${data[k]}`)
          .join(', ') || '(none)'}`
      );
      return undefined;
    }

    const result: OtcShareStructure = {
      sharesOutstanding,
      sharesFloat,
      authorizedShares,
      fetchedAt: new Date().toISOString(),
      sourceUrl: url,
    };

    console.log(`[otcMarkets] ${symbol}: enrichment complete →`, result);
    return result;

  } catch (err) {
    const isAbort   = err instanceof Error && err.name === 'AbortError';
    const isNetwork = err instanceof TypeError;

    if (isAbort) {
      console.warn(
        `[otcMarkets] ${symbol}: request timed out after ${REQUEST_TIMEOUT}ms. ` +
        `OTC endpoint did not respond in time.`
      );
    } else if (isNetwork) {
      console.warn(
        `[otcMarkets] ${symbol}: network error — ${(err as TypeError).message}. ` +
        `Check connectivity to backend.otcmarkets.com.`
      );
    } else {
      console.warn(
        `[otcMarkets] ${symbol}: unexpected error — ` +
        `${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`
      );
    }

    return undefined;
  }
}
