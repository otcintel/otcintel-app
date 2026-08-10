/**
 * Ingestion pipeline
 *
 * Orchestrates the full ingestion flow for a ticker:
 *   1. Fetch filing index (metadata)
 *   2. Fetch full text for each filing
 *   3. Parse each filing with all applicable parsers
 *   4. Normalize parsed output into NormalizedFiling records
 *
 * Usage:
 *   const result = await ingestTicker('WXYZ');
 *   // result.normalized → NormalizedFiling[]
 *   // Store result.normalized in DB or mock store for consumption by lib/data.ts
 *
 * In production:
 *   - Replace MockFilingFetcher with EdgarFilingFetcher via env var
 *   - Persist result.normalized to Supabase (upsert by accessionNumber)
 *   - Run on a schedule (e.g. nightly) or on-demand via webhook
 */

import type { PipelineOptions, PipelineResult, NormalizedFiling, FetcherMode, RawFiling, SecFormType } from './types';
import { FINANCING_FORM_TYPES } from './types';
import { createFilingFetcher } from './fetcher';
import { FallbackFilingFetcher } from './fetchers/fallback';
import { parseRawFiling } from './parsers/index';
import { normalizeParsedFiling } from './normalize';
import { fetchOtcShareStructure } from './enrichment';
import { enrichWithComparisons } from './intelligence/filingComparison';

// ─── Extended scan configuration ─────────────────────────────────────────────

/**
 * Form types targeted in the extended structure scan.
 * Narrowed to annual and quarterly reports — the most reliable sources of
 * authorized/outstanding share counts and preferred share disclosures.
 */
const EXTENDED_STRUCTURE_FORMS: SecFormType[] = ['10-K', '10-K/A', '10-Q', '10-Q/A'];

/**
 * How far back to scan EDGAR's recent list for the extended passes.
 * 500 entries covers several years of filings for most OTC companies.
 */
const EXTENDED_SCAN_WINDOW = 500;

/** Max structure filings to fetch in the extended scan (most recent 10-Ks and 10-Qs). */
const EXTENDED_STRUCTURE_LIMIT = 4;

/** Max financing filings to fetch in the extended scan. */
const EXTENDED_FINANCING_LIMIT = 5;

/**
 * Map a FetcherMode to the NormalizedFiling source label.
 * 'edgar-with-fallback' resolves per-filing based on which source was actually
 * used; for all other modes the mapping is 1-to-1.
 */
function resolveSource(
  mode: FetcherMode,
  fetcher: ReturnType<typeof createFilingFetcher>,
): NormalizedFiling['source'] {
  if (mode === 'edgar-with-fallback') {
    // FallbackFilingFetcher tracks which source it actually used last
    return (fetcher as FallbackFilingFetcher).lastIndexSource ?? 'edgar';
  }
  if (mode === 'edgar')       return 'edgar';
  if (mode === 'third-party') return 'third-party';
  return 'mock';
}

/**
 * Run the full ingestion pipeline for a single ticker.
 *
 * @param ticker  Ticker symbol, e.g. "WXYZ"
 * @param options Pipeline options (form type filter, since date, etc.)
 * @returns       PipelineResult with normalized filings and metadata
 */
