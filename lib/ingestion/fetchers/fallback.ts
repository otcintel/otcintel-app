/**
 * Fallback filing fetcher
 *
 * Attempts every operation against the real SEC EDGAR API first.
 * If EDGAR returns an error (network failure, rate-limit, unknown ticker, etc.),
 * it logs a warning and transparently retries with the MockFilingFetcher so that
 * development and testing are never broken by EDGAR availability.
 *
 * Fallback scope:
 *   fetchFilingsIndex — if EDGAR fails, returns mock index for the ticker.
 *                       If the ticker has no mock data either, returns an empty
 *                       index (zero filings) rather than throwing.
 *
 *   fetchFilingText   — if EDGAR fails to fetch a document's full text, falls
 *                       back to mock text.  For real EDGAR filings that have no
 *                       mock equivalent the fallback returns an empty string;
 *                       the pipeline treats that as a parse-only filing with a
 *                       non-fatal "no text available" warning rather than a
 *                       hard crash.
 *
 * The `mode` property is always 'edgar-with-fallback'.
 * In normalize.ts the pipeline maps this to source = 'edgar' in NormalizedFiling
 * records that came from EDGAR, and source = 'mock' for those that fell back.
 * That distinction is tracked per-filing via FallbackFilingFetcher.lastSource.
 */

import type {
  IFilingFetcher,
  RawFiling,
  FilingIndexResult,
  FetchOptions,
  FilingFetcherConfig,
} from '../types';
import { EdgarFilingFetcher } from './edgar';
import { MockFilingFetcher } from './mock';

export class FallbackFilingFetcher implements IFilingFetcher {
  readonly mode = 'edgar-with-fallback' as const;

  private readonly edgar: EdgarFilingFetcher;
  private readonly mock:  MockFilingFetcher;

  /**
   * Tracks the actual source used for the most recent fetchFilingsIndex call.
   * Set after each call so the pipeline can record the true source per filing.
   * 'edgar' = EDGAR succeeded; 'mock' = fell back to mock.
   */
  lastIndexSource: 'edgar' | 'mock' = 'edgar';

  /**
   * If the last EDGAR fetch failed, the error message is stored here for
   * surfacing in API responses and debugging.
   */
  lastEdgarError: string | undefined;

  constructor(config: FilingFetcherConfig) {
    this.edgar = new EdgarFilingFetcher(config);
    this.mock  = new MockFilingFetcher();
  }

  // ─── fetchFilingsIndex ────────────────────────────────────────────────────

  async fetchFilingsIndex(
    ticker: string,
    options?: FetchOptions,
  ): Promise<FilingIndexResult> {
    // ── Try EDGAR first ──
    this.lastEdgarError = undefined;
    try {
      const result = await this.edgar.fetchFilingsIndex(ticker, options);
      this.lastIndexSource = 'edgar';
      return result;
    } catch (edgarErr) {
      const msg = edgarErr instanceof Error ? edgarErr.message : String(edgarErr);
      this.lastEdgarError = msg;
      console.warn(`[fallback] EDGAR index fetch failed for ${ticker}: ${msg}. Falling back to mock data.`);
    }

    // ── Fall back to mock ──
    try {
      const result = await this.mock.fetchFilingsIndex(ticker, options);
      this.lastIndexSource = 'mock';
      return result;
    } catch (mockErr) {
      // Mock fetcher never throws (it returns empty arrays for unknown tickers),
      // but guard defensively so callers always get a valid result shape.
      console.warn(
        `[fallback] Mock index fetch also failed for ${ticker}: ` +
        `${mockErr instanceof Error ? mockErr.message : String(mockErr)}. ` +
        `Returning empty index.`,
      );
      this.lastIndexSource = 'mock';
      return {
        ticker: ticker.toUpperCase(),
        cik:    '',
        filings: [],
        fetchedAt: new Date().toISOString(),
        source: 'mock',
      };
    }
  }

  // ─── fetchFilingText ──────────────────────────────────────────────────────

  async fetchFilingText(filing: RawFiling): Promise<string> {
    // If the index fell back to mock, the filing already has text pre-populated;
    // the pipeline skips this call in that case (it checks `if (!filing.text)`).
    // We still handle it gracefully in case it is called explicitly.

    // ── Try EDGAR first (only meaningful for real EDGAR filings) ──
    try {
      return await this.edgar.fetchFilingText(filing);
    } catch (edgarErr) {
      console.warn(
        `[fallback] EDGAR text fetch failed for ${filing.accessionNumber}: ` +
        `${edgarErr instanceof Error ? edgarErr.message : String(edgarErr)}. ` +
        `Falling back to mock text.`,
      );
    }

    // ── Fall back to mock text ──
    // Returns empty string for filings not in the mock dataset, which is fine —
    // the parser returns empty extractions and the pipeline records a non-fatal
    // "no filing text available" warning rather than crashing.
    try {
      return await this.mock.fetchFilingText(filing);
    } catch {
      return '';
    }
  }
}
