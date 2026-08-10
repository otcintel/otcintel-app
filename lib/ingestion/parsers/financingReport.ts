/**
 * Financing report parser — 10-K / 10-Q
 *
 * Extracts and organizes all financing-related activity from annual and
 * quarterly reports into seven structured sections:
 *
 *   1. Convertible / Debt Financing
 *   2. Equity Issuances
 *   3. Conversions (debt-to-equity)
 *   4. Warrants / Options
 *   5. Related Party Transactions
 *   6. Equity Facilities (ELOCs / EFAs)
 *   7. Dilution Summary
 *
 * Design principles:
 *   - Note-block aware: splits the filing into individual numbered notes and
 *     runs targeted extractors on each note's full text.
 *   - Stable instrument identity: every extracted mention is fingerprinted and
 *     clustered so each real-world instrument appears exactly once.
 *   - Strict name validation: investor / party names are only accepted when
 *     they look like legal entities or proper nouns.
 *   - Source tracking: every record carries _noteNumber and _section.
 *   - Common-stock-only share count: preferred shares are never confused with
 *     common shares outstanding.
 *   - Analyst prose: per-instrument blocks, not bullet sentences.
 *   - Non-fatal: never throws. All errors collected in warnings[].
 *
 * @module parsers/financingReport
 */

import type {
  FinancingReport,
  ConvertibleNote,
  EquityIssuance,
  ConversionRecord,
  WarrantRecord,
  RelatedPartyTransaction,
  EquityFacility,
  DilutionSummary,
  FinancialStatements,
  ExtractionConfidence,
  FieldProvenanceEntry,
  RejectedCandidate,
} from '../types';
import { parseFinancialStatements } from './financialStatements';
import {
  buildInstrumentLayer,
  fieldConfidenceMap,
  sourceSentenceIndices,
} from './sentenceLayer';
import type { Instrument, ExtractedField } from './sentenceLayer';
import { buildTableLayer } from './tableLayer';
import type { TableInstrument } from './tableLayer';
import { enrichConvertibleNotes } from './noteEnrichment';

// ─── Text cleaning ────────────────────────────────────────────────────────────

const BLOCK_END_RE   = /<\/(?:p|div|tr|li|h[1-6]|section|article|td|th|br|blockquote)\s*>/gi;
const INLINE_TAG_RE  = /<[^>]{0,500}>/g;
const HTML_ENTITY_RE = /&(?:amp|lt|gt|nbsp|apos|quot|#\d{1,5}|#x[\dA-Fa-f]{1,4});/g;

const HTML_ENTITY_MAP: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&nbsp;': ' ', '&apos;': "'", '&quot;': '"',
};

function decodeEntity(e: string): string {
  if (e.startsWith('&#x')) return String.fromCharCode(parseInt(e.slice(3, -1), 16));
  if (e.startsWith('&#'))  return String.fromCharCode(parseInt(e.slice(2, -1), 10));
  return HTML_ENTITY_MAP[e] ?? e;
}

