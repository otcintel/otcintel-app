/**
 * Sentence-level semantic extraction layer.
 *
 * Pipeline:
 *   raw note text
 *     → splitNoteIntoSentences()      — sentence records with (noteNumber, para, sentence) indices
 *     → classifySentence()            — 16 semantic tags per sentence
 *     → linkInstruments()             — paragraph-level entity linking → Instrument[]
 *     → extractFieldsFromInstrument() — per-field extraction with per-field confidence scoring
 *
 * Every ExtractedField carries { value, confidence 0–1, sourceSentenceIndex, sourceNoteNumber }
 * enabling future UI deep-links into the SEC filing and per-field confidence reporting.
 *
 * @module parsers/sentenceLayer
 */

// ─── Public types ─────────────────────────────────────────────────────────────

export type SentenceTag =
  | 'note_issuance'
  | 'conversion'
  | 'maturity'
  | 'interest'
  | 'conversion_formula'
  | 'floor_price'
  | 'reset_provision'
  | 'lender_identity'
  | 'warrant_issuance'
  | 'equity_line'
  | 'common_stock_issuance'
  | 'preferred_stock_issuance'
  | 'related_party'
  | 'repayment'
  | 'amendment'
  | 'extinguishment';

export interface SentenceRecord {
  noteNumber?:    number;
  paragraphIndex: number;
  sentenceIndex:  number;
  text:           string;
}

export interface TaggedSentence extends SentenceRecord {
  tags: Set<SentenceTag>;
}

export interface ExtractedField<T> {
  value:               T;
  confidence:          number;    // 0.0–1.0
  sourceSentenceIndex: number;
  sourceNoteNumber?:   number;
}

export type InstrumentType =
  | 'note'
  | 'facility'
  | 'warrant'
  | 'issuance'
  | 'conversion'
  | 'related_party';

export interface InstrumentFields {
  // Note economics
  principalAmount?:      ExtractedField<number>;
  purchasePrice?:        ExtractedField<number>;
  originalIssueDiscount?: ExtractedField<number>;
  netProceeds?:          ExtractedField<number>;
  legalFees?:            ExtractedField<number>;
  placementFees?:        ExtractedField<number>;
  outstandingBalance?:   ExtractedField<number>;
  interestRate?:         ExtractedField<number>;
  defaultInterestRate?:  ExtractedField<number>;
  prepaymentPremium?:    ExtractedField<number>;
  prepaymentTerms?:      ExtractedField<string>;
  redemptionPremium?:    ExtractedField<number>;
  // Conversion
  conversionFormula?:    ExtractedField<string>;
  discountRate?:         ExtractedField<number>;
  lookbackDays?:         ExtractedField<number>;
  fixedConversionPrice?: ExtractedField<number>;
  floorPrice?:           ExtractedField<number | null>;
  hasFloorPrice?:        ExtractedField<boolean>;
  ceilingPrice?:         ExtractedField<number>;
  exchangeCap?:          ExtractedField<number>;
  beneficialOwnershipBlocker?: ExtractedField<number>;
  hasResetProvisions?:   ExtractedField<boolean>;
  antiDilutionProvisions?: ExtractedField<boolean>;
  // Defaults
  hasAccelerationClause?: ExtractedField<boolean>;
  penaltyRate?:          ExtractedField<number>;
  // Identity / status
  instrumentType?:       ExtractedField<string>;
  instrumentName?:       ExtractedField<string>;
  isAmendment?:          ExtractedField<boolean>;
  status?:               ExtractedField<string>;
  amountConverted?:      ExtractedField<number>;
  amountRepaid?:         ExtractedField<number>;
  // Dates
  maturityDate?:         ExtractedField<string>;
  executionDate?:        ExtractedField<string>;
  // Identity
  investorName?:         ExtractedField<string>;
  isExplicitlyConvertible?: ExtractedField<boolean>;
  // Facility
  facilitySize?:         ExtractedField<number>;
  drawnAmount?:          ExtractedField<number>;
  pricingFormula?:       ExtractedField<string>;
  // Issuance
  sharesIssued?:         ExtractedField<number>;
  debtConverted?:        ExtractedField<number>;
  effectivePrice?:       ExtractedField<number>;
  pricePerShare?:        ExtractedField<number>;
  grossProceeds?:        ExtractedField<number>;
  issuanceType?:         ExtractedField<string>;
  // Warrants
  warrantShares?:        ExtractedField<number>;
  exercisePrice?:        ExtractedField<number>;
  expirationDate?:       ExtractedField<string>;
  // Related party
  transactionAmount?:    ExtractedField<number>;
  partyDescription?:     ExtractedField<string>;
}

export interface Instrument {
  type:        InstrumentType;
  sentences:   TaggedSentence[];
  noteNumber?: number;
  fields:      InstrumentFields;
  allTags:     Set<SentenceTag>;
}

// ─── Private parse helpers ────────────────────────────────────────────────────
// Duplicated from financingReport.ts to avoid circular imports.

