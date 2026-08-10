/**
 * Filing fetcher factory
 *
 * Creates the appropriate IFilingFetcher implementation based on config.
 * Switch modes with the FILING_FETCHER_MODE environment variable:
 *
 *   FILING_FETCHER_MODE=edgar-with-fallback  (default)
 *     Tries the real SEC EDGAR API; falls back to mock data on any error.
 *     Safe for development — fake tickers fall back to mock automatically.
 *
 *   FILING_FETCHER_MODE=edgar
 *     Real EDGAR API only — throws on any failure.  Use in production when
 *     you want failures to surface rather than silently returning stale data.
 *
 *   FILING_FETCHER_MODE=mock
 *     Pure mock — no network requests.  Useful for unit tests and CI.
 *
 * In production set FILING_FETCHER_MODE=edgar; in development leave it unset
 * (or set it to edgar-with-fallback) so the UI stays usable even when EDGAR
 * is unavailable.
 */

import type { IFilingFetcher, FilingFetcherConfig, FetcherMode } from './types';
import { MockFilingFetcher }    from './fetchers/mock';
import { EdgarFilingFetcher }   from './fetchers/edgar';
import { FallbackFilingFetcher } from './fetchers/fallback';

/**
 * Create a filing fetcher for the given mode.
 * Defaults to 'edgar-with-fallback' if no mode is specified or the env var
 * is unset — real EDGAR data with automatic fallback to mock on failure.
 */
export function createFilingFetcher(config?: Partial<FilingFetcherConfig>): IFilingFetcher {
  const mode: FetcherMode =
    (config?.mode ?? (process.env.FILING_FETCHER_MODE as FetcherMode)) ?? 'edgar-with-fallback';

  const resolved: FilingFetcherConfig = {
    mode,
    edgarBaseUrl: 'https://data.sec.gov',
    rateLimitMs:  110,
    maxFilings:   20,
    ...config,
  };

  switch (resolved.mode) {
    case 'edgar':
      return new EdgarFilingFetcher(resolved);
    case 'edgar-with-fallback':
      return new FallbackFilingFetcher(resolved);
    case 'mock':
      return new MockFilingFetcher();
    default:
      // Unknown mode — fall back safely to mock rather than crashing
      console.warn(`[fetcher] Unknown FILING_FETCHER_MODE "${resolved.mode}". Using edgar-with-fallback.`);
      return new FallbackFilingFetcher(resolved);
  }
}

// Re-export for convenience
export type { IFilingFetcher, FilingFetcherConfig, FetcherMode };
