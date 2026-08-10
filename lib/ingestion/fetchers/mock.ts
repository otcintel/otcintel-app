/**
 * Mock filing fetcher
 *
 * Returns pre-built RawFiling records with realistic SEC filing text.
 * The text is authored to match the language patterns the parsers expect,
 * simulating what actual 8-K filings from OTC companies contain.
 *
 * Implements IFilingFetcher — swap for EdgarFilingFetcher in production.
 */

import type {
  IFilingFetcher,
  RawFiling,
  FilingIndexResult,
  FetchOptions,
  SecFormType,
} from '../types';
import { TIER_1_FORM_TYPES, TIER_2_FORM_TYPES } from '../types';
import { mockRawFilings } from '../../mock/rawFilings';

/** Assign a tier number (lower = higher priority) */
function tierOf(form: SecFormType): 1 | 2 | 3 {
  if ((TIER_1_FORM_TYPES as string[]).includes(form)) return 1;
  if ((TIER_2_FORM_TYPES as string[]).includes(form)) return 2;
  return 3;
}

export class MockFilingFetcher implements IFilingFetcher {
  readonly mode = 'mock' as const;

  async fetchFilingsIndex(ticker: string, options?: FetchOptions): Promise<FilingIndexResult> {
    // Simulate network latency
    await delay(20);

    const all = mockRawFilings[ticker.toUpperCase()] ?? [];

    let filings = [...all];

    // Apply since date filter first (always respected).
    if (options?.since) {
      filings = filings.filter(f => f.filedAt >= options.since!);
    }

    // Apply form type filter, with a fallback: if the filter produces zero
    // results but filings exist for this ticker, drop the form type constraint
    // so we never return empty when mock data is available.
    if (options?.formTypes?.length) {
      const typed = filings.filter(f => options.formTypes!.includes(f.formType));
      filings = typed.length > 0 ? typed : filings;
    }

    // Sort by tier (ascending) then by date (descending within tier) — same
    // priority logic as EdgarFilingFetcher so mock and real behavior match.
    filings.sort((a, b) => {
      const tierDiff = tierOf(a.formType) - tierOf(b.formType);
      if (tierDiff !== 0) return tierDiff;
      return b.filedAt.localeCompare(a.filedAt);
    });

    // Apply limit
    const limit = options?.limit ?? 10;
    filings = filings.slice(0, limit);

    return {
      ticker: ticker.toUpperCase(),
      cik: filings[0]?.cik ?? '',
      filings,
      fetchedAt: new Date().toISOString(),
      source: 'mock',
    };
  }

  async fetchFilingText(filing: RawFiling): Promise<string> {
    // Simulate network latency
    await delay(10);

    // Text is pre-populated in the mock raw filings
    if (filing.text) return filing.text;

    // Fallback — look it up by accession number
    const all = Object.values(mockRawFilings).flat();
    const found = all.find(f => f.accessionNumber === filing.accessionNumber);
    return found?.text ?? '';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
