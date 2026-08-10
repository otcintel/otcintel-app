/**
 * Financial statements parser — 10-K / 10-Q
 *
 * Extracts key financial metrics from the income statement, balance sheet,
 * and cash flow statement sections of annual and quarterly reports.
 *
 * Design principles:
 *   - Multiplier-aware: detects "in thousands" / "in millions" headers and
 *     scales raw table values accordingly.
 *   - Two-column aware: when two numbers follow a label (current + prior period),
 *     the first (most recent) is preferred for current-period fields and the
 *     second is captured as the prior-period comparison.
 *   - Loss-positive convention: net loss, operating loss, and cash burn are
 *     stored as negative numbers. Parentheses are treated as negation.
 *   - Non-fatal: never throws. All warnings collected in FinancialStatements.warnings[].
 *
 * @module parsers/financialStatements
 */

import type { FinancialStatements, ExtractionConfidence } from '../types';

// ─── Amount helpers ───────────────────────────────────────────────────────────

/**
 * Parse a raw dollar string from a financial statement table cell.
 * Returns the absolute value; callers are responsible for negation from context
 * (parentheses, "deficit", etc.).
 */
function parseTableValue(raw: string, multiplier: number): number | undefined {
  const s = raw.replace(/,/g, '').replace(/^\(/, '').replace(/\)$/, '').replace(/^\$/, '').trim();
  if (!s || s === '-' || s === '—' || s === '–') return undefined;
  const n = parseFloat(s);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * multiplier);
}

/** True if the matched text string represents a parenthesized (negative) value. */
function isParenthesized(s: string): boolean {
  return s.trim().startsWith('(') && s.trim().endsWith(')');
}

// ─── Multiplier detection ─────────────────────────────────────────────────────

function detectMultiplier(text: string): number {
  if (/\bin\s+(?:US\s+)?(?:thousands|000s)\b/i.test(text)) return 1_000;
  if (/\bin\s+(?:US\s+)?millions?\b/i.test(text))          return 1_000_000;
  if (/expressed\s+in\s+thousands\b/i.test(text))          return 1_000;
  if (/expressed\s+in\s+millions\b/i.test(text))           return 1_000_000;
  return 1;
}

// ─── Period label detection ───────────────────────────────────────────────────

