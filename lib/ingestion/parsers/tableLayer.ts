/**
 * HTML table extraction layer.
 *
 * Runs against the raw HTML filing — before cleanText() strips tags — to recover
 * the structured data that SEC issuers present in financial statement tables.
 * Sentence-level extraction operating on plain text systematically misses:
 *
 *   • Convertible note schedules (lender / principal / rate / maturity / balance)
 *   • Debt rollforward tables (beginning balance → additions → conversions → ending)
 *   • Warrant activity tables (shares / exercise price / expiration)
 *   • Related-party debt tables (officer loans, management-fee payables)
 *   • Equity issuance tables (shares sold / price / proceeds)
 *   • Share activity and preferred stock tables
 *
 * Every extracted field carries full provenance:
 *   { value, confidence, sourceTable, rowIndex, colIndex, noteNumber }
 *
 * The caller (parseFinancingReport) merges TableInstrument[] into the output
 * arrays BEFORE consolidation, so table values win over sentence-derived values
 * via the existing mergeNote / mergeFacility logic.
 *
 * @module parsers/tableLayer
 */

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ParsedCell {
  text:     string;
  rowIndex: number;
  colIndex: number;
  colspan:  number;
  rowspan:  number;
  isHeader: boolean;
}

export type TableClass =
  | 'convertible_note_schedule'
  | 'debt_rollforward'
  | 'related_party_debt'
  | 'warrant_table'
  | 'equity_issuance'
  | 'share_activity'
  | 'preferred_stock'
  | 'subsequent_events'
  | 'unknown';

export interface TableFieldSource {
  sourceTable: number;   // zero-based table index within the document
  rowIndex:    number;
  colIndex:    number;
  noteNumber?: number;
  confidence:  number;
}

export interface TableExtractedField<T> extends TableFieldSource {
  value: T;
}

export interface TableInstrument {
  tableClass:  TableClass;
  tableIndex:  number;
  noteNumber?: number;
  rowIndex:    number;
  fields: {
    investorName?:         TableExtractedField<string>;
    principalAmount?:      TableExtractedField<number>;
    outstandingBalance?:   TableExtractedField<number>;
    interestRate?:         TableExtractedField<number>;
    discountRate?:         TableExtractedField<number>;
    fixedConversionPrice?: TableExtractedField<number>;
    floorPrice?:           TableExtractedField<number | null>;
    maturityDate?:         TableExtractedField<string>;
    executionDate?:        TableExtractedField<string>;
    facilitySize?:         TableExtractedField<number>;
    drawnAmount?:          TableExtractedField<number>;
    sharesIssued?:         TableExtractedField<number>;
    debtConverted?:        TableExtractedField<number>;
    effectivePrice?:       TableExtractedField<number>;
    pricePerShare?:        TableExtractedField<number>;
    grossProceeds?:        TableExtractedField<number>;
    warrantShares?:        TableExtractedField<number>;
    exercisePrice?:        TableExtractedField<number>;
    expirationDate?:       TableExtractedField<string>;
    transactionAmount?:    TableExtractedField<number>;
    partyDescription?:     TableExtractedField<string>;
    beginningBalance?:     TableExtractedField<number>;
    endingBalance?:        TableExtractedField<number>;
    additions?:            TableExtractedField<number>;
    conversionsAmount?:    TableExtractedField<number>;
    repayments?:           TableExtractedField<number>;
    sharesAuthorized?:     TableExtractedField<number>;
    sharesOutstanding?:    TableExtractedField<number>;
  };
}

// ─── Private: value parsers ───────────────────────────────────────────────────

function parseTableAmount(text: string, multiplier: number): number | undefined {
  const s = text.trim();
  if (!s || /^[-–—*]+$/.test(s)) return undefined;
  const isNeg = s.startsWith('(') && s.endsWith(')');
  const clean = s.replace(/[(),\$\s]/g, '').replace(/,/g, '').replace(/[^0-9.]/g, '');
  if (!clean) return undefined;
  const n = parseFloat(clean);
  if (!Number.isFinite(n) || n < 0) return undefined;
  const result = Math.round(n * multiplier);
  return isNeg ? -result : result;
}

function parseTablePct(text: string): number | undefined {
  const s = text.trim().replace(/%/g, '').replace(/[^0-9.]/g, '');
  const n = parseFloat(s);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return undefined;
  return n / 100;
}

function parseTableDate(text: string): string | undefined {
  const t = text.trim();
  const m =
    t.match(/((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4})/i)
    ?? t.match(/(\d{4}-\d{2}-\d{2})/)
    ?? t.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
  return m?.[1];
}

function isAmountLike(text: string): boolean {
  return /^\s*\(?\$?[\d,]+\.?\d*\)?\s*$/.test(text);
}

function looksLikeName(text: string): boolean {
  if (!text || text.length < 3 || text.length > 80) return false;
  if (isAmountLike(text))  return false;
  if (parseTableDate(text)) return false;
  if (/^[\d.%]+$/.test(text.trim())) return false;
  return true;
}

