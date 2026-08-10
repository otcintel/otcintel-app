/**
 * Normalization layer
 *
 * Converts a ParsedFiling into a NormalizedFiling — the shape that gets
 * stored (in the mock store or a real database) and consumed by lib/data.ts.
 *
 * Responsibilities:
 *   1. Compute UI-ready display fields (summary, terms, tags) from parsed extractions
 *   2. Attach ingestion metadata (source, ingestedAt, parseErrors)
 *   3. Forward raw extractions for downstream use (risk scoring, alerts, etc.)
 *
 * The summary / terms / tags generation here is a best-effort fallback.
 * For companies with hand-curated mock filing records in lib/mock/filings.ts,
 * those records take precedence (set in buildCompanyData in lib/data.ts).
 */

import type { ParsedFiling, NormalizedFiling, ExtractedFinancingTerms } from './types';
import type { FilingTerm } from '../types';
import { PARSER_VERSION } from '../universe/types';

// ─── Summary generator ────────────────────────────────────────────────────────

/**
 * Generate a human-readable narrative summary from extracted financing terms.
 * Uses the same language style as the hand-curated mock summaries.
 */
function generateSummary(financing: ExtractedFinancingTerms, ticker: string): string {
  const parts: string[] = [];

  const principal = financing.principalAmount
    ? `<strong>$${financing.principalAmount.toLocaleString()} convertible note</strong>`
    : 'a convertible note';

  const investor = financing.investorName
    ? ` with ${financing.investorName}`
    : '';

  parts.push(`The company entered into ${principal}${investor}.`);

  if (financing.discountRate !== undefined) {
    const pct = (financing.discountRate * 100).toFixed(0);
    const lookback = financing.lookbackDays ? `${financing.lookbackDays}-day ` : '';
    parts.push(
      `Conversion is priced at a <strong>${pct}% discount to the ${lookback}VWAP</strong>` +
      (financing.hasFloorPrice && financing.floorPrice
        ? ` with a floor price of <strong>$${financing.floorPrice}</strong>`
        : ' with no stated floor') +
      (financing.hasResetProvisions ? ' and includes anti-dilution reset provisions.' : '.')
    );
  }

  if (financing.maturityDate) {
    parts.push(`The note matures on <strong>${financing.maturityDate}</strong>.`);
  }

  if (financing.warrantShares) {
    const exerciseStr = financing.warrantExercisePrice
      ? ` at $${financing.warrantExercisePrice} per share`
      : '';
    parts.push(
      `Warrants covering <strong>${financing.warrantShares.toLocaleString()} shares</strong>${exerciseStr} were issued alongside.`
    );
  }

  return parts.join(' ');
}

// ─── Terms grid generator ─────────────────────────────────────────────────────

/**
 * Build the structured terms grid from extracted financing data.
 * Each row maps to one cell in the filing terms grid on the company page.
 */
function generateTerms(financing: ExtractedFinancingTerms): FilingTerm[] {
  const terms: FilingTerm[] = [];

  if (financing.principalAmount !== undefined) {
    terms.push({
      label: 'Principal',
      value: `$${financing.principalAmount.toLocaleString()}`,
      className: '',
    });
  }

  if (financing.discountRate !== undefined) {
    const pct = (financing.discountRate * 100).toFixed(0);
    const lookback = financing.lookbackDays ? ` to ${financing.lookbackDays}-day VWAP` : '';
    terms.push({
      label: 'Discount',
      value: `${pct}%${lookback}`,
      className: financing.discountRate >= 0.20 ? 'danger' : financing.discountRate >= 0.15 ? 'warning' : '',
    });
  }

  if (financing.lookbackDays !== undefined) {
    terms.push({
      label: 'Lookback',
      value: `${financing.lookbackDays}-day VWAP`,
      className: financing.lookbackDays >= 10 ? 'warning' : '',
    });
  }

  terms.push({
    label: 'Floor price',
    value: financing.hasFloorPrice && financing.floorPrice
      ? `$${financing.floorPrice}`
      : 'Not stated',
    className: financing.hasFloorPrice ? 'positive' : 'warning',
  });

  if (financing.warrantShares !== undefined) {
    terms.push({
      label: 'Warrants',
      value: `${financing.warrantShares.toLocaleString()} shares`,
      className: financing.warrantShares > 0 ? 'danger' : '',
    });
  }

  if (financing.maturityDate) {
    terms.push({ label: 'Maturity', value: financing.maturityDate, className: '' });
  }

  terms.push({
    label: 'Reset provisions',
    value: financing.hasResetProvisions ? 'Present' : 'None stated',
    className: financing.hasResetProvisions ? 'danger' : 'positive',
  });

  return terms;
}

// ─── Tag generator ────────────────────────────────────────────────────────────

function generateTags(financing: ExtractedFinancingTerms): string[] {
  const tags: string[] = [];

  const typeLabel: Record<string, string> = {
    convertible_note: 'Convertible note',
    equity_line: 'Equity line',
    preferred_stock: 'Preferred stock',
    warrant_only: 'Warrants',
    unknown: 'Financing event',
  };
  tags.push(typeLabel[financing.financingType] ?? 'Financing event');

  if (financing.discountRate !== undefined) {
    tags.push(`${(financing.discountRate * 100).toFixed(0)}% discount`);
  }

  if (financing.lookbackDays !== undefined) {
    tags.push(`${financing.lookbackDays}-day VWAP`);
  }

  if (financing.warrantShares) tags.push('Warrants issued');
  if (financing.hasResetProvisions) tags.push('Reset provisions');
  if (!financing.hasFloorPrice) tags.push('No floor price');
  if (financing.hasFloorPrice && financing.floorPrice) {
    tags.push(`Floor price $${financing.floorPrice}`);
  }

  return tags;
}

// ─── Main normalizer ──────────────────────────────────────────────────────────

/**
 * Convert a ParsedFiling into a NormalizedFiling ready for storage and consumption.
 * Generates best-effort display fields from parser output.
 */
export function normalizeParsedFiling(
  parsed: ParsedFiling,
  source: NormalizedFiling['source'] = 'mock',
): NormalizedFiling {
  const { raw, financing, shareStructure, dilution, eventSummary, eventType, financingReport, parseErrors } = parsed;

  let summary: string | undefined;
  let terms: FilingTerm[] | undefined;
  let tags: string[] | undefined;

  if (financing) {
    summary = generateSummary(financing, raw.ticker);
    terms   = generateTerms(financing);
    tags    = generateTags(financing);
  }

  return {
    // Identity
    ticker:          raw.ticker,
    formType:        raw.formType,
    filedAt:         raw.filedAt,
    periodOfReport:  raw.periodOfReport,
    cik:             raw.cik,
    accessionNumber: raw.accessionNumber,
    documentUrl:     raw.documentUrl,
    // Extractions (preserved for downstream use)
    financing,
    shareStructure,
    dilution,
    financingReport,
    // Display fields
    eventSummary,
    eventType,
    summary,
    terms,
    tags,
    // Metadata
    ingestedAt:    new Date().toISOString(),
    source,
    parseErrors,
    parserVersion: PARSER_VERSION,
  };
}