function detectPeriodLabel(text: string): string | undefined {
  const m =
    text.match(/(?:three|six|nine|twelve)\s+months?\s+ended\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i)
    ?? text.match(/(?:year|period)\s+ended\s+([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i)
    ?? text.match(/(?:three|six|nine|twelve)\s+months?\s+ended\s+(\d{4}-\d{2}-\d{2})/i);
  if (!m) return undefined;
  const prefix = m[0].match(/^(?:three|six|nine|twelve|year|period)/i)?.[0] ?? '';
  return prefix ? `${prefix.charAt(0).toUpperCase() + prefix.slice(1).toLowerCase()} months ended ${m[1]}` : m[1];
}

function detectBalanceSheetDate(text: string): string | undefined {
  const m =
    text.match(/(?:as\s+of|at)\s+((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})/i)
    ?? text.match(/balance\s+sheets?\s+(?:as\s+of\s+)?([A-Za-z]+\s+\d{1,2},?\s+\d{4})/i);
  return m?.[1];
}

// ─── Section locator ──────────────────────────────────────────────────────────

type FinancialSection = {
  label: string;
  text:  string;
};

const INCOME_STMT_HEADERS = [
  /(?:condensed\s+)?(?:consolidated\s+)?statements?\s+of\s+(?:operations|comprehensive\s+(?:income|loss)|(?:income|loss)\s+and\s+comprehensive)/i,
  /statements?\s+of\s+(?:net\s+loss|net\s+income|earnings\s+and\s+comprehensive)/i,
];
const BALANCE_SHEET_HEADERS = [
  /(?:condensed\s+)?(?:consolidated\s+)?balance\s+sheets?/i,
  /statement\s+of\s+(?:financial\s+(?:position|condition))/i,
];
const CASH_FLOW_HEADERS = [
  /statements?\s+of\s+cash\s+flows?/i,
  /(?:condensed\s+)?(?:consolidated\s+)?cash\s+flow\s+statements?/i,
];

function findSection(text: string, headers: RegExp[]): FinancialSection | undefined {
  for (const h of headers) {
    const re = new RegExp(h.source, 'i');
    const m  = re.exec(text);
    if (!m) continue;
    return {
      label: m[0],
      text:  text.slice(m.index, m.index + 12_000),
    };
  }
  return undefined;
}

// ─── Labeled value extractor ──────────────────────────────────────────────────
//
// Scans up to 3000 chars after a label pattern for the first dollar-like value.
// Returns [currentValue, priorValue | undefined] accounting for sign from parens.

function extractLabeledValues(
  text:       string,
  label:      RegExp,
  multiplier: number,
): [number | undefined, number | undefined] {
  const re = new RegExp(label.source, 'i');
  const m  = re.exec(text);
  if (!m) return [undefined, undefined];

  const region = text.slice(m.index + m[0].length, m.index + m[0].length + 500);

  // Find all numeric tokens in the region (before any new labeled line)
  const nextLabel = region.search(/\n\s*[A-Z][a-zA-Z\s]{4,}/);
  const searchIn  = nextLabel > 0 ? region.slice(0, nextLabel) : region;

  const TOKEN_RE = /\(?\$?\s*([\d,]+)\s*\)?/g;
  const values: number[] = [];
  let tok: RegExpExecArray | null;
  while ((tok = TOKEN_RE.exec(searchIn)) !== null && values.length < 2) {
    const raw     = parseTableValue(tok[1], multiplier);
    if (raw == null || raw === 0) continue;
    const neg = isParenthesized(tok[0]);
    values.push(neg ? -raw : raw);
  }

  return [values[0], values[1]];
}

// ─── Income statement ─────────────────────────────────────────────────────────

function parseIncomeStatement(
  section:    FinancialSection,
  multiplier: number,
  result:     Partial<FinancialStatements>,
): void {
  const t = section.text;

  // Revenue
  const [rev, revPrior] = extractLabeledValues(t, /(?:net\s+)?(?:revenues?|sales)\b(?!\s+(?:of|from|during))/i, multiplier);
  if (rev != null) {
    result.revenue            = rev;
    result.revenuePriorPeriod = revPrior;
  }

  // Gross profit
  const [gp] = extractLabeledValues(t, /gross\s+(?:profit|margin|loss)\b/i, multiplier);
  if (gp != null) {
    result.grossProfit = gp;
    if (result.revenue && result.revenue > 0) {
      result.grossMarginPct = gp / result.revenue;
    }
  }

  // Total operating expenses
  const [opex] = extractLabeledValues(t, /total\s+(?:operating\s+)?expenses?\b/i, multiplier);
  if (opex != null) result.totalOperatingExpenses = Math.abs(opex);

  // Operating loss / income
  const [opinc] = extractLabeledValues(t, /(?:(?:loss|income)\s+from\s+operations|operating\s+(?:loss|income))\b/i, multiplier);
  if (opinc != null) result.operatingLoss = opinc;  // already negative if parenthesized

  // Net loss
  const [net, netPrior] = extractLabeledValues(t, /net\s+(?:loss|income)\b/i, multiplier);
  if (net != null) {
    result.netLoss            = net;
    result.netLossPriorPeriod = netPrior;
  }
}

// ─── Balance sheet ────────────────────────────────────────────────────────────

function parseBalanceSheet(
  section:    FinancialSection,
  multiplier: number,
  result:     Partial<FinancialStatements>,
): void {
  const t = section.text;

  // Cash
  const [cash] = extractLabeledValues(t, /cash\s+and\s+cash\s+equivalents?\b/i, multiplier);
  if (cash != null) result.cashAndEquivalents = Math.abs(cash);

  // Total current assets (needed for working capital)
  const [curAssets] = extractLabeledValues(t, /total\s+current\s+assets?\b/i, multiplier);

  // Total current liabilities (needed for working capital)
  const [curLiab] = extractLabeledValues(t, /total\s+current\s+liabilities?\b/i, multiplier);

  // Working capital — may be stated directly or derived
  const wcM = t.match(/working\s+capital\s+(?:deficit\s+)?of\s+\$?\s*([\d,]+(?:\s*(?:million|M|thousand))?)/i)
    ?? t.match(/(?:deficit|surplus)\s+in\s+working\s+capital\s+of\s+\$?\s*([\d,]+)/i);
  if (wcM) {
    const raw = parseTableValue(wcM[1], multiplier);
    if (raw != null) {
      const isDeficit = /deficit/i.test(wcM[0]);
      result.workingCapital = isDeficit ? -raw : raw;
    }
  } else if (curAssets != null && curLiab != null) {
    result.workingCapital = Math.abs(curAssets) - Math.abs(curLiab);
  }

  // Total assets
  const [assets] = extractLabeledValues(t, /total\s+assets?\b/i, multiplier);
  if (assets != null) result.totalAssets = Math.abs(assets);

  // Total liabilities
  const [liab] = extractLabeledValues(t, /total\s+liabilities?\b(?!\s+and\s+(?:stockholders|shareholders))/i, multiplier);
  if (liab != null) result.totalLiabilities = Math.abs(liab);

  // Stockholders' equity / deficit
  const [equity] = extractLabeledValues(
    t,
    /total\s+(?:stockholders?['']?|shareholders?['']?)\s+(?:equity|deficit)\b/i,
    multiplier,
  );
  if (equity != null) result.stockholdersEquity = equity; // retain sign (deficit = negative)
}

// ─── Cash flow ────────────────────────────────────────────────────────────────

function parseCashFlow(
  section:    FinancialSection,
  multiplier: number,
  result:     Partial<FinancialStatements>,
): void {
  const t = section.text;
  const [ops] = extractLabeledValues(
    t,
    /net\s+cash\s+(?:used\s+in|(?:provided\s+by|from))\s+operating\s+activities?\b/i,
    multiplier,
  );
  if (ops != null) result.cashFromOperations = ops; // retain sign (used in = negative)
}

// ─── Going concern ────────────────────────────────────────────────────────────

function detectGoingConcern(text: string): { hasGoingConcern: boolean; language?: string } {
  const PATTERNS = [
    /substantial\s+doubt\s+(?:about|exists?\s+(?:about|as\s+to)|regarding)\s+(?:the\s+)?(?:company['']?s?\s+)?ability\s+to\s+continue\s+as\s+a\s+going\s+concern/i,
    /going\s+concern\s+(?:doubt|uncertainty|risk|qualification|opinion|issue)/i,
    /raise[sd]?\s+substantial\s+doubt\s+about.*?going\s+concern/i,
    /ability\s+to\s+continue\s+as\s+a\s+going\s+concern/i,
  ];
  for (const p of PATTERNS) {
    const m = p.exec(text);
    if (m) {
      const excerpt = text.slice(Math.max(0, m.index - 20), m.index + 300).trim().replace(/\s+/g, ' ');
      return { hasGoingConcern: true, language: excerpt.slice(0, 400) };
    }
  }
  return { hasGoingConcern: false };
}

// ─── Confidence scorer ────────────────────────────────────────────────────────

function scoreConfidence(fs: Partial<FinancialStatements>): ExtractionConfidence {
  let score = 0;
  if (fs.netLoss        != null) score += 3;
  if (fs.cashAndEquivalents != null) score += 2;
  if (fs.totalAssets    != null) score += 2;
  if (fs.totalLiabilities != null) score += 1;
  if (fs.cashFromOperations != null) score += 2;
  if (fs.revenue        != null) score += 1;
  if (fs.workingCapital != null) score += 1;
  if (score >= 8) return 'high';
  if (score >= 4) return 'medium';
  return 'low';
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Extract financial statement data from 10-K / 10-Q filing text.
 * Never throws — all warnings collected in result.warnings[].
 */
export function parseFinancialStatements(text: string): FinancialStatements {
  const warnings: string[] = [];
  const result: Partial<FinancialStatements> = { warnings, hasGoingConcern: false };

  const multiplier = detectMultiplier(text);
  result.reportingMultiplier = multiplier;

  // Period/date metadata
  result.periodLabel     = detectPeriodLabel(text);
  result.balanceSheetDate = detectBalanceSheetDate(text);

  // Income statement
  const incomeSection = findSection(text, INCOME_STMT_HEADERS);
  if (incomeSection) {
    try { parseIncomeStatement(incomeSection, multiplier, result); }
    catch (e) { warnings.push(`Income statement extraction error: ${e instanceof Error ? e.message : String(e)}`); }
  } else {
    warnings.push('Income statement section not detected.');
  }

  // Balance sheet
  const balanceSection = findSection(text, BALANCE_SHEET_HEADERS);
  if (balanceSection) {
    try { parseBalanceSheet(balanceSection, multiplier, result); }
    catch (e) { warnings.push(`Balance sheet extraction error: ${e instanceof Error ? e.message : String(e)}`); }
  } else {
    warnings.push('Balance sheet section not detected.');
  }

  // Cash flow
  const cfSection = findSection(text, CASH_FLOW_HEADERS);
  if (cfSection) {
    try { parseCashFlow(cfSection, multiplier, result); }
    catch (e) { warnings.push(`Cash flow extraction error: ${e instanceof Error ? e.message : String(e)}`); }
  } else {
    warnings.push('Cash flow statement section not detected.');
  }

  // Going concern
  const gc = detectGoingConcern(text);
  result.hasGoingConcern      = gc.hasGoingConcern;
  result.goingConcernLanguage = gc.language;

  result.confidence = scoreConfidence(result);

  return result as FinancialStatements;
}
