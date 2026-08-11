/**
 * XBRL concept extractor — Phase 7 Step 2
 *
 * Pure function: given a CompanyFacts document from the SEC XBRL API, extracts
 * a structured financial snapshot covering balance sheet items, cash flow, and
 * derived signals needed for cash-runway scoring.
 *
 * Design principles (from Phase 7 architecture):
 *   - Structured XBRL data is authoritative for numeric values.
 *   - Latest-filed amendment wins for every (fp, fy, period) combination.
 *   - Instant values only for balance sheet items; duration values only for cash flow.
 *   - Missing concepts are tracked in missingConcepts[] — never substituted.
 *   - Debt is a best-effort sum; undefined if zero components are found.
 *   - No fetch calls, no DB calls, no mutations — pure transformation.
 */

import type { CompanyFacts, XbrlConceptValue, XbrlConceptData } from '../../fetchers/edgar/companyFacts';

// ─── Concept priority lists ───────────────────────────────────────────────────

/** Balance sheet: cash and cash equivalents (tried in order; first hit wins). */
export const CASH_CONCEPTS = [
  'CashAndCashEquivalentsAtCarryingValue',
  'Cash',
  'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',  // ASU 2016-18 combined concept
  'CashCashEquivalentsAndShortTermInvestments',
] as const;

/** Cash flow statement: net operating cash flow (duration only). */
export const OPERATING_CF_CONCEPTS = [
  'NetCashProvidedByUsedInOperatingActivities',
] as const;

/** Balance sheet: total current liabilities. */
export const CURRENT_LIABILITIES_CONCEPTS = [
  'LiabilitiesCurrent',
] as const;

/** Balance sheet: retained earnings / accumulated deficit (sign preserved). */
export const ACCUMULATED_DEFICIT_CONCEPTS = [
  'RetainedEarningsAccumulatedDeficit',
] as const;

/**
 * Balance sheet: individual debt components summed to produce totalDebt.
 * Each concept is extracted independently; only found components are summed.
 */
export const DEBT_CONCEPTS = [
  'NotesPayableCurrent',
  'LongTermDebt',
  'ConvertibleNotesPayable',
  'ConvertibleDebtCurrent',
] as const;

/** All balance sheet concept lists (instant values) for period discovery. */
const BALANCE_SHEET_CONCEPTS: readonly string[] = [
  ...CASH_CONCEPTS,
  ...CURRENT_LIABILITIES_CONCEPTS,
  ...ACCUMULATED_DEFICIT_CONCEPTS,
];

/** Forms from which financial statement data is extracted. */
const FINANCIAL_FORMS = new Set(['10-K', '10-K/A', '10-Q', '10-Q/A']);

/** Map from EDGAR fiscal period code to number of months (YTD for quarterly). */
const FP_MONTHS: Record<string, number> = {
  Q1: 3,
  Q2: 6,
  Q3: 9,
  FY: 12,
};

// ─── Result type ──────────────────────────────────────────────────────────────

export interface XbrlConceptsResult {
  // ── Period identification ────────────────────────────────────────────────
  /** EDGAR fiscal period code: Q1 | Q2 | Q3 | FY */
  fiscalPeriod:    string    | undefined;
  /** Fiscal year (e.g. 2026) */
  fiscalYear:      number    | undefined;
  /** Balance sheet date — end date of the reporting period (ISO YYYY-MM-DD) */
  periodEndDate:   string    | undefined;
  /** Filing date of the winning accession that set the period (ISO YYYY-MM-DD) */
  filedAt:         string    | undefined;
  /** Accession number of the winning filing (set by the first found balance sheet concept) */
  accessionNumber: string    | undefined;

  // ── Balance sheet (instant values at periodEndDate) ──────────────────────
  cashAndEquivalents:  number | undefined;
  currentLiabilities:  number | undefined;
  /** Retained earnings / accumulated deficit — negative value means a deficit */
  accumulatedDeficit:  number | undefined;

  // ── Cash flow statement (duration: YTD through periodEndDate) ────────────
  operatingCashFlow:       number | undefined;
  /** Number of months covered by operatingCashFlow (3 | 6 | 9 | 12) */
  operatingCashFlowMonths: number | undefined;

  // ── Debt (best-effort sum of found components) ────────────────────────────
  /** Sum of all found debt components; undefined when no debt concept is present */
  totalDebt:           number   | undefined;
  /** Names of the XBRL concepts that contributed to totalDebt */
  totalDebtComponents: string[];