function parseDollar(raw: string): number | undefined {
  const s  = raw.replace(/,/g, '').replace(/[()]/g, '').trim();
  const mB = s.match(/\$?([\d.]+)\s*(?:billion|B)\b/i);
  if (mB) { const n = parseFloat(mB[1]); return Number.isFinite(n) ? Math.round(n * 1_000_000_000) : undefined; }
  const mM = s.match(/\$?([\d.]+)\s*(?:million|M)\b/i);
  if (mM) { const n = parseFloat(mM[1]); return Number.isFinite(n) ? Math.round(n * 1_000_000) : undefined; }
  const mK = s.match(/\$?([\d.]+)\s*[Kk]\b/);
  if (mK) { const n = parseFloat(mK[1]); return Number.isFinite(n) ? Math.round(n * 1_000) : undefined; }
  const n  = parseFloat(s.replace(/^\$/, '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

function parsePct(raw: string): number | undefined {
  const n = parseFloat(raw.replace(/%/g, '').trim());
  if (!Number.isFinite(n) || n <= 0 || n > 100) return undefined;
  return n / 100;
}

function parseShares(raw: string): number | undefined {
  const s  = raw.replace(/,/g, '').trim();
  const mB = s.match(/([\d.]+)\s*(?:billion|B)\b/i);
  if (mB) { const n = parseFloat(mB[1]); return Number.isFinite(n) ? Math.round(n * 1_000_000_000) : undefined; }
  const mM = s.match(/([\d.]+)\s*(?:million|M)\b/i);
  if (mM) { const n = parseFloat(mM[1]); return Number.isFinite(n) ? Math.round(n * 1_000_000) : undefined; }
  const mK = s.match(/([\d.]+)\s*[Kk]\b/);
  if (mK) { const n = parseFloat(mK[1]); return Number.isFinite(n) ? Math.round(n * 1_000) : undefined; }
  const n  = parseFloat(s.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

function parseDate(text: string): string | undefined {
  const iso = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  const long = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}/i);
  if (long) return long[0];
  const short = text.match(/\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/);
  return short?.[1];
}

// Must appear at the END of the name (trailing punctuation tolerated) to avoid
// matching words like "Financial Disclosure" or "Securities Act" mid-sentence.
const ENTITY_SUFFIX_RE = /\b(?:LLC|L\.L\.C\.?|LP|L\.P\.?|Ltd\.?|Limited|Corp\.?|Corporation|Inc\.?|Incorporated|Capital|Fund(?:ing)?|Holdings?|Ventures?|Management|Partners?|Advisors?|Securities|Financial|Investments?|Group|Trust|Equity|Credit|Lending|Strategies)[.,]?\s*$/i;
const NARRATIVE_START_RE = /^(?:the|a|an|this|that|such|any|each|all|both|our|its|their|certain|following|prior|above|below)\b/i;
const NARRATIVE_BODY_RE  = /\b(?:described|pursuant|referenced|mentioned|noted|set\s+forth|defined|outlined|arrangement|assumed|stated|herein|hereby|thereof|thereunder|thereto|hereunder)\b/i;
const NARRATIVE_LEAD_RE  = /^(?:issue[sd]?|issuance|assumption|condition|term|provision|section|note\s+\d|page\s+\d|paragraph|clause|schedule|exhibit|annex)\b/i;
// Rejects strings that are clearly auditor/disclosure boilerplate
const AUDITOR_BOILERPLATE_RE = /\b(?:accountants?\s+on|accounting\s+and\s+financial|disagreements?\s+with|disclosure\s+controls?|internal\s+control|critical\s+accounting|significant\s+accounting|audit\s+committee)\b/i;

function validateInvestorName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name.length < 4 || name.length > 90) return undefined;
  if (NARRATIVE_START_RE.test(name)) return undefined;
  if (NARRATIVE_BODY_RE.test(name))  return undefined;
  if (NARRATIVE_LEAD_RE.test(name))  return undefined;
  if (/\b20\d\d\b|\b19\d\d\b/.test(name)) return undefined;
  if (AUDITOR_BOILERPLATE_RE.test(name)) return undefined;
  if (ENTITY_SUFFIX_RE.test(name)) return name;
  const words = name.split(' ');
  if (words.length >= 2 && words.length <= 5) {
    const allProper = words.every(w => /^[A-Z][a-z]{1,}$/.test(w) || /^[A-Z]{2,6}$/.test(w));
    if (allProper) return name;
  }
  return undefined;
}

function parseInvestorName(text: string): string | undefined {
  const candidates = [
    text.match(/([A-Z][A-Za-z0-9\s,\.&]{2,60}?)\s*\(\s*(?:the\s+)?["""]?(?:Holder|Lender|Investor|Purchaser|Noteholder)["""]?\s*\)/i)?.[1],
    text.match(/entered\s+into\s+(?:a\s+)?(?:Securities\s+Purchase\s+Agreement|Loan\s+Agreement|Note\s+Purchase\s+Agreement)[^,]{0,20},?\s+with\s+([A-Z][A-Za-z0-9\s,\.&]{2,60}?)(?:\s*\(|,|\.|$)/i)?.[1],
    text.match(/\bwith\s+([A-Z][A-Za-z0-9\s,\.&]{2,60}?)(?:\s*\(|\s*,\s+an?\s+|\s*,\s+a\s+|\s*\.|$)/i)?.[1],
    text.match(/\bfrom\s+([A-Z][A-Za-z0-9\s,\.&]{2,60}?)(?:\s*\(|,|\.|$)/i)?.[1],
    text.match(/(?:lender|holder|investor|purchaser)\s+is\s+([A-Z][A-Za-z0-9\s,\.&]{2,60}?)(?:\s*\(|,|\.|$)/i)?.[1],
    text.match(/([A-Z][A-Za-z0-9\s,\.&]{2,60}?),?\s+an?\s+(?:accredited\s+investor|third[\s-]party)/i)?.[1],
  ];
  for (const raw of candidates) {
    const valid = validateInvestorName(raw?.trim());
    if (valid) return valid;
  }
  return undefined;
}

// ─── Sentence splitting ───────────────────────────────────────────────────────

// Sentinel character (ONE DOT LEADER) replaces protected periods during splitting.
const SENTINEL = '․';

function protectPeriods(text: string): string {
  return text
    // Common word abbreviations
    .replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Co|Corp|Inc|Ltd|LLC|LP|LLP|Mr|Mrs|Ms|Dr|No|Nos|Vol|vs|Sr|Jr|Sec|Dept|approx|Est|Ref)\./gi,
      (_, abbr) => abbr + SENTINEL)
    // U.S.-style initialism abbreviations
    .replace(/\bU\.S\./g,  `U${SENTINEL}S${SENTINEL}`)
    .replace(/\be\.g\./g,  `e${SENTINEL}g${SENTINEL}`)
    .replace(/\bi\.e\./g,  `i${SENTINEL}e${SENTINEL}`)
    // Decimal numbers: 0.001, 3.5, $0.001
    .replace(/(\d)\.(\d)/g, `$1${SENTINEL}$2`);
}

function restorePeriods(text: string): string {
  return text.replace(new RegExp(SENTINEL, 'g'), '.');
}

function splitSentencesInParagraph(para: string): string[] {
  const safe  = protectPeriods(para);
  // Lookbehind: split after [.!?] followed by whitespace before a capital letter.
  const parts = safe.split(/(?<=[.!?])\s+(?=[A-Z(])/);
  return parts.map(p => restorePeriods(p).trim()).filter(p => p.length > 8);
}

// ─── Step 1: Split text into tagged sentences ─────────────────────────────────

export function splitNoteIntoSentences(
  text:        string,
  noteNumber?: number,
): TaggedSentence[] {
  const paragraphs = text
    .split(/\n{2,}|\r\n{2,}/)
    .map(p => p.trim())
    .filter(p => p.length > 0);

  const result: TaggedSentence[] = [];
  let sentenceIndex = 0;

  for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
    const sentences = splitSentencesInParagraph(paragraphs[pIdx]);
    for (const sentText of sentences) {
      result.push({
        noteNumber,
        paragraphIndex: pIdx,
        sentenceIndex:  sentenceIndex++,
        text:           sentText,
        tags:           classifySentence(sentText),
      });
    }
  }

  return result;
}

// ─── Step 2: Sentence classifiers ────────────────────────────────────────────

const TAG_RULES: Array<[SentenceTag, RegExp]> = [
  ['note_issuance',
    /(?:entered\s+into|issued?|executed|borrowed|received\s+(?:the\s+)?(?:proceeds|loan)|signed|closed)\s+(?:a[n]?\s+)?(?:\$[\d,]+\s+)?(?:convertible|secured|unsecured|promissory|bridge|demand|senior|junior|subordinated?)\s+(?:note|loan|debenture|debt)|securities\s+purchase\s+agreement|principal\s+amount\s+of\s+\$|face\s+(?:amount|value)\s+of\s+\$|note\s+(?:in\s+the\s+amount\s+of|for\s+a\s+total\s+of|for)\s+\$|\bSPA\b.*\$|aggregate\s+principal/i],

  ['conversion',
    /conver(?:t(?:ed|ing)|sion)\s+(?:of|into|to)|converted?\s+\$|holder\s+(?:converted?|elected\s+to\s+convert|submitted\s+a\s+conversion\s+notice)|debt[-\s]to[-\s]equity\s+conversion/i],

  ['maturity',
    /matur(?:ity|es?|ing|ed)\s+(?:date|on\s+[A-Z]|date\s+(?:is|of|was))|due\s+(?:and\s+payable\s+)?(?:on\s+[A-Z]|date)|payable\s+in\s+full\s+on|maturity\s+date\s+(?:is|of|was)\s+[A-Z]/i],

  ['interest',
    /(?:bears?|accrues?|carries?|accruing|bearing)\s+interest\s+at|interest\s+(?:rate\s+(?:of|is)|accrues?\s+at\s+a\s+rate)|per\s+annum|p\.a\./i],

  ['conversion_formula',
    /conversion\s+price\s+(?:equal|is|of|at|shall\s+be)|discount\s+(?:of\s+\d|to\s+(?:the\s+)?(?:VWAP|market|closing|average))|VWAP|lowest\s+(?:closing|trading)\s+(?:bid\s+)?price\s+(?:over|during|of)\s+the\s+(?:previous|prior|last)\s+\d|convertible\s+at\s+(?:a\s+price\s+of\s+)?\$/i],

  ['floor_price',
    /floor\s+(?:conversion\s+)?price\s+(?:of\s+|at\s+|is\s+|shall\s+(?:not\s+be\s+)?)\$|minimum\s+(?:conversion\s+)?price\s+(?:of\s+|at\s+)\$|(?:not\s+(?:be\s+)?less\s+than|no\s+lower\s+than|no\s+less\s+than)\s+\$|floor\s+of\s+\$/i],

  ['reset_provision',
    /reset\s+provision|anti[-\s]dilut(?:ion|ive)|ratchet\s+(?:provision|adjustment|clause)|full\s+ratchet|weighted\s+average\s+anti/i],

  ['lender_identity',
    /(?:lender|holder|investor|purchaser|noteholder|payee)\s+(?:is|shall\s+be|being)\s+[A-Z]|(?:Securities\s+Purchase\s+Agreement|Loan\s+Agreement|Note\s+Purchase\s+Agreement).*\bwith\s+[A-Z]|[A-Z][A-Za-z\s&]{2,40}(?:LLC|LP|Ltd|Corp|Inc|Capital|Fund|Holdings?|Partners?|Management|Securities|Financial|Investments?|Group|Credit|Equity|Lending|Ventures?)\b/],

  ['warrant_issuance',
    /\bwarrants?\b.*(?:\d|purchase|exercis|right\s+to)|purchase\s+warrant|right\s+to\s+purchase\s+[\d,]+\s+shares?\s+of\s+common/i],

  ['equity_line',
    /equity\s+(?:line\s+of\s+credit|facility|purchase\s+agreement|financing\s+agreement|distribution\s+agreement)|\beloc\b|standby\s+equity\s+(?:distribution|purchase)|common\s+stock\s+purchase\s+agreement|\bcspa\b|committed\s+equity\s+facility/i],

  ['common_stock_issuance',
    /(?:issued?|sold?|delivered)\s+(?:[\d,]+\s+)?(?:shares?\s+of\s+)?(?:our\s+)?common\s+stock|common\s+stock\s+(?:was\s+)?(?:issued?|sold?|delivered)|private\s+placement\s+of\s+common|registered\s+direct\s+offering/i],

  ['preferred_stock_issuance',
    /preferred\s+stock\s+(?:was\s+)?(?:issued?|sold?|delivered)|issued?\s+(?:[\d,]+\s+)?(?:shares?\s+of\s+)?(?:series\s+[a-z]\s+)?preferred\s+(?:stock|shares?)|preferred\s+stock\s+offering/i],

  ['related_party',
    /\b(?:related[-\s]party|officer|director|CEO|CFO|COO|CTO|chief\s+(?:executive|financial|operating|technology)\s+officer|president|controlling\s+shareholder|majority\s+shareholder|principal\s+shareholder|affiliate[d]?)\b/i],

  ['repayment',
    /(?:repaid?|paid\s+(?:off|in\s+full)|repayment\s+of|retired\s+the\s+(?:note|loan|debt)|satisfied\s+(?:in\s+full\s+)?(?:the\s+)?(?:note|debt|obligation)|paid\s+down\s+(?:the\s+)?(?:balance|principal))/i],

  ['amendment',
    /\b(?:amended|modified|extended|restated|supplement(?:ed|al))\b.*(?:note|agreement|loan|facility)|amendment\s+(?:no\.?\s*\d|agreement|to\s+the)|modification\s+agreement/i],

  ['extinguishment',
    /(?:extinguished|settled\s+in\s+full|cancelled?|forgiven|wrote\s+off|write[-\s]off|forgave|debt\s+settlement|cancelled?\s+the\s+(?:note|debt|loan))/i],
];

export function classifySentence(text: string): Set<SentenceTag> {
  const tags = new Set<SentenceTag>();
  for (const [tag, re] of TAG_RULES) {
    if (re.test(text)) tags.add(tag);
  }
  return tags;
}

// ─── Step 3: Entity linking — paragraph-level ─────────────────────────────────
//
// An instrument boundary is drawn each time a paragraph contains an issuance
// trigger (note_issuance, equity_line, warrant_issuance, or stock issuance).
// Non-trigger paragraphs (maturity, interest, formula detail) are accumulated
// into the most recently opened instrument.
//
// This matches how SEC notes are actually written: each term paragraph for a
// distinct instrument begins with the issuance description, then adds details
// in following sentences or sub-paragraphs.

const ISSUANCE_TAGS = new Set<SentenceTag>([
  'note_issuance', 'equity_line', 'warrant_issuance',
  'common_stock_issuance', 'preferred_stock_issuance',
]);

function inferType(sentences: TaggedSentence[]): InstrumentType {
  const tags = new Set<SentenceTag>(sentences.flatMap(s => [...s.tags]));
  if (tags.has('equity_line'))              return 'facility';
  if (tags.has('warrant_issuance'))         return 'warrant';
  if (tags.has('conversion'))               return 'conversion';
  if (tags.has('preferred_stock_issuance')) return 'issuance';
  if (tags.has('common_stock_issuance'))    return 'issuance';
  if (tags.has('related_party'))            return 'related_party';
  if (tags.has('note_issuance'))            return 'note';
  return 'note';
}

function hasParagraphIssuanceTag(sentences: TaggedSentence[]): boolean {
  return sentences.some(s => {
    for (const t of ISSUANCE_TAGS) if (s.tags.has(t)) return true;
    return false;
  });
}

function createInstrument(sentences: TaggedSentence[], noteNumber?: number): Instrument {
  const allTags = new Set<SentenceTag>(sentences.flatMap(s => [...s.tags]));
  return {
    type:       inferType(sentences),
    sentences:  [...sentences],
    noteNumber,
    fields:     {},
    allTags,
  };
}

export function linkInstruments(
  sentences:   TaggedSentence[],
  noteNumber?: number,
): Instrument[] {
  if (sentences.length === 0) return [];

  // Group by paragraph index
  const byParagraph = new Map<number, TaggedSentence[]>();
  for (const s of sentences) {
    if (!byParagraph.has(s.paragraphIndex)) byParagraph.set(s.paragraphIndex, []);
    byParagraph.get(s.paragraphIndex)!.push(s);
  }

  const instruments: Instrument[] = [];
  let current: Instrument | null = null;

  for (const paraSentences of byParagraph.values()) {
    const paragraphHasIssuance = hasParagraphIssuanceTag(paraSentences);

    if (paragraphHasIssuance) {
      // Flush current instrument and start a new one for this issuance paragraph
      if (current !== null) instruments.push(current);
      current = createInstrument(paraSentences, noteNumber);
    } else if (current !== null) {
      // Continue: detail/modifier paragraphs belong to the open instrument
      for (const s of paraSentences) {
        current.sentences.push(s);
        for (const tag of s.tags) current.allTags.add(tag);
      }
    } else {
      // No open instrument yet — open one even without an explicit issuance
      // trigger (handles notes that start mid-block or in subsequent events)
      const hasAnyTag = paraSentences.some(s => s.tags.size > 0);
      if (hasAnyTag) current = createInstrument(paraSentences, noteNumber);
    }
  }

  if (current !== null) instruments.push(current);

  // Split note instruments that absorbed multiple distinct note announcements
  // within a single paragraph (common in subsequent-events blocks listing
  // several notes side-by-side).
  const split = instruments.flatMap(inst =>
    inst.type === 'note' ? splitMultiNoteInstrument(inst) : [inst],
  );

  // Populate fields on every instrument
  for (const inst of split) extractFieldsFromInstrument(inst);

  return split;
}

// Pattern for a sentence that opens a new distinct note description.
// Must start with a date reference + "Company issued" to distinguish
// opener sentences from mid-note detail sentences.
const NOTE_OPENER_RE =
  /\b(?:on\s+(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[^,]{0,30},\s+\d{4}[,\s]+(?:the\s+)?(?:company|we|registrant)\s+(?:issued?|entered\s+into|executed?|closed?\s+on))/i;

function splitMultiNoteInstrument(inst: Instrument): Instrument[] {
  // Find sentences that open a new note description
  const boundaries: number[] = [];
  for (let i = 0; i < inst.sentences.length; i++) {
    if (NOTE_OPENER_RE.test(inst.sentences[i].text)) {
      boundaries.push(i);
    }
  }

  // Only split if there are at least 2 boundaries (multiple notes)
  if (boundaries.length < 2) return [inst];

  const parts: Instrument[] = [];
  for (let b = 0; b < boundaries.length; b++) {
    const start = boundaries[b];
    const end   = b + 1 < boundaries.length ? boundaries[b + 1] : inst.sentences.length;
    const slice = inst.sentences.slice(start, end);
    const allTags = new Set<SentenceTag>(slice.flatMap(s => [...s.tags]));
    parts.push({
      type:       inst.type,
      sentences:  slice,
      noteNumber: inst.noteNumber,
      fields:     {},
      allTags,
    });
  }

  // Prepend any sentences that appeared before the first boundary
  if (boundaries[0] > 0) {
    const prefix = inst.sentences.slice(0, boundaries[0]);
    const prefixTags = new Set<SentenceTag>(prefix.flatMap(s => [...s.tags]));
    // Only keep prefix if it has its own meaningful content
    if (prefix.some(s => s.tags.size > 0)) {
      parts.unshift({ type: inst.type, sentences: prefix, noteNumber: inst.noteNumber, fields: {}, allTags: prefixTags });
    }
  }

  return parts;
}

// ─── Step 4: Per-field extraction with confidence scoring ─────────────────────
//
// bestMatch scans all sentences in an instrument for each pattern variant,
// ordered by confidence (most explicit first). Returns the highest-confidence
// match found, with its originating sentence index for source attribution.

interface FieldPattern<T> {
  re:   RegExp;
  conf: number;              // confidence for this pattern, 0.0–1.0
  fn:   (m: RegExpExecArray) => T | undefined;
}

function bestMatch<T>(
  sentences: TaggedSentence[],
  patterns:  FieldPattern<T>[],
): ExtractedField<T> | undefined {
  let best: { val: T; conf: number; idx: number } | undefined;
  for (const s of sentences) {
    for (const { re, conf, fn } of patterns) {
      const m = new RegExp(re.source, re.flags.includes('i') ? 'i' : '').exec(s.text);
      if (!m) continue;
      const val = fn(m);
      if (val === undefined) continue;
      if (!best || conf > best.conf) best = { val, conf, idx: s.sentenceIndex };
    }
  }
  if (!best) return undefined;
  return {
    value:               best.val,
    confidence:          best.conf,
    sourceSentenceIndex: best.idx,
    sourceNoteNumber:    sentences[0]?.noteNumber,
  };
}

// ── Principal ─────────────────────────────────────────────────────────────────

const PRINCIPAL_PATTERNS: FieldPattern<number>[] = [
  { conf: 0.95, re: /principal\s+(?:amount\s+)?(?:of\s+)?\$\s*([\d,\.]+(?:\s*(?:million|billion|M|B))?)/i,
    fn: m => parseDollar(m[1]) },
  { conf: 0.90, re: /(?:face|aggregate|original)\s+(?:principal\s+)?(?:amount|value)\s+(?:of\s+)?\$\s*([\d,\.]+(?:\s*(?:million|M))?)/i,
    fn: m => parseDollar(m[1]) },
  { conf: 0.85, re: /\$\s*([\d,\.]+(?:\s*(?:million|M))?)\s+(?:convertible|promissory|secured|unsecured|bridge|demand|exchange|senior)\s+note/i,
    fn: m => parseDollar(m[1]) },
  { conf: 0.80, re: /note[^.]{0,30}(?:in\s+the\s+amount\s+of|for(?:\s+a\s+total\s+of)?)\s+\$\s*([\d,\.]+(?:\s*(?:million|M))?)/i,
    fn: m => parseDollar(m[1]) },
  { conf: 0.78, re: /(?:issued?|entered\s+into)\s+[^.]{0,50}?\bnote\b[^.]{0,40}for\s+\$\s*([\d,\.]+(?:\s*(?:million|M))?)/i,
    fn: m => parseDollar(m[1]) },
  { conf: 0.75, re: /(?:borrowed|loaned|advanced|received)\s+(?:the\s+sum\s+of\s+)?\$\s*([\d,\.]+(?:\s*(?:million|M))?)/i,
    fn: m => parseDollar(m[1]) },
];

// ── Outstanding balance ───────────────────────────────────────────────────────

const BALANCE_PATTERNS: FieldPattern<number>[] = [
  { conf: 0.90, re: /(?:outstanding|remaining|unpaid|current)\s+(?:balance|principal|amount)\s+(?:of\s+)?\$\s*([\d,\.]+(?:\s*(?:million|M))?)/i,
    fn: m => parseDollar(m[1]) },
  { conf: 0.80, re: /(?:principal\s+)?balance\s+(?:of\s+)?\$\s*([\d,\.]+(?:\s*(?:million|M))?)/i,
    fn: m => parseDollar(m[1]) },
  { conf: 0.70, re: /(?:net\s+carrying\s+value|amount\s+due)\s+(?:of\s+)?\$\s*([\d,\.]+(?:\s*(?:million|M))?)/i,
    fn: m => parseDollar(m[1]) },
];

// ── Interest rate ─────────────────────────────────────────────────────────────

const INTEREST_PATTERNS: FieldPattern<number>[] = [
  { conf: 0.95, re: /(?:bears?|accrues?|carries?|accruing|bearing)\s+interest\s+at\s+(?:a\s+rate\s+of\s+)?(\d{1,3}(?:\.\d+)?)\s*%/i,
    fn: m => parsePct(m[1]) },
  { conf: 0.90, re: /interest\s+rate\s+(?:of|is)\s+(\d{1,3}(?:\.\d+)?)\s*%/i,
    fn: m => parsePct(m[1]) },
  { conf: 0.85, re: /(\d{1,3}(?:\.\d+)?)\s*%\s*(?:per\s+annum|annual|p\.a\.)/i,
    fn: m => parsePct(m[1]) },
  { conf: 0.75, re: /at\s+(?:the\s+rate\s+of\s+)?(\d{1,3}(?:\.\d+)?)\s*%\s+per\s+(?:annum|year)/i,
    fn: m => parsePct(m[1]) },
];

// ── Discount rate ─────────────────────────────────────────────────────────────
//
// OTCIntel invariant: discountRate ALWAYS represents the ECONOMIC discount from
// market price (i.e. the holder's advantage), regardless of how the filing
// phrases the conversion formula.
//
//   Direct form  ("X% discount to VWAP")   → stored = X / 100
//   Inverse form ("X% of [reference price]") → stored = (100 − X) / 100
//
// Pattern classification:
//   [0] "X% discount to VWAP/market/closing/lowest" → direct form
//   [1] "conversion price equal to X% [of…]"        → inverse form
//   [2] "at X% of the [lowest|average|closing|market]" → inverse form
//   [3] "discount of X%"                             → direct form
//   [4] "OID of X%"                                  → direct form (as implied discount)

function invertPct(raw: string): number | undefined {
  const f = parsePct(raw);
  return f == null ? undefined : 1 - f;
}

const DISCOUNT_PATTERNS: FieldPattern<number>[] = [
  // [0] Direct: "X% discount to VWAP/market/closing/lowest"
  { conf: 0.95, re: /(\d{1,3}(?:\.\d+)?)\s*%\s*discount\s+to\s+(?:the\s+)?(?:VWAP|market|closing|lowest)/i,
    fn: m => parsePct(m[1]) },
  // [1] Inverse: "conversion price equal to X% [of …]" — X% is the conversion factor, not the discount
  { conf: 0.90, re: /conversion\s+price\s+equal\s+to\s+(\d{1,3}(?:\.\d+)?)\s*%/i,
    fn: m => invertPct(m[1]) },
  // [2] Inverse: "at X% of the [lowest|average|closing|market]" — same semantic
  { conf: 0.85, re: /at\s+(\d{1,3}(?:\.\d+)?)\s*%\s+of\s+(?:the\s+)?(?:lowest|average|closing|market)/i,
    fn: m => invertPct(m[1]) },
  // [3] Direct: "discount of X%"
  { conf: 0.75, re: /discount\s+(?:of\s+)?(\d{1,3}(?:\.\d+)?)\s*%/i,
    fn: m => parsePct(m[1]) },
  // [4] Direct: OID as implied discount
  { conf: 0.70, re: /(?:OID|original\s+issue\s+discount)\s+(?:of\s+)?(\d{1,3}(?:\.\d+)?)\s*%/i,
    fn: m => parsePct(m[1]) },
];

// ── Lookback days ─────────────────────────────────────────────────────────────

const LOOKBACK_PATTERNS: FieldPattern<number>[] = [
  { conf: 0.90, re: /(\d+)\s*[-–]?\s*(?:trading\s+)?days?\s+VWAP/i,
    fn: m => { const n = parseInt(m[1], 10); return n > 0 && n <= 250 ? n : undefined; } },
  { conf: 0.85, re: /(?:previous|prior|last)\s+(\d+)\s*(?:trading\s+)?days?\s+(?:VWAP|average|closing)/i,
    fn: m => { const n = parseInt(m[1], 10); return n > 0 && n <= 250 ? n : undefined; } },
  { conf: 0.80, re: /VWAP\s+(?:of|over|for)\s+(?:the\s+)?(?:previous|prior|last)?\s*(\d+)\s*(?:trading\s+)?days?/i,
    fn: m => { const n = parseInt(m[1], 10); return n > 0 && n <= 250 ? n : undefined; } },
  { conf: 0.75, re: /lowest\s+(?:closing|trading)\s+(?:bid\s+)?price\s+(?:of\s+)?(?:the\s+)?(?:previous|prior|last)\s+(\d+)/i,
    fn: m => { const n = parseInt(m[1], 10); return n > 0 && n <= 250 ? n : undefined; } },
  { conf: 0.80, re: /(\d+)\s*(?:trading\s+)?days?\s+prior\s+to\s+(?:the\s+)?(?:conversion|exercise|applicable)/i,
    fn: m => { const n = parseInt(m[1], 10); return n > 0 && n <= 250 ? n : undefined; } },
  { conf: 0.75, re: /lowest\s+(?:trading|closing|bid)\s+price[^.]{0,40}(\d+)\s*(?:trading\s+)?days?/i,
    fn: m => { const n = parseInt(m[1], 10); return n > 0 && n <= 250 ? n : undefined; } },
];

// ── Fixed conversion price ────────────────────────────────────────────────────

const FIXED_PRICE_PATTERNS: FieldPattern<number>[] = [
  { conf: 0.95, re: /(?:fixed\s+)?conversion\s+price\s+(?:of\s+|equal\s+to\s+|at\s+)?\$\s*([\d.]+)\s*(?:per\s+share)?(?!\s*%)/i,
    fn: m => { const n = parseFloat(m[1]); return n > 0 && n < 1_000 ? n : undefined; } },
  { conf: 0.90, re: /convertible\s+(?:at|into\s+common\s+stock\s+at)\s+\$\s*([\d.]+)\s+per\s+share/i,
    fn: m => { const n = parseFloat(m[1]); return n > 0 && n < 1_000 ? n : undefined; } },
  { conf: 0.85, re: /at\s+a\s+(?:fixed\s+)?(?:conversion\s+)?price\s+of\s+\$\s*([\d.]+)\s+per\s+share/i,
    fn: m => { const n = parseFloat(m[1]); return n > 0 && n < 1_000 ? n : undefined; } },
];

// ── Floor price ───────────────────────────────────────────────────────────────

const FLOOR_PRICE_PATTERNS: FieldPattern<number | null>[] = [
  { conf: 0.95, re: /floor\s+(?:conversion\s+)?price\s+(?:of\s+)?\$\s*([\d.]+)/i,
    fn: m => { const n = parseFloat(m[1]); return n > 0 ? n : null; } },
  { conf: 0.90, re: /(?:minimum|floor)\s+price\s+(?:of\s+)?\$\s*([\d.]+)/i,
    fn: m => { const n = parseFloat(m[1]); return n > 0 ? n : null; } },
  { conf: 0.85, re: /(?:not\s+(?:be\s+)?less\s+than|no\s+lower\s+than|no\s+less\s+than)\s+\$\s*([\d.]+)/i,
    fn: m => { const n = parseFloat(m[1]); return n > 0 ? n : null; } },
  // Explicit no-floor statement
  { conf: 0.85, re: /no\s+floor|without\s+a\s+floor|no\s+minimum\s+conversion\s+price/i,
    fn: () => null },
];

// ── Maturity date ─────────────────────────────────────────────────────────────

const MATURITY_PATTERNS: FieldPattern<string>[] = [
  { conf: 0.95, re: /matur(?:ity|es?|ing|ed)\s+(?:date\s+(?:of|is)\s+)?(?:on\s+)?((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2})/i,
    fn: m => m[1] },
  { conf: 0.90, re: /due\s+(?:and\s+payable\s+)?(?:on\s+)?((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2})/i,
    fn: m => m[1] },
  { conf: 0.80, re: /payable\s+in\s+full\s+on\s+((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2})/i,
    fn: m => m[1] },
];

// ── Execution date ────────────────────────────────────────────────────────────

const EXEC_DATE_PATTERNS: FieldPattern<string>[] = [
  { conf: 0.90, re: /(?:dated?\s+as\s+of|entered\s+into\s+on|executed\s+on|issued?\s+on)\s+((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2})/i,
    fn: m => m[1] },
  // "On June 3, 2025, the Company issued / entered into / executed..."
  { conf: 0.85, re: /\bon\s+((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}),?\s+(?:the\s+)?(?:company|we|registrant)\s+(?:issued?|entered|executed|closed)\b/i,
    fn: m => m[1] },
  // "On March 17, 2025, Acme Corp. (the 'Company') entered into a convertible..."
  { conf: 0.82, re: /\bon\s+((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4})\b[\s\S]{0,200}?(?:issued?|entered\s+into)\s+(?:a\s+)?convertible\b/i,
    fn: m => m[1] },
  { conf: 0.80, re: /dated?\s+((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2})/i,
    fn: m => m[1] },
];

// ── Investor / lender name ────────────────────────────────────────────────────

const INVESTOR_PATTERNS: FieldPattern<string>[] = [
  { conf: 0.95, re: /([A-Z][A-Za-z0-9\s,\.&]{2,60}?)\s*\(\s*(?:the\s+)?["""]?(?:Holder|Lender|Investor|Purchaser|Noteholder)["""]?\s*\)/i,
    fn: m => validateInvestorName(m[1]) },
  { conf: 0.90, re: /(?:Securities\s+Purchase\s+Agreement|Loan\s+Agreement|Note\s+Purchase\s+Agreement)[^,]{0,20},?\s+with\s+([A-Z][A-Za-z0-9\s,\.&]{2,60}?)(?:\s*\(|,|\.|$)/i,
    fn: m => validateInvestorName(m[1]) },
  { conf: 0.80, re: /(?:lender|holder|investor|purchaser)\s+is\s+([A-Z][A-Za-z0-9\s,\.&]{2,60}?)(?:\s*\(|,|\.|$)/i,
    fn: m => validateInvestorName(m[1]) },
  { conf: 0.75, re: /\bwith\s+([A-Z][A-Za-z0-9\s,\.&]{2,60}?)(?:\s*\(|\s*,\s+an?\s+|\s*,\s+a\s+|\s*\.|$)/i,
    fn: m => validateInvestorName(m[1]) },
  { conf: 0.70, re: /([A-Z][A-Za-z0-9\s,\.&]{2,60}?),?\s+an?\s+(?:accredited\s+investor|third[\s-]party)/i,
    fn: m => validateInvestorName(m[1]) },
];

// ── Facility size ─────────────────────────────────────────────────────────────

const FACILITY_SIZE_PATTERNS: FieldPattern<number>[] = [
  { conf: 0.95, re: /(?:up\s+to|total\s+of|maximum\s+of|commitment\s+of|aggregate\s+of|not\s+to\s+exceed)\s+\$\s*([\d,\.]+(?:\s*(?:million|M))?)/i,
    fn: m => parseDollar(m[1]) },
  { conf: 0.85, re: /\$\s*([\d,\.]+(?:\s*(?:million|M))?)\s+(?:equity\s+)?(?:facility|line|commitment|aggregate|financing)/i,
    fn: m => parseDollar(m[1]) },
];

// ── Drawn amount ──────────────────────────────────────────────────────────────

const DRAWN_PATTERNS: FieldPattern<number>[] = [
  { conf: 0.90, re: /(?:drawn|utilized|sold?\s+(?:and\s+issued?)?)\s+\$\s*([\d,\.]+(?:\s*(?:million|M))?)/i,
    fn: m => parseDollar(m[1]) },
  { conf: 0.80, re: /\$\s*([\d,\.]+(?:\s*(?:million|M))?)\s+(?:has\s+been\s+)?(?:drawn|utilized|accessed|sold|issued\s+(?:and\s+sold)?)/i,
    fn: m => parseDollar(m[1]) },
];

// ── Pricing formula ───────────────────────────────────────────────────────────

const PRICING_FORMULA_PATTERNS: FieldPattern<string>[] = [
  { conf: 0.90, re: /at\s+a\s+discount\s+to\s+([^.\n]{3,80}?(?:VWAP|market|closing|average)[^.\n]{0,60})/i,
    fn: m => m[1].trim().slice(0, 120) },
  { conf: 0.80, re: /(\d{1,3}(?:\.\d+)?%\s+of\s+(?:the\s+)?(?:lowest\s+|average\s+)?(?:VWAP|closing|market)[^.\n]{0,80})/i,
    fn: m => m[1].trim().slice(0, 120) },
];

// ── Shares issued / converted ─────────────────────────────────────────────────

const SHARES_ISSUED_PATTERNS: FieldPattern<number>[] = [
  { conf: 0.90, re: /(?:issued?|sold?|aggregate\s+of|delivered)\s+(?:of\s+)?([\d,\.]+(?:\s*(?:million|M|B))?)\s+(?:shares?\s+of\s+)?(?:common|preferred|restricted)?\s*(?:stock|shares?)/i,
    fn: m => parseShares(m[1]) },
  { conf: 0.85, re: /([\d,\.]+(?:\s*(?:million|M|B))?)\s+shares?\s+(?:of\s+)?(?:common\s+)?(?:stock|shares?)\s+(?:were\s+)?(?:issued|sold)/i,
    fn: m => parseShares(m[1]) },
  { conf: 0.80, re: /resulting\s+in\s+(?:the\s+)?issuance\s+of\s+([\d,\.]+(?:\s*(?:million|M|B))?)\s+shares/i,
    fn: m => parseShares(m[1]) },
];

const DEBT_CONVERTED_PATTERNS: FieldPattern<number>[] = [
  { conf: 0.90, re: /(?:principal|debt|face\s+value|outstanding)\s+(?:of\s+)?\$\s*([\d,\.]+(?:\s*(?:million|M))?)/i,
    fn: m => parseDollar(m[1]) },
  { conf: 0.85, re: /\$\s*([\d,\.]+(?:\s*(?:million|M))?)\s+(?:of\s+)?(?:principal|note|debt|outstanding)/i,
    fn: m => parseDollar(m[1]) },
  { conf: 0.80, re: /converted?\s+\$\s*([\d,\.]+(?:\s*(?:million|M))?)/i,
    fn: m => parseDollar(m[1]) },
];

// ── Conversion / share price ──────────────────────────────────────────────────

const EFFECTIVE_PRICE_PATTERNS: FieldPattern<number>[] = [
  { conf: 0.90, re: /(?:conversion\s+price|converted?\s+at)\s+(?:of\s+)?\$\s*([\d.]+)/i,
    fn: m => { const n = parseFloat(m[1]); return n > 0 ? n : undefined; } },
  { conf: 0.85, re: /effective\s+(?:conversion\s+)?price\s+(?:of\s+)?\$\s*([\d.]+)/i,
    fn: m => { const n = parseFloat(m[1]); return n > 0 ? n : undefined; } },
  { conf: 0.75, re: /\$\s*([\d.]+)\s+per\s+share/i,
    fn: m => { const n = parseFloat(m[1]); return n > 0 ? n : undefined; } },
];

// ── Warrant fields ────────────────────────────────────────────────────────────

const WARRANT_SHARES_PATTERNS: FieldPattern<number>[] = [
  { conf: 0.90, re: /warrants?\s+to\s+purchase\s+(?:up\s+to\s+)?([\d,\.]+(?:\s*(?:million|M|B))?)\s+shares?/i,
    fn: m => parseShares(m[1]) },
  { conf: 0.85, re: /right\s+to\s+purchase\s+(?:up\s+to\s+)?([\d,\.]+(?:\s*(?:million|M|B))?)\s+(?:shares?\s+of\s+)?(?:common\s+)?(?:stock|shares?)/i,
    fn: m => parseShares(m[1]) },
  { conf: 0.80, re: /([\d,\.]+(?:\s*(?:million|M|B))?)\s+(?:shares?\s+(?:of\s+)?(?:common\s+)?(?:stock\s+)?)?warrants?/i,
    fn: m => parseShares(m[1]) },
];

const EXERCISE_PRICE_PATTERNS: FieldPattern<number>[] = [
  { conf: 0.90, re: /exercise\s+price\s+(?:of\s+)?\$\s*([\d.]+)/i,
    fn: m => { const n = parseFloat(m[1]); return n > 0 ? n : undefined; } },
  { conf: 0.85, re: /exercis(?:able|ed?)\s+at\s+\$\s*([\d.]+)/i,
    fn: m => { const n = parseFloat(m[1]); return n > 0 ? n : undefined; } },
  { conf: 0.80, re: /strike\s+price\s+(?:of\s+)?\$\s*([\d.]+)/i,
    fn: m => { const n = parseFloat(m[1]); return n > 0 ? n : undefined; } },
];

const EXPIRATION_DATE_PATTERNS: FieldPattern<string>[] = [
  { conf: 0.90, re: /expir(?:e[sd]?|ation|ing)\s+(?:on\s+)?((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2})/i,
    fn: m => m[1] },
];

// ── Related party ─────────────────────────────────────────────────────────────

const TXN_AMOUNT_PATTERNS: FieldPattern<number>[] = [
  // Take the single largest dollar amount in the sentence as the transaction amount
  { conf: 0.80, re: /\$\s*([\d,\.]+(?:\s*(?:million|M))?)/i,
    fn: m => parseDollar(m[1]) },
];

const PARTY_DESC_PATTERNS: FieldPattern<string>[] = [
  { conf: 0.90, re: /(?:our|the\s+)?(?:CEO|CFO|COO|CTO|chief\s+(?:executive|financial|operating|technology)\s+officer|president|director|officer|principal\s+shareholder|majority\s+shareholder|controlling\s+shareholder)/i,
    fn: m => m[0].slice(0, 80).trim() },
  { conf: 0.75, re: /\b(CEO|CFO|COO|CTO|President|Director|Officer)\b/i,
    fn: m => m[1] },
];

// ── Price per share / gross proceeds for issuances ────────────────────────────

const PRICE_PER_SHARE_PATTERNS: FieldPattern<number>[] = [
  { conf: 0.90, re: /(?:at|price\s+of|priced\s+at)\s+\$\s*([\d.]+)\s+per\s+share/i,
    fn: m => { const n = parseFloat(m[1]); return n > 0 ? n : undefined; } },
  { conf: 0.80, re: /\$\s*([\d.]+)\s+per\s+(?:common\s+)?share/i,
    fn: m => { const n = parseFloat(m[1]); return n > 0 ? n : undefined; } },
];

const GROSS_PROCEEDS_PATTERNS: FieldPattern<number>[] = [
  { conf: 0.90, re: /(?:gross\s+|net\s+)?proceeds\s+(?:of\s+)?\$\s*([\d,\.]+(?:\s*(?:million|M))?)/i,
    fn: m => parseDollar(m[1]) },
  { conf: 0.80, re: /\$\s*([\d,\.]+(?:\s*(?:million|M))?)\s+(?:in\s+(?:gross\s+)?)?proceeds/i,
    fn: m => parseDollar(m[1]) },
];

const ISSUANCE_TYPE_PATTERNS: FieldPattern<string>[] = [
  { conf: 0.95, re: /at[-\s]the[-\s]market|\bATM\b/i,              fn: () => 'atm' },
  { conf: 0.90, re: /registered\s+direct/i,                         fn: () => 'registered_direct' },
  { conf: 0.85, re: /preferred\s+stock/i,                           fn: () => 'preferred' },
  { conf: 0.80, re: /private\s+placement/i,                         fn: () => 'common' },
  { conf: 0.60, re: /common\s+stock/i,                              fn: () => 'common' },
];

// ── Purchase price ────────────────────────────────────────────────────────────

const PURCHASE_PRICE_PATTERNS: FieldPattern<number>[] = [
  { conf: 0.95, re: /purchase\s+price\s+(?:of\s+|shall\s+be\s+|is\s+)?\$\s*([\d,\.]+(?:\s*(?:million|M))?)/i,
    fn: m => parseDollar(m[1]) },
  { conf: 0.90, re: /aggregate\s+purchase\s+price\s+(?:of\s+|shall\s+be\s+)?\$\s*([\d,\.]+(?:\s*(?:million|M))?)/i,
    fn: m => parseDollar(m[1]) },
];

// ── Original Issue Discount ───────────────────────────────────────────────────

const OID_PATTERNS: FieldPattern<number>[] = [
  { conf: 0.95, re: /(?:original\s+issue\s+discount|OID)\s+(?:of\s+)?\$\s*([\d,\.]+(?:\s*(?:million|M))?)/i,
    fn: m => parseDollar(m[1]) },
  { conf: 0.90, re: /(?:issue|issuance)\s+discount\s+of\s+\$\s*([\d,\.]+)/i,
    fn: m => parseDollar(m[1]) },
  { conf: 0.85, re: /\bOID\b\s+of\s+\$\s*([\d,\.]+)/i,
    fn: m => parseDollar(m[1]) },
];

// ── Net proceeds ──────────────────────────────────────────────────────────────

const NET_PROCEEDS_PATTERNS: FieldPattern<number>[] = [
  { conf: 0.95, re: /net\s+proceeds\s+(?:(?:to\s+(?:the\s+)?(?:company|us|we))\s+)?(?:of|were|totaling)\s+\$\s*([\d,\.]+(?:\s*(?:million|M))?)/i,
    fn: m => parseDollar(m[1]) },
  { conf: 0.90, re: /\$\s*([\d,\.]+(?:\s*(?:million|M))?)\s+in\s+net\s+proceeds/i,
    fn: m => parseDollar(m[1]) },
  { conf: 0.85, re: /(?:received|resulted\s+in)\s+net\s+proceeds\s+of\s+\$\s*([\d,\.]+(?:\s*(?:million|M))?)/i,
    fn: m => parseDollar(m[1]) },
  // "cash proceeds of $X" — used in OTC filings as synonym for net proceeds
  { conf: 0.83, re: /cash\s+proceeds\s+of\s+\$\s*([\d,\.]+(?:\s*(?:million|M))?)/i,
    fn: m => parseDollar(m[1]) },
];

// ── Legal fees ────────────────────────────────────────────────────────────────

const LEGAL_FEE_PATTERNS: FieldPattern<number>[] = [
  { conf: 0.90, re: /(?:legal\s+(?:fees?|expenses?)|attorney(?:s)?\s+fees?)\s+(?:of\s+)?\$\s*([\d,\.]+)/i,
    fn: m => parseDollar(m[1]) },
  { conf: 0.85, re: /\$\s*([\d,\.]+)\s+(?:in\s+)?(?:legal\s+fees?|attorney\s+fees?)/i,
    fn: m => parseDollar(m[1]) },
];

// ── Placement fees ────────────────────────────────────────────────────────────

const PLACEMENT_FEE_PATTERNS: FieldPattern<number>[] = [
  { conf: 0.90, re: /(?:placement\s+(?:agent\s+)?(?:fee|commission)|finder(?:'s)?\s+fee|broker(?:age)?\s+fee)\s+(?:of\s+)?\$\s*([\d,\.]+)/i,
    fn: m => parseDollar(m[1]) },
  { conf: 0.85, re: /\$\s*([\d,\.]+)\s+(?:in\s+)?(?:placement|finder|brokerage)\s+(?:agent\s+)?fee/i,
    fn: m => parseDollar(m[1]) },
];

// ── Default interest rate ─────────────────────────────────────────────────────

const DEFAULT_INTEREST_PATTERNS: FieldPattern<number>[] = [
  { conf: 0.95, re: /default\s+interest\s+(?:rate\s+(?:of|is|shall\s+be)\s+)?(\d{1,3}(?:\.\d+)?)\s*%/i,
    fn: m => parsePct(m[1]) },
  { conf: 0.90, re: /interest\s+(?:rate\s+)?(?:shall\s+)?(?:increase\s+to|become)\s+(\d{1,3}(?:\.\d+)?)\s*%[^.]{0,60}(?:event\s+of\s+)?default/i,
    fn: m => parsePct(m[1]) },
  { conf: 0.90, re: /upon\s+(?:an?\s+)?(?:event\s+of\s+)?default[^.]{0,80}?interest[^.]{0,30}?(\d{1,3}(?:\.\d+)?)\s*%/i,
    fn: m => parsePct(m[1]) },
  { conf: 0.85, re: /(?:default|penalty)\s+rate\s+(?:of\s+)?(\d{1,3}(?:\.\d+)?)\s*%/i,
    fn: m => parsePct(m[1]) },
];

// ── Prepayment premium ────────────────────────────────────────────────────────

const PREPAYMENT_PREMIUM_PATTERNS: FieldPattern<number>[] = [
  // "prepayment premium of 25%" → 0.25
  { conf: 0.95, re: /prepayment\s+(?:premium|penalty)\s+(?:of\s+)?(\d{1,3}(?:\.\d+)?)\s*%/i,
    fn: m => { const n = parseFloat(m[1]); return n > 0 && n < 100 ? n / 100 : undefined; } },
  // "prepay at 125% of outstanding" → 0.25
  { conf: 0.90, re: /(?:prepay|prepaid?|redeem|redeemed?)[^.]{0,80}?(1[0-9]{2}(?:\.\d+)?)\s*%\s+of\s+(?:the\s+)?(?:outstanding|aggregate|principal|then[-\s]outstanding)/i,
    fn: m => { const n = parseFloat(m[1]); return n > 100 && n <= 200 ? (n - 100) / 100 : undefined; } },
  // "must pay 125% to prepay" → 0.25
  { conf: 0.85, re: /(1[0-9]{2}(?:\.\d+)?)\s*%\s+(?:of\s+(?:the\s+)?(?:outstanding|aggregate|principal|face)[^.]{0,60}?)?(?:prepay|prepayment|optional\s+redemption)/i,
    fn: m => { const n = parseFloat(m[1]); return n > 100 && n <= 200 ? (n - 100) / 100 : undefined; } },
];

// ── Redemption premium ────────────────────────────────────────────────────────

const REDEMPTION_PREMIUM_PATTERNS: FieldPattern<number>[] = [
  // "redemption premium of 10%" → 0.10
  { conf: 0.95, re: /redemption\s+(?:premium|price\s+equal\s+to)\s+(?:of\s+)?(\d{1,3}(?:\.\d+)?)\s*%/i,
    fn: m => { const n = parseFloat(m[1]); return n > 0 && n < 100 ? n / 100 : undefined; } },
  // "redeemed at 110% of outstanding" → 0.10
  { conf: 0.90, re: /redeemed?\s+at\s+(1[0-9]{2}(?:\.\d+)?)\s*%\s+of\s+(?:the\s+)?(?:outstanding|aggregate|principal|face)/i,
    fn: m => { const n = parseFloat(m[1]); return n > 100 && n <= 200 ? (n - 100) / 100 : undefined; } },
];

// ── Conversion formula text ───────────────────────────────────────────────────

const CONVERSION_FORMULA_PATTERNS: FieldPattern<string>[] = [
  { conf: 0.90, re: /conversion\s+price\s+(?:shall\s+(?:equal|be)|is\s+equal\s+to|equals?|means?)\s+([^.]{15,300}?(?:VWAP|lowest|average|closing|market|bid|ask)[^.]{0,200})/i,
    fn: m => m[1].trim().replace(/\s+/g, ' ').slice(0, 400) },
  { conf: 0.85, re: /convertible\s+(?:at|into[^.]{0,30}at)\s+(?:a\s+price\s+(?:equal\s+to\s+)?(?:of\s+)?)?([^.]{15,300}?%[^.]{0,200})/i,
    fn: m => m[1].trim().replace(/\s+/g, ' ').slice(0, 400) },
  { conf: 0.80, re: /(?:the\s+)?conversion\s+price\s+(?:is\s+)?(?:equal\s+to\s+)?(\d{1,3}(?:\.\d+)?%[^.]{5,200})/i,
    fn: m => m[1].trim().replace(/\s+/g, ' ').slice(0, 400) },
  // "converts at X% of the lowest trading price..." — verb form instead of adjective
  { conf: 0.78, re: /\bconverts?\b[^.]{0,80}?\bat\s+(\d{1,3}(?:\.\d+)?\s*%[^.]{5,200})/i,
    fn: m => m[1].trim().replace(/\s+/g, ' ').slice(0, 400) },
];

// ── Ceiling price ─────────────────────────────────────────────────────────────

const CEILING_PRICE_PATTERNS: FieldPattern<number>[] = [
  { conf: 0.95, re: /(?:ceiling|maximum|cap(?:ped\s+at)?)\s+(?:conversion\s+)?price\s+(?:of\s+)?\$\s*([\d.]+)/i,
    fn: m => { const n = parseFloat(m[1]); return n > 0 ? n : undefined; } },
  { conf: 0.90, re: /(?:not\s+(?:to\s+)?(?:exceed|be\s+(?:more|greater)\s+than))\s+\$\s*([\d.]+)\s+per\s+(?:common\s+)?share/i,
    fn: m => { const n = parseFloat(m[1]); return n > 0 ? n : undefined; } },
  { conf: 0.85, re: /maximum\s+conversion\s+price\s+(?:of\s+)?\$\s*([\d.]+)/i,
    fn: m => { const n = parseFloat(m[1]); return n > 0 ? n : undefined; } },
];

// ── Exchange cap ──────────────────────────────────────────────────────────────

const EXCHANGE_CAP_PATTERNS: FieldPattern<number>[] = [
  { conf: 0.90, re: /exchange\s+cap\s+(?:of\s+|at\s+)?([\d,\.]+(?:\s*(?:million|M|B))?)\s+shares?/i,
    fn: m => parseShares(m[1]) },
  { conf: 0.85, re: /(?:Nasdaq|NYSE|exchange)\s+(?:rule[^.]{0,40}|listing\s+rule[^.]{0,40}|cap[^.]{0,10}of\s+)([\d,\.]+(?:\s*(?:million|M|B))?)\s+shares?/i,
    fn: m => parseShares(m[1]) },
  { conf: 0.80, re: /aggregate\s+(?:share\s+)?(?:issuance\s+)?cap\s+of\s+([\d,\.]+(?:\s*(?:million|M|B))?)\s+shares?/i,
    fn: m => parseShares(m[1]) },
];

// ── Beneficial ownership blocker ──────────────────────────────────────────────

const BENEFICIAL_OWNERSHIP_PATTERNS: FieldPattern<number>[] = [
  { conf: 0.95, re: /beneficial\s+ownership\s+(?:limitation|blocker|cap|limit|threshold|provision)\s+of\s+(\d{1,2}(?:\.\d+)?)\s*%/i,
    fn: m => parsePct(m[1]) },
  { conf: 0.90, re: /(?:not\s+(?:to\s+)?(?:exceed|convert|beneficial(?:ly)?\s+own)|shall\s+not\s+result\s+in\s+(?:the\s+holder)?(?:.*?)beneficially\s+own)[^.]{0,100}?(\d{1,2}(?:\.\d+)?)\s*%\s+of\s+(?:the\s+)?(?:total\s+)?(?:outstanding|issued\s+and\s+outstanding)/i,
    fn: m => parsePct(m[1]) },
  // Hardcoded common values when expressed in context of "ownership"
  { conf: 0.88, re: /\b4\.99\s*%\b[^.]{0,80}(?:outstanding|beneficial|ownership|shares)/i,
    fn: () => 0.0499 },
  { conf: 0.88, re: /\b9\.99\s*%\b[^.]{0,80}(?:outstanding|beneficial|ownership|shares)/i,
    fn: () => 0.0999 },
];

// ── Anti-dilution provisions ──────────────────────────────────────────────────

const ANTI_DILUTION_PATTERNS: FieldPattern<boolean>[] = [
  { conf: 0.92, re: /anti[-\s]dilution\s+(?:provision|protection|clause|right|adjustment|feature|covenant)/i,
    fn: () => true },
  { conf: 0.90, re: /most[-\s]favored[-\s]nation|MFN\s+(?:clause|provision|right|covenant)/i,
    fn: () => true },
  { conf: 0.88, re: /full[-\s]ratchet\s+anti[-\s]dilution/i,
    fn: () => true },
  { conf: 0.80, re: /weighted[-\s]average\s+anti[-\s]dilution/i,
    fn: () => true },
];

// ── Acceleration clause ───────────────────────────────────────────────────────

const ACCELERATION_PATTERNS: FieldPattern<boolean>[] = [
  { conf: 0.90, re: /accelerat(?:e|ion|ed)\s+(?:upon|following|in\s+the\s+event)|note\s+(?:shall|will)\s+be(?:come)?\s+immediately\s+due\s+and\s+payable/i,
    fn: () => true },
  { conf: 0.85, re: /declare(?:d)?\s+(?:the\s+)?(?:entire\s+)?(?:outstanding\s+)?(?:principal|balance|note)\s+(?:to\s+be\s+)?(?:immediately\s+)?due\s+and\s+payable/i,
    fn: () => true },
];

// ── Penalty rate ──────────────────────────────────────────────────────────────

const PENALTY_RATE_PATTERNS: FieldPattern<number>[] = [
  { conf: 0.90, re: /(?:penalty|late\s+charge|liquidated\s+damages?)\s+(?:of\s+)?(\d{1,3}(?:\.\d+)?)\s*%\s*(?:per\s+(?:month|day|week|annum))?/i,
    fn: m => parsePct(m[1]) },
  { conf: 0.85, re: /(\d{1,3}(?:\.\d+)?)\s*%\s+(?:per\s+(?:month|day))\s+(?:penalty|late\s+fee|liquidated\s+damages?)/i,
    fn: m => parsePct(m[1]) },
];

// ── Instrument type ───────────────────────────────────────────────────────────

const INSTRUMENT_TYPE_PATTERNS: FieldPattern<string>[] = [
  { conf: 0.95, re: /\bconvertible\s+(?:promissory\s+)?note\b/i,           fn: () => 'convertible_note' },
  { conf: 0.93, re: /\bconvertible\s+debenture\b/i,                        fn: () => 'debenture' },
  { conf: 0.92, re: /\bbridge\s+(?:convertible\s+|promissory\s+)?note\b/i, fn: () => 'bridge_note' },
  // "convertible, redeemable note" / "convertible secured note" etc — comma or adjective between
  { conf: 0.90, re: /\bconvertible\b[^.]{0,30}?\bnote\b/i,                 fn: () => 'convertible_note' },
  { conf: 0.88, re: /\bpromissory\s+note\b/i,                              fn: () => 'promissory_note' },
  { conf: 0.85, re: /\bdemand\s+(?:promissory\s+)?note\b/i,                fn: () => 'demand_note' },
  { conf: 0.80, re: /\bsenior\s+(?:secured\s+)?note\b/i,                   fn: () => 'promissory_note' },
];

// ── Amendment flag ────────────────────────────────────────────────────────────

const AMENDMENT_PATTERNS: FieldPattern<boolean>[] = [
  { conf: 0.95, re: /(?:first|second|third|fourth|fifth|\d+(?:st|nd|rd|th))\s+amendment\s+to\s+(?:the\s+)?(?:convertible\s+)?(?:note|agreement|loan)/i,
    fn: () => true },
  { conf: 0.90, re: /(?:amended\s+and\s+restated|restated)\s+(?:convertible\s+)?(?:note|promissory)/i,
    fn: () => true },
  { conf: 0.85, re: /amendment\s+(?:no\.?\s*\d+\s+)?to\s+(?:the\s+)?(?:note|loan\s+agreement)/i,
    fn: () => true },
];

// ── Status ────────────────────────────────────────────────────────────────────

const STATUS_PATTERNS: FieldPattern<string>[] = [
  { conf: 0.92, re: /(?:fully?\s+)?(?:repaid?|paid\s+(?:off|in\s+full)|discharged|satisfied\s+in\s+full|retired(?:\s+in\s+full)?)\b/i,
    fn: () => 'repaid' },
  { conf: 0.92, re: /(?:fully?\s+)?converted?\s+(?:in\s+full|(?:all\s+)?into\s+(?:common\s+)?(?:stock|shares?))\b/i,
    fn: () => 'converted' },
  { conf: 0.90, re: /\b(?:cancelled?|forgiven|extinguished|written\s+off|forgave)\b/i,
    fn: () => 'cancelled' },
  { conf: 0.88, re: /\bmatured?\b[^.]{0,40}(?:paid|converted|settled|outstanding|unpaid)/i,
    fn: () => 'matured' },
  { conf: 0.80, re: /\b(?:outstanding|still\s+outstanding|currently\s+outstanding|remains?\s+outstanding)\b/i,
    fn: () => 'outstanding' },
  { conf: 0.70, re: /\b(?:settled?|debt\s+settlement)\b/i,
    fn: () => 'settled' },
];

// ── Amount converted ──────────────────────────────────────────────────────────

const AMOUNT_CONVERTED_PATTERNS: FieldPattern<number>[] = [
  { conf: 0.90, re: /converted?\s+\$\s*([\d,\.]+(?:\s*(?:million|M))?)\s+(?:of\s+(?:the\s+)?(?:principal|note|outstanding|face\s+value))?/i,
    fn: m => parseDollar(m[1]) },
  { conf: 0.85, re: /\$\s*([\d,\.]+(?:\s*(?:million|M))?)\s+(?:of\s+)?(?:principal|outstanding|face\s+value)\s+(?:was|has\s+been|were)\s+converted?/i,
    fn: m => parseDollar(m[1]) },
];

// ── Amount repaid ─────────────────────────────────────────────────────────────

const AMOUNT_REPAID_PATTERNS: FieldPattern<number>[] = [
  { conf: 0.90, re: /(?:repaid?|paid\s+(?:off|down))\s+\$\s*([\d,\.]+(?:\s*(?:million|M))?)/i,
    fn: m => parseDollar(m[1]) },
  { conf: 0.85, re: /\$\s*([\d,\.]+(?:\s*(?:million|M))?)\s+(?:was|were|has\s+been)\s+(?:repaid?|paid\s+(?:off|down|in\s+full))/i,
    fn: m => parseDollar(m[1]) },
];

// ── Explicitly convertible flag ───────────────────────────────────────────────

const IS_CONVERTIBLE_PATTERN: FieldPattern<boolean>[] = [
  { conf: 0.90, re: /\bconvertible\b/i, fn: () => true },
];

// ─── Step 4 driver: populate all fields on an instrument ─────────────────────

export function extractFieldsFromInstrument(inst: Instrument): void {
  const s = inst.sentences;

  switch (inst.type) {
    case 'note': {
      // ── Core economics ─────────────────────────────────────────────────────
      inst.fields.principalAmount        = bestMatch(s, PRINCIPAL_PATTERNS);
      inst.fields.purchasePrice          = bestMatch(s, PURCHASE_PRICE_PATTERNS);
      inst.fields.originalIssueDiscount  = bestMatch(s, OID_PATTERNS);
      inst.fields.netProceeds            = bestMatch(s, NET_PROCEEDS_PATTERNS);
      inst.fields.legalFees              = bestMatch(s, LEGAL_FEE_PATTERNS);
      inst.fields.placementFees          = bestMatch(s, PLACEMENT_FEE_PATTERNS);
      inst.fields.outstandingBalance     = bestMatch(s, BALANCE_PATTERNS);
      inst.fields.interestRate           = bestMatch(s, INTEREST_PATTERNS);
      inst.fields.defaultInterestRate    = bestMatch(s, DEFAULT_INTEREST_PATTERNS);
      inst.fields.prepaymentPremium      = bestMatch(s, PREPAYMENT_PREMIUM_PATTERNS);
      inst.fields.redemptionPremium      = bestMatch(s, REDEMPTION_PREMIUM_PATTERNS);
      inst.fields.maturityDate           = bestMatch(s, MATURITY_PATTERNS);
      inst.fields.executionDate          = bestMatch(s, EXEC_DATE_PATTERNS);
      // ── Conversion ─────────────────────────────────────────────────────────
      inst.fields.conversionFormula      = bestMatch(s, CONVERSION_FORMULA_PATTERNS);
      inst.fields.discountRate           = bestMatch(s, DISCOUNT_PATTERNS);
      inst.fields.lookbackDays           = bestMatch(s, LOOKBACK_PATTERNS);
      // Fixed price only when discount rate is absent (not a variable-rate note)
      if (!inst.fields.discountRate) {
        inst.fields.fixedConversionPrice = bestMatch(s, FIXED_PRICE_PATTERNS);
      }
      inst.fields.floorPrice             = bestMatch(s, FLOOR_PRICE_PATTERNS);
      inst.fields.hasFloorPrice          = inst.fields.floorPrice
        ? { value: inst.fields.floorPrice.value !== null,
            confidence: inst.fields.floorPrice.confidence,
            sourceSentenceIndex: inst.fields.floorPrice.sourceSentenceIndex,
            sourceNoteNumber: inst.fields.floorPrice.sourceNoteNumber }
        : undefined;
      inst.fields.ceilingPrice           = bestMatch(s, CEILING_PRICE_PATTERNS);
      inst.fields.exchangeCap            = bestMatch(s, EXCHANGE_CAP_PATTERNS);
      inst.fields.beneficialOwnershipBlocker = bestMatch(s, BENEFICIAL_OWNERSHIP_PATTERNS);
      inst.fields.hasResetProvisions     = inst.allTags.has('reset_provision')
        ? { value: true, confidence: 0.90,
            sourceSentenceIndex: s.find(x => x.tags.has('reset_provision'))?.sentenceIndex ?? 0,
            sourceNoteNumber: inst.noteNumber }
        : undefined;
      inst.fields.antiDilutionProvisions = bestMatch(s, ANTI_DILUTION_PATTERNS);
      // ── Defaults ───────────────────────────────────────────────────────────
      inst.fields.hasAccelerationClause  = bestMatch(s, ACCELERATION_PATTERNS);
      inst.fields.penaltyRate            = bestMatch(s, PENALTY_RATE_PATTERNS);
      // ── Identity / status ──────────────────────────────────────────────────
      inst.fields.instrumentType         = bestMatch(s, INSTRUMENT_TYPE_PATTERNS);
      inst.fields.isAmendment            = inst.allTags.has('amendment')
        ? bestMatch(s, AMENDMENT_PATTERNS)
        : undefined;
      inst.fields.status                 = bestMatch(s, STATUS_PATTERNS);
      inst.fields.amountConverted        = inst.allTags.has('conversion')
        ? bestMatch(s, AMOUNT_CONVERTED_PATTERNS) : undefined;
      inst.fields.amountRepaid           = inst.allTags.has('repayment')
        ? bestMatch(s, AMOUNT_REPAID_PATTERNS)    : undefined;
      // ── Identity ───────────────────────────────────────────────────────────
      inst.fields.investorName           = bestMatch(s, INVESTOR_PATTERNS);
      inst.fields.isExplicitlyConvertible = bestMatch(s, IS_CONVERTIBLE_PATTERN);
      break;
    }

    case 'facility': {
      inst.fields.facilitySize    = bestMatch(s, FACILITY_SIZE_PATTERNS);
      inst.fields.drawnAmount     = bestMatch(s, DRAWN_PATTERNS);
      inst.fields.pricingFormula  = bestMatch(s, PRICING_FORMULA_PATTERNS);
      inst.fields.investorName    = bestMatch(s, INVESTOR_PATTERNS);
      break;
    }

    case 'warrant': {
      inst.fields.warrantShares   = bestMatch(s, WARRANT_SHARES_PATTERNS);
      inst.fields.exercisePrice   = bestMatch(s, EXERCISE_PRICE_PATTERNS);
      inst.fields.expirationDate  = bestMatch(s, EXPIRATION_DATE_PATTERNS);
      inst.fields.investorName    = bestMatch(s, INVESTOR_PATTERNS);
      break;
    }

    case 'issuance': {
      inst.fields.sharesIssued    = bestMatch(s, SHARES_ISSUED_PATTERNS);
      inst.fields.pricePerShare   = bestMatch(s, PRICE_PER_SHARE_PATTERNS);
      inst.fields.grossProceeds   = bestMatch(s, GROSS_PROCEEDS_PATTERNS);
      inst.fields.investorName    = bestMatch(s, INVESTOR_PATTERNS);
      inst.fields.issuanceType    = bestMatch(s, ISSUANCE_TYPE_PATTERNS);
      inst.fields.executionDate   = bestMatch(s, EXEC_DATE_PATTERNS);
      break;
    }

    case 'conversion': {
      inst.fields.debtConverted   = bestMatch(s, DEBT_CONVERTED_PATTERNS);
      inst.fields.sharesIssued    = bestMatch(s, SHARES_ISSUED_PATTERNS);
      inst.fields.effectivePrice  = bestMatch(s, EFFECTIVE_PRICE_PATTERNS);
      inst.fields.investorName    = bestMatch(s, INVESTOR_PATTERNS);
      inst.fields.executionDate   = bestMatch(s, EXEC_DATE_PATTERNS);
      break;
    }

    case 'related_party': {
      // For related party, grab all dollar amounts and pick the largest
      let largest: { val: number; conf: number; idx: number } | undefined;
      for (const sent of s) {
        const allAmounts = [...sent.text.matchAll(/\$\s*([\d,\.]+(?:\s*(?:million|M))?)/gi)];
        for (const am of allAmounts) {
          const v = parseDollar(am[1]);
          if (v == null) continue;
          if (!largest || v > largest.val) largest = { val: v, conf: 0.80, idx: sent.sentenceIndex };
        }
      }
      if (largest) {
        inst.fields.transactionAmount = {
          value: largest.val, confidence: largest.conf,
          sourceSentenceIndex: largest.idx, sourceNoteNumber: inst.noteNumber,
        };
      }
      inst.fields.partyDescription = bestMatch(s, PARTY_DESC_PATTERNS);
      break;
    }
  }
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Full pipeline: text → Instrument[].
 * Call once per note block or section text.
 */
export function buildInstrumentLayer(
  text:        string,
  noteNumber?: number,
): Instrument[] {
  const sentences = splitNoteIntoSentences(text, noteNumber);
  return linkInstruments(sentences, noteNumber);
}

/**
 * Convenience: extract a flat confidence map for a ConvertibleNote record.
 * Returned as a plain object for JSON serialisation alongside the note.
 */
export function fieldConfidenceMap(
  inst: Instrument,
): Partial<Record<string, number>> {
  const out: Partial<Record<string, number>> = {};
  for (const [k, v] of Object.entries(inst.fields)) {
    if (v != null && typeof (v as ExtractedField<unknown>).confidence === 'number') {
      out[k] = (v as ExtractedField<unknown>).confidence;
    }
  }
  return out;
}

/**
 * Source sentence indices for all fields populated on an instrument.
 * Used to populate _sourceSentences on output records.
 */
export function sourceSentenceIndices(inst: Instrument): number[] {
  const indices = new Set<number>();
  for (const v of Object.values(inst.fields)) {
    if (v != null && typeof (v as ExtractedField<unknown>).sourceSentenceIndex === 'number') {
      indices.add((v as ExtractedField<unknown>).sourceSentenceIndex);
    }
  }
  return [...indices].sort((a, b) => a - b);
}
