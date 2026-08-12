/**
 * financingBridge — Synthesize ExtractedFinancingTerms from financingReport.convertibleDebt.
 *
 * Bridges the 10-K/10-Q financing report into the quantitative scoring pipeline when
 * no 8-K ExtractedFinancingTerms with a discountRate is available.
 *
 * Invariant: discountRate ALWAYS represents the economic discount from market (0–1).
 * This module does not extract or modify raw parser output — it only selects and maps
 * already-normalized ConvertibleNote records.
 *
 * Domain constraints:
 *   - Only the most recently filed report with qualifying notes is used.
 *   - Notes are not aggregated across reporting periods.
 *   - Confidence is always 'low' (inferred from periodic report, not an 8-K term sheet).
 *   - hasFloorPriceDetermined and hasResetProvisionsDetermined are always false
 *     (these flags require explicit positive/negative statement from the source text,
 *     which the bridge cannot verify from note-level fields alone).
 *   - CENN is explicitly excluded at the call-site, not here.
 */

import type { NormalizedFiling, ConvertibleNote, ExtractedFinancingTerms } from './types';

// ─── Status filter ────────────────────────────────────────────────────────────

const ACTIVE_STATUSES = new Set<ConvertibleNote['status'] | undefined>([
  undefined,
  'outstanding',
  'unknown',
]);

const EXCLUDED_STATUSES = new Set<ConvertibleNote['status']>([
  'converted',
  'repaid',
  'settled',
  'cancelled',
  'matured',
]);

function isQualifying(note: ConvertibleNote): boolean {
  if (note.status !== undefined && EXCLUDED_STATUSES.has(note.status)) return false;
  if (!ACTIVE_STATUSES.has(note.status)) return false;
  return note.discountRate !== undefined;
}

// ─── Representative note selection ───────────────────────────────────────────

/**
 * Select the single note that best represents the overall convertible risk.
 * Priority: highest discountRate → shortest lookbackDays → largest exposure.
 * Assumes notes.length >= 1.
 */
function selectRepresentative(notes: ConvertibleNote[]): ConvertibleNote {
  return [...notes].sort((a, b) => {
    // 1. Highest discountRate (primary risk signal)
    const drDiff = (b.discountRate ?? 0) - (a.discountRate ?? 0);
    if (drDiff !== 0) return drDiff;
    // 2. Shortest lookbackDays (tighter pricing window = less protection)
    const lbA = a.lookbackDays ?? Infinity;
    const lbB = b.lookbackDays ?? Infinity;
    if (lbA !== lbB) return lbA - lbB;
    // 3. Largest outstanding exposure as final tiebreaker
    const pA = a.outstandingBalance ?? a.principalAmount ?? 0;
    const pB = b.outstandingBalance ?? b.principalAmount ?? 0;
    return pB - pA;
  })[0];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Synthesize ExtractedFinancingTerms from a company's 10-Q/10-K filings.
 *
 * Selects the most recently filed report that contains at least one qualifying note
 * (discountRate defined, status not in {converted, repaid, settled, cancelled, matured}).
 * Returns undefined when no qualifying notes exist.
 */
export function bridgeFinancingFromReport(
  filings: NormalizedFiling[],
): ExtractedFinancingTerms | undefined {
  // Find the most recently filed report with qualifying notes
  const candidates = filings
    .filter(f => f.financingReport?.convertibleDebt?.some(isQualifying))
    .sort((a, b) => b.filedAt.localeCompare(a.filedAt));

  if (candidates.length === 0) return undefined;

  const filing = candidates[0];
  const qualifying = filing.financingReport!.convertibleDebt.filter(isQualifying);
  const rep = selectRepresentative(qualifying);

  const totalPrincipal = qualifying.reduce(
    (sum, n) => sum + (n.outstandingBalance ?? n.principalAmount ?? 0),
    0,
  );

  const provenance = `[bridge] ${filing.formType} · ${filing.filedAt} · ${filing.accessionNumber}`;

  return {
    financingType:              'convertible_note',
    principalAmount:            totalPrincipal > 0 ? totalPrincipal : undefined,
    discountRate:               rep.discountRate,
    lookbackDays:               rep.lookbackDays,
    floorPrice:                 rep.floorPrice,
    hasFloorPrice:              rep.hasFloorPrice,
    hasFloorPriceDetermined:    false,
    hasResetProvisions:         rep.hasResetProvisions,
    hasResetProvisionsDetermined: false,
    warrantShares:              undefined,
    warrantExercisePrice:       undefined,
    maturityDate:               rep.maturityDate,
    investorName:               rep.investorName,
    confidence:                 'low',
    matchedPhrases:             [provenance],
  };
}

/**
 * Select the effective ExtractedFinancingTerms for scoring and display.
 *
 * Priority:
 *   1. rawFinancing with discountRate defined (8-K term sheet — highest signal)
 *   2. Bridge from financingReport.convertibleDebt (10-K/10-Q periodic report)
 *   3. rawFinancing without discountRate (shown in UI but cannot score)
 *   4. undefined
 *
 * CENN is explicitly excluded from bridge scoring pending domain review:
 *   - Multiple-note ambiguity (discount from default conversion clause vs. normal conversion)
 *   - One stale 1.0.0 row with incorrect dr=0.85 (not yet reparsed)
 *   - 2 of 3 notes per filing lack discountRate
 */
export function selectEffectiveFinancing(
  ticker: string,
  rawFinancing: ExtractedFinancingTerms | undefined,
  filings: NormalizedFiling[],
): ExtractedFinancingTerms | undefined {
  // 8-K with discountRate → always preferred; never downgrade to bridge
  if (rawFinancing?.discountRate !== undefined) return rawFinancing;
  // CENN is explicitly excluded from bridge path
  if (ticker === 'CENN') return rawFinancing;
  // Try bridge; fall back to raw (may be undefined or a term without discountRate)
  return bridgeFinancingFromReport(filings) ?? rawFinancing;
}