  // ── Data quality ──────────────────────────────────────────────────────────
  xbrlAvailable:   boolean;
  /** Concept names that were attempted but absent from the XBRL document */
  missingConcepts: string[];
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Deduplicate a list of concept values by applying amendment resolution:
 * for each (fp, fy, period) key, the entry with the latest `filed` date wins.
 *
 * Key encoding:
 *   Instant values  → `${fp}|${fy}|${end}`
 *   Duration values → `${fp}|${fy}|${start}|${end}`
 */
function deduplicateByAmendment(values: XbrlConceptValue[]): XbrlConceptValue[] {
  const best = new Map<string, XbrlConceptValue>();
  for (const v of values) {
    const key = v.start
      ? `${v.fp ?? ''}|${v.fy ?? ''}|${v.start}|${v.end}`
      : `${v.fp ?? ''}|${v.fy ?? ''}|${v.end}`;
    const existing = best.get(key);
    if (!existing || v.filed > existing.filed) {
      best.set(key, v);
    }
  }
  return [...best.values()];
}

/** Filter concept data to instant USD values from financial forms with valid fp/fy. */
function instantUsdValues(data: XbrlConceptData): XbrlConceptValue[] {
  return (data.units.USD ?? []).filter(
    v => !v.start && FINANCIAL_FORMS.has(v.form) && v.fp != null && v.fy != null,
  );
}

/** Filter concept data to duration USD values from financial forms with valid fp/fy. */
function durationUsdValues(data: XbrlConceptData): XbrlConceptValue[] {
  return (data.units.USD ?? []).filter(
    v => !!v.start && FINANCIAL_FORMS.has(v.form) && v.fp != null && v.fy != null,
  );
}

/**
 * Convert a fiscal period code to a month count.
 * Falls back to computing from start/end dates when fp is unknown.
 */
function fpToMonths(fp: string | null, start?: string, end?: string): number | undefined {
  if (fp && FP_MONTHS[fp] !== undefined) return FP_MONTHS[fp];
  if (start && end) {
    const s = new Date(start);
    const e = new Date(end);
    const diff = (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth());
    if (diff <= 4)  return 3;
    if (diff <= 7)  return 6;
    if (diff <= 10) return 9;
    return 12;
  }
  return undefined;
}

interface PeriodContext {
  fp:    string;
  fy:    number;
  end:   string;
  filed: string;
  accn:  string;
}

/**
 * Scan balance sheet concepts to identify the most recent 10-K/10-Q period
 * present in the us-gaap taxonomy. Amendment resolution is applied so that
 * amended periods are treated as single, latest-filed entries.
 */
function findMostRecentPeriod(
  usgaap: Record<string, XbrlConceptData>,
): PeriodContext | null {
  let best: XbrlConceptValue | null = null;

  for (const concept of BALANCE_SHEET_CONCEPTS) {
    const data = usgaap[concept];
    if (!data) continue;

    const deduped = deduplicateByAmendment(instantUsdValues(data));
    for (const v of deduped) {
      if (!best || v.end > best.end || (v.end === best.end && v.filed > best.filed)) {
        best = v;
      }
    }
  }

  if (!best || best.fp == null || best.fy == null) return null;
  return { fp: best.fp, fy: best.fy, end: best.end, filed: best.filed, accn: best.accn };
}

interface ConceptHit {
  value: number;
  accn:  string;
  filed: string;
  conceptUsed: string;
}

/**
 * Extract the best instant value for an ordered priority list of concept names
 * at the given period context. Returns the first concept that has a matching
 * value; returns null if none found.
 */
function extractInstant(
  usgaap: Record<string, XbrlConceptData>,
  concepts: readonly string[],
  period: PeriodContext,
  missingConcepts: string[],
): ConceptHit | null {
  for (const concept of concepts) {
    const data = usgaap[concept];
    if (!data) {
      missingConcepts.push(concept);
      continue;
    }

    const deduped = deduplicateByAmendment(instantUsdValues(data));
    const match = deduped.find(
      v => v.fp === period.fp && v.fy === period.fy && v.end === period.end,
    );

    if (match !== undefined) {
      return { value: match.val, accn: match.accn, filed: match.filed, conceptUsed: concept };
    }
    missingConcepts.push(concept);
  }
  return null;
}

interface DurationConceptHit extends ConceptHit {
  months: number;
  start:  string;
}

/**
 * Extract the best duration value for an ordered priority list of concept names
 * at the given period context (matched by fp, fy, and period end date).
 */
function extractDuration(
  usgaap: Record<string, XbrlConceptData>,
  concepts: readonly string[],
  period: PeriodContext,
  missingConcepts: string[],
): DurationConceptHit | null {
  for (const concept of concepts) {
    const data = usgaap[concept];
    if (!data) {
      missingConcepts.push(concept);
      continue;
    }

    const deduped = deduplicateByAmendment(durationUsdValues(data));
    const match = deduped.find(
      v => v.fp === period.fp && v.fy === period.fy && v.end === period.end,
    );

    if (match !== undefined) {
      const months = fpToMonths(match.fp, match.start, match.end);
      if (months === undefined) {
        missingConcepts.push(concept);
        continue;
      }
      return {
        value: match.val,
        accn:  match.accn,
        filed: match.filed,
        conceptUsed: concept,
        months,
        start: match.start!,
      };
    }
    missingConcepts.push(concept);
  }
  return null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Extract a structured financial snapshot from SEC XBRL company facts data.
 *
 * @param facts   - The parsed CompanyFacts from fetchCompanyFacts().
 * @param options - Optional period override. If omitted, the most recent
 *                  10-K or 10-Q period found in the document is used.
 * @returns       - XbrlConceptsResult with all available fields populated,
 *                  or a mostly-empty result with xbrlAvailable:false if the
 *                  document contains no usable us-gaap data.
 */
export function extractXbrlConcepts(
  facts: CompanyFacts,
  options?: { fp?: string; fy?: number; end?: string },
): XbrlConceptsResult {
  const empty = (): XbrlConceptsResult => ({
    fiscalPeriod:            undefined,
    fiscalYear:              undefined,
    periodEndDate:           undefined,
    filedAt:                 undefined,
    accessionNumber:         undefined,
    cashAndEquivalents:      undefined,
    currentLiabilities:      undefined,
    accumulatedDeficit:      undefined,
    operatingCashFlow:       undefined,
    operatingCashFlowMonths: undefined,
    totalDebt:               undefined,
    totalDebtComponents:     [],
    xbrlAvailable:           false,
    missingConcepts:         [],
  });

  const usgaap = facts.facts?.['us-gaap'];
  if (!usgaap || Object.keys(usgaap).length === 0) {
    return { ...empty(), missingConcepts: [
      ...CASH_CONCEPTS, ...OPERATING_CF_CONCEPTS, ...CURRENT_LIABILITIES_CONCEPTS,
      ...ACCUMULATED_DEFICIT_CONCEPTS, ...DEBT_CONCEPTS,
    ]};
  }

  // ── Period selection ─────────────────────────────────────────────────────

  let period: PeriodContext | null;

  if (options?.fp && options?.fy != null && options?.end) {
    // Caller pinned a specific period — construct a synthetic context.
    // We'll set filed/accn from the first concept hit, so start with placeholders.
    period = { fp: options.fp, fy: options.fy, end: options.end, filed: '', accn: '' };
  } else {
    period = findMostRecentPeriod(usgaap);
  }

  if (!period) {
    return { ...empty(), missingConcepts: [
      ...CASH_CONCEPTS, ...OPERATING_CF_CONCEPTS, ...CURRENT_LIABILITIES_CONCEPTS,
      ...ACCUMULATED_DEFICIT_CONCEPTS, ...DEBT_CONCEPTS,
    ]};
  }

  const missingConcepts: string[] = [];

  // ── Balance sheet (instant values) ──────────────────────────────────────

  const cashHit = extractInstant(usgaap, CASH_CONCEPTS, period, missingConcepts);
  const liabHit = extractInstant(usgaap, CURRENT_LIABILITIES_CONCEPTS, period, missingConcepts);
  const defHit  = extractInstant(usgaap, ACCUMULATED_DEFICIT_CONCEPTS, period, missingConcepts);

  // The first balance sheet concept hit anchors the period's accn/filedAt.
  // If caller provided a pinned period with no accn yet, fill from first hit.
  const anchorHit = cashHit ?? liabHit ?? defHit;
  const anchorAccn  = (anchorHit?.accn  ?? period.accn)  || undefined;
  const anchorFiled = (anchorHit?.filed ?? period.filed) || undefined;

  // ── Cash flow statement (duration values) ───────────────────────────────

  const cfHit = extractDuration(usgaap, OPERATING_CF_CONCEPTS, period, missingConcepts);

  // ── Debt aggregation (best-effort sum) ──────────────────────────────────

  const debtComponents: string[] = [];
  let   debtTotal: number | undefined;

  for (const concept of DEBT_CONCEPTS) {
    const hit = extractInstant(usgaap, [concept], period, []);
    if (hit !== null) {
      debtComponents.push(concept);
      debtTotal = (debtTotal ?? 0) + hit.value;
    } else {
      missingConcepts.push(concept);
    }
  }

  return {
    fiscalPeriod:            period.fp,
    fiscalYear:              period.fy,
    periodEndDate:           period.end,
    filedAt:                 anchorFiled,
    accessionNumber:         anchorAccn,

    cashAndEquivalents:      cashHit?.value,
    currentLiabilities:      liabHit?.value,
    accumulatedDeficit:      defHit?.value,

    operatingCashFlow:       cfHit?.value,
    operatingCashFlowMonths: cfHit?.months,

    totalDebt:               debtTotal,
    totalDebtComponents:     debtComponents,

    xbrlAvailable:           true,
    missingConcepts,
  };
}