function cleanText(raw: string): string {
  return raw
    .replace(BLOCK_END_RE, '\n')
    .replace(INLINE_TAG_RE, ' ')
    .replace(HTML_ENTITY_RE, decodeEntity)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── Amount helpers ───────────────────────────────────────────────────────────

function parseDollar(raw: string): number | undefined {
  const s = raw.replace(/,/g, '').replace(/[()]/g, '').trim();
  const mB  = s.match(/\$?([\d.]+)\s*(?:billion|B)\b/i);
  if (mB)  { const n = parseFloat(mB[1]);  return Number.isFinite(n) ? Math.round(n * 1_000_000_000) : undefined; }
  const mM  = s.match(/\$?([\d.]+)\s*(?:million|M)\b/i);
  if (mM)  { const n = parseFloat(mM[1]);  return Number.isFinite(n) ? Math.round(n * 1_000_000)     : undefined; }
  const mK  = s.match(/\$?([\d.]+)\s*[Kk]\b/);
  if (mK)  { const n = parseFloat(mK[1]);  return Number.isFinite(n) ? Math.round(n * 1_000)         : undefined; }
  const n = parseFloat(s.replace(/^\$/, '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

function parsePct(raw: string): number | undefined {
  const n = parseFloat(raw.replace(/%/g, '').trim());
  if (!Number.isFinite(n) || n <= 0 || n > 100) return undefined;
  return n / 100;
}

function parseShares(raw: string): number | undefined {
  const s = raw.replace(/,/g, '').trim();
  const mB  = s.match(/([\d.]+)\s*(?:billion|B)\b/i);
  if (mB)  { const n = parseFloat(mB[1]);  return Number.isFinite(n) ? Math.round(n * 1_000_000_000) : undefined; }
  const mM  = s.match(/([\d.]+)\s*(?:million|M)\b/i);
  if (mM)  { const n = parseFloat(mM[1]);  return Number.isFinite(n) ? Math.round(n * 1_000_000)     : undefined; }
  const mK  = s.match(/([\d.]+)\s*[Kk]\b/);
  if (mK)  { const n = parseFloat(mK[1]);  return Number.isFinite(n) ? Math.round(n * 1_000)         : undefined; }
  const n = parseFloat(s.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

// ─── Investor name validation ─────────────────────────────────────────────────
//
// Only accept names that look like a real legal entity or proper noun sequence.
// Reject narrative phrases, section references, and common English words.

const ENTITY_SUFFIX_RE = /\b(?:LLC|L\.L\.C\.?|LP|L\.P\.?|Ltd\.?|Limited|Corp\.?|Corporation|Inc\.?|Incorporated|Capital|Fund(?:ing)?|Holdings?|Ventures?|Management|Partners?|Advisors?|Securities|Financial|Investments?|Group|Trust|Equity|Credit|Lending|Strategies)\b/i;

const NARRATIVE_START_RE = /^(?:the|a|an|this|that|such|any|each|all|both|our|its|their|certain|following|prior|above|below|its|his|her)\b/i;
const NARRATIVE_BODY_RE  = /\b(?:described|pursuant|referenced|mentioned|noted|set\s+forth|defined|outlined|arrangement|assumed|stated|herein|hereby|thereof|thereunder|thereto|hereunder)\b/i;
const NARRATIVE_LEAD_RE  = /^(?:issue[sd]?|issuance|assumption|condition|term|provision|section|note\s+\d|page\s+\d|paragraph|clause|schedule|exhibit|annex)\b/i;

function validateInvestorName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const name = raw.trim().replace(/\s+/g, ' ');

  // Length gate
  if (name.length < 4 || name.length > 90) return undefined;

  // Reject obvious narrative fragments
  if (NARRATIVE_START_RE.test(name)) return undefined;
  if (NARRATIVE_BODY_RE.test(name))  return undefined;
  if (NARRATIVE_LEAD_RE.test(name))  return undefined;

  // Reject if it contains a standalone year (looks like a date phrase)
  if (/\b20\d\d\b/.test(name) || /\b19\d\d\b/.test(name)) return undefined;

  // Accept: matches a known entity-type suffix
  if (ENTITY_SUFFIX_RE.test(name)) return name;

  // Accept: 2–5 words, all Title-Cased or ALL-CAPS abbreviations (e.g. "GS Capital")
  const words = name.split(' ');
  if (words.length >= 2 && words.length <= 5) {
    const allProper = words.every(w => /^[A-Z][a-z]{1,}$/.test(w) || /^[A-Z]{2,6}$/.test(w));
    if (allProper) return name;
  }

  return undefined;
}

function parseInvestorName(text: string): string | undefined {
  const candidates = [
    text.match(/\bwith\s+([A-Z][A-Za-z0-9\s,\.&]{2,60}?)(?:\s*\(|\s*,\s+an?\s+|\s*,\s+a\s+|\s*\.|$)/i)?.[1],
    text.match(/\bfrom\s+([A-Z][A-Za-z0-9\s,\.&]{2,60}?)(?:\s*\(|,|\.|$)/i)?.[1],
    text.match(/([A-Z][A-Za-z0-9\s,\.&]{2,60}?)\s*\(\s*(?:the\s+)?["""]?(?:Holder|Lender|Investor|Purchaser|Noteholder)["""]?\s*\)/i)?.[1],
    text.match(/(?:lender|holder|investor|purchaser)\s+is\s+([A-Z][A-Za-z0-9\s,\.&]{2,60}?)(?:\s*\(|,|\.|$)/i)?.[1],
    text.match(/([A-Z][A-Za-z0-9\s,\.&]{2,60}?),?\s+an?\s+(?:accredited\s+investor|third[\s-]party)/i)?.[1],
    text.match(/entered\s+into\s+(?:a\s+)?(?:Securities\s+Purchase\s+Agreement|Loan\s+Agreement|Note\s+Purchase\s+Agreement)[^,]{0,20},?\s+with\s+([A-Z][A-Za-z0-9\s,\.&]{2,60}?)(?:\s*\(|,|\.|$)/i)?.[1],
  ];

  for (const raw of candidates) {
    const valid = validateInvestorName(raw?.trim());
    if (valid) return valid;
  }
  return undefined;
}

// ─── Note block parsing ───────────────────────────────────────────────────────

interface NoteBlock {
  number: number;
  title:  string;
  text:   string;
}

const NOTE_HEADER_RE = /(?:^|\n)[ \t]*NOTE\s+(\d{1,2}[A-Z]?)[ \t]*(?:[–—\-\.\:][ \t]*|\s{2,})([^\n]{3,120})/gim;

function parseNoteBlocks(text: string): NoteBlock[] {
  const headers: Array<{ index: number; number: number; title: string }> = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(NOTE_HEADER_RE.source, NOTE_HEADER_RE.flags);
  while ((m = re.exec(text)) !== null) {
    const num = parseInt(m[1], 10);
    if (!Number.isFinite(num) || num > 50) continue;
    const title = m[2].trim().toUpperCase().replace(/["""'']/g, '');
    if (headers.some(h => h.number === num && Math.abs(h.index - m!.index) < 200)) continue;
    headers.push({ index: m.index, number: num, title });
  }

  if (headers.length === 0) return [];
  headers.sort((a, b) => a.index - b.index);
  const deduped = headers.filter((h, i) =>
    i === 0 || h.number !== headers[i - 1].number || h.index - headers[i - 1].index > 100,
  );

  return deduped.map((h, i) => ({
    number: h.number,
    title:  h.title,
    text:   text.slice(h.index, deduped[i + 1]?.index ?? text.length),
  }));
}

// ─── Section detection ────────────────────────────────────────────────────────

type SectionKey =
  | 'convertible_debt' | 'equity_issuances' | 'conversions'
  | 'warrants' | 'related_party' | 'equity_facilities' | 'dilution'
  | 'subsequent_events' | 'mda';

interface DetectedSection { key: SectionKey; text: string; noteNumber?: number; }

function classifyNoteTitle(title: string): SectionKey | null {
  const t = title.toUpperCase();
  if (/CONVERTIBLE|NOTES?\s+PAYABLE|PROMISSORY|BRIDGE\s+(?:NOTE|LOAN)|SECURED\s+NOTE|UNSECURED\s+NOTE|DEMAND\s+NOTE|EXCHANGE\s+AGREE|OID|ORIGINAL\s+ISSUE\s+DISCOUNT|BORROWING|LOAN\s+PAYABLE|LONG[\s-]TERM\s+DEBT|SHORT[\s-]TERM\s+DEBT|DEBT\s+DISCOUNT/.test(t))
    return 'convertible_debt';
  if (/EQUITY\s+(?:LINE|FACILITY|FACILITIES|PURCHASE\s+AGREE|FINANCING\s+AGREE|DISTRIBUTION)|ELOC|\bCSPA\b|COMMON\s+STOCK\s+PURCHASE\s+AGREE|VARIABLE\s+RATE\s+NOTE/.test(t))
    return 'equity_facilities';
  if (/RELATED[\s-]PARTY|RELATED\s+TRANSACTIONS?/.test(t))
    return 'related_party';
  if (/\bWARRANT|\bDERIVATIVE\b|STOCK[\s-]BASED\s+COMP|\bOPTION\s+(?:ACTIVITY|PLAN|AGREEMENT)/.test(t))
    return 'warrants';
  if (/STOCKHOLDER|SHAREHOLDER|SHAREHOLDERS?['']?\s+EQUITY|PREFERRED\s+STOCK|COMMON\s+STOCK(?!\s+PURCHASE\s+AGREE)|AUTHORIZED\s+CAPITAL|CAPITAL\s+STOCK|ISSUANCE\s+OF\s+(?:COMMON|PREFERRED)/.test(t))
    return 'equity_issuances';
  if (/DILUT|EARNINGS?\s+PER\s+SHARE|\bEPS\b/.test(t))
    return 'dilution';
  if (/SUBSEQUENT\s+EVENT|EVENTS?\s+AFTER\s+(?:THE\s+)?(?:BALANCE|REPORTING)|POST[\s-]BALANCE/.test(t))
    return 'subsequent_events';
  return null;
}

const FALLBACK_HEADER_PATTERNS: Array<[RegExp, SectionKey]> = [
  [/CONVERTIBLE\s+NOTES?\s+PAYABLE/i,                       'convertible_debt'],
  [/NOTES?\s+PAYABLE/i,                                     'convertible_debt'],
  [/(?:LONG|SHORT)[\s-]TERM\s+DEBT/i,                      'convertible_debt'],
  [/EQUITY\s+LINE\s+(?:OF\s+CREDIT|FACILITY)/i,            'equity_facilities'],
  [/COMMON\s+STOCK\s+PURCHASE\s+AGREEMENT/i,               'equity_facilities'],
  [/EQUITY\s+(?:PURCHASE|FINANCING)\s+AGREEMENT/i,         'equity_facilities'],
  [/RELATED\s+PARTY\s+TRANSACTIONS?/i,                     'related_party'],
  [/WARRANT\s+ACTIVITY/i,                                  'warrants'],
  [/SUBSEQUENT\s+EVENTS?/i,                                'subsequent_events'],
  [/MANAGEMENT['']?S?\s+DISCUSSION/i,                      'mda'],
];

function detectNonNoteSections(text: string, key: 'mda' | 'subsequent_events'): string | null {
  const pattern = key === 'mda'
    ? /(?:^|\n)[ \t]*MANAGEMENT['']?S?\s+DISCUSSION\s+AND\s+ANALYSIS/i
    : /(?:^|\n)[ \t]*(?:NOTE\s+\d+[A-Z]?\s*[–—\-\.\:]?\s*)?SUBSEQUENT\s+EVENTS?\b/i;
  const re = new RegExp(pattern.source, 'i');
  const m  = re.exec(text);
  if (!m) return null;
  return text.slice(m.index, m.index + 20_000);
}

function detectSections(text: string): DetectedSection[] {
  const noteBlocks = parseNoteBlocks(text);
  if (noteBlocks.length > 0) {
    const sections: DetectedSection[] = [];
    for (const block of noteBlocks) {
      const key = classifyNoteTitle(block.title);
      if (key) sections.push({ key, text: block.text, noteNumber: block.number });
    }
    const mda = detectNonNoteSections(text, 'mda');
    const sub  = detectNonNoteSections(text, 'subsequent_events');
    if (mda)  sections.push({ key: 'mda',               text: mda  });
    if (sub)  sections.push({ key: 'subsequent_events', text: sub  });
    if (sections.length > 0) return sections;
  }

  const matches: Array<{ index: number; key: SectionKey }> = [];
  for (const [pattern, key] of FALLBACK_HEADER_PATTERNS) {
    const re = new RegExp(pattern.source, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (!matches.some(x => Math.abs(x.index - m!.index) < 50)) {
        matches.push({ index: m.index, key });
      }
    }
  }

  if (matches.length === 0) {
    return (['convertible_debt','equity_issuances','conversions','warrants',
             'related_party','equity_facilities','dilution','subsequent_events'] as SectionKey[])
      .map(key => ({ key, text }));
  }

  matches.sort((a, b) => a.index - b.index);
  return matches.map((m, i) => ({
    key:  m.key,
    text: text.slice(m.index, matches[i + 1]?.index ?? text.length),
  }));
}

function getSectionText(sections: DetectedSection[], key: SectionKey): string {
  return sections.filter(s => s.key === key).map(s => s.text).join('\n\n');
}

function getSectionNoteNumber(sections: DetectedSection[], key: SectionKey): number | undefined {
  return sections.find(s => s.key === key)?.noteNumber;
}

// ─── Convertible note extractor ───────────────────────────────────────────────
//
// Delegates to the sentence layer: build Instruments, then map each 'note'
// instrument to a ConvertibleNote record. The seenStart sliding-window approach
// is replaced by paragraph-level entity linking inside buildInstrumentLayer.

const FLOOR_PRINCIPAL = 25_000;

// ─── Cross-instrument contamination ───────────────────────────────────────────
//
// When multiple financing events appear in the same sentence window (e.g. a
// subsidiary sale termination next to a convertible note entry), monetary
// fields can be sourced from the wrong instrument.  We reject a field when its
// source sentence contains a dollar amount > CONTAMINATION_RATIO × the note's
// anchor principal — the amount that caused this ConvertibleNote to exist.

const MONETARY_PRINCIPAL_FIELDS = new Set<string>([
  'purchasePrice', 'outstandingBalance', 'amountConverted', 'amountRepaid', 'netProceeds',
]);

const CONTAMINATION_RATIO = 20;

function extractSentenceAmounts(text: string): number[] {
  const amounts: number[] = [];
  for (const m of text.matchAll(/\$\s*([\d,\.]+(?:\s*(?:billion|B|million|M))?)/gi)) {
    const v = parseDollar(m[1]);
    if (v != null) amounts.push(v);
  }
  return amounts;
}

function contaminationReason(
  fieldKey:        string,
  sourceText:      string,
  anchorPrincipal: number,
): string | null {
  if (!MONETARY_PRINCIPAL_FIELDS.has(fieldKey)) return null;
  for (const amt of extractSentenceAmounts(sourceText)) {
    if (amt > anchorPrincipal * CONTAMINATION_RATIO) {
      return `source amount ${fmt$(amt)} is ${Math.round(amt / anchorPrincipal)}× note principal ${fmt$(anchorPrincipal)}`;
    }
  }
  return null;
}

function instrumentToNote(inst: Instrument, section?: string, noteNumber?: number): ConvertibleNote | null {
  const f = inst.fields;

  const anchorPrincipal = f.principalAmount?.value;
  const anchorSentIdx   = f.principalAmount?.sourceSentenceIndex;

  const note: ConvertibleNote = {
    hasFloorPrice:          f.hasFloorPrice?.value  ?? false,
    hasResetProvisions:     f.hasResetProvisions?.value ?? false,
    _section:               section,
    _noteNumber:            noteNumber ?? inst.noteNumber,
    _sourceSentences:       sourceSentenceIndices(inst),
    _sourceSentenceTexts:   inst.sentences.map(s => s.text),
    _fieldConfidence:       fieldConfidenceMap(inst),
    _anchorSentenceIndex:   anchorSentIdx,
    _anchorPrincipalAmount: anchorPrincipal,
    _fieldProvenance:       {},
    _rejectedCandidates:    [],
  };

  /**
   * Assign a field from a primary ExtractedField, recording provenance and
   * rejecting when the source sentence implies cross-instrument contamination.
   */
  function assignField<T>(
    key:     string,
    extracted: ExtractedField<T> | undefined,
    setter:  (v: T) => void,
  ): void {
    if (!extracted) return;

    const srcSent    = inst.sentences.find(s => s.sentenceIndex === extracted.sourceSentenceIndex);
    const sourceText = srcSent?.text ?? '';

    note._fieldProvenance![key] = {
      sourceText,
      sentenceIndex:  extracted.sourceSentenceIndex,
      paragraphIndex: srcSent?.paragraphIndex,
      anchorDistance: anchorSentIdx != null
        ? Math.abs(extracted.sourceSentenceIndex - anchorSentIdx)
        : undefined,
      method: 'primary',
    } satisfies FieldProvenanceEntry;

    if (anchorPrincipal != null) {
      const reason = contaminationReason(key, sourceText, anchorPrincipal);
      if (reason) {
        note._rejectedCandidates!.push({
          field: key, value: extracted.value, sourceText,
          sentenceIndex: extracted.sourceSentenceIndex, reason,
        } satisfies RejectedCandidate);
        return;
      }
    }

    setter(extracted.value);
  }

  // ── Principal (anchor — no contamination check on self) ───────────────────
  if (f.principalAmount) {
    note.principalAmount = f.principalAmount.value;
    const s = inst.sentences.find(ss => ss.sentenceIndex === f.principalAmount!.sourceSentenceIndex);
    note._fieldProvenance!['principalAmount'] = {
      sourceText: s?.text ?? '', sentenceIndex: f.principalAmount.sourceSentenceIndex,
      paragraphIndex: s?.paragraphIndex, anchorDistance: 0, method: 'primary',
    };
  }

  // ── Economics ──────────────────────────────────────────────────────────────
  assignField('purchasePrice',         f.purchasePrice,         v => { note.purchasePrice         = v; });
  assignField('originalIssueDiscount', f.originalIssueDiscount, v => { note.originalIssueDiscount = v; });
  assignField('netProceeds',           f.netProceeds,           v => { note.netProceeds           = v; });
  assignField('legalFees',             f.legalFees,             v => { note.legalFees             = v; });
  assignField('placementFees',         f.placementFees,         v => { note.placementFees         = v; });
  assignField('outstandingBalance',    f.outstandingBalance,    v => { note.outstandingBalance    = v; });
  assignField('interestRate',          f.interestRate,          v => { note.interestRate          = v; });
  assignField('defaultInterestRate',   f.defaultInterestRate,   v => { note.defaultInterestRate   = v; });
  assignField('prepaymentPremium',     f.prepaymentPremium,     v => { note.prepaymentPremium     = v; });
  assignField('redemptionPremium',     f.redemptionPremium,     v => { note.redemptionPremium     = v; });
  assignField('maturityDate',          f.maturityDate,          v => { note.maturityDate          = v; });
  assignField('executionDate',         f.executionDate,         v => { note.executionDate         = v; });
  // ── Conversion ─────────────────────────────────────────────────────────────
  assignField('conversionFormula',     f.conversionFormula,     v => { note.conversionFormula     = v; });
  assignField('discountRate',          f.discountRate,          v => { note.discountRate          = v; });
  assignField('lookbackDays',          f.lookbackDays,          v => { note.lookbackDays          = v; });
  assignField('fixedConversionPrice',  f.fixedConversionPrice,  v => { note.fixedConversionPrice  = v; });
  if (f.floorPrice != null) {
    assignField('floorPrice', f.floorPrice, v => { note.floorPrice = v; note.hasFloorPrice = v !== null; });
  }
  assignField('ceilingPrice',          f.ceilingPrice,          v => { note.ceilingPrice          = v; });
  assignField('exchangeCap',           f.exchangeCap,           v => { note.exchangeCap           = v; });
  assignField('beneficialOwnershipBlocker', f.beneficialOwnershipBlocker, v => { note.beneficialOwnershipBlocker = v; });
  assignField('antiDilutionProvisions', f.antiDilutionProvisions, v => { note.antiDilutionProvisions = v; });
  // ── Defaults ───────────────────────────────────────────────────────────────
  assignField('hasAccelerationClause', f.hasAccelerationClause, v => { note.hasAccelerationClause = v; });
  assignField('penaltyRate',           f.penaltyRate,           v => { note.penaltyRate           = v; });
  // ── Identity / status ──────────────────────────────────────────────────────
  assignField('instrumentType', f.instrumentType, v => { note.instrumentType = v as ConvertibleNote['instrumentType']; });
  assignField('isAmendment',    f.isAmendment,    v => { note.isAmendment    = v; });
  assignField('status',         f.status,         v => { note.status         = v as ConvertibleNote['status']; });
  assignField('amountConverted', f.amountConverted, v => { note.amountConverted = v; });
  assignField('amountRepaid',    f.amountRepaid,    v => { note.amountRepaid    = v; });
  assignField('investorName',    f.investorName,    v => { note.investorName    = v; });
  if (f.isExplicitlyConvertible) note.isExplicitlyConvertible = f.isExplicitlyConvertible.value;

  // Signal threshold: reject low-value noise
  const financialFieldCount = [note.discountRate, note.interestRate, note.maturityDate, note.investorName].filter(Boolean).length;
  const principalQualifies   = note.principalAmount != null && note.principalAmount >= FLOOR_PRINCIPAL;
  const noPrincipalQualifies = note.principalAmount == null && note.discountRate != null && financialFieldCount >= 2;
  if (!principalQualifies && !noPrincipalQualifies) return null;

  return note;
}

function extractConvertibleNotes(text: string, section?: string, noteNumber?: number): ConvertibleNote[] {
  if (!text) return [];
  const instruments = buildInstrumentLayer(text, noteNumber);
  const notes: ConvertibleNote[] = [];
  for (const inst of instruments) {
    if (inst.type !== 'note') continue;
    const note = instrumentToNote(inst, section, noteNumber);
    if (note) notes.push(note);
  }
  return notes;
}

/** Extract from tabular disclosure rows: one record per row. */
function extractConvertibleNotesFromTable(text: string, section?: string, noteNumber?: number): ConvertibleNote[] {
  const notes: ConvertibleNote[] = [];
  if (!text) return notes;

  // Row pattern: entity-name $amount $amount %rate — intentionally kept as
  // a direct regex pass since tabular rows don't form natural sentences.
  const ROW_RE = /([A-Z][A-Za-z0-9\s,\.&]{4,60}?)\s+\$\s*([\d,\.]+)\s+(?:\$[\d,\.]+\s+)*(\d{1,3}(?:\.\d+)?)\s*%/g;
  let m: RegExpExecArray | null;
  while ((m = ROW_RE.exec(text)) !== null) {
    const name      = m[1].trim();
    const principal = parseDollar(m[2]);
    const rate      = parsePct(m[3]);
    const validName = validateInvestorName(name);
    if (principal && principal >= FLOOR_PRINCIPAL && rate && validName) {
      notes.push({
        principalAmount:    principal,
        interestRate:       rate,
        investorName:       validName,
        hasFloorPrice:      false,
        hasResetProvisions: false,
        _section:           section,
        _noteNumber:        noteNumber,
      });
    }
  }

  return notes;
}

// ─── Other extractors ─────────────────────────────────────────────────────────

function extractEquityIssuances(text: string, section?: string, noteNumber?: number): EquityIssuance[] {
  if (!text) return [];
  const instruments = buildInstrumentLayer(text, noteNumber);
  const issuances: EquityIssuance[] = [];

  for (const inst of instruments) {
    if (inst.type !== 'issuance') continue;
    const f = inst.fields;

    const issuance: EquityIssuance = {
      _section:        section,
      _noteNumber:     noteNumber ?? inst.noteNumber,
      _sourceSentences: sourceSentenceIndices(inst),
    };

    if (f.sharesIssued)   issuance.sharesIssued   = f.sharesIssued.value;
    if (f.pricePerShare)  issuance.pricePerShare   = f.pricePerShare.value;
    if (f.grossProceeds)  issuance.grossProceeds   = f.grossProceeds.value;
    if (f.investorName)   issuance.investorName    = f.investorName.value;
    if (f.executionDate)  issuance.issuanceDate    = f.executionDate.value;
    issuance.issuanceType = (f.issuanceType?.value as EquityIssuance['issuanceType']) ?? 'other';

    const sigShares   = (issuance.sharesIssued  ?? 0) >= 10_000;
    const sigProceeds = (issuance.grossProceeds ?? 0) >= 1_000;
    if (sigShares || sigProceeds) issuances.push(issuance);
  }

  return issuances;
}

function extractConversions(text: string, section?: string, noteNumber?: number): ConversionRecord[] {
  if (!text) return [];
  const instruments = buildInstrumentLayer(text, noteNumber);
  const conversions: ConversionRecord[] = [];

  for (const inst of instruments) {
    if (inst.type !== 'conversion') continue;
    const f = inst.fields;

    const conv: ConversionRecord = {
      _section:        section,
      _noteNumber:     noteNumber ?? inst.noteNumber,
      _sourceSentences: sourceSentenceIndices(inst),
    };

    if (f.debtConverted)   conv.debtConverted  = f.debtConverted.value;
    if (f.sharesIssued)    conv.sharesIssued    = f.sharesIssued.value;
    if (f.effectivePrice)  conv.effectivePrice  = f.effectivePrice.value;
    if (f.investorName)    conv.investorName    = f.investorName.value;
    if (f.executionDate)   conv.conversionDate  = f.executionDate.value;

    if (conv.debtConverted || conv.sharesIssued) conversions.push(conv);
  }

  return conversions;
}

function extractWarrants(text: string, section?: string, noteNumber?: number): WarrantRecord[] {
  if (!text) return [];
  const instruments = buildInstrumentLayer(text, noteNumber);
  const warrants: WarrantRecord[] = [];

  for (const inst of instruments) {
    if (inst.type !== 'warrant') continue;
    const f = inst.fields;

    const warrant: WarrantRecord = {
      _section:        section,
      _noteNumber:     noteNumber ?? inst.noteNumber,
      _sourceSentences: sourceSentenceIndices(inst),
    };

    if (f.warrantShares)   warrant.warrantShares  = f.warrantShares.value;
    if (f.exercisePrice)   warrant.exercisePrice  = f.exercisePrice.value;
    if (f.expirationDate)  warrant.expirationDate = f.expirationDate.value;
    if (f.investorName)    warrant.recipientName  = f.investorName.value;

    const combined = inst.sentences.map(s => s.text).join(' ');
    warrant.issuedWithNote = /(?:in\s+connection\s+with|conjunction\s+with|issued\s+with|granted\s+with)\s+(?:the\s+)?(?:note|convertible|loan)/i.test(combined);

    if (warrant.warrantShares || warrant.exercisePrice) warrants.push(warrant);
  }

  return warrants;
}

// Phrases that unambiguously identify an outstanding loan balance owed to/from a related party.
// These are required for basis=ending_balance at high confidence (>= 0.85 gate in intelligence layer).
// The pattern must be present in addition to the generic balance language.
const EXPLICIT_LOAN_BALANCE_RE =
  /\b(?:loan|note|advance[s]?|promissory)\s+(?:payable|outstanding|due|owed|balance(?:\s+(?:as\s+of|at|of))?)|amount\s+(?:due|owed)\s+to\s+(?:related\s+part|officer|director|shareholder|affiliate)|due\s+to\s+(?:officer|director|shareholder|related\s+part|affiliate|company)\b|related[-\s]party\s+(?:loan|note|debt|advance[s]?|payable)|notes?\s+payable\s+(?:to\s+(?:related|officer|director|shareholder))|advances?\s+payable\s+(?:to\s+(?:related|officer|director|shareholder))/i;

function extractRelatedPartyTransactions(text: string, section?: string, noteNumber?: number): RelatedPartyTransaction[] {
  if (!text) return [];
  const instruments = buildInstrumentLayer(text, noteNumber);
  const txns: RelatedPartyTransaction[] = [];

  for (const inst of instruments) {
    if (inst.type !== 'related_party') continue;
    const f = inst.fields;
    if (!f.transactionAmount) continue;

    const txn: RelatedPartyTransaction = {
      _section:        section,
      _noteNumber:     noteNumber ?? inst.noteNumber,
      _sourceSentences: sourceSentenceIndices(inst),
      amount:          f.transactionAmount.value,
    };

    if (f.partyDescription) txn.partyDescription = f.partyDescription.value;

    const combined = inst.sentences.map(s => s.text).join(' ');
    txn._sourceText = combined.slice(0, 600);  // diagnostic: first 600 chars of matched context
    if      (/loan|borrow|lend|promissory|advance[d]?/i.test(combined))                             txn.transactionType = 'loan';
    else if (/compens|salary|bonus|wage|payroll|consulting\s+fee|management\s+fee/i.test(combined)) txn.transactionType = 'compensation';
    else if (/rent|lease|office|facilit|sublease/i.test(combined))                                  txn.transactionType = 'lease';
    else if (/service|consult|contract/i.test(combined))                                            txn.transactionType = 'service';
    else                                                                                            txn.transactionType = 'other';

    // Tier 1: explicit loan-balance phrase → high confidence (0.92), basis = ending_balance
    const explicitLoanMatch = EXPLICIT_LOAN_BALANCE_RE.exec(combined);
    if (explicitLoanMatch) {
      txn.basis         = 'ending_balance';
      txn.confidence    = 0.92;
      txn.matchedPhrase = explicitLoanMatch[0].toLowerCase().trim();

      // PROXIMITY EXTRACTION: the sentence layer picks the LARGEST amount in the entire
      // instrument, which may span a full Related Party note section. Instead, extract
      // amounts and dates directly from the phrase-containing sentence(s) and use THOSE
      // as the balance, overriding the sentence-layer amount.
      const phraseSentences = inst.sentences.filter(s => EXPLICIT_LOAN_BALANCE_RE.test(s.text));
      if (phraseSentences.length > 0) {
        const phraseText = phraseSentences.map(s => s.text).join(' ');

        // Dollar amounts in order of appearance (SEC format: current period first, then prior)
        const amtsInOrder = [...phraseText.matchAll(/\$\s*([\d,]+(?:\.\d+)?)/g)]
          .map(m => parseFloat(m[1].replace(/,/g, '')))
          .filter(v => !isNaN(v) && v >= 100);

        // Dates in order of appearance (matches "February 28, 2026", "2026-02-28", "2/28/2026")
        const RP_DATE_RE = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+\d{1,2},\s+\d{4}|\b\d{1,2}\/\d{1,2}\/\d{4}|\b\d{4}-\d{2}-\d{2}\b/gi;
        const datesInOrder = [...phraseText.matchAll(RP_DATE_RE)].map(m => m[0]);

        if (amtsInOrder.length >= 1) {
          // Amounts confirmed near the loan-balance phrase — use them as the source of truth
          txn.currentBalance     = amtsInOrder[0];
          txn.currentBalanceDate = datesInOrder[0];
          if (amtsInOrder.length >= 2) {
            txn.priorBalance     = amtsInOrder[1];
            txn.priorBalanceDate = datesInOrder[1] ?? datesInOrder[0];
          }
          txn.amount     = txn.currentBalance;   // override the sentence-layer amount
          txn.confidence = 0.90;                 // explicit phrase + amount confirmed in phrase sentence
          txn.matchedPhrase = explicitLoanMatch[0].toLowerCase().trim();
        } else {
          // Explicit phrase found but no dollar amounts in the phrase sentence — the sentence
          // layer's amount came from an unrelated paragraph; drop below gate.
          const reported = txn.amount ?? 0;
          txn.confidence    = 0.72;
          txn.matchedPhrase = txn.matchedPhrase +
            ` [no amounts in phrase sentence; sentence-layer amount $${reported.toLocaleString()} excluded]`;
        }
      }
    } else if (/during\s+the\s+(?:three|six|nine|twelve|period)|for\s+the\s+(?:year|period|quarter)/i.test(combined)) {
      txn.basis = 'period_activity';
      txn.confidence = 0.80;
    } else if (/compens|salary|bonus|wage/i.test(combined)) {
      txn.basis = 'compensation_expense';
      txn.confidence = 0.80;
    } else if (/repaid|paid\s+(?:back|off|down)|payment\s+(?:made|of)/i.test(combined)) {
      txn.basis = 'repayment';
      txn.confidence = 0.80;
    } else if (/advanced|drew\s+down|new\s+(?:loan|advance)/i.test(combined)) {
      txn.basis = 'advance';
      txn.confidence = 0.80;
    } else if (/outstanding|owed|balance\s+(?:as\s+of|at|of)|as\s+of/i.test(combined)) {
      // Tier 2: generic balance/outstanding language without explicit loan-balance phrase.
      // Confidence is below the 0.85 gate → will NOT count toward company-level totals.
      txn.basis      = 'ending_balance';
      txn.confidence = 0.72;
      const m = combined.match(/outstanding|owed|balance\s+(?:as\s+of|at|of)|as\s+of/i);
      if (m) txn.matchedPhrase = m[0].toLowerCase().trim();
    } else {
      txn.basis      = 'unknown';
      txn.confidence = 0.60;
    }

    txns.push(txn);
  }

  return txns;
}

// ── Equity facilities ─────────────────────────────────────────────────────────

function classifyFacilityType(combined: string): EquityFacility['facilityType'] {
  if (/\beloc\b/i.test(combined))                                                  return 'eloc';
  if (/equity\s+(?:purchase|financing)\s+agreement/i.test(combined))              return 'efa';
  if (/equity\s+facility/i.test(combined))                                        return 'efa';
  if (/equity\s+(?:line|distribution)/i.test(combined))                           return 'equity_line';
  if (/common\s+stock\s+purchase\s+agreement|\bcspa\b/i.test(combined))           return 'equity_line';
  if (/standby\s+equity/i.test(combined))                                         return 'equity_line';
  if (/variable\s+rate/i.test(combined))                                          return 'variable_note';
  if (/(?:purchase|sell)\s+up\s+to|right\s+to\s+purchase|put\s+(?:notice|shares)/i.test(combined)) return 'equity_line';
  return 'other';
}

function extractEquityFacilities(text: string, section?: string, noteNumber?: number): EquityFacility[] {
  if (!text) return [];
  const instruments = buildInstrumentLayer(text, noteNumber);
  const facilities: EquityFacility[] = [];

  for (const inst of instruments) {
    if (inst.type !== 'facility') continue;
    const f = inst.fields;

    const facility: EquityFacility = {
      _section:        section,
      _noteNumber:     noteNumber ?? inst.noteNumber,
      _sourceSentences: sourceSentenceIndices(inst),
    };

    if (f.facilitySize)   facility.facilitySize    = f.facilitySize.value;
    if (f.drawnAmount)    facility.drawnAmount      = f.drawnAmount.value;
    if (f.pricingFormula) facility.pricingFormula   = f.pricingFormula.value;
    if (f.investorName)   facility.counterpartyName = f.investorName.value;

    const combined      = inst.sentences.map(s => s.text).join(' ');
    facility.facilityType = classifyFacilityType(combined);

    // Require at least one concrete field to avoid empty facility records
    if (facility.facilitySize || facility.drawnAmount || facility.pricingFormula || facility.counterpartyName) {
      facilities.push(facility);
    }
  }

  return facilities;
}

// ─── Dilution summary — common stock only ────────────────────────────────────
//
// Priority: cover page > balance sheet > capital stock note.
// NEVER use preferred shares outstanding as common shares outstanding.

function extractDilutionSummary(text: string): DilutionSummary {
  const summary: DilutionSummary = { dilutionPhrases: [], hasDilutionWarning: false };
  if (!text) return summary;

  // ── Common stock shares outstanding — explicit "common" qualifier required ──
  //
  // Pattern A: "X shares of Common Stock issued and outstanding"
  // Pattern B: "Common Stock: X authorized; Y issued and outstanding"
  // Pattern C: cover page "X shares of Common Stock outstanding as of [date]"
  //
  // Excluded: "Preferred Stock: X shares outstanding"
  //           "Series A Preferred: X shares outstanding"

  const COMMON_SHARES_PATTERNS = [
    // Cover page / explicit common
    /([\d,\.]+(?:\s*(?:million|billion|M|B))?)\s+shares?\s+of\s+(?:our\s+)?common\s+stock\s+(?:were\s+)?(?:issued\s+and\s+)?outstanding/gi,
    // "Y shares issued and outstanding" after "Common Stock:" in a balance-sheet line
    /common\s+stock[^;\n]{0,80};\s*([\d,\.]+(?:\s*(?:million|M|B))?)\s+(?:shares?\s+)?(?:issued\s+and\s+)?outstanding/gi,
    // Balance sheet table: "issued and outstanding" with no preferred keyword nearby
    /([\d,\.]+(?:\s*(?:million|M|B))?)\s+shares?\s+(?:issued\s+and\s+)?outstanding(?!\s+(?:of\s+)?(?:preferred|series\s+[a-z]))/gi,
  ];

  const shareMatches: number[] = [];
  for (const re of COMMON_SHARES_PATTERNS) {
    const reG = new RegExp(re.source, re.flags);
    let m: RegExpExecArray | null;
    while ((m = reG.exec(text)) !== null) {
      // Ensure no preferred context within 150 chars before the match
      const lookBehind = text.slice(Math.max(0, m.index - 150), m.index).toLowerCase();
      if (/preferred\s+stock|series\s+[a-z]\s+preferred|class\s+[a-z]\s+preferred/i.test(lookBehind)) continue;
      const n = parseShares(m[1]);
      if (n && n >= 1_000) shareMatches.push(n); // ignore sub-1000 junk
    }
  }

  if (shareMatches.length >= 2) {
    summary.sharesOutstandingStart = shareMatches[0];
    summary.sharesOutstandingEnd   = shareMatches[shareMatches.length - 1];
  } else if (shareMatches.length === 1) {
    summary.sharesOutstandingEnd = shareMatches[0];
  }

  // ── Potentially dilutive shares ──
  const potentialM =
    text.match(/(?:potentially\s+dilutive|maximum\s+(?:dilutive\s+)?shares?|could\s+result\s+in\s+(?:the\s+issuance\s+of\s+)?(?:up\s+to\s+)?)([\d,\.]+(?:\s*(?:million|M|B))?)\s+(?:additional\s+)?shares?/i)
    ?? text.match(/([\d,\.]+(?:\s*(?:million|M|B))?)\s+shares?\s+(?:that\s+)?(?:could|may|might)\s+(?:be\s+)?(?:issued?|result)/i);
  if (potentialM) summary.potentialDilutiveShares = parseShares(potentialM[1]);

  // ── Dilution warning language ──
  const DILUTION_TRIGGERS = [
    /(?:significant(?:ly)?|substantial(?:ly)?|materially?)\s+dilut/gi,
    /dilut(?:ion|ive|ed?)\s+(?:of|to|impact|effect|risk)/gi,
    /result\s+in\s+(?:significant\s+)?dilution/gi,
    /anti[-\s]dilution/gi,
  ];
  for (const pattern of DILUTION_TRIGGERS) {
    const re = new RegExp(pattern.source, 'gi');
    let dm: RegExpExecArray | null;
    while ((dm = re.exec(text)) !== null) {
      const phrase = text.slice(Math.max(0, dm.index - 40), Math.min(text.length, dm.index + 200)).trim();
      if (!summary.dilutionPhrases.includes(phrase)) summary.dilutionPhrases.push(phrase);
      if (summary.dilutionPhrases.length >= 5) break;
    }
  }

  summary.hasDilutionWarning = summary.dilutionPhrases.length > 0
    || /(?:there\s+can\s+be\s+no\s+assurance|risk\s+of\s+dilution|holders?.*may\s+be\s+diluted)/i.test(text);

  return summary;
}

// ─── Consolidation layer ──────────────────────────────────────────────────────
//
// Stable instrument identity rules:
//
//   Notes: same principal (±2%) AND no conflicting valid investor names
//       OR same valid investor name AND same interest rate
//       OR same valid investor name AND same maturity date
//
//   The merge pass prefers the record with more complete data.

function mergeNote(a: ConvertibleNote, b: ConvertibleNote): ConvertibleNote {
  return {
    // Identity
    instrumentName:      a.instrumentName      ?? b.instrumentName,
    instrumentType:      a.instrumentType      ?? b.instrumentType,
    isAmendment:         a.isAmendment         ?? b.isAmendment,
    isReplacement:       a.isReplacement       ?? b.isReplacement,
    investorName:        a.investorName        ?? b.investorName,
    label:               a.label               ?? b.label,
    // Economics
    principalAmount:     a.principalAmount     ?? b.principalAmount,
    purchasePrice:       a.purchasePrice       ?? b.purchasePrice,
    originalIssueDiscount: a.originalIssueDiscount ?? b.originalIssueDiscount,
    netProceeds:         a.netProceeds         ?? b.netProceeds,
    legalFees:           a.legalFees           ?? b.legalFees,
    placementFees:       a.placementFees       ?? b.placementFees,
    outstandingBalance:  a.outstandingBalance  ?? b.outstandingBalance,
    interestRate:        a.interestRate        ?? b.interestRate,
    defaultInterestRate: a.defaultInterestRate ?? b.defaultInterestRate,
    maturityDate:        a.maturityDate        ?? b.maturityDate,
    executionDate:       a.executionDate       ?? b.executionDate,
    prepaymentPremium:   a.prepaymentPremium   ?? b.prepaymentPremium,
    prepaymentTerms:     a.prepaymentTerms     ?? b.prepaymentTerms,
    redemptionPremium:   a.redemptionPremium   ?? b.redemptionPremium,
    // Conversion
    conversionFormula:   a.conversionFormula   ?? b.conversionFormula,
    discountRate:        a.discountRate        ?? b.discountRate,
    lookbackDays:        a.lookbackDays        ?? b.lookbackDays,
    fixedConversionPrice: a.fixedConversionPrice ?? b.fixedConversionPrice,
    floorPrice:          a.floorPrice !== undefined ? a.floorPrice : b.floorPrice,
    hasFloorPrice:       a.hasFloorPrice || b.hasFloorPrice,
    ceilingPrice:        a.ceilingPrice        ?? b.ceilingPrice,
    exchangeCap:         a.exchangeCap         ?? b.exchangeCap,
    beneficialOwnershipBlocker: a.beneficialOwnershipBlocker ?? b.beneficialOwnershipBlocker,
    hasResetProvisions:  a.hasResetProvisions  || b.hasResetProvisions,
    antiDilutionProvisions: a.antiDilutionProvisions ?? b.antiDilutionProvisions,
    // Defaults
    eventsOfDefault:     a.eventsOfDefault     ?? b.eventsOfDefault,
    defaultConversionRights: a.defaultConversionRights ?? b.defaultConversionRights,
    hasAccelerationClause: a.hasAccelerationClause ?? b.hasAccelerationClause,
    penaltyRate:         a.penaltyRate         ?? b.penaltyRate,
    // Status
    status:              a.status              ?? b.status,
    amountConverted:     a.amountConverted     ?? b.amountConverted,
    amountRepaid:        a.amountRepaid        ?? b.amountRepaid,
    // Provenance
    isExplicitlyConvertible: a.isExplicitlyConvertible ?? b.isExplicitlyConvertible,
    _noteNumber:          a._noteNumber          ?? b._noteNumber,
    _section:             a._section             ?? b._section,
    _sourceSentences:     [...new Set([...(a._sourceSentences ?? []), ...(b._sourceSentences ?? [])])],
    _sourceSentenceTexts: [...new Set([...(a._sourceSentenceTexts ?? []), ...(b._sourceSentenceTexts ?? [])])],
    _fieldConfidence:     { ...b._fieldConfidence, ...a._fieldConfidence },
    _anchorSentenceIndex:   a._anchorSentenceIndex   ?? b._anchorSentenceIndex,
    _anchorPrincipalAmount: a._anchorPrincipalAmount ?? b._anchorPrincipalAmount,
    _fieldProvenance:     { ...b._fieldProvenance, ...a._fieldProvenance },
    _rejectedCandidates:  [...(a._rejectedCandidates ?? []), ...(b._rejectedCandidates ?? [])],
  };
}

function validateConvertibleNote(note: ConvertibleNote): string[] {
  const warns: string[] = [];

  // Principal vs purchase price
  if (note.principalAmount != null && note.purchasePrice != null) {
    if (note.principalAmount < note.purchasePrice) {
      warns.push(
        `Principal ${fmt$(note.principalAmount)} < purchase price ${fmt$(note.purchasePrice)} — likely extraction error`,
      );
    }
  }

  // Net proceeds vs purchase price
  if (note.netProceeds != null && note.purchasePrice != null) {
    if (note.netProceeds > note.purchasePrice) {
      warns.push(
        `Net proceeds ${fmt$(note.netProceeds)} > purchase price ${fmt$(note.purchasePrice)} — unlikely; check sentences`,
      );
    }
  }

  // Maturity after execution
  if (note.executionDate && note.maturityDate) {
    const exec = Date.parse(note.executionDate);
    const mat  = Date.parse(note.maturityDate);
    if (!isNaN(exec) && !isNaN(mat) && mat <= exec) {
      warns.push(
        `Maturity date ${note.maturityDate} is not after execution date ${note.executionDate}`,
      );
    }
  }

  // Interest rate sanity (0.1% – 36%)
  if (note.interestRate != null) {
    if (note.interestRate < 0.001 || note.interestRate > 0.36) {
      warns.push(
        `Interest rate ${(note.interestRate * 100).toFixed(2)}% outside expected range 0.1%–36%`,
      );
    }
  }

  // Default interest > regular interest
  if (note.defaultInterestRate != null && note.interestRate != null) {
    if (note.defaultInterestRate <= note.interestRate) {
      warns.push(
        `Default interest rate ${(note.defaultInterestRate * 100).toFixed(2)}% ≤ regular rate ${(note.interestRate * 100).toFixed(2)}% — check extraction`,
      );
    }
  }

  // Conflicting conversion signals
  if (note.discountRate != null && note.fixedConversionPrice != null) {
    warns.push(
      `Both variable discountRate (${(note.discountRate * 100).toFixed(0)}%) and fixedConversionPrice ($${note.fixedConversionPrice}) extracted — likely from different sentences`,
    );
  }

  // Prepayment premium sanity (0% – 50%)
  if (note.prepaymentPremium != null) {
    if (note.prepaymentPremium < 0 || note.prepaymentPremium > 0.50) {
      warns.push(
        `Prepayment premium ${(note.prepaymentPremium * 100).toFixed(1)}% outside expected range 0%–50%`,
      );
    }
  }

  return warns;
}

function sameNote(a: ConvertibleNote, b: ConvertibleNote): boolean {
  const aN = a.investorName?.toLowerCase().trim();
  const bN = b.investorName?.toLowerCase().trim();
  const namesConflict = aN && bN && aN !== bN;

  // Same principal (±2%) — tight to avoid merging different notes with same amount
  if (a.principalAmount && b.principalAmount) {
    const diff = Math.abs(a.principalAmount - b.principalAmount);
    const base = Math.min(a.principalAmount, b.principalAmount);
    if (diff / base < 0.02) {
      // Don't merge if both have distinct valid investor names
      return !namesConflict;
    }
  }

  // Same outstanding balance (±2%) with no investor conflict
  if (a.outstandingBalance && b.outstandingBalance && !namesConflict) {
    const diff = Math.abs(a.outstandingBalance - b.outstandingBalance);
    const base = Math.min(a.outstandingBalance, b.outstandingBalance);
    if (diff / base < 0.02) return true;
  }

  // Same investor name + same maturity date
  if (aN && bN && aN === bN && a.maturityDate && b.maturityDate && a.maturityDate === b.maturityDate) return true;

  // Same investor name + same interest rate
  if (aN && bN && aN === bN && a.interestRate && b.interestRate) {
    if (Math.abs(a.interestRate - b.interestRate) < 0.005) return true;
  }

  // Same investor name + same discount rate (variable rate lender, multiple filings)
  if (aN && bN && aN === bN && a.discountRate && b.discountRate) {
    if (Math.abs(a.discountRate - b.discountRate) < 0.005) return true;
  }

  return false;
}

function consolidateNotes(notes: ConvertibleNote[]): ConvertibleNote[] {
  const result: ConvertibleNote[] = [];
  const used = new Set<number>();
  for (let i = 0; i < notes.length; i++) {
    if (used.has(i)) continue;
    let best = { ...notes[i] };
    for (let j = i + 1; j < notes.length; j++) {
      if (used.has(j)) continue;
      if (sameNote(best, notes[j])) {
        best = mergeNote(best, notes[j]);
        used.add(j);
      }
    }
    result.push(best);
    used.add(i);
  }
  return result;
}

function consolidateConversions(conversions: ConversionRecord[]): ConversionRecord[] {
  const seen = new Set<string>();
  return conversions.filter(c => {
    const key = `${c.debtConverted ?? '?'}:${c.sharesIssued ?? '?'}:${c.conversionDate ?? '?'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Merge warrants with identical exercise price AND expiration date. */
function consolidateWarrants(warrants: WarrantRecord[]): WarrantRecord[] {
  const groups: WarrantRecord[] = [];
  for (const w of warrants) {
    const existing = groups.find(g => {
      // Must match on exercise price (±2%) AND expiration date when both present
      const priceMatch = w.exercisePrice && g.exercisePrice
        ? Math.abs(w.exercisePrice - g.exercisePrice) / g.exercisePrice < 0.02
        : !w.exercisePrice && !g.exercisePrice;
      const expiryMatch = w.expirationDate && g.expirationDate
        ? w.expirationDate === g.expirationDate
        : !w.expirationDate && !g.expirationDate;
      return priceMatch && expiryMatch;
    });
    if (existing) {
      existing.warrantShares  = (existing.warrantShares ?? 0) + (w.warrantShares ?? 0) || undefined;
      existing.issuedWithNote = existing.issuedWithNote || w.issuedWithNote;
      existing.recipientName  = existing.recipientName  ?? w.recipientName;
    } else {
      groups.push({ ...w });
    }
  }
  return groups;
}

function consolidateIssuances(issuances: EquityIssuance[]): EquityIssuance[] {
  const seen = new Set<string>();
  return issuances.filter(e => {
    const key = `${e.sharesIssued ?? '?'}:${e.grossProceeds ?? '?'}:${e.pricePerShare ?? '?'}:${e.issuanceDate ?? '?'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sameFacility(a: EquityFacility, b: EquityFacility): boolean {
  if (a.counterpartyName && b.counterpartyName &&
      a.counterpartyName.toLowerCase() === b.counterpartyName.toLowerCase()) return true;
  if (a.facilitySize && b.facilitySize) {
    const pct = Math.abs(a.facilitySize - b.facilitySize) / a.facilitySize;
    if (pct < 0.01) return true;
    if (pct < 0.05 && (a.facilityType === b.facilityType || a.facilityType === 'other' || b.facilityType === 'other')) return true;
  }
  return false;
}

function mergeFacility(a: EquityFacility, b: EquityFacility): EquityFacility {
  return {
    facilitySize:     a.facilitySize     ?? b.facilitySize,
    drawnAmount:      (a.drawnAmount != null && b.drawnAmount != null)
                        ? Math.max(a.drawnAmount, b.drawnAmount)
                        : (a.drawnAmount ?? b.drawnAmount),
    pricingFormula:   a.pricingFormula   ?? b.pricingFormula,
    facilityType:     (a.facilityType !== 'other' ? a.facilityType : b.facilityType) ?? 'other',
    counterpartyName: a.counterpartyName ?? b.counterpartyName,
    _noteNumber:      a._noteNumber      ?? b._noteNumber,
    _section:         a._section         ?? b._section,
  };
}

function consolidateFacilities(facilities: EquityFacility[]): EquityFacility[] {
  const result: EquityFacility[] = [];
  const used = new Set<number>();
  for (let i = 0; i < facilities.length; i++) {
    if (used.has(i)) continue;
    let best = { ...facilities[i] };
    for (let j = i + 1; j < facilities.length; j++) {
      if (used.has(j)) continue;
      if (sameFacility(best, facilities[j])) {
        best = mergeFacility(best, facilities[j]);
        used.add(j);
      }
    }
    result.push(best);
    used.add(i);
  }
  return result;
}

// ─── Related party — grouped by party ────────────────────────────────────────

interface PartyGroup {
  /** Human-readable party identifier */
  party:    string;
  loans:    number;
  compensation: number;
  lease:    number;
  service:  number;
  other:    number;
  total:    number;
  count:    number;
}

function groupRelatedPartyByParty(txns: RelatedPartyTransaction[]): PartyGroup[] {
  // Deduplicate by exact amount+type first
  const amtTypeSeen = new Set<string>();
  const deduped: RelatedPartyTransaction[] = [];
  for (const t of txns) {
    const k = `${t.transactionType}:${t.amount}`;
    if (amtTypeSeen.has(k)) continue;
    amtTypeSeen.add(k);
    deduped.push(t);
  }

  // Normalize party descriptions into canonical keys
  function partyKey(t: RelatedPartyTransaction): string {
    const desc = t.partyDescription ?? '';
    const titleM = desc.match(/\b(CEO|CFO|COO|CTO|President|Director|Officer|Shareholder)\b/i);
    return titleM ? titleM[1].toUpperCase() : 'RELATED PARTY';
  }

  const byParty = new Map<string, PartyGroup>();
  for (const t of deduped) {
    const key = partyKey(t);
    if (!byParty.has(key)) {
      byParty.set(key, { party: t.partyDescription ?? key, loans: 0, compensation: 0, lease: 0, service: 0, other: 0, total: 0, count: 0 });
    }
    const g = byParty.get(key)!;
    // Update party description if we got a richer one
    if (t.partyDescription && t.partyDescription.length > g.party.length) g.party = t.partyDescription;
    const amt = t.amount ?? 0;
    g.count++;
    g.total += amt;
    switch (t.transactionType) {
      case 'loan':         g.loans        += amt; break;
      case 'compensation': g.compensation += amt; break;
      case 'lease':        g.lease        += amt; break;
      case 'service':      g.service      += amt; break;
      default:             g.other        += amt; break;
    }
  }

  return [...byParty.values()].sort((a, b) => b.total - a.total);
}

// ─── Prose formatters ─────────────────────────────────────────────────────────

function fmt$(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (n >= 1_000)     return `$${Math.round(n / 1_000)}K`;
  return `$${n.toLocaleString()}`;
}

function fmtShares(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2).replace(/\.?0+$/, '')}B shares`;
  if (n >= 1_000_000)     return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M shares`;
  if (n >= 1_000)         return `${Math.round(n / 1_000)}K shares`;
  return `${n.toLocaleString()} shares`;
}

// ─── Note risk classification ─────────────────────────────────────────────────

type NoteRiskTier = 'toxic' | 'variable' | 'floored' | 'fixed' | 'unknown';

function classifyNoteTier(n: ConvertibleNote): NoteRiskTier {
  if (n.discountRate && !n.hasFloorPrice && n.hasResetProvisions) return 'toxic';
  if (n.discountRate && !n.hasFloorPrice)                         return 'variable';
  if (n.discountRate &&  n.hasFloorPrice)                         return 'floored';
  // 'fixed' ONLY when the filing states an explicit fixed conversion price.
  // Interest rate or principal amount alone are insufficient — those fields
  // exist on non-convertible loans and do not imply a conversion price.
  if (n.fixedConversionPrice)                                     return 'fixed';
  return 'unknown';
}

function noteConfidenceLevel(n: ConvertibleNote): 'high' | 'medium' | 'low' {
  const populated = [n.principalAmount, n.interestRate, n.maturityDate, n.investorName, n.discountRate, n.fixedConversionPrice]
    .filter(v => v != null).length;
  if (populated >= 4) return 'high';
  if (populated >= 2) return 'medium';
  return 'low';
}

const NOTE_TIER_LABEL: Record<NoteRiskTier, string> = {
  toxic:    'TOXIC — variable discount, no floor price, anti-dilution reset provisions',
  variable: 'VARIABLE RATE — discount to market/VWAP, no floor price',
  floored:  'FLOORED CONVERTIBLE — discount to market/VWAP with floor price',
  fixed:    'FIXED CONVERSION PRICE — convertible at a stated price per share',
  unknown:  'TERMS UNEXTRACTED — convertible instrument; conversion terms not confirmed from available text',
};

// ─── Prose formatters — per instrument ───────────────────────────────────────

function noteToProse(n: ConvertibleNote, idx: number): string {
  const tier       = classifyNoteTier(n);
  const confidence = noteConfidenceLevel(n);
  const nameStr    = n.investorName ? `with ${n.investorName}` : '';
  const ref        = n._noteNumber  ? ` (Note ${n._noteNumber})` : '';
  const label      = n.investorName
    ? `a convertible note ${nameStr}${ref}`
    : `convertible note ${idx + 1}${ref}`;
  const sentences: string[] = [];

  if (n.principalAmount) {
    const outstanding = n.outstandingBalance != null && n.outstandingBalance !== n.principalAmount
      ? `, of which ${fmt$(n.outstandingBalance)} remains outstanding`
      : '';
    sentences.push(
      `The Company has ${label} with an original principal of ${fmt$(n.principalAmount)}${outstanding}.`,
    );
  } else if (n.outstandingBalance) {
    sentences.push(
      `The Company carries ${label} with an outstanding balance of ${fmt$(n.outstandingBalance)}.`,
    );
  } else {
    sentences.push(
      `The Company has ${label} (principal amount not disclosed in the sections reviewed).`,
    );
  }

  const termParts: string[] = [];
  if (n.interestRate) {
    const r = n.interestRate * 100;
    termParts.push(`bears interest at ${r % 1 === 0 ? r.toFixed(0) : r.toFixed(1)}% per annum`);
  }
  if (n.maturityDate) termParts.push(`matures on ${n.maturityDate}`);
  if (termParts.length > 0) sentences.push(`The note ${termParts.join(' and ')}.`);

  // Maturity overdue check
  if (n.maturityDate) {
    const yearMatch = n.maturityDate.match(/\b(20\d{2})\b/);
    const year      = yearMatch ? parseInt(yearMatch[1]) : null;
    if (year && year < new Date().getFullYear()) {
      sentences.push(
        `This instrument had a stated maturity in ${year} and may be past due, extended by amendment, ` +
        `or otherwise modified; the filing should be reviewed for subsequent disclosure.`,
      );
    }
  }

  if (n.discountRate) {
    const pct      = (n.discountRate * 100).toFixed(0);
    const lookback = n.lookbackDays ? `${n.lookbackDays}-day ` : '';
    const floorStr = n.hasFloorPrice && n.floorPrice != null
      ? `, with a floor price of $${n.floorPrice}`
      : (!n.hasFloorPrice ? ', with no floor price stated' : '');
    const resetStr = n.hasResetProvisions
      ? ' Anti-dilution reset provisions permit the conversion price to step down with the market price, meaning each price decline can trigger additional dilution in a self-reinforcing cycle.'
      : '';
    const riskStr = tier === 'toxic'
      ? ` This structure — variable discount, no price floor, and price-reset provisions — represents the highest-risk category of convertible instrument. Dilution is effectively unlimited and accelerates as the stock price falls.`
      : tier === 'variable'
      ? ` Without a price floor, the share count required to retire this obligation is uncapped and grows as the market price declines.`
      : '';
    sentences.push(
      `Conversion is exercisable at a ${pct}% discount to the ${lookback}VWAP${floorStr}.${resetStr}${riskStr}`,
    );
  } else if (tier === 'fixed' && n.fixedConversionPrice) {
    sentences.push(`The note is convertible at a fixed price of $${n.fixedConversionPrice} per share.`);
    if (n.hasResetProvisions) sentences.push('The note carries anti-dilution reset provisions that may reduce the effective conversion price.');
  } else if (n.hasResetProvisions) {
    sentences.push('The note carries anti-dilution reset provisions.');
  } else if (tier === 'unknown') {
    // Do NOT say "fixed-rate" — we don't know whether it's convertible or not
    if (n.isExplicitlyConvertible) {
      sentences.push(
        'This instrument was identified as convertible debt, but conversion terms (discount rate, fixed conversion price, or conversion formula) ' +
        'could not be extracted with sufficient confidence from the available filing text. ' +
        'Investors should review the full Note disclosure for conversion terms.',
      );
    } else {
      sentences.push(
        'Conversion terms (if any) could not be determined from the available filing text. ' +
        'This instrument may be a convertible note, a fixed-price convertible, or a non-convertible obligation — ' +
        'the filing should be reviewed directly to assess dilution potential.',
      );
    }
  }

  // Confidence caveat — only for non-unknown tiers (unknown already has its own caveat)
  if (tier !== 'unknown') {
    if (confidence === 'low') {
      sentences.push(
        'Note: limited disclosure was available for this instrument. The characterization above is based on partial data and may be incomplete.',
      );
    } else if (confidence === 'medium') {
      sentences.push('Some terms for this instrument could not be confirmed from the available disclosure.');
    }
  }

  return `[${NOTE_TIER_LABEL[tier]}]\n${sentences.join(' ')}`;
}

function facilityToProse(f: EquityFacility, idx: number): string {
  const TYPE_LABEL: Record<string, string> = {
    eloc: 'equity line of credit (ELOC)', efa: 'equity financing agreement (EFA)',
    equity_line: 'equity line of credit', variable_note: 'variable-rate note facility', other: 'equity facility',
  };
  const typeStr = TYPE_LABEL[f.facilityType ?? 'other'];
  // Never use positional fallbacks — if the counterparty is unknown, say so explicitly
  const party = f.counterpartyName ?? 'an undisclosed counterparty';
  const ref   = f._noteNumber ? ` (Note ${f._noteNumber})` : '';
  const sentences: string[] = [];

  if (f.facilitySize) {
    sentences.push(`The Company has a committed ${typeStr} with ${party}${ref} for up to ${fmt$(f.facilitySize)}.`);
  } else {
    sentences.push(`The Company has a ${typeStr} with ${party}${ref}.`);
  }

  if (f.drawnAmount && f.drawnAmount > 0) {
    const remaining = f.facilitySize ? ` leaving ${fmt$(f.facilitySize - f.drawnAmount)} undrawn` : '';
    sentences.push(`${fmt$(f.drawnAmount)} has been drawn to date${remaining}.`);
  } else if (f.facilitySize) {
    sentences.push('No amounts have been drawn as of the reporting date.');
  }

  if (f.pricingFormula) {
    sentences.push(`Shares are priced at ${f.pricingFormula.slice(0, 120)}.`);
  }

  return sentences.join(' ');
}

// ─── Key insights generator ───────────────────────────────────────────────────

type DilutionRisk = 'low' | 'moderate' | 'high' | 'severe';

interface InsightSignals {
  toxicNoteCount:           number;
  variableNoteCount:        number;
  flooredNoteCount:         number;
  hasActiveConversions:     boolean;
  hasEquityFacility:        boolean;
  facilityBeingDrawn:       boolean;
  hasRelatedPartyLoans:     boolean;
  relatedPartyIsOnlySource: boolean;
  sharesDeltaPct:           number | undefined;
  sharesGrowing:            boolean;
  sharesOutstanding:        number | undefined;
  sharesAbove1B:            boolean;
  sharesAbove10B:           boolean;
  hasDilutionWarning:       boolean;
  totalConvertibleDebt:     number;
  anyDilutionSignal:        boolean;
}

function assessSignals(
  notes:       ConvertibleNote[],
  conversions: ConversionRecord[],
  relParty:    RelatedPartyTransaction[],
  facilities:  EquityFacility[],
  dilution:    DilutionSummary,
): InsightSignals {
  const toxicNoteCount    = notes.filter(n => n.discountRate && !n.hasFloorPrice && n.hasResetProvisions).length;
  const variableNoteCount = notes.filter(n => n.discountRate && !n.hasFloorPrice && !n.hasResetProvisions).length;
  const flooredNoteCount  = notes.filter(n => n.discountRate && n.hasFloorPrice).length;
  const totalConvertibleDebt = notes.reduce((s, n) => s + (n.outstandingBalance ?? n.principalAmount ?? 0), 0);

  const hasActiveConversions = conversions.length > 0;
  const hasEquityFacility    = facilities.length > 0;
  const facilityBeingDrawn   = facilities.some(f => f.drawnAmount && f.drawnAmount > 0);

  const relatedLoans         = relParty.filter(t => t.transactionType === 'loan');
  const hasRelatedPartyLoans = relatedLoans.length > 0;
  const relatedLoanTotal     = relatedLoans.reduce((s, t) => s + (t.amount ?? 0), 0);
  const relatedPartyIsOnlySource  = hasRelatedPartyLoans && totalConvertibleDebt === 0 && facilities.length === 0;
  const relatedPartyIsMajorSource = hasRelatedPartyLoans && totalConvertibleDebt > 0
    && relatedLoanTotal / totalConvertibleDebt > 0.4;

  const sharesOutstanding = dilution.sharesOutstandingEnd;
  const sharesAbove1B     = (sharesOutstanding ?? 0) >= 1_000_000_000;
  const sharesAbove10B    = (sharesOutstanding ?? 0) >= 10_000_000_000;

  const sharesDeltaPct = dilution.sharesOutstandingStart && dilution.sharesOutstandingEnd
    && dilution.sharesOutstandingStart > 0
    ? ((dilution.sharesOutstandingEnd - dilution.sharesOutstandingStart) / dilution.sharesOutstandingStart) * 100
    : undefined;
  const sharesGrowing = (sharesDeltaPct ?? 0) > 5;

  const anyDilutionSignal =
    toxicNoteCount > 0 || variableNoteCount > 0 || flooredNoteCount > 0 ||
    hasActiveConversions || hasEquityFacility || dilution.hasDilutionWarning ||
    sharesAbove1B || sharesGrowing;

  return {
    toxicNoteCount, variableNoteCount, flooredNoteCount,
    hasActiveConversions, hasEquityFacility, facilityBeingDrawn,
    hasRelatedPartyLoans: hasRelatedPartyLoans && (relatedPartyIsOnlySource || relatedPartyIsMajorSource),
    relatedPartyIsOnlySource,
    sharesDeltaPct, sharesGrowing, sharesOutstanding,
    sharesAbove1B, sharesAbove10B,
    hasDilutionWarning: dilution.hasDilutionWarning,
    totalConvertibleDebt, anyDilutionSignal,
  };
}

const RISK_SCORE_THRESHOLDS: Array<[number, DilutionRisk]> = [
  [7, 'severe'], [4, 'high'], [2, 'moderate'], [0, 'low'],
];

function maxRisk(a: DilutionRisk, b: DilutionRisk): DilutionRisk {
  const order: Record<DilutionRisk, number> = { low: 0, moderate: 1, high: 2, severe: 3 };
  return order[a] >= order[b] ? a : b;
}

function deriveDilutionRisk(signals: InsightSignals): DilutionRisk {
  let score = 0;
  score += signals.toxicNoteCount    * 3;
  score += signals.variableNoteCount * 2;
  score += signals.flooredNoteCount  * 1;
  if (signals.hasActiveConversions)         score += 2;
  if (signals.facilityBeingDrawn)           score += 2;
  else if (signals.hasEquityFacility)       score += 1;
  if (signals.sharesAbove10B)               score += 3;
  else if (signals.sharesAbove1B)           score += 1;
  if (signals.sharesGrowing && (signals.sharesDeltaPct ?? 0) >= 25) score += 2;
  else if (signals.sharesGrowing)           score += 1;
  if (signals.hasDilutionWarning)           score += 1;

  let floor: DilutionRisk = 'low';
  if (signals.anyDilutionSignal)            floor = maxRisk(floor, 'moderate');
  if (signals.sharesAbove1B)                floor = maxRisk(floor, 'moderate');
  if (signals.sharesAbove10B)               floor = maxRisk(floor, 'high');
  if (signals.toxicNoteCount > 0)           floor = maxRisk(floor, 'high');
  if (signals.toxicNoteCount > 0 && signals.hasActiveConversions) floor = maxRisk(floor, 'severe');
  if (signals.facilityBeingDrawn && signals.hasActiveConversions) floor = maxRisk(floor, 'high');

  const fromScore = RISK_SCORE_THRESHOLDS.find(([t]) => score >= t)![1];
  return maxRisk(fromScore, floor);
}

function generateKeyInsights(
  notes:       ConvertibleNote[],
  conversions: ConversionRecord[],
  relParty:    RelatedPartyTransaction[],
  facilities:  EquityFacility[],
  dilution:    DilutionSummary,
): string {
  if (notes.length === 0 && conversions.length === 0 && relParty.length === 0 && facilities.length === 0) {
    return '';
  }

  const signals = assessSignals(notes, conversions, relParty, facilities, dilution);
  const risk    = deriveDilutionRisk(signals);
  const sentences: string[] = [];

  if (signals.toxicNoteCount > 0) {
    const count    = signals.toxicNoteCount === 1 ? 'a convertible note' : `${signals.toxicNoteCount} convertible notes`;
    const severity = signals.hasActiveConversions ? 'severe dilution risk' : 'high dilution risk';
    sentences.push(`The company has issued ${count} structured with a variable conversion discount, no floor price, and anti-dilution reset provisions — a combination that can generate unlimited share issuance at declining prices and represents ${severity}.`);
  } else if (signals.variableNoteCount > 0) {
    const count = signals.variableNoteCount === 1 ? 'one convertible note' : `${signals.variableNoteCount} convertible notes`;
    sentences.push(`The company carries ${count} with no floor price on conversion, creating open-ended dilution exposure tied to market price movement.`);
  } else if (signals.totalConvertibleDebt > 0) {
    sentences.push(`Outstanding convertible debt includes floor prices on conversion, which limits but does not eliminate dilution risk.`);
  }

  {
    const shareParts: string[] = [];
    if (signals.sharesAbove10B) {
      shareParts.push('Share count is above 10 billion, placing this company in the most severely diluted tier of OTC issuers');
    } else if (signals.sharesAbove1B) {
      shareParts.push('Share count exceeds one billion, itself a sign of significant prior dilution');
    }

    if (signals.hasActiveConversions && signals.sharesGrowing) {
      const d = (signals.sharesDeltaPct ?? 0) >= 50 ? 'dramatically' : (signals.sharesDeltaPct ?? 0) >= 25 ? 'materially' : 'meaningfully';
      shareParts.push(shareParts.length > 0
        ? `and continued to grow ${d} during the period as note conversions remain active`
        : `Active note conversions drove ${d} share count growth during the period, confirming dilution is in progress`);
    } else if (signals.hasActiveConversions) {
      shareParts.push(shareParts.length > 0
        ? 'with active note conversions continuing to add to the float'
        : 'Active note conversions during the period confirm dilution is occurring, not merely a forward risk');
    } else if (signals.sharesGrowing) {
      const d = (signals.sharesDeltaPct ?? 0) >= 50 ? 'substantially' : (signals.sharesDeltaPct ?? 0) >= 25 ? 'materially' : 'meaningfully';
      shareParts.push(shareParts.length > 0
        ? `with the float growing ${d} during the period`
        : `Share count grew ${d} during the period`);
    }

    if (shareParts.length > 0) sentences.push(shareParts.join(' — ') + '.');
  }

  if (signals.hasEquityFacility) {
    sentences.push(signals.facilityBeingDrawn
      ? `An active equity facility is being drawn upon, providing an ongoing channel for share issuance beyond the convertible note stack.`
      : `An equity facility is in place and available to be drawn at management's discretion, representing additional latent dilution capacity.`);
  }

  if (signals.hasRelatedPartyLoans) {
    sentences.push(signals.relatedPartyIsOnlySource
      ? `Related-party loans appear to be the primary source of debt financing, suggesting limited access to institutional capital.`
      : `Related-party loans make up a meaningful portion of the financing stack.`);
  }

  if (sentences.length === 0 && signals.hasDilutionWarning) {
    sentences.push('The filing contains dilution risk language, though no convertible debt or active conversion activity was identified.');
  }
  if (sentences.length === 0) return '';

  const RISK_LABEL: Record<DilutionRisk, string> = {
    severe:   '⚠ SEVERE DILUTION RISK',
    high:     '⚠ HIGH DILUTION RISK',
    moderate: 'MODERATE DILUTION RISK',
    low:      'LOW DILUTION RISK',
  };

  return `KEY INSIGHTS  [${RISK_LABEL[risk]}]\n  ${sentences.join(' ')}`;
}

// ─── Analyst report — 13-section institutional memo format ───────────────────

function generateAnalystReport(
  notes:       ConvertibleNote[],
  issuances:   EquityIssuance[],
  conversions: ConversionRecord[],
  warrants:    WarrantRecord[],
  relParty:    RelatedPartyTransaction[],
  facilities:  EquityFacility[],
  dilution:    DilutionSummary,
  fs?:         FinancialStatements,
): string {
  const memo: string[] = [];

  const signals = assessSignals(notes, conversions, relParty, facilities, dilution);
  const risk    = deriveDilutionRisk(signals);
  const RISK_LABEL: Record<DilutionRisk, string> = {
    severe: 'SEVERE', high: 'HIGH', moderate: 'MODERATE', low: 'LOW',
  };

  // Partition subsequent-events items so they appear only in Section 11
  const periodNotes      = notes      .filter(n => n._section !== 'subsequent_events');
  const subseqNotes      = notes      .filter(n => n._section === 'subsequent_events');
  const periodConv       = conversions.filter(c => c._section !== 'subsequent_events');
  const subseqConv       = conversions.filter(c => c._section === 'subsequent_events');
  const periodWarrants   = warrants   .filter(w => w._section !== 'subsequent_events');
  const subseqWarrants   = warrants   .filter(w => w._section === 'subsequent_events');
  const periodFacilities = facilities .filter(f => f._section !== 'subsequent_events');
  const subseqFacilities = facilities .filter(f => f._section === 'subsequent_events');
  const commonIssuances    = issuances.filter(e => e.issuanceType !== 'preferred');
  const preferredIssuances = issuances.filter(e => e.issuanceType === 'preferred');

  const totalDebt    = periodNotes.reduce((s, n) => s + (n.outstandingBalance ?? n.principalAmount ?? 0), 0);
  const toxicCount   = periodNotes.filter(n => classifyNoteTier(n) === 'toxic').length;
  const variableCount = periodNotes.filter(n => classifyNoteTier(n) === 'variable').length;
  const divider      = '\n\n' + '─'.repeat(60) + '\n\n';

  // Confidence-aware absence language.
  // Use ABSENCE_NOTE when the filing was parseable but the section had no extractable
  // instruments.  Use ABSENCE_ACTIVITY when there simply was no activity to find.
  const ABSENCE_NOTE     = 'No instruments were identified with sufficient confidence to report in this section. The underlying filing section may contain activity that could not be extracted from the available text.';
  const ABSENCE_ACTIVITY = 'No activity was identified in this filing for this period.';

  // ── 1. Executive Summary ─────────────────────────────────────────────────
  // Five-paragraph analyst memo structure:
  //   Para A — Operating performance (financial statement data if available)
  //   Para B — Liquidity position and going concern
  //   Para C — Financing activity and capital structure
  //   Para D — Dilution risk assessment and share count
  //   Para E — Key watchpoints for investors
  {
    const paragraphs: string[] = [];

    // ── A: Operating performance ──────────────────────────────────────────
    {
      const parts: string[] = [];
      const period = fs?.periodLabel ?? '';

      if (fs && (fs.revenue != null || fs.netLoss != null)) {
        const periodStr = period ? `For the ${period}, ` : '';

        if (fs.revenue != null && fs.revenue > 0) {
          const revStr   = fmt$(fs.revenue);
          const priorRev = fs.revenuePriorPeriod;
          const yoyStr   = priorRev && priorRev > 0
            ? ` (${fs.revenue >= priorRev ? '+' : ''}${(((fs.revenue - priorRev) / priorRev) * 100).toFixed(0)}% year-over-year)`
            : '';
          parts.push(`${periodStr}the Company reported revenue of ${revStr}${yoyStr}.`);
          if (fs.grossProfit != null) {
            const gmStr = fs.grossMarginPct != null ? ` (${(fs.grossMarginPct * 100).toFixed(1)}% gross margin)` : '';
            parts.push(`Gross profit was ${fmt$(fs.grossProfit)}${gmStr}.`);
          }
        } else if (fs.revenue != null && fs.revenue === 0) {
          parts.push(`${periodStr}the Company reported no revenue.`);
        } else {
          parts.push(`${periodStr}revenue figures were not extracted from this filing.`);
        }

        if (fs.netLoss != null) {
          const lossAmt  = Math.abs(fs.netLoss);
          const lossWord = fs.netLoss < 0 ? 'net loss' : 'net income';
          const priorNet = fs.netLossPriorPeriod;
          const cmpStr   = priorNet != null
            ? ` compared to ${priorNet < 0 ? 'a net loss' : 'net income'} of ${fmt$(Math.abs(priorNet))} in the prior comparable period`
            : '';
          parts.push(`The Company reported a ${lossWord} of ${fmt$(lossAmt)}${cmpStr}.`);
        }

        if (fs.cashFromOperations != null) {
          const burnAmt = Math.abs(fs.cashFromOperations);
          const burnDir = fs.cashFromOperations < 0 ? 'used' : 'generated';
          parts.push(`Cash ${burnDir} in operating activities was ${fmt$(burnAmt)}.`);
        }
      } else {
        // No financial data — summarize what we know from financing activity
        if (periodNotes.length > 0 && periodConv.length > 0) {
          parts.push(
            `This filing reflects an active dilution cycle. ` +
            `The Company carries ${periodNotes.length === 1 ? 'a convertible note' : `${periodNotes.length} convertible notes`} ` +
            `with ${fmt$(totalDebt)} in outstanding principal, and note holders exercised conversions during the period.`,
          );
        } else if (periodNotes.length > 0) {
          parts.push(
            `The Company carries ${periodNotes.length === 1 ? 'a convertible note' : `${periodNotes.length} convertible notes`} ` +
            `with ${fmt$(totalDebt)} in outstanding principal.`,
          );
        } else {
          parts.push('Financial statement data and structured financing activity were not extracted with high confidence from this filing.');
        }
      }

      if (parts.length > 0) paragraphs.push(parts.join(' '));
    }

    // ── B: Liquidity and going concern ────────────────────────────────────
    {
      const parts: string[] = [];

      if (fs && (fs.cashAndEquivalents != null || fs.workingCapital != null || fs.totalAssets != null)) {
        const dateStr = fs.balanceSheetDate ? ` as of ${fs.balanceSheetDate}` : '';

        if (fs.cashAndEquivalents != null) {
          parts.push(`The Company held ${fmt$(fs.cashAndEquivalents)} in cash and cash equivalents${dateStr}.`);
        }

        if (fs.workingCapital != null) {
          const isDeficit = fs.workingCapital < 0;
          parts.push(`Working capital ${isDeficit ? 'deficit' : 'surplus'} was ${fmt$(Math.abs(fs.workingCapital))}.`);
        }

        if (fs.totalAssets != null && fs.totalLiabilities != null) {
          const excess = fs.totalLiabilities - fs.totalAssets;
          if (excess > 0) {
            parts.push(
              `Total liabilities of ${fmt$(fs.totalLiabilities)} exceeded total assets of ${fmt$(fs.totalAssets)}, ` +
              `resulting in net liabilities of ${fmt$(excess)}.`,
            );
          } else {
            parts.push(`Total assets were ${fmt$(fs.totalAssets)} against total liabilities of ${fmt$(fs.totalLiabilities)}.`);
          }
        }

        if (fs.stockholdersEquity != null) {
          const isDeficit = fs.stockholdersEquity < 0;
          parts.push(
            `Stockholders' ${isDeficit ? 'deficit' : 'equity'} was ${fmt$(Math.abs(fs.stockholdersEquity))}.`,
          );
        }
      }

      if (fs?.hasGoingConcern) {
        parts.push(
          `The filing contains a going concern disclosure — the Company's auditors have raised substantial doubt ` +
          `about its ability to continue as a going concern. This is a significant negative signal for holders of ` +
          `convertible instruments, as the risk of default or restructuring is elevated.`,
        );
      }

      if (parts.length > 0) paragraphs.push(parts.join(' '));
    }

    // ── C: Financing activity ─────────────────────────────────────────────
    {
      const parts: string[] = [];

      if (toxicCount > 0) {
        const plural = toxicCount === 1 ? 'note' : 'notes';
        parts.push(
          `On the financing side, the Company carries ${toxicCount} toxic convertible ${plural} (variable discount, no floor, reset provisions) ` +
          `that can generate effectively unlimited share issuance as the stock price declines.`,
        );
      } else if (variableCount > 0) {
        parts.push(
          `The Company carries ${variableCount} variable-rate convertible ${variableCount === 1 ? 'note' : 'notes'} with no floor price, ` +
          `creating dilution exposure that grows as the share price declines.`,
        );
      } else if (periodNotes.length > 0 && totalDebt > 0) {
        parts.push(`Outstanding convertible debt totals ${fmt$(totalDebt)} across ${periodNotes.length} instrument${periodNotes.length > 1 ? 's' : ''}.`);
      }

      if (periodConv.length > 0) {
        const totalConvShares = periodConv.reduce((s, c) => s + (c.sharesIssued ?? 0), 0);
        const totalDebtConv   = periodConv.reduce((s, c) => s + (c.debtConverted ?? 0), 0);
        if (totalDebtConv > 0 && totalConvShares > 0) {
          parts.push(
            `During the period, note holders converted ${fmt$(totalDebtConv)} of principal into ${fmtShares(totalConvShares)} of common stock, ` +
            `confirming that dilution is occurring in real time.`,
          );
        } else if (totalConvShares > 0) {
          parts.push(`Note holders converted into ${fmtShares(totalConvShares)} of common stock during the period.`);
        }
      }

      if (periodFacilities.length > 0) {
        const drawn       = periodFacilities.some(f => f.drawnAmount && f.drawnAmount > 0);
        const totalCommit = periodFacilities.reduce((s, f) => s + (f.facilitySize ?? 0), 0);
        const sizeStr     = totalCommit > 0 ? ` of up to ${fmt$(totalCommit)}` : '';
        parts.push(drawn
          ? `An equity facility${sizeStr} is in place and being actively drawn, providing a parallel channel for dilutive share issuance.`
          : `An equity facility${sizeStr} is in place and undrawn, representing latent dilution capacity.`);
      }

      const totalRaised = issuances.reduce((s, e) => s + (e.grossProceeds ?? 0), 0);
      if (totalRaised > 0) {
        parts.push(`The Company raised ${fmt$(totalRaised)} through equity issuances during the period.`);
      }

      if (parts.length > 0) paragraphs.push(parts.join(' '));
    }

    // ── D: Dilution risk and capital structure ────────────────────────────
    {
      const parts: string[] = [];

      if (dilution.sharesOutstandingEnd) {
        const end   = dilution.sharesOutstandingEnd;
        const start = dilution.sharesOutstandingStart;
        if (start && start !== end) {
          const delta = end - start;
          const pct   = ((delta / start) * 100).toFixed(0);
          const dir   = delta > 0 ? 'increased' : 'decreased';
          parts.push(`Common shares outstanding ${dir} by ${Math.abs(Number(pct))}% during the period to ${fmtShares(end)}.`);
        } else {
          parts.push(`Common shares outstanding at period end: ${fmtShares(end)}.`);
        }
      }

      parts.push(`Overall dilution risk rating: ${RISK_LABEL[risk]}.`);

      if (signals.sharesAbove10B) {
        parts.push(
          `With a share count exceeding 10 billion, the Company is in the most severely diluted tier of OTC issuers. ` +
          `Future share issuance is constrained by authorized shares, making another authorized-share increase or reverse split likely.`,
        );
      } else if (signals.sharesAbove1B) {
        parts.push(`A share count above one billion reflects sustained historical dilution.`);
      }

      if (parts.length > 0) paragraphs.push(parts.join(' '));
    }

    // ── E: Key watchpoints ────────────────────────────────────────────────
    {
      const watchpoints: string[] = [];

      if (toxicCount > 0 || variableCount > 0) {
        watchpoints.push('conversion activity in subsequent periods (active conversions accelerate the dilution cycle)');
      }
      if (periodFacilities.some(f => !f.drawnAmount || f.drawnAmount === 0)) {
        watchpoints.push('draws on the equity facility (each draw issues new shares at a market discount)');
      }
      if (fs?.hasGoingConcern) {
        watchpoints.push('ability to fund operations and service convertible debt (going concern risk is elevated)');
      }
      if (dilution.sharesOutstandingEnd && signals.sharesAbove1B) {
        watchpoints.push('authorized share ceiling and any pending reverse stock splits or authorized-share votes');
      }
      if (periodNotes.some(n => {
        const yearMatch = n.maturityDate?.match(/\b(20\d{2})\b/);
        return yearMatch && parseInt(yearMatch[1]) <= new Date().getFullYear();
      })) {
        watchpoints.push('past-due convertible notes and any amendments, extensions, or default notices');
      }
      if (relParty.some(t => t.transactionType === 'loan')) {
        watchpoints.push('related-party loan terms and whether repayment triggers equity issuance');
      }

      if (watchpoints.length > 0) {
        paragraphs.push(
          `Key investor watchpoints: ${watchpoints.map((w, i) => `(${i + 1}) ${w}`).join('; ')}.`,
        );
      }
    }

    memo.push(`1. EXECUTIVE SUMMARY\n\n${paragraphs.filter(Boolean).join('\n\n')}`);
  }

  // ── 2. Capital Raises During the Period ──────────────────────────────────
  {
    const TYPE_LABEL: Record<string, string> = {
      atm: 'at-the-market offering', registered_direct: 'registered direct offering',
      common: 'private placement', other: 'equity offering', preferred: 'preferred stock offering',
    };

    if (commonIssuances.length === 0 && preferredIssuances.length === 0) {
      memo.push(`2. CAPITAL RAISES DURING THE PERIOD\n\n${ABSENCE_ACTIVITY}`);
    } else {
      const paragraphs: string[] = [];

      for (const e of commonIssuances) {
        const typeStr = TYPE_LABEL[e.issuanceType ?? 'other'];
        const parts: string[] = [];
        if (e.sharesIssued && e.pricePerShare) {
          parts.push(`The Company issued ${fmtShares(e.sharesIssued)} of common stock at $${e.pricePerShare}/share`);
        } else if (e.sharesIssued) {
          parts.push(`The Company issued ${fmtShares(e.sharesIssued)} of common stock`);
        } else {
          parts.push(`The Company conducted a ${typeStr}`);
        }
        if (e.grossProceeds) parts.push(` generating ${fmt$(e.grossProceeds)} in gross proceeds`);
        if (e.investorName)  parts.push(` from ${e.investorName}`);
        if (e.issuanceDate)  parts.push(` (${e.issuanceDate})`);
        parts.push(` via ${typeStr}`);
        paragraphs.push(parts.join('') + '.');
      }

      if (commonIssuances.length > 1) {
        const totalProceeds = commonIssuances.reduce((s, e) => s + (e.grossProceeds ?? 0), 0);
        const totalShares   = commonIssuances.reduce((s, e) => s + (e.sharesIssued   ?? 0), 0);
        if (totalProceeds > 0) {
          paragraphs.push(`In aggregate, the Company raised ${fmt$(totalProceeds)} through ${commonIssuances.length} common stock transactions, resulting in the issuance of ${fmtShares(totalShares)} new shares during the period.`);
        }
      }

      if (preferredIssuances.length > 0) {
        const totalProceeds = preferredIssuances.reduce((s, e) => s + (e.grossProceeds ?? 0), 0);
        const totalShares   = preferredIssuances.reduce((s, e) => s + (e.sharesIssued   ?? 0), 0);
        paragraphs.push(totalShares > 0 && totalProceeds > 0
          ? `The Company raised ${fmt$(totalProceeds)} through the issuance of ${fmtShares(totalShares)} shares of preferred stock.`
          : totalProceeds > 0
          ? `The Company raised ${fmt$(totalProceeds)} through preferred stock issuances.`
          : 'The Company issued preferred stock during the period; pricing and share counts were not identified with sufficient confidence to quantify.');
      }

      memo.push(`2. CAPITAL RAISES DURING THE PERIOD\n\n${paragraphs.join(' ')}`);
    }
  }

  // ── 3. Outstanding Convertible Notes ─────────────────────────────────────
  {
    if (periodNotes.length > 0) {
      const totalPrincipal   = periodNotes.reduce((s, n) => s + (n.principalAmount ?? 0), 0);
      const totalOutstanding = periodNotes.reduce((s, n) => s + (n.outstandingBalance ?? n.principalAmount ?? 0), 0);
      let intro = '';
      if (periodNotes.length > 1) {
        const diff = totalPrincipal > 0 && Math.abs(totalOutstanding - totalPrincipal) / totalPrincipal > 0.03;
        const toxStr = toxicCount > 0
          ? ` Of these, ${toxicCount} ${toxicCount === 1 ? 'is' : 'are'} classified as toxic (variable discount, no floor, reset provisions).`
          : variableCount > 0
          ? ` Of these, ${variableCount} carry variable conversion terms with no floor price.`
          : '';
        intro = diff
          ? `The Company has ${periodNotes.length} convertible notes outstanding, representing ${fmt$(totalPrincipal)} in original principal and ${fmt$(totalOutstanding)} currently outstanding.${toxStr} Each instrument is described below.\n\n`
          : `The Company has ${periodNotes.length} convertible notes outstanding, totaling approximately ${fmt$(totalOutstanding)} in aggregate.${toxStr} Each instrument is described below.\n\n`;
      }
      memo.push(`3. OUTSTANDING CONVERTIBLE NOTES\n\n${intro}${periodNotes.map((n, i) => noteToProse(n, i)).join('\n\n')}`);
    } else {
      memo.push(`3. OUTSTANDING CONVERTIBLE NOTES\n\n${ABSENCE_NOTE}`);
    }
  }

  // ── 4. Equity Facilities ──────────────────────────────────────────────────
  {
    if (periodFacilities.length > 0) {
      memo.push(`4. EQUITY FACILITIES (EFA / ELOC / ATM)\n\n${periodFacilities.map((f, i) => facilityToProse(f, i)).join('\n\n')}`);
    } else {
      memo.push(`4. EQUITY FACILITIES (EFA / ELOC / ATM)\n\n${ABSENCE_NOTE}`);
    }
  }

  // ── 5. Common Stock Issuances ────────────────────────────────────────────
  {
    if (commonIssuances.length > 0) {
      const paragraphs: string[] = [];
      for (const e of commonIssuances) {
        const parts: string[] = [];
        const typeStr = e.issuanceType === 'atm' ? 'at-the-market' : e.issuanceType === 'registered_direct' ? 'registered direct' : 'private placement';
        if (e.sharesIssued && e.pricePerShare) {
          parts.push(`The Company issued ${fmtShares(e.sharesIssued)} shares of common stock at $${e.pricePerShare}/share (${typeStr})`);
        } else if (e.sharesIssued) {
          parts.push(`The Company issued ${fmtShares(e.sharesIssued)} shares of common stock via ${typeStr}`);
        } else {
          parts.push(`The Company completed a ${typeStr} common stock offering`);
        }
        if (e.grossProceeds) parts.push(`, generating ${fmt$(e.grossProceeds)} in gross proceeds`);
        if (e.investorName)  parts.push(` (purchaser: ${e.investorName})`);
        if (e.issuanceDate)  parts.push(` on ${e.issuanceDate}`);
        paragraphs.push(parts.join('') + '.');
      }
      memo.push(`5. COMMON STOCK ISSUANCES\n\n${paragraphs.join(' ')}`);
    } else {
      memo.push(`5. COMMON STOCK ISSUANCES\n\n${ABSENCE_ACTIVITY}`);
    }
  }

  // ── 6. Preferred Stock Activity ───────────────────────────────────────────
  {
    if (preferredIssuances.length > 0) {
      const paragraphs: string[] = [];
      for (const e of preferredIssuances) {
        const parts: string[] = [];
        if (e.sharesIssued && e.pricePerShare) {
          parts.push(`The Company issued ${fmtShares(e.sharesIssued)} shares of preferred stock at $${e.pricePerShare}/share`);
        } else if (e.sharesIssued) {
          parts.push(`The Company issued ${fmtShares(e.sharesIssued)} shares of preferred stock`);
        } else {
          parts.push('The Company issued preferred stock');
        }
        if (e.grossProceeds) parts.push(`, raising ${fmt$(e.grossProceeds)} in gross proceeds`);
        if (e.investorName)  parts.push(` from ${e.investorName}`);
        if (e.issuanceDate)  parts.push(` (${e.issuanceDate})`);
        paragraphs.push(parts.join('') + '.');
      }
      memo.push(`6. PREFERRED STOCK ACTIVITY\n\n${paragraphs.join(' ')}`);
    } else {
      memo.push(`6. PREFERRED STOCK ACTIVITY\n\n${ABSENCE_ACTIVITY}`);
    }
  }

  // ── 7. Debt Conversions ───────────────────────────────────────────────────
  {
    if (periodConv.length > 0) {
      const totalDebtConv     = periodConv.reduce((s, c) => s + (c.debtConverted ?? 0), 0);
      const totalSharesIssued = periodConv.reduce((s, c) => s + (c.sharesIssued  ?? 0), 0);
      const priced            = periodConv.filter(c => c.effectivePrice);
      const avgPx             = priced.length > 0 ? priced.reduce((s, c) => s + c.effectivePrice!, 0) / priced.length : undefined;
      const impliedPx         = totalDebtConv > 0 && totalSharesIssued > 0 ? totalDebtConv / totalSharesIssued : undefined;
      const px                = avgPx ?? impliedPx;

      const holderCounts = new Map<string, number>();
      for (const c of periodConv) {
        if (c.investorName) holderCounts.set(c.investorName, (holderCounts.get(c.investorName) ?? 0) + 1);
      }
      const primaryHolder = holderCounts.size > 0
        ? [...holderCounts.entries()].sort((a, b) => b[1] - a[1])[0][0]
        : undefined;

      const body: string[] = [];
      if (totalDebtConv > 0 && totalSharesIssued > 0) {
        const pxStr = px
          ? ` at an average effective conversion price of $${px < 0.001 ? px.toFixed(6) : px < 0.01 ? px.toFixed(5) : px.toFixed(4)}/share`
          : '';
        body.push(`During the reporting period, note holders converted ${fmt$(totalDebtConv)} in outstanding principal into ${fmtShares(totalSharesIssued)} of common stock${pxStr} across ${periodConv.length} conversion event${periodConv.length > 1 ? 's' : ''}.`);
      } else if (totalSharesIssued > 0) {
        body.push(`${fmtShares(totalSharesIssued)} of common stock were issued through ${periodConv.length} debt conversion event${periodConv.length > 1 ? 's' : ''} during the period.`);
      } else if (totalDebtConv > 0) {
        body.push(`${fmt$(totalDebtConv)} in principal was converted during the period across ${periodConv.length} transaction${periodConv.length > 1 ? 's' : ''}.`);
      }

      if (primaryHolder) {
        body.push(`${primaryHolder} is the primary converting holder${periodConv.length > 1 ? ' by transaction count' : ''}.`);
      }

      if (dilution.sharesOutstandingEnd && totalSharesIssued > 0) {
        const dilPct = (totalSharesIssued / dilution.sharesOutstandingEnd) * 100;
        if (dilPct > 0.1) {
          body.push(`These conversions represent approximately ${dilPct.toFixed(1)}% of current shares outstanding, illustrating the rate at which convertible debt is being translated into share count.`);
        }
      }

      memo.push(`7. DEBT CONVERSIONS\n\n${body.join(' ')}`);
    } else {
      memo.push(`7. DEBT CONVERSIONS\n\n${ABSENCE_ACTIVITY}`);
    }
  }

  // ── 8. Warrants ───────────────────────────────────────────────────────────
  {
    if (periodWarrants.length > 0) {
      const totalWarrantShares = periodWarrants.reduce((s, w) => s + (w.warrantShares ?? 0), 0);
      const paragraphs: string[] = [];

      if (periodWarrants.length === 1) {
        const w = periodWarrants[0];
        const parts: string[] = [];
        const noteLink = w.issuedWithNote ? ' issued in connection with a convertible note' : '';
        if (w.warrantShares) parts.push(`The Company has outstanding warrants to purchase ${fmtShares(w.warrantShares)} shares of common stock${noteLink}`);
        else                 parts.push(`The Company has outstanding warrants${noteLink}`);
        if (w.exercisePrice)  parts.push(` at an exercise price of $${w.exercisePrice}/share`);
        if (w.expirationDate) parts.push(`, expiring ${w.expirationDate}`);
        if (w.recipientName)  parts.push(`, held by ${w.recipientName}`);
        paragraphs.push(parts.join('') + '.');
      } else {
        const noteLinkedCount = periodWarrants.filter(w => w.issuedWithNote).length;
        const noteLinkedStr   = noteLinkedCount > 0
          ? ` Of these, ${noteLinkedCount} ${noteLinkedCount === 1 ? 'tranche is' : 'tranches are'} issued in connection with convertible notes, compounding the dilution profile.`
          : '';
        paragraphs.push(`The Company has ${periodWarrants.length} warrant tranches outstanding, representing ${fmtShares(totalWarrantShares)} in aggregate potential share issuance.${noteLinkedStr}`);
        for (const w of periodWarrants) {
          const parts: string[] = [];
          if (w.warrantShares)  parts.push(fmtShares(w.warrantShares));
          if (w.exercisePrice)  parts.push(`exercise price $${w.exercisePrice}`);
          if (w.expirationDate) parts.push(`expires ${w.expirationDate}`);
          if (w.issuedWithNote) parts.push('note-linked');
          if (w.recipientName)  parts.push(w.recipientName);
          const src = w._noteNumber ? ` [Note ${w._noteNumber}]` : '';
          paragraphs.push(`  • ${parts.join(', ')}${src}.`);
        }
      }

      memo.push(`8. WARRANTS\n\n${paragraphs.join('\n')}`);
    } else {
      memo.push(`8. WARRANTS\n\n${ABSENCE_NOTE}`);
    }
  }

  // ── 9. Related-Party Transactions ────────────────────────────────────────
  {
    if (relParty.length > 0) {
      const groups     = groupRelatedPartyByParty(relParty);
      const grandTotal = groups.reduce((s, g) => s + g.total, 0);

      const paragraphs: string[] = [];
      const introStr = grandTotal > 0
        ? `The Company disclosed related-party transactions totaling ${fmt$(grandTotal)} during the period. The following parties were involved:`
        : 'The Company disclosed related-party transactions during the period. The following parties were involved:';
      paragraphs.push(introStr);

      for (const g of groups) {
        const partyName  = g.party.length > 3 ? g.party : `a related party`;
        const txnParts: string[] = [];
        if (g.loans        > 0) txnParts.push(`${fmt$(g.loans)} in loans or advances`);
        if (g.compensation > 0) txnParts.push(`${fmt$(g.compensation)} in compensation`);
        if (g.lease        > 0) txnParts.push(`${fmt$(g.lease)} in lease or rental payments`);
        if (g.service      > 0) txnParts.push(`${fmt$(g.service)} in service or consulting fees`);
        if (g.other        > 0) txnParts.push(`${fmt$(g.other)} in other transactions`);

        if (txnParts.length === 0) {
          paragraphs.push(`${partyName} was identified as a related party; transaction amounts were not quantified.`);
        } else if (txnParts.length === 1) {
          paragraphs.push(`${partyName} had ${txnParts[0]} with the Company during the period.`);
        } else {
          const last = txnParts.pop()!;
          paragraphs.push(`${partyName} transacted ${txnParts.join(', ')} and ${last} with the Company, totaling ${fmt$(g.total)}.`);
        }
      }

      // Governance flag for insider-as-only-lender
      if (signals.hasRelatedPartyLoans && signals.relatedPartyIsOnlySource) {
        paragraphs.push('The concentration of debt financing through related parties suggests the Company has limited access to arm\'s-length capital. Investors should evaluate whether loan terms reflect market conditions.');
      }

      memo.push(`9. RELATED-PARTY TRANSACTIONS\n\n${paragraphs.join('\n\n')}`);
    } else {
      memo.push(`9. RELATED-PARTY TRANSACTIONS\n\n${ABSENCE_NOTE}`);
    }
  }

  // ── 10. Share Structure Changes ───────────────────────────────────────────
  {
    const { sharesOutstandingStart: start, sharesOutstandingEnd: end,
            sharesFromConversions: fromConv, sharesFromIssuances: fromIss } = dilution;
    const paragraphs: string[] = [];

    if (end) {
      if (start && start !== end) {
        const delta     = end - start;
        const pct       = ((delta / start) * 100).toFixed(0);
        const magnitude = Math.abs(Number(pct));
        const modifier  = magnitude >= 50 ? 'substantially ' : magnitude >= 20 ? 'materially ' : '';
        const dir       = delta > 0 ? 'increased' : 'decreased';
        paragraphs.push(`Common shares outstanding ${modifier}${dir} during the period from ${fmtShares(start)} to ${fmtShares(end)}, a ${delta > 0 ? '+' : ''}${pct}% change.`);
      } else if (start) {
        paragraphs.push(`Common shares outstanding were unchanged at ${fmtShares(end)} relative to the prior period open.`);
      } else {
        paragraphs.push(`Common shares outstanding at period end: ${fmtShares(end)}. A prior-period baseline was not identified, so period-over-period change cannot be computed.`);
      }
    } else {
      paragraphs.push('Period-end share count was not identified with sufficient confidence from this filing.');
    }

    const drivers: string[] = [];
    if (fromConv && fromConv > 0) drivers.push(`${fmtShares(fromConv)} from debt-to-equity conversions`);
    if (fromIss  && fromIss  > 0) drivers.push(`${fmtShares(fromIss)} from new equity issuances`);
    if (drivers.length > 0) paragraphs.push(`Period share count growth is attributable to: ${drivers.join('; ')}.`);

    memo.push(`10. SHARE STRUCTURE CHANGES\n\n${paragraphs.join(' ')}`);
  }

  // ── 11. Subsequent Events ─────────────────────────────────────────────────
  {
    const hasSubseq = subseqNotes.length + subseqConv.length + subseqWarrants.length + subseqFacilities.length > 0;
    if (hasSubseq) {
      const paragraphs: string[] = [
        'The following events were disclosed subsequent to the balance sheet date. These items are not reflected in the period financial statements but may be material to the forward-looking dilution profile:',
      ];

      for (const [i, n] of subseqNotes.entries()) paragraphs.push(noteToProse(n, i));

      for (const f of subseqFacilities) {
        const TYPE_LABEL: Record<string, string> = {
          eloc: 'equity line of credit (ELOC)', efa: 'equity financing agreement',
          equity_line: 'equity line of credit', variable_note: 'variable-rate note facility', other: 'equity facility',
        };
        const typeStr  = TYPE_LABEL[f.facilityType ?? 'other'];
        const sizeStr  = f.facilitySize ? ` of up to ${fmt$(f.facilitySize)}` : '';
        const partyStr = f.counterpartyName ? ` with ${f.counterpartyName}` : '';
        paragraphs.push(`The Company entered into a ${typeStr}${sizeStr}${partyStr} subsequent to period end.`);
      }

      if (subseqConv.length > 0) {
        const totalDebtSubseq   = subseqConv.reduce((s, c) => s + (c.debtConverted ?? 0), 0);
        const totalSharesSubseq = subseqConv.reduce((s, c) => s + (c.sharesIssued  ?? 0), 0);
        if (totalDebtSubseq > 0 && totalSharesSubseq > 0) {
          paragraphs.push(`Subsequent to period end, ${fmt$(totalDebtSubseq)} of outstanding principal was converted into ${fmtShares(totalSharesSubseq)} of common stock — dilution continues post-close.`);
        } else if (totalSharesSubseq > 0) {
          paragraphs.push(`Subsequent to period end, ${fmtShares(totalSharesSubseq)} were issued through note conversions.`);
        }
      }

      for (const w of subseqWarrants) {
        const parts: string[] = [];
        if (w.warrantShares)  parts.push(`${fmtShares(w.warrantShares)} warrants`);
        if (w.exercisePrice)  parts.push(`exercise price $${w.exercisePrice}`);
        if (w.expirationDate) parts.push(`expiring ${w.expirationDate}`);
        paragraphs.push(`Subsequent to period end, the Company issued warrants: ${parts.join(', ')}.`);
      }

      memo.push(`11. SUBSEQUENT EVENTS\n\n${paragraphs.join('\n\n')}`);
    } else {
      memo.push(`11. SUBSEQUENT EVENTS\n\n${ABSENCE_NOTE}`);
    }
  }

  // ── 12. Potential Dilution Analysis ──────────────────────────────────────
  {
    const sharesNow  = dilution.sharesOutstandingEnd;
    const tableRows: string[] = [];
    const narrative:  string[] = [];

    // Build bottom-up dilution table
    type DilRow = { label: string; shares: number | undefined; note: string };
    const rows: DilRow[] = [];

    // Row: existing shares
    if (sharesNow) {
      rows.push({ label: 'Shares outstanding (current)', shares: sharesNow, note: '' });
    }

    // Rows: convertible notes (no floor = uncapped)
    const noFloorNotes = periodNotes.filter(n => n.discountRate && !n.hasFloorPrice);
    const flooredNotes = periodNotes.filter(n => n.discountRate && n.hasFloorPrice && n.floorPrice != null);
    const fixedNotes   = periodNotes.filter(n => !n.discountRate && (n.principalAmount || n.outstandingBalance));

    if (noFloorNotes.length > 0) {
      const totalNoFloor = noFloorNotes.reduce((s, n) => s + (n.outstandingBalance ?? n.principalAmount ?? 0), 0);
      rows.push({ label: `Variable notes (no floor) — ${fmt$(totalNoFloor)} principal`, shares: undefined, note: 'UNCAPPED — share count grows as price declines' });
      narrative.push(`The most significant dilution risk is ${fmt$(totalNoFloor)} in variable-rate convertible debt with no floor price. The number of shares required to retire this obligation is uncapped and increases as the market price falls — a dynamic that can accelerate into a death spiral if holders convert aggressively.`);
    }

    for (const n of flooredNotes) {
      const bal = n.outstandingBalance ?? n.principalAmount;
      if (bal && n.floorPrice != null) {
        const potentialShares = Math.round(bal / n.floorPrice);
        const pctStr = sharesNow ? ` / ${((potentialShares / sharesNow) * 100).toFixed(1)}% of current SO` : '';
        rows.push({ label: `Floored note — ${fmt$(bal)} @ floor $${n.floorPrice}${n.investorName ? ` (${n.investorName})` : ''}`, shares: potentialShares, note: pctStr });
      }
    }

    for (const n of fixedNotes) {
      const bal = n.outstandingBalance ?? n.principalAmount;
      if (bal) {
        rows.push({ label: `Fixed-rate note — ${fmt$(bal)}${n.investorName ? ` (${n.investorName})` : ''}`, shares: undefined, note: 'No conversion terms identified' });
      }
    }

    // Row: warrants
    const totalWarrantShares = periodWarrants.reduce((s, w) => s + (w.warrantShares ?? 0), 0);
    if (totalWarrantShares > 0) {
      const pctStr = sharesNow ? ` / ${((totalWarrantShares / (sharesNow + totalWarrantShares)) * 100).toFixed(1)}% fully diluted` : '';
      rows.push({ label: `Outstanding warrants`, shares: totalWarrantShares, note: pctStr });
    }

    // Row: equity facilities (undrawn capacity)
    const totalUndrawn = periodFacilities.reduce((s, f) => {
      if (!f.facilitySize) return s;
      return s + (f.facilitySize - (f.drawnAmount ?? 0));
    }, 0);
    if (totalUndrawn > 0) {
      rows.push({ label: `Equity facility (undrawn)`, shares: undefined, note: `${fmt$(totalUndrawn)} available at market discount — shares at prevailing price` });
      narrative.push(`Up to ${fmt$(totalUndrawn)} remains available under committed equity facilities. Draws are priced at a discount to market, meaning each draw generates incremental dilution at no fixed conversion price.`);
    }

    // Row: disclosed dilutive shares
    if (dilution.potentialDilutiveShares) {
      rows.push({ label: 'Filing-disclosed dilutive shares', shares: dilution.potentialDilutiveShares, note: '' });
    }

    // Format table
    if (rows.length > 0) {
      const colW = 52;
      tableRows.push('Source'.padEnd(colW) + 'Potential Shares' + '  Notes');
      tableRows.push('─'.repeat(colW) + '─'.repeat(18) + '──' + '─'.repeat(30));
      for (const r of rows) {
        const sharesStr = r.shares != null ? fmtShares(r.shares).padStart(16) : '(uncapped)'.padStart(16);
        tableRows.push(r.label.slice(0, colW - 2).padEnd(colW) + sharesStr + '  ' + r.note);
      }
    }

    if (dilution.hasDilutionWarning) {
      narrative.push('The filing contains explicit dilution risk disclosure language.');
    }

    if (tableRows.length === 0 && narrative.length === 0) {
      memo.push(`12. POTENTIAL DILUTION ANALYSIS\n\nInsufficient data to quantify potential dilution from this filing.`);
    } else {
      const parts: string[] = [];
      if (tableRows.length > 0) parts.push(tableRows.join('\n'));
      if (narrative.length > 0) parts.push(narrative.join(' '));
      memo.push(`12. POTENTIAL DILUTION ANALYSIS\n\n${parts.join('\n\n')}`);
    }
  }

  // ── 13. Analyst Conclusion ────────────────────────────────────────────────
  {
    const RISK_LABEL_LONG: Record<DilutionRisk, string> = {
      severe: 'severe', high: 'high', moderate: 'moderate', low: 'low',
    };
    const paragraphs: string[] = [];

    // Primary risk assessment
    if (signals.toxicNoteCount > 0) {
      const count = signals.toxicNoteCount === 1 ? 'a convertible note' : `${signals.toxicNoteCount} convertible notes`;
      const activeStr = signals.hasActiveConversions
        ? 'Active conversions during the period confirm that dilution is occurring in real time and that holders are exercising their conversion rights.'
        : 'Conversion has not yet been observed in the current period, but the structural conditions for severe dilution are in place.';
      paragraphs.push(
        `Based on the disclosures in this filing, the Company presents ${RISK_LABEL_LONG[risk]} dilution risk — ` +
        `the highest category of concern. The Company carries ${count} structured with variable conversion discounts, ` +
        `no floor price, and anti-dilution reset provisions. This combination allows the holder to convert at progressively ` +
        `lower prices as the stock declines, creating a self-reinforcing dilution cycle that can lead to near-total shareholder displacement. ` +
        activeStr,
      );
    } else if (signals.variableNoteCount > 0) {
      const n   = signals.variableNoteCount;
      const str = n === 1 ? 'an outstanding variable-rate note' : `${n} outstanding variable-rate notes`;
      paragraphs.push(
        `Based on the disclosures in this filing, the Company presents ${RISK_LABEL_LONG[risk]} dilution risk. ` +
        `Open-ended conversion terms with no floor price on ${str} create dilution exposure that cannot be ` +
        `precisely quantified and worsens as the share price declines. While less structurally severe than a reset-provision note, ` +
        `variable-rate debt without a floor remains a meaningful risk factor for retail holders.`,
      );
    } else if (signals.totalConvertibleDebt > 0) {
      const floorQual = signals.flooredNoteCount > 0
        ? ` Floor prices on conversion terms limit (but do not eliminate) the downside dilution scenario.`
        : '';
      paragraphs.push(
        `Based on the disclosures in this filing, the Company presents ${RISK_LABEL_LONG[risk]} dilution risk. ` +
        `Convertible debt is present; the conversion structure determines the severity of the dilution path.${floorQual}`,
      );
    } else if (signals.hasEquityFacility) {
      paragraphs.push(
        `Based on the disclosures in this filing, the Company presents ${RISK_LABEL_LONG[risk]} dilution risk. ` +
        `An equity facility provides management with ongoing capacity to issue shares at a discount to market without ` +
        `requiring new financing agreements, representing a persistent source of dilution risk.`,
      );
    } else {
      paragraphs.push(
        `Based on available disclosures, the Company presents ${RISK_LABEL_LONG[risk]} dilution risk. ` +
        `Structured dilutive financing was not identified with high confidence in this filing; ` +
        `this assessment may be revised if additional filings are analyzed.`,
      );
    }

    // Share count severity
    if (signals.sharesAbove10B) {
      paragraphs.push(
        'Share count exceeds 10 billion — the most severely diluted tier among OTC issuers. ' +
        'At this level the authorized share ceiling constrains further issuance, meaning the Company will require ' +
        'a shareholder vote to increase authorized shares before additional dilutive financing can proceed. ' +
        'Authorized-share increases at this scale are generally accomplished via reverse split or written consent.',
      );
    } else if (signals.sharesAbove1B) {
      paragraphs.push(
        'Share count already exceeds one billion, reflecting sustained prior dilution. ' +
        'This level is often associated with a history of convertible note financing and suggests the Company ' +
        'has repeatedly relied on dilutive instruments to fund operations.',
      );
    }

    // Related-party governance note
    if (signals.hasRelatedPartyLoans && signals.relatedPartyIsOnlySource) {
      paragraphs.push(
        'Related-party loans appear to be the primary debt financing source, indicating limited access to ' +
        'arm\'s-length institutional capital. Investors should scrutinize whether insider loan terms are comparable ' +
        'to market rates and whether repayment obligations could trigger additional equity issuance.',
      );
    }

    memo.push(`13. ANALYST CONCLUSION  [${RISK_LABEL[risk]} DILUTION RISK]\n\n${paragraphs.join('\n\n')}`);
  }

  return memo.join(divider);
}

// ─── Confidence scorer ────────────────────────────────────────────────────────

function scoreConfidence(
  notes:       ConvertibleNote[],
  issuances:   EquityIssuance[],
  conversions: ConversionRecord[],
  warrants:    WarrantRecord[],
  facilities:  EquityFacility[],
  dilution:    DilutionSummary,
): ExtractionConfidence {
  let score = 0;
  for (const n of notes) {
    if (n.principalAmount) score += 2;
    if (n.discountRate)    score += 2;
    if (n.interestRate)    score += 1;
    if (n.maturityDate)    score += 1;
    if (n.investorName)    score += 1;
  }
  score += issuances .filter(e => e.sharesIssued  || e.grossProceeds).length * 2;
  score += conversions.filter(c => c.debtConverted || c.sharesIssued).length * 2;
  score += warrants   .filter(w => w.warrantShares).length;
  score += facilities .filter(f => f.facilitySize).length * 2;
  if (dilution.sharesOutstandingEnd) score += 1;
  if (dilution.hasDilutionWarning)   score += 1;

  if (score >= 8) return 'high';
  if (score >= 3) return 'medium';
  return 'low';
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse a 10-K or 10-Q filing text into a structured FinancingReport.
 *
 * Never throws — all errors collected in warnings[].
 */
// ─── Table layer → output record converters ────────────────────────────────
// Each function maps the subset of TableInstrument[] that is relevant to its
// output type.  Table-derived records are prepended to the sentence-derived
// arrays before consolidation so that table values win via mergeNote(a, b)
// (which uses ?? — keeps `a` when both `a` and `b` are present).

function tableInstsToNotes(insts: TableInstrument[]): ConvertibleNote[] {
  const QUALIFYING: TableInstrument['tableClass'][] = [
    'convertible_note_schedule', 'debt_rollforward', 'subsequent_events',
  ];
  const notes: ConvertibleNote[] = [];
  for (const inst of insts) {
    if (!QUALIFYING.includes(inst.tableClass)) continue;
    const f = inst.fields;
    // For rollforward tables the ending balance IS the current outstanding balance
    const principal   = f.principalAmount?.value ?? f.beginningBalance?.value;
    const outstanding = f.outstandingBalance?.value ?? f.endingBalance?.value;
    if (!principal && !outstanding) continue;
    if ((principal ?? outstanding ?? 0) < FLOOR_PRINCIPAL) continue;

    const note: ConvertibleNote = {
      hasFloorPrice:        f.floorPrice?.value != null,
      hasResetProvisions:   false,
      _section:             inst.tableClass,
      _noteNumber:          inst.noteNumber,
      _sourceSentences:     [],
      _fieldConfidence:     {},
    };
    if (principal)          note.principalAmount        = principal;
    if (outstanding && outstanding !== principal)
                            note.outstandingBalance      = outstanding;
    if (f.interestRate)     note.interestRate            = f.interestRate.value;
    if (f.discountRate)     note.discountRate            = f.discountRate.value;
    if (f.fixedConversionPrice) note.fixedConversionPrice = f.fixedConversionPrice.value;
    if (f.floorPrice)       note.floorPrice              = f.floorPrice.value;
    if (f.maturityDate)     note.maturityDate            = f.maturityDate.value;
    if (f.executionDate)    note.executionDate           = f.executionDate.value;
    if (f.investorName)     note.investorName            = f.investorName.value;
    notes.push(note);
  }
  return notes;
}

function tableInstsToConversions(insts: TableInstrument[]): ConversionRecord[] {
  const records: ConversionRecord[] = [];
  for (const inst of insts) {
    const f = inst.fields;
    // Rollforward rows carry conversionsAmount; equity issuance rows carry sharesIssued + debtConverted
    const debtAmt  = f.conversionsAmount?.value ?? f.debtConverted?.value;
    const shares   = f.sharesIssued?.value;
    if (!debtAmt && !shares) continue;
    if ((debtAmt ?? 0) < 1_000 && (shares ?? 0) < 1_000) continue;

    const rec: ConversionRecord = {
      _section:    inst.tableClass,
      _noteNumber: inst.noteNumber,
    };
    if (debtAmt)  rec.debtConverted  = debtAmt;
    if (shares)   rec.sharesIssued   = shares;
    if (f.effectivePrice) rec.effectivePrice = f.effectivePrice.value;
    if (f.investorName)   rec.investorName   = f.investorName.value;
    records.push(rec);
  }
  return records;
}

function tableInstsToWarrants(insts: TableInstrument[]): WarrantRecord[] {
  const records: WarrantRecord[] = [];
  for (const inst of insts) {
    if (inst.tableClass !== 'warrant_table') continue;
    const f = inst.fields;
    if (!f.warrantShares && !f.exercisePrice) continue;

    const rec: WarrantRecord = {
      _section:    inst.tableClass,
      _noteNumber: inst.noteNumber,
    };
    if (f.warrantShares)  rec.warrantShares  = f.warrantShares.value;
    if (f.exercisePrice)  rec.exercisePrice  = f.exercisePrice.value;
    if (f.expirationDate) rec.expirationDate = f.expirationDate.value;
    if (f.investorName)   rec.recipientName  = f.investorName.value;
    records.push(rec);
  }
  return records;
}

function tableInstsToIssuances(insts: TableInstrument[]): EquityIssuance[] {
  const QUALIFYING: TableInstrument['tableClass'][] = ['equity_issuance', 'preferred_stock', 'share_activity'];
  const records: EquityIssuance[] = [];
  for (const inst of insts) {
    if (!QUALIFYING.includes(inst.tableClass)) continue;
    const f = inst.fields;
    if (!f.sharesIssued && !f.grossProceeds) continue;
    if ((f.sharesIssued?.value ?? 0) < 10_000 && (f.grossProceeds?.value ?? 0) < 1_000) continue;

    const rec: EquityIssuance = {
      _section:    inst.tableClass,
      _noteNumber: inst.noteNumber,
      issuanceType: inst.tableClass === 'preferred_stock' ? 'preferred' : 'common',
    };
    if (f.sharesIssued)  rec.sharesIssued  = f.sharesIssued.value;
    if (f.grossProceeds) rec.grossProceeds = f.grossProceeds.value;
    if (f.pricePerShare) rec.pricePerShare = f.pricePerShare.value;
    if (f.investorName)  rec.investorName  = f.investorName.value;
    if (f.executionDate) rec.issuanceDate  = f.executionDate.value;
    records.push(rec);
  }
  return records;
}

function tableInstsToRelatedParty(insts: TableInstrument[]): RelatedPartyTransaction[] {
  const records: RelatedPartyTransaction[] = [];
  for (const inst of insts) {
    if (inst.tableClass !== 'related_party_debt') continue;
    const f = inst.fields;

    // Use the most specific field available; confidence tracks which column was the source.
    // endingBalance: from an explicit "Ending Balance" column → highest confidence
    // outstandingBalance: from an "Outstanding" column → high confidence
    // principalAmount/transactionAmount: from generic amount column → basis unknown
    let amt: number | undefined;
    let basis: RelatedPartyTransaction['basis'];
    let confidence: number;

    if (f.endingBalance) {
      amt = f.endingBalance.value;
      basis = 'ending_balance';
      confidence = 0.92;
    } else if (f.outstandingBalance) {
      amt = f.outstandingBalance.value;
      basis = 'ending_balance';
      confidence = 0.88;
    } else {
      amt = f.principalAmount?.value ?? f.transactionAmount?.value;
      basis = 'unknown';
      confidence = 0.70;
    }

    if (!amt || amt < 1_000) continue;

    const rec: RelatedPartyTransaction = {
      _section:        inst.tableClass,
      _noteNumber:     inst.noteNumber,
      transactionType: 'loan',
      basis,
      confidence,
      amount:          amt,
    };
    if (f.partyDescription) rec.partyDescription = f.partyDescription.value;
    else if (f.investorName) rec.partyDescription = f.investorName.value;
    records.push(rec);
  }
  return records;
}

export function parseFinancingReport(text: string): FinancingReport {
  const warnings: string[] = [];

  // ── Pass 0: HTML table extraction (runs on raw HTML, before cleanText) ──────
  let tableInstruments: TableInstrument[] = [];
  try {
    const tableResult = buildTableLayer(text);
    tableInstruments  = tableResult.instruments;
    warnings.push(...tableResult.warnings);
  } catch (e) { warnings.push(`Table layer: ${e instanceof Error ? e.message : String(e)}`); }

  const clean    = cleanText(text);
  const sections = detectSections(clean);

  let convertibleDebt:          ConvertibleNote[]         = [];
  let equityIssuances:          EquityIssuance[]          = [];
  let conversions:              ConversionRecord[]        = [];
  let warrants:                 WarrantRecord[]           = [];
  let relatedPartyTransactions: RelatedPartyTransaction[] = [];
  let equityFacilities:         EquityFacility[]          = [];
  let dilutionSummary:          DilutionSummary;

  // ── Pass 1: per-section extraction ─────────────────────────────────────────

  try {
    for (const s of sections.filter(s => s.key === 'convertible_debt')) {
      convertibleDebt.push(...extractConvertibleNotes(s.text, s.key, s.noteNumber));
      convertibleDebt.push(...extractConvertibleNotesFromTable(s.text, s.key, s.noteNumber));
    }
  } catch (e) { warnings.push(`Convertible debt extractor: ${e instanceof Error ? e.message : String(e)}`); }

  try {
    for (const s of sections.filter(s => s.key === 'equity_issuances')) {
      equityIssuances.push(...extractEquityIssuances(s.text, s.key, s.noteNumber));
    }
  } catch (e) { warnings.push(`Equity issuances extractor: ${e instanceof Error ? e.message : String(e)}`); }

  try {
    for (const s of sections.filter(s => s.key === 'convertible_debt')) {
      conversions.push(...extractConversions(s.text, s.key, s.noteNumber));
    }
  } catch (e) { warnings.push(`Conversions extractor: ${e instanceof Error ? e.message : String(e)}`); }

  try {
    for (const s of sections.filter(s => s.key === 'warrants')) {
      warrants.push(...extractWarrants(s.text, s.key, s.noteNumber));
    }
    // Warrants commonly co-disclosed in debt note
    for (const s of sections.filter(s => s.key === 'convertible_debt')) {
      warrants.push(...extractWarrants(s.text, s.key, s.noteNumber));
    }
  } catch (e) { warnings.push(`Warrants extractor: ${e instanceof Error ? e.message : String(e)}`); }

  try {
    for (const s of sections.filter(s => s.key === 'related_party')) {
      relatedPartyTransactions.push(...extractRelatedPartyTransactions(s.text, s.key, s.noteNumber));
    }
  } catch (e) { warnings.push(`Related party extractor: ${e instanceof Error ? e.message : String(e)}`); }

  try {
    const facilitySections: SectionKey[] = ['equity_facilities', 'convertible_debt', 'equity_issuances'];
    for (const s of sections.filter(s => facilitySections.includes(s.key))) {
      equityFacilities.push(...extractEquityFacilities(s.text, s.key, s.noteNumber));
    }
  } catch (e) { warnings.push(`Equity facilities extractor: ${e instanceof Error ? e.message : String(e)}`); }

  try {
    dilutionSummary = extractDilutionSummary(getSectionText(sections, 'dilution'));
  } catch (e) {
    warnings.push(`Dilution extractor: ${e instanceof Error ? e.message : String(e)}`);
    dilutionSummary = { dilutionPhrases: [], hasDilutionWarning: false };
  }

  // ── Pass 2: subsequent events ───────────────────────────────────────────────

  try {
    const subText = getSectionText(sections, 'subsequent_events');
    if (subText) {
      const subN = getSectionNoteNumber(sections, 'subsequent_events');
      convertibleDebt.push(...extractConvertibleNotes(subText, 'subsequent_events', subN));
      conversions     .push(...extractConversions(subText, 'subsequent_events', subN));
      warrants        .push(...extractWarrants(subText, 'subsequent_events', subN));
      equityFacilities.push(...extractEquityFacilities(subText, 'subsequent_events', subN));
    }
  } catch (e) { warnings.push(`Subsequent events scan: ${e instanceof Error ? e.message : String(e)}`); }

  // ── Pass 3: MD&A — cross-reference enrichment ──────────────────────────────
  // Run note extraction on MD&A to capture any note descriptions there that
  // might supply investor names or terms missing from the notes section.
  // These records are merged in the consolidation pass so duplicate instruments
  // collapse into a single enriched record.

  try {
    const mdaText = getSectionText(sections, 'mda');
    if (mdaText) {
      convertibleDebt .push(...extractConvertibleNotes(mdaText, 'mda'));
      conversions     .push(...extractConversions(mdaText, 'mda'));
      equityFacilities.push(...extractEquityFacilities(mdaText, 'mda'));
      if (!dilutionSummary.sharesOutstandingEnd) {
        const mdaDil = extractDilutionSummary(mdaText);
        if (mdaDil.sharesOutstandingEnd) dilutionSummary.sharesOutstandingEnd = mdaDil.sharesOutstandingEnd;
        if (mdaDil.sharesOutstandingStart) dilutionSummary.sharesOutstandingStart = mdaDil.sharesOutstandingStart;
      }
    }
  } catch (e) { warnings.push(`MD&A scan: ${e instanceof Error ? e.message : String(e)}`); }

  // ── Pass 4: global fallback — only when per-section found nothing ───────────

  const perSectionTotal = convertibleDebt.length + equityIssuances.length + conversions.length
    + warrants.length + relatedPartyTransactions.length + equityFacilities.length;

  if (perSectionTotal === 0) {
    try {
      convertibleDebt          .push(...extractConvertibleNotes(clean, 'global'));
      convertibleDebt          .push(...extractConvertibleNotesFromTable(clean, 'global'));
      equityIssuances          .push(...extractEquityIssuances(clean, 'global'));
      conversions              .push(...extractConversions(clean, 'global'));
      warrants                 .push(...extractWarrants(clean, 'global'));
      relatedPartyTransactions .push(...extractRelatedPartyTransactions(clean, 'global'));
      equityFacilities         .push(...extractEquityFacilities(clean, 'global'));
    } catch (e) { warnings.push(`Global fallback: ${e instanceof Error ? e.message : String(e)}`); }
  } else {
    // Even with section data, do a targeted conversion scan over the full doc
    try {
      conversions.push(...extractConversions(clean, 'global'));
    } catch (e) { /* non-fatal */ }
  }

  // Dilution fallback — cover page + first 80KB
  if (!dilutionSummary.sharesOutstandingEnd) {
    try {
      const fallback = extractDilutionSummary(clean.slice(0, 80_000));
      if (fallback.sharesOutstandingEnd) {
        dilutionSummary.sharesOutstandingEnd   = fallback.sharesOutstandingEnd;
        dilutionSummary.sharesOutstandingStart = fallback.sharesOutstandingStart;
      }
    } catch (e) { warnings.push(`Dilution fallback: ${e instanceof Error ? e.message : String(e)}`); }
  }

  // ── Prepend table-derived records (table values win via ?? in mergeNote) ────
  convertibleDebt          = [...tableInstsToNotes(tableInstruments),          ...convertibleDebt];
  conversions              = [...tableInstsToConversions(tableInstruments),     ...conversions];
  warrants                 = [...tableInstsToWarrants(tableInstruments),        ...warrants];
  equityIssuances          = [...tableInstsToIssuances(tableInstruments),       ...equityIssuances];
  relatedPartyTransactions = [...tableInstsToRelatedParty(tableInstruments),    ...relatedPartyTransactions];

  // ── Consolidate ────────────────────────────────────────────────────────────
  convertibleDebt  = consolidateNotes(convertibleDebt);
  conversions      = consolidateConversions(conversions);
  warrants         = consolidateWarrants(warrants);
  equityIssuances  = consolidateIssuances(equityIssuances);
  equityFacilities = consolidateFacilities(equityFacilities);

  // ── Pass 5: Note enrichment ─────────────────────────────────────────────────
  // Search section texts for fields that the primary pass couldn't find
  // (typically because they appeared outside the instrument's sentence window).
  try {
    enrichConvertibleNotes(convertibleDebt, sections);
  } catch (e) {
    warnings.push(`Note enrichment: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── Per-note validation ─────────────────────────────────────────────────────
  for (const note of convertibleDebt) {
    note._validationWarnings = validateConvertibleNote(note);
    for (const w of note._validationWarnings) {
      warnings.push(`VALIDATION[CN]: ${w}`);
    }
  }

  const convShares = conversions.reduce((s, c) => s + (c.sharesIssued ?? 0), 0);
  if (convShares > 0) dilutionSummary.sharesFromConversions = convShares;
  const issShares = equityIssuances.reduce((s, e) => s + (e.sharesIssued ?? 0), 0);
  if (issShares > 0) dilutionSummary.sharesFromIssuances = issShares;

  const totalRecords = convertibleDebt.length + equityIssuances.length + conversions.length
    + warrants.length + relatedPartyTransactions.length + equityFacilities.length;

  if (totalRecords === 0) {
    warnings.push('No structured financing records extracted — filing may not contain relevant disclosures or the format is unrecognized.');
  }

  // ── Cross-check validation ──────────────────────────────────────────────────
  // Post-extraction sanity checks. Each warning is prefixed with VALIDATION:
  // so downstream consumers can separate extraction warnings from validation flags.

  // Conversion language in filing but zero conversions extracted
  if (conversions.length === 0 &&
    /(?:conver(?:t(?:ed|ible|ing)|sion))\s+(?:of|into|to)\s+(?:common\s+)?(?:stock|shares?)/i.test(clean)) {
    warnings.push(
      'VALIDATION: Conversion language detected in filing but no conversion records were extracted. ' +
      'Manual review is recommended to confirm whether active conversions occurred.',
    );
  }

  // Dilution warning language present but no dilutive instruments found
  if (dilutionSummary.hasDilutionWarning && convertibleDebt.length === 0 && equityFacilities.length === 0) {
    warnings.push(
      'VALIDATION: Filing contains dilution risk language but no convertible instruments or equity facilities were extracted. ' +
      'Dilutive instruments may be present in sections that could not be parsed.',
    );
  }

  // Material share count increase unexplained by extracted records
  if (dilutionSummary.sharesOutstandingStart && dilutionSummary.sharesOutstandingEnd) {
    const delta         = dilutionSummary.sharesOutstandingEnd - dilutionSummary.sharesOutstandingStart;
    const pct           = delta / dilutionSummary.sharesOutstandingStart;
    const explainedShares = (dilutionSummary.sharesFromConversions ?? 0) + (dilutionSummary.sharesFromIssuances ?? 0);
    if (delta > 0 && pct > 0.05 && explainedShares < delta * 0.5) {
      const unexplainedPct = explainedShares > 0 ? Math.round((explainedShares / delta) * 100) : 0;
      warnings.push(
        `VALIDATION: Shares outstanding increased by ${(pct * 100).toFixed(0)}% during the period, but extracted ` +
        `issuance/conversion records account for only ~${unexplainedPct}% of the increase. ` +
        `Additional share issuances, stock dividends, or conversions may be unextracted.`,
      );
    }
  }

  // Convertible notes without an identifiable investor
  const notesLackingInvestor = convertibleDebt.filter(n => !n.investorName && (n.principalAmount ?? 0) >= 25_000);
  if (notesLackingInvestor.length > 0) {
    warnings.push(
      `VALIDATION: ${notesLackingInvestor.length} convertible note(s) identified without an extractable investor/lender name. ` +
      `The filing should be reviewed directly to identify counterparties.`,
    );
  }

  // Equity facilities without a counterparty
  const facilitiesLackingCounterparty = equityFacilities.filter(f => !f.counterpartyName);
  if (facilitiesLackingCounterparty.length > 0) {
    warnings.push(
      `VALIDATION: ${facilitiesLackingCounterparty.length} equity facilit${facilitiesLackingCounterparty.length === 1 ? 'y' : 'ies'} ` +
      `identified without an extractable counterparty name. Investor identity should be verified in the filing.`,
    );
  }

  // ── Financial statements ────────────────────────────────────────────────────
  let financialStatements: ReturnType<typeof parseFinancialStatements> | undefined;
  try {
    financialStatements = parseFinancialStatements(clean);
    if (financialStatements.confidence === 'low') {
      warnings.push('Financial statement extraction confidence: LOW — income statement, balance sheet, or cash flow data may be incomplete.');
    }
  } catch (e) {
    warnings.push(`Financial statements parser: ${e instanceof Error ? e.message : String(e)}`);
  }

  const reportText = totalRecords === 0 && !dilutionSummary.hasDilutionWarning
    ? 'No financing activity detected in this filing.'
    : generateAnalystReport(
        convertibleDebt, equityIssuances, conversions, warrants,
        relatedPartyTransactions, equityFacilities, dilutionSummary,
        financialStatements,
      );

  return {
    convertibleDebt,
    equityIssuances,
    conversions,
    warrants,
    relatedPartyTransactions,
    equityFacilities,
    dilutionSummary,
    financialStatements,
    reportText,
    extractedAt: new Date().toISOString(),
    confidence:  scoreConfidence(convertibleDebt, equityIssuances, conversions, warrants, equityFacilities, dilutionSummary),
    warnings,
  };
}