// ─── Private: HTML cell cleaner ───────────────────────────────────────────────

function cleanCellHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]{0,400}>/g, '')
    .replace(/&amp;/g,   '&')
    .replace(/&lt;/g,    '<')
    .replace(/&gt;/g,    '>')
    .replace(/&nbsp;/g,  ' ')
    .replace(/&#160;/g,  ' ')
    .replace(/&quot;/g,  '"')
    .replace(/&apos;/g,  "'")
    .replace(/&#(\d{1,5});/g,         (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([\dA-Fa-f]{1,4});/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Private: table HTML extractor ───────────────────────────────────────────
//
// State machine that tracks <table> nesting depth and extracts only the
// outermost tables. Nested tables (layout wrappers) are captured as part of
// the outer table's HTML and ignored by the grid parser (which uses the
// row/cell structure at the outermost level only).

function extractRawTables(
  html: string,
): Array<{ tableHtml: string; context: string; tableIndex: number }> {
  const results: Array<{ tableHtml: string; context: string; tableIndex: number }> = [];
  let depth      = 0;
  let tableStart = -1;
  let idx        = 0;

  const TABLE_TAG_RE = /<(\/?)table(?:\s[^>]*)?>/gi;
  let m: RegExpExecArray | null;
  while ((m = TABLE_TAG_RE.exec(html)) !== null) {
    if (m[1] === '/') {
      if (depth > 0) depth--;
      if (depth === 0 && tableStart >= 0) {
        const end       = m.index + m[0].length;
        const tableHtml = html.slice(tableStart, end);
        const ctxStart  = Math.max(0, tableStart - 600);
        results.push({ tableHtml, context: html.slice(ctxStart, tableStart), tableIndex: idx++ });
        tableStart = -1;
      }
    } else {
      if (depth === 0) tableStart = m.index;
      depth++;
    }
  }
  return results;
}

// ─── Private: grid parser ─────────────────────────────────────────────────────

function parseTableGrid(tableHtml: string): ParsedCell[][] {
  const rows: ParsedCell[][] = [];
  let rowIndex = 0;

  const ROW_RE = /<tr(?:\s[^>]*)?>([\s\S]*?)<\/tr>/gi;
  let trM: RegExpExecArray | null;

  while ((trM = ROW_RE.exec(tableHtml)) !== null) {
    const rowHtml = trM[1];
    const cells: ParsedCell[] = [];
    let colIndex = 0;

    const CELL_RE = /<(td|th)((?:\s[^>]*)?)>([\s\S]*?)<\/(?:td|th)>/gi;
    let cellM: RegExpExecArray | null;

    while ((cellM = CELL_RE.exec(rowHtml)) !== null) {
      const tag      = cellM[1].toLowerCase();
      const attrs    = cellM[2];
      const content  = cellM[3];
      const colspanM = attrs.match(/colspan\s*=\s*["']?(\d+)["']?/i);
      const rowspanM = attrs.match(/rowspan\s*=\s*["']?(\d+)["']?/i);
      const colspan  = Math.max(1, parseInt(colspanM?.[1] ?? '1', 10));
      const rowspan  = Math.max(1, parseInt(rowspanM?.[1] ?? '1', 10));
      const text     = cleanCellHtml(content);

      cells.push({ text, rowIndex, colIndex, colspan, rowspan, isHeader: tag === 'th' });
      colIndex += colspan;
    }

    if (cells.length > 0) { rows.push(cells); rowIndex++; }
  }
  return rows;
}

// ─── Private: context analysis ───────────────────────────────────────────────

function detectNoteNumberFromContext(context: string): number | undefined {
  const text = cleanCellHtml(context);
  // Take the LAST "NOTE X" match — closest to the table
  const matches = [...text.matchAll(/\bNOTE\s+(\d{1,2}[A-Z]?)(?:\s*[–—\-\.\:]|\s{2,}|$)/gi)];
  if (matches.length === 0) return undefined;
  const last = matches[matches.length - 1];
  const n    = parseInt(last[1], 10);
  return Number.isFinite(n) ? n : undefined;
}

function detectMultiplierFromContext(context: string, tableHtml: string): number {
  const combined = cleanCellHtml(context) + ' ' + tableHtml.slice(0, 800);
  if (/\bin\s+(?:US\s+)?thousands\b/i.test(combined)) return 1_000;
  if (/\bin\s+(?:US\s+)?millions?\b/i.test(combined)) return 1_000_000;
  if (/expressed\s+in\s+thousands/i.test(combined))   return 1_000;
  if (/expressed\s+in\s+millions/i.test(combined))    return 1_000_000;
  return 1;
}

// ─── Private: column semantic detection ──────────────────────────────────────

type ColSemantic =
  | 'investor'       | 'principal'      | 'outstanding'  | 'interest_rate'
  | 'maturity'       | 'issue_date'     | 'discount'     | 'conversion'
  | 'warrant_shares' | 'exercise_price' | 'expiration'   | 'shares_issued'
  | 'proceeds'       | 'price_per_share'| 'beginning_balance' | 'additions'
  | 'conversions_col'| 'repayments'     | 'ending_balance'    | 'transaction_amount'
  | 'shares_authorized' | 'shares_outstanding' | 'party_description';

const COL_PATTERNS: Array<[ColSemantic, RegExp]> = [
  ['investor',          /\b(?:lender|holder|investor|purchaser|payee|note\s+holder|counterparty|name|issuer|note\s+payable\s+to)\b/i],
  ['principal',         /\b(?:principal|face\s+(?:amount|value)|original\s+(?:principal|amount)|gross\s+amount|amount\s+of\s+note|face\s+value)\b/i],
  ['outstanding',       /\b(?:net\s+carrying|carrying\s+(?:value|amount)|book\s+value|remaining\s+(?:balance|principal)|outstanding\s+(?:principal|balance)|(?:current|unpaid)\s+balance)\b/i],
  ['interest_rate',     /\b(?:interest\s+rate|annual\s+(?:interest\s+)?rate|coupon|int\.?\s*rate|rate\s*%|interest\s*%)\b/i],
  ['maturity',          /\b(?:maturity|matures?|due\s+date|maturity\s+date)\b/i],
  ['issue_date',        /\b(?:issue\s+date|dated?|origination|grant\s+date|date\s+(?:of\s+)?(?:note|issuance|loan)|entered\s+into)\b/i],
  ['discount',          /\b(?:unamortized\s+(?:debt\s+)?discount|debt\s+discount|discount\s+on\s+note)\b/i],
  ['conversion',        /\b(?:conversion\s+(?:price|rate|terms?)|convertible|convert(?:ed)?\s+price|conversion\s+feature)\b/i],
  ['warrant_shares',    /\b(?:warrant\s+shares?|shares?\s+(?:underlying|issuable|purchasable|under\s+warrant)|number\s+of\s+warrants?|warrants?\s+outstanding|warrant\s+count)\b/i],
  ['exercise_price',    /\b(?:exercise\s+price|strike\s+price)\b/i],
  ['expiration',        /\b(?:expir(?:ation|es?|y)|expiry|term\s+(?:end|date)|expiration\s+date)\b/i],
  ['shares_issued',     /\b(?:shares?\s+issued?|shares?\s+sold?|number\s+of\s+shares?|shares?\s+(?:of\s+)?common\s+stock\s+(?:issued?|sold?)|shares?\s+granted)\b/i],
  ['proceeds',          /\b(?:(?:gross|net)\s+proceeds|proceeds\s+(?:received|from|of)|cash\s+proceeds|amount\s+received)\b/i],
  ['price_per_share',   /\b(?:price\s+per\s+share|offering\s+price|per(?:\s+common)?\s+share(?:\s+price)?|sale\s+price)\b/i],
  ['beginning_balance', /\b(?:beginning\s+(?:balance|of\s+(?:period|year))|opening\s+balance|balance\s+at\s+(?:beginning|start|january\s+1))\b/i],
  ['additions',         /\b(?:additions?|new\s+(?:borrowings?|notes?|issuances?)|borrowed\s+during|issued\s+during|proceeds\s+from\s+new|advances?)\b/i],
  ['conversions_col',   /\b(?:conversions?(?:\s+to\s+(?:equity|stock|common))?|converted(?:\s+to)?|debt\s+converted)\b/i],
  ['repayments',        /\b(?:repayments?|cash\s+payments?|paid\s+(?:off|down)|settlements?|reductions?\s+(?:from|due\s+to)\s+payments?)\b/i],
  ['ending_balance',    /\b(?:ending\s+(?:balance|of\s+(?:period|year))|closing\s+balance|balance\s+at\s+end|(?:total\s+)?outstanding\s+at\s+end)\b/i],
  ['transaction_amount',/\b(?:amount(?:\s+outstanding)?|total\s+amount|balance\s+(?:due|outstanding)|value)\b/i],
  ['shares_authorized', /\b(?:shares?\s+authorized|authorized\s+(?:shares?|capital|stock))\b/i],
  ['shares_outstanding',/\b(?:shares?\s+(?:issued\s+and\s+)?outstanding|outstanding\s+shares?)\b/i],
  ['party_description', /\b(?:relationship|description|nature\s+of|transaction\s+type|party)\b/i],
];

function detectColumnSemantics(headerRows: ParsedCell[][]): Map<ColSemantic, number> {
  // Build combined header text per column (join all header row texts at that colIndex)
  const colTexts = new Map<number, string>();
  for (const row of headerRows) {
    for (const cell of row) {
      const existing = colTexts.get(cell.colIndex) ?? '';
      colTexts.set(cell.colIndex, existing + ' ' + cell.text);
    }
  }

  const result = new Map<ColSemantic, number>();
  // Process columns in order so first match wins for each semantic
  for (const [colIdx, text] of [...colTexts.entries()].sort((a, b) => a[0] - b[0])) {
    for (const [sem, re] of COL_PATTERNS) {
      if (!result.has(sem) && re.test(text)) {
        result.set(sem, colIdx);
        break;
      }
    }
  }
  return result;
}

// ─── Private: header row detection ───────────────────────────────────────────

function isHeaderRow(row: ParsedCell[], rowIdx: number): boolean {
  if (row.length === 0) return false;
  // Explicit <th> cells
  if (row.every(c => c.isHeader)) return true;
  // First few rows with no amount-like values
  if (rowIdx < 4 && !row.some(c => isAmountLike(c.text) && c.text.length > 1)) return true;
  return false;
}

function splitHeadersAndData(rows: ParsedCell[][]): { headers: ParsedCell[][]; data: ParsedCell[][] } {
  let splitAt = 0;
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    if (isHeaderRow(rows[i], i)) splitAt = i + 1;
    else break;
  }
  return { headers: rows.slice(0, splitAt), data: rows.slice(splitAt) };
}

// ─── Private: table classification ───────────────────────────────────────────

function classifyTable(
  colMap:  Map<ColSemantic, number>,
  context: string,
  rows:    ParsedCell[][],
): TableClass {
  const has  = (s: ColSemantic) => colMap.has(s);
  const ctx  = cleanCellHtml(context).toLowerCase();
  const html = rows.flat().map(c => c.text).join(' ').toLowerCase();

  if (/subsequent\s+event|events?\s+after/i.test(ctx)) return 'subsequent_events';

  // Rollforward — has explicit period columns
  if (has('beginning_balance') && has('ending_balance'))   return 'debt_rollforward';
  if (has('beginning_balance') && (has('conversions_col') || has('additions') || has('repayments')))
    return 'debt_rollforward';

  // Warrant table
  if (has('warrant_shares') || has('exercise_price') || has('expiration'))  return 'warrant_table';
  if (/\bwarrant/i.test(ctx) && rows.length > 1 && has('shares_issued'))    return 'warrant_table';

  // Equity issuance
  if (has('shares_issued') && (has('proceeds') || has('price_per_share')))  return 'equity_issuance';
  if (/private\s+placement|common\s+stock\s+offer|equity\s+raise/i.test(ctx) && has('shares_issued'))
    return 'equity_issuance';

  // Share activity
  if (has('shares_authorized') || has('shares_outstanding'))                 return 'share_activity';

  // Preferred stock
  if (/preferred\s+stock|series\s+[a-z]/i.test(ctx) &&
      (has('shares_authorized') || has('transaction_amount')))               return 'preferred_stock';

  // Related-party debt
  if (/related.party|officer|director|insider/i.test(ctx) &&
      (has('principal') || has('outstanding') || has('transaction_amount'))) return 'related_party_debt';
  if (has('party_description') && (has('transaction_amount') || has('principal')))
    return 'related_party_debt';

  // Convertible note schedule — broadest catch
  if ((has('investor') || has('principal')) &&
      (has('interest_rate') || has('maturity') || has('outstanding') || has('conversion') || has('discount')))
    return 'convertible_note_schedule';

  // Check HTML content for strong signals
  if (/convertible\s+note|promissory\s+note|notes?\s+payable/i.test(html) &&
      (has('principal') || has('outstanding')))                              return 'convertible_note_schedule';
  if (/convertible\s+note|promissory\s+note|notes?\s+payable/i.test(ctx) &&
      (has('outstanding') || has('transaction_amount')))                    return 'convertible_note_schedule';

  return 'unknown';
}

// ─── Private: field builder ───────────────────────────────────────────────────

function makeField<T>(
  value:      T,
  tableIndex: number,
  rowIndex:   number,
  colIndex:   number,
  noteNumber: number | undefined,
  confidence: number,
): TableExtractedField<T> {
  return { value, sourceTable: tableIndex, rowIndex, colIndex, noteNumber, confidence };
}

// ─── Private: cell lookup helper ─────────────────────────────────────────────

function cellAt(row: ParsedCell[], colIndex: number): ParsedCell | undefined {
  return row.find(c => c.colIndex === colIndex);
}

function cellText(row: ParsedCell[], colIndex: number): string {
  return cellAt(row, colIndex)?.text ?? '';
}

// ─── Private: row extractors by table class ───────────────────────────────────

function extractConvertibleNoteRows(
  dataRows:   ParsedCell[][],
  colMap:     Map<ColSemantic, number>,
  tableIndex: number,
  noteNumber: number | undefined,
  multiplier: number,
): TableInstrument[] {
  const instruments: TableInstrument[] = [];
  let carryName = '';   // carry investor name across rowspan gaps

  for (const row of dataRows) {
    if (row.length < 2) continue;

    const investorCol   = colMap.get('investor');
    const principalCol  = colMap.get('principal');
    const outstandingCol = colMap.get('outstanding');
    const interestCol   = colMap.get('interest_rate');
    const maturityCol   = colMap.get('maturity');
    const issueDateCol  = colMap.get('issue_date');
    const discountCol   = colMap.get('discount');
    const conversionCol = colMap.get('conversion');

    // Investor name carry-forward
    let investorName = '';
    if (investorCol != null) {
      const raw = cellText(row, investorCol);
      if (looksLikeName(raw)) { investorName = raw; carryName = raw; }
      else if (carryName)       investorName = carryName;
    } else {
      // Check col 0 as implicit investor column
      const c0 = row.find(c => c.colIndex === 0);
      if (c0 && looksLikeName(c0.text)) { investorName = c0.text; carryName = c0.text; }
      else if (carryName)                investorName = carryName;
    }

    const principal   = principalCol  != null ? parseTableAmount(cellText(row, principalCol),  multiplier) : undefined;
    const outstanding = outstandingCol != null ? parseTableAmount(cellText(row, outstandingCol), multiplier) : undefined;
    const interest    = interestCol    != null ? parseTablePct(cellText(row, interestCol))    : undefined;
    const maturity    = maturityCol    != null ? parseTableDate(cellText(row, maturityCol))   : undefined;
    const issueDate   = issueDateCol   != null ? parseTableDate(cellText(row, issueDateCol))  : undefined;

    // Discount — if present, treat as discountRate (variable rate note)
    const discountRaw = discountCol != null ? parseTableAmount(cellText(row, discountCol), multiplier) : undefined;
    let discountRate: number | undefined;
    if (discountRaw != null && principal && principal > 0) {
      discountRate = Math.abs(discountRaw) / principal;
      if (discountRate > 1) discountRate = undefined;  // sanity: not > 100%
    }

    // Fixed conversion price from conversion column
    let fixedConversionPrice: number | undefined;
    if (conversionCol != null) {
      const convText = cellText(row, conversionCol);
      const convM = convText.match(/\$\s*([\d.]+)\s*(?:per\s+share)?/i);
      if (convM) {
        const px = parseFloat(convM[1]);
        if (px > 0 && px < 1_000) fixedConversionPrice = px;
      }
    }

    // Require at least one quantitative signal
    if (!principal && !outstanding) continue;
    const effectivePrincipal = principal ?? outstanding;
    if (!effectivePrincipal || effectivePrincipal < 25_000) continue;

    const ri = row[0].rowIndex;
    const inst: TableInstrument = {
      tableClass: 'convertible_note_schedule',
      tableIndex,
      noteNumber,
      rowIndex:   ri,
      fields:     {},
    };

    if (investorName) inst.fields.investorName  = makeField(investorName, tableIndex, ri, investorCol ?? 0, noteNumber, 0.92);
    if (principal)    inst.fields.principalAmount = makeField(principal, tableIndex, ri, principalCol ?? 0, noteNumber, 0.95);
    if (outstanding && outstanding !== principal)
      inst.fields.outstandingBalance = makeField(outstanding, tableIndex, ri, outstandingCol ?? 0, noteNumber, 0.93);
    if (interest)     inst.fields.interestRate   = makeField(interest,   tableIndex, ri, interestCol ?? 0,   noteNumber, 0.95);
    if (maturity)     inst.fields.maturityDate   = makeField(maturity,   tableIndex, ri, maturityCol ?? 0,   noteNumber, 0.93);
    if (issueDate)    inst.fields.executionDate  = makeField(issueDate,  tableIndex, ri, issueDateCol ?? 0,  noteNumber, 0.90);
    if (discountRate) inst.fields.discountRate   = makeField(discountRate, tableIndex, ri, discountCol ?? 0, noteNumber, 0.85);
    if (fixedConversionPrice) inst.fields.fixedConversionPrice = makeField(fixedConversionPrice, tableIndex, ri, conversionCol ?? 0, noteNumber, 0.88);

    instruments.push(inst);
  }

  return instruments;
}

function extractDebtRollforwardRows(
  dataRows:   ParsedCell[][],
  colMap:     Map<ColSemantic, number>,
  tableIndex: number,
  noteNumber: number | undefined,
  multiplier: number,
): TableInstrument[] {
  const instruments: TableInstrument[] = [];

  for (const row of dataRows) {
    const beginCol = colMap.get('beginning_balance');
    const endCol   = colMap.get('ending_balance');
    const addCol   = colMap.get('additions');
    const convCol  = colMap.get('conversions_col');
    const repayCol = colMap.get('repayments');

    const begin   = beginCol != null ? parseTableAmount(cellText(row, beginCol), multiplier) : undefined;
    const end     = endCol   != null ? parseTableAmount(cellText(row, endCol),   multiplier) : undefined;
    const adds    = addCol   != null ? parseTableAmount(cellText(row, addCol),   multiplier) : undefined;
    const convAmt = convCol  != null ? parseTableAmount(cellText(row, convCol),  multiplier) : undefined;
    const repay   = repayCol != null ? parseTableAmount(cellText(row, repayCol), multiplier) : undefined;

    if (!begin && !end) continue;
    if ((begin ?? 0) === 0 && (end ?? 0) === 0) continue;

    // Investor from col 0 label
    const c0 = row.find(c => c.colIndex === 0);
    const investorName = c0 && looksLikeName(c0.text) ? c0.text : undefined;

    const ri   = row[0].rowIndex;
    const inst: TableInstrument = {
      tableClass: 'debt_rollforward',
      tableIndex,
      noteNumber,
      rowIndex:   ri,
      fields:     {},
    };

    if (investorName) inst.fields.investorName    = makeField(investorName, tableIndex, ri, 0,        noteNumber, 0.85);
    if (begin)        inst.fields.beginningBalance = makeField(begin,       tableIndex, ri, beginCol ?? 0, noteNumber, 0.93);
    if (end)          inst.fields.endingBalance    = makeField(end,         tableIndex, ri, endCol ?? 0,   noteNumber, 0.95);
    if (adds)         inst.fields.additions        = makeField(adds,        tableIndex, ri, addCol ?? 0,   noteNumber, 0.88);
    if (convAmt)      inst.fields.conversionsAmount = makeField(convAmt,   tableIndex, ri, convCol ?? 0,   noteNumber, 0.90);
    if (repay)        inst.fields.repayments       = makeField(repay,       tableIndex, ri, repayCol ?? 0, noteNumber, 0.88);

    // Outstanding balance = ending balance of the rollforward
    if (end && Math.abs(end) >= 25_000) {
      inst.fields.outstandingBalance = makeField(Math.abs(end), tableIndex, ri, endCol ?? 0, noteNumber, 0.93);
    }

    instruments.push(inst);
  }

  return instruments;
}

function extractWarrantRows(
  dataRows:   ParsedCell[][],
  colMap:     Map<ColSemantic, number>,
  tableIndex: number,
  noteNumber: number | undefined,
  multiplier: number,
): TableInstrument[] {
  const instruments: TableInstrument[] = [];

  for (const row of dataRows) {
    const sharesCol   = colMap.get('warrant_shares');
    const exPriceCol  = colMap.get('exercise_price');
    const expDateCol  = colMap.get('expiration');
    const issueDateCol = colMap.get('issue_date');
    const investorCol = colMap.get('investor');

    const shares    = sharesCol   != null ? parseTableAmount(cellText(row, sharesCol),   1)          : undefined;
    const exPrice   = exPriceCol  != null ? parseFloat(cellText(row, exPriceCol).replace(/[^0-9.]/g, '')) : undefined;
    const expDate   = expDateCol  != null ? parseTableDate(cellText(row, expDateCol))                : undefined;
    const issDate   = issueDateCol != null ? parseTableDate(cellText(row, issueDateCol))             : undefined;

    let investorName = '';
    if (investorCol != null) {
      const t = cellText(row, investorCol);
      if (looksLikeName(t)) investorName = t;
    } else {
      const c0 = row.find(c => c.colIndex === 0);
      if (c0 && looksLikeName(c0.text)) investorName = c0.text;
    }

    if (!shares && (!exPrice || !Number.isFinite(exPrice))) continue;
    if (shares && shares < 1_000) continue;  // ignore tiny grants

    const ri   = row[0].rowIndex;
    const inst: TableInstrument = {
      tableClass: 'warrant_table',
      tableIndex,
      noteNumber,
      rowIndex:   ri,
      fields:     {},
    };

    if (investorName)                inst.fields.investorName  = makeField(investorName, tableIndex, ri, investorCol ?? 0, noteNumber, 0.88);
    if (shares)                      inst.fields.warrantShares = makeField(shares,       tableIndex, ri, sharesCol ?? 0,   noteNumber, 0.95);
    if (exPrice && Number.isFinite(exPrice) && exPrice > 0)
                                     inst.fields.exercisePrice  = makeField(exPrice,    tableIndex, ri, exPriceCol ?? 0,   noteNumber, 0.95);
    if (expDate)                     inst.fields.expirationDate = makeField(expDate,    tableIndex, ri, expDateCol ?? 0,   noteNumber, 0.93);
    if (issDate)                     inst.fields.executionDate  = makeField(issDate,    tableIndex, ri, issueDateCol ?? 0, noteNumber, 0.88);

    instruments.push(inst);
  }

  return instruments;
}

function extractEquityIssuanceRows(
  dataRows:   ParsedCell[][],
  colMap:     Map<ColSemantic, number>,
  tableIndex: number,
  noteNumber: number | undefined,
  multiplier: number,
): TableInstrument[] {
  const instruments: TableInstrument[] = [];

  for (const row of dataRows) {
    const sharesCol   = colMap.get('shares_issued');
    const priceCol    = colMap.get('price_per_share');
    const proceedsCol = colMap.get('proceeds');
    const dateCol     = colMap.get('issue_date');
    const investorCol = colMap.get('investor');

    const shares    = sharesCol   != null ? parseTableAmount(cellText(row, sharesCol),   1)   : undefined;
    const price     = priceCol    != null ? parseFloat(cellText(row, priceCol).replace(/[^0-9.]/g, ''))  : undefined;
    const proceeds  = proceedsCol != null ? parseTableAmount(cellText(row, proceedsCol), multiplier) : undefined;
    const date      = dateCol     != null ? parseTableDate(cellText(row, dateCol))            : undefined;

    let investorName = '';
    if (investorCol != null) {
      const t = cellText(row, investorCol);
      if (looksLikeName(t)) investorName = t;
    } else {
      const c0 = row.find(c => c.colIndex === 0);
      if (c0 && looksLikeName(c0.text)) investorName = c0.text;
    }

    if (!shares && !proceeds) continue;
    if (shares && shares < 10_000) continue;
    if (proceeds && Math.abs(proceeds) < 1_000) continue;

    const ri   = row[0].rowIndex;
    const inst: TableInstrument = {
      tableClass: 'equity_issuance',
      tableIndex,
      noteNumber,
      rowIndex:   ri,
      fields:     {},
    };

    if (investorName) inst.fields.investorName  = makeField(investorName, tableIndex, ri, investorCol ?? 0, noteNumber, 0.88);
    if (shares)       inst.fields.sharesIssued   = makeField(shares,      tableIndex, ri, sharesCol ?? 0,   noteNumber, 0.95);
    if (price && Number.isFinite(price) && price > 0)
                      inst.fields.pricePerShare   = makeField(price,      tableIndex, ri, priceCol ?? 0,    noteNumber, 0.92);
    if (proceeds)     inst.fields.grossProceeds   = makeField(proceeds,   tableIndex, ri, proceedsCol ?? 0, noteNumber, 0.93);
    if (date)         inst.fields.executionDate   = makeField(date,       tableIndex, ri, dateCol ?? 0,     noteNumber, 0.88);

    instruments.push(inst);
  }

  return instruments;
}

function extractRelatedPartyRows(
  dataRows:   ParsedCell[][],
  colMap:     Map<ColSemantic, number>,
  tableIndex: number,
  noteNumber: number | undefined,
  multiplier: number,
): TableInstrument[] {
  const instruments: TableInstrument[] = [];

  // Column priority: ending_balance > outstanding > principal > transaction_amount
  // The chosen column determines which field is populated, which affects basis assignment.
  const endingBalanceColIdx = colMap.get('ending_balance');
  const outstandingColIdx   = colMap.get('outstanding');
  const principalColIdx     = colMap.get('principal');
  const txnAmtColIdx        = colMap.get('transaction_amount');

  const descCol = colMap.get('party_description');

  // Determine which amount column to use and what semantic it represents
  let amtCol: number | undefined;
  let amtSemantic: 'ending_balance' | 'outstanding' | 'principal' | 'transaction_amount';
  if (endingBalanceColIdx != null) {
    amtCol = endingBalanceColIdx;
    amtSemantic = 'ending_balance';
  } else if (outstandingColIdx != null) {
    amtCol = outstandingColIdx;
    amtSemantic = 'outstanding';
  } else if (principalColIdx != null) {
    amtCol = principalColIdx;
    amtSemantic = 'principal';
  } else if (txnAmtColIdx != null) {
    amtCol = txnAmtColIdx;
    amtSemantic = 'transaction_amount';
  } else {
    return instruments;  // no amount column found
  }

  for (const row of dataRows) {
    const amt = parseTableAmount(cellText(row, amtCol), multiplier);
    if (!amt || Math.abs(amt) < 1_000) continue;

    // Party description from col 0 or dedicated column
    const c0    = row.find(c => c.colIndex === 0);
    const party = (descCol != null ? cellText(row, descCol) : undefined) ?? (c0 ? c0.text : '');

    const ri   = row[0].rowIndex;
    const inst: TableInstrument = {
      tableClass: 'related_party_debt',
      tableIndex,
      noteNumber,
      rowIndex:   ri,
      fields:     {},
    };

    const absAmt = Math.abs(amt);
    // Populate the field matching the column's semantic so the converter knows what it represents
    if (amtSemantic === 'ending_balance') {
      inst.fields.endingBalance = makeField(absAmt, tableIndex, ri, amtCol, noteNumber, 0.92);
    } else if (amtSemantic === 'outstanding') {
      inst.fields.outstandingBalance = makeField(absAmt, tableIndex, ri, amtCol, noteNumber, 0.88);
    } else {
      inst.fields.transactionAmount = makeField(absAmt, tableIndex, ri, amtCol, noteNumber, 0.80);
    }

    if (party && looksLikeName(party))
      inst.fields.partyDescription = makeField(party, tableIndex, ri, descCol ?? 0, noteNumber, 0.85);

    instruments.push(inst);
  }

  return instruments;
}

function extractShareActivityRows(
  dataRows:   ParsedCell[][],
  colMap:     Map<ColSemantic, number>,
  tableIndex: number,
  noteNumber: number | undefined,
  _multiplier: number,
): TableInstrument[] {
  const instruments: TableInstrument[] = [];

  for (const row of dataRows) {
    const authCol  = colMap.get('shares_authorized');
    const outstCol = colMap.get('shares_outstanding');

    const authorized  = authCol  != null ? parseTableAmount(cellText(row, authCol),  1) : undefined;
    const outstanding = outstCol != null ? parseTableAmount(cellText(row, outstCol), 1) : undefined;

    if (!authorized && !outstanding) continue;
    if ((authorized ?? 0) < 1_000 && (outstanding ?? 0) < 1_000) continue;

    const ri   = row[0].rowIndex;
    const inst: TableInstrument = {
      tableClass: 'share_activity',
      tableIndex,
      noteNumber,
      rowIndex:   ri,
      fields:     {},
    };

    if (authorized)  inst.fields.sharesAuthorized  = makeField(authorized,  tableIndex, ri, authCol ?? 0,  noteNumber, 0.92);
    if (outstanding) inst.fields.sharesOutstanding = makeField(outstanding, tableIndex, ri, outstCol ?? 0, noteNumber, 0.92);

    instruments.push(inst);
  }

  return instruments;
}

// ─── Private: extract records from one classified table ───────────────────────

interface ParsedTableRecord {
  tableClass:  TableClass;
  tableIndex:  number;
  noteNumber?: number;
  rows:        ParsedCell[][];
  colMap:      Map<ColSemantic, number>;
  multiplier:  number;
}

function extractTableRecords(t: ParsedTableRecord): TableInstrument[] {
  const { tableClass, tableIndex, noteNumber, rows, colMap, multiplier } = t;
  const { data } = splitHeadersAndData(rows);

  switch (tableClass) {
    case 'convertible_note_schedule':
    case 'subsequent_events':
      return extractConvertibleNoteRows(data, colMap, tableIndex, noteNumber, multiplier);

    case 'debt_rollforward':
      return extractDebtRollforwardRows(data, colMap, tableIndex, noteNumber, multiplier);

    case 'warrant_table':
      return extractWarrantRows(data, colMap, tableIndex, noteNumber, multiplier);

    case 'equity_issuance':
    case 'preferred_stock':
      return extractEquityIssuanceRows(data, colMap, tableIndex, noteNumber, multiplier);

    case 'related_party_debt':
      return extractRelatedPartyRows(data, colMap, tableIndex, noteNumber, multiplier);

    case 'share_activity':
      return extractShareActivityRows(data, colMap, tableIndex, noteNumber, multiplier);

    default:
      return [];
  }
}

// ─── Public entry point ───────────────────────────────────────────────────────

export interface TableLayerResult {
  instruments: TableInstrument[];
  warnings:    string[];
}

/**
 * Run the table extraction layer on raw HTML filing text.
 * Must be called BEFORE cleanText() strips tags.
 * Returns TableInstrument[] ordered by table position in the document.
 */
export function buildTableLayer(html: string): TableLayerResult {
  const instruments: TableInstrument[] = [];
  const warnings:    string[]          = [];

  if (!html || !html.includes('<table')) return { instruments, warnings };

  const rawTables = extractRawTables(html);

  for (const { tableHtml, context, tableIndex } of rawTables) {
    try {
      const rows       = parseTableGrid(tableHtml);
      if (rows.length < 2) continue;   // single-row tables are headers/spacers

      const { headers } = splitHeadersAndData(rows);
      if (headers.length === 0) continue;

      const colMap     = detectColumnSemantics(headers);
      if (colMap.size === 0) continue;  // no recognizable columns

      const noteNumber = detectNoteNumberFromContext(context);
      const multiplier = detectMultiplierFromContext(context, tableHtml);
      const tableClass = classifyTable(colMap, context, rows);

      if (tableClass === 'unknown') continue;

      const record: ParsedTableRecord = { tableClass, tableIndex, noteNumber, rows, colMap, multiplier };
      const extracted = extractTableRecords(record);

      if (extracted.length === 0) {
        warnings.push(
          `VALIDATION: ${tableClass} table (index ${tableIndex}, note ${noteNumber ?? '?'}) ` +
          `produced no records — column headers detected but no qualifying data rows extracted.`,
        );
      }

      instruments.push(...extracted);
    } catch (e) {
      warnings.push(`Table ${tableIndex}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { instruments, warnings };
}