export async function ingestTicker(
  ticker: string,
  options?: PipelineOptions,
): Promise<PipelineResult> {
  const startedAt = Date.now();
  const errors: string[] = [];
  const normalized: NormalizedFiling[] = [];
  const processedRawFilings: RawFiling[] = [];

  const fetcher = createFilingFetcher();

  if (options?.verbose) {
    console.log(`[pipeline] Starting ingestion for ${ticker} (mode: ${fetcher.mode})`);
  }

  // Collect all filings to process, keyed by accessionNumber to deduplicate.
  // Phase 1 (recent scan) populates this first; Phase 2 (extended scan) adds
  // any new accession numbers not already seen.
  const filingMap = new Map<string, RawFiling>();

  try {
    // ── Phase 1: Recent scan ──────────────────────────────────────────────────
    // Mirrors the original logic: fetch the most recent filings using whatever
    // options the caller supplied (formTypes, since, limit).
    if (options?.verbose) {
      console.log(`[pipeline] Phase 1: recent scan for ${ticker}`);
    }

    const recentIndex = await fetcher.fetchFilingsIndex(ticker, {
      formTypes: options?.formTypes,
      since:     options?.since,
      limit:     options?.limit,
    });

    for (const f of recentIndex.filings) filingMap.set(f.accessionNumber, f);

    if (options?.verbose) {
      console.log(`[pipeline] Phase 1: ${recentIndex.filings.length} filing(s) collected`);
    }

    // ── Phase 2: Extended scan for key historical filings ────────────────────
    // Search deeper into EDGAR's recent list specifically for:
    //   • Annual / quarterly reports (10-K, 10-Q) — most reliable share structure source
    //   • Financing-related forms (8-K, S-1, S-3, …) — financing terms and dilution data
    //
    // The fetcher caches the CIK lookup and the submissions JSON so these two
    // additional calls cost zero extra HTTP requests when using EdgarFilingFetcher.
    // Extended scan failures are non-fatal — Phase 1 data is still returned.
    try {
      if (options?.verbose) {
        console.log(`[pipeline] Phase 2: extended scan for ${ticker} (window: ${EXTENDED_SCAN_WINDOW})`);
      }

      const structureIndex = await fetcher.fetchFilingsIndex(ticker, {
        formTypes:  EXTENDED_STRUCTURE_FORMS,
        scanWindow: EXTENDED_SCAN_WINDOW,
        limit:      EXTENDED_STRUCTURE_LIMIT,
      });

      const financingIndex = await fetcher.fetchFilingsIndex(ticker, {
        formTypes:  FINANCING_FORM_TYPES,
        scanWindow: EXTENDED_SCAN_WINDOW,
        limit:      EXTENDED_FINANCING_LIMIT,
      });

      let newCount = 0;
      for (const f of [...structureIndex.filings, ...financingIndex.filings]) {
        if (!filingMap.has(f.accessionNumber)) {
          filingMap.set(f.accessionNumber, f);
          newCount++;
        }
      }

      if (options?.verbose) {
        console.log(`[pipeline] Phase 2: ${newCount} new filing(s) added after deduplication`);
      }
    } catch (err) {
      const msg = `Extended scan failed for ${ticker} (non-fatal): ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      if (options?.verbose) console.warn(`[pipeline] ${msg}`);
    }

    // ── Phase 3: Fetch text → parse → normalize for all unique filings ───────
    const allFilings = Array.from(filingMap.values());

    if (options?.verbose) {
      console.log(`[pipeline] Phase 3: processing ${allFilings.length} unique filing(s)`);
    }

    for (const filing of allFilings) {
      try {
        // Skip filings already persisted in the DB for this ticker
        if (options?.skipAccessions?.has(filing.accessionNumber)) {
          if (options?.verbose) {
            console.log(`[pipeline] Skipping already-stored filing ${filing.accessionNumber}`);
          }
          continue;
        }

        // Fetch full text (no-op in mock — text is pre-populated)
        if (!filing.text) {
          filing.text = await fetcher.fetchFilingText(filing);
        }

        // Parse
        const parsed = parseRawFiling(filing);

        if (parsed.parseErrors.length > 0 && options?.verbose) {
          console.warn(`[pipeline] Parse warnings for ${filing.accessionNumber}:`, parsed.parseErrors);
        }

        // Normalize — resolve actual source (edgar vs mock) for this filing
        const norm = normalizeParsedFiling(parsed, resolveSource(fetcher.mode, fetcher));
        normalized.push(norm);
        processedRawFilings.push(filing);

        errors.push(...parsed.parseErrors);
      } catch (err) {
        const msg = `Failed to process filing ${filing.accessionNumber}: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(msg);
        if (options?.verbose) console.error(`[pipeline] ${msg}`);
      }
    }
  } catch (err) {
    const msg = `Pipeline failed for ${ticker}: ${err instanceof Error ? err.message : String(err)}`;
    errors.push(msg);
    if (options?.verbose) console.error(`[pipeline] ${msg}`);
  }

  // ── Phase 4: OTC Markets enrichment (supplementary share structure) ─────────
  // Only runs when no SEC filing in this batch provided extractable share structure.
  // Fetches once per ticker per pipeline run and attaches the result to all
  // normalized filings that lack SEC-extracted share data so downstream consumers
  // can fall back to it.  Entirely non-fatal — failures are recorded in errors[]
  // but do not affect the SEC-derived data already collected.
  const hasSecStructure = normalized.some(n => n.shareStructure);
  if (!hasSecStructure && normalized.length > 0) {
    try {
      if (options?.verbose) {
        console.log(`[pipeline] Phase 4: OTC enrichment for ${ticker} (no SEC structure found)`);
      }

      const otcData = await fetchOtcShareStructure(ticker);

      if (otcData) {
        // Attach to every filing that lacks SEC share structure so any store
        // query against this ticker can surface the OTC fallback data.
        let attached = 0;
        for (const n of normalized) {
          if (!n.shareStructure) {
            n.otcShareStructure = otcData;
            attached++;
          }
        }
        if (options?.verbose) {
          console.log(
            `[pipeline] Phase 4: attached OTC structure to ${attached} filing(s) ` +
            `(outstanding: ${otcData.sharesOutstanding?.toLocaleString() ?? 'n/a'}, ` +
            `float: ${otcData.sharesFloat?.toLocaleString() ?? 'n/a'})`
          );
        }
      } else if (options?.verbose) {
        console.log(`[pipeline] Phase 4: OTC enrichment returned no data for ${ticker}`);
      }
    } catch (err) {
      const msg = `OTC enrichment failed for ${ticker} (non-fatal): ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      if (options?.verbose) console.warn(`[pipeline] ${msg}`);
    }
  }

  // ── Phase 5: Filing-over-filing comparison sections ─────────────────────────
  // Injects a "CHANGES SINCE PRIOR REPORT" section into each 10-K / 10-Q
  // reportText, immediately after the Executive Summary.  Non-fatal.
  try {
    enrichWithComparisons(normalized);
    if (options?.verbose) {
      const count = normalized.filter(n =>
        ['10-K','10-K/A','10-Q','10-Q/A'].includes(n.formType) && n.financingReport,
      ).length;
      console.log(`[pipeline] Phase 5: comparison sections processed for ${count} filing(s)`);
    }
  } catch (err) {
    const msg = `Comparison enrichment failed for ${ticker} (non-fatal): ${err instanceof Error ? err.message : String(err)}`;
    errors.push(msg);
    if (options?.verbose) console.warn(`[pipeline] ${msg}`);
  }

  const durationMs = Date.now() - startedAt;

  if (options?.verbose) {
    console.log(
      `[pipeline] Completed ${ticker}: ${normalized.length} normalized, ` +
      `${errors.length} error(s), ${durationMs}ms`
    );
  }

  // Capture which source the index fetch actually used (edgar vs mock fallback)
  const indexSource: PipelineResult['indexSource'] =
    fetcher.mode === 'edgar-with-fallback'
      ? ((fetcher as FallbackFilingFetcher).lastIndexSource ?? 'edgar')
      : fetcher.mode === 'edgar' ? 'edgar'
      : fetcher.mode === 'mock'  ? 'mock'
      : 'third-party';

  const edgarError =
    fetcher.mode === 'edgar-with-fallback'
      ? (fetcher as FallbackFilingFetcher).lastEdgarError
      : undefined;

  return {
    ticker:      ticker.toUpperCase(),
    normalized,
    fetched:     normalized.length,
    parsed:      normalized.filter(n => n.parseErrors.length === 0).length,
    errors,
    durationMs,
    indexSource,
    edgarError,
    rawFilings:  processedRawFilings,
  };
}

/**
 * Run the ingestion pipeline for multiple tickers in sequence.
 * Uses sequential processing to respect EDGAR rate limits.
 *
 * @param tickers  Array of ticker symbols
 * @param options  Pipeline options applied to all tickers
 * @returns        Map of ticker → PipelineResult
 */
export async function ingestTickers(
  tickers: string[],
  options?: PipelineOptions,
): Promise<Map<string, PipelineResult>> {
  const results = new Map<string, PipelineResult>();

  for (const ticker of tickers) {
    results.set(ticker, await ingestTicker(ticker, options));
  }

  return results;
}
