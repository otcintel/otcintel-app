/**
 * noteEnrichment.ts
 *
 * Second-pass enrichment for ConvertibleNote objects.
 *
 * After the primary extraction pass (table + sentence layer + consolidation),
 * notes sourced from balance-sheet tables often identify the instrument but lack
 * conversion terms, interest rate, maturity date, etc. — because those appear
 * elsewhere in the same filing section.
 *
 * This pass searches specifically within:
 *   - the note's own section (convertible_debt, subsequent_events, …)
 *   - MD&A / Liquidity
 *
 * Anchor matching (principalAmount ± 5%, investorName, maturity date, execution
 * date) restricts the search to paragraphs actually describing this note.
 *
 * Rules:
 *   - Never overwrites a field already at confidence ≥ ENRICHMENT_CONF_CAP.
 *   - All enrichment-derived values are capped at ENRICHMENT_CONF_CAP (0.72).
 *   - Provenance is recorded: _fieldConfidence entry updated, section appended
 *     to _sourceSentenceTexts as "[enriched from <section>]".
 */

import type { ConvertibleNote, RejectedCandidate } from '../types';
import {
  buildInstrumentLayer,
  type Instrument,
  type ExtractedField,
} from './sentenceLayer';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Enrichment results are capped here to avoid overriding high-quality extractions. */
const ENRICHMENT_CONF_CAP = 0.72;

/** Minimum confidence to accept from enrichment (filter noise). */
const ENRICHMENT_CONF_MIN = 0.75; // instrument-layer minimum; we cap at 0.72 on write

/** Sections searched for enrichment, in priority order. */
const ENRICHMENT_SECTION_KEYS = [
  'convertible_debt',
  'subsequent_events',
  'mda',
  'related_party',
] as const;

/**
 * Monetary fields checked against the note's anchor principal during enrichment.
 * Mirrors the set in financingReport.ts — kept local to avoid circular imports.
 */
const ENRICH_MONETARY_FIELDS = new Set<string>([
  'purchasePrice', 'outstandingBalance', 'amountConverted', 'amountRepaid', 'netProceeds',
]);

const ENRICH_CONTAMINATION_RATIO = 20;

function enrichSentenceAmounts(text: string): number[] {
  const amounts: number[] = [];
  for (const m of text.matchAll(/\$\s*([\d,\.]+(?:\s*(?:billion|B|million|M))?)/gi)) {
    const s = m[1].replace(/,/g, '').trim();
    const mM = s.match(/^([\d.]+)\s*(?:million|M)\b/i);
    if (mM) { const n = parseFloat(mM[1]); if (Number.isFinite(n)) { amounts.push(Math.round(n * 1_000_000)); continue; } }
    const mB = s.match(/^([\d.]+)\s*(?:billion|B)\b/i);
    if (mB) { const n = parseFloat(mB[1]); if (Number.isFinite(n)) { amounts.push(Math.round(n * 1_000_000_000)); continue; } }
    const n = parseFloat(s.replace(/^\$/, '').replace(/[^0-9.]/g, ''));
    if (Number.isFinite(n) && n > 0) amounts.push(Math.round(n));
  }
  return amounts;
}

function enrichContaminationReason(
  field:           string,
  sourceText:      string,
  anchorPrincipal: number,
): string | null {
  if (!ENRICH_MONETARY_FIELDS.has(field)) return null;
  for (const amt of enrichSentenceAmounts(sourceText)) {
    if (amt > anchorPrincipal * ENRICH_CONTAMINATION_RATIO) {
      const fmt = (n: number) => n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `$${Math.round(n / 1_000)}K` : `$${n}`;
      return `[enrichment] source amount ${fmt(amt)} is ${Math.round(amt / anchorPrincipal)}× note principal ${fmt(anchorPrincipal)}`;
    }
  }
  return null;
}

/** Critical fields — enrichment is only run when at least one is missing. */
const CRITICAL_FIELDS: (keyof ConvertibleNote)[] = [
  'interestRate', 'maturityDate', 'discountRate', 'fixedConversionPrice',
  'beneficialOwnershipBlocker', 'floorPrice',
];

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EnrichmentSection {
  key: string;
  text: string;
  noteNumber?: number;
}

// ── Anchor matching ───────────────────────────────────────────────────────────

/** Returns true if the paragraph plausibly describes this specific note. */
function paragraphMatchesNote(para: string, note: ConvertibleNote): boolean {
  const lower = para.toLowerCase();
  let hits = 0;

  // Principal amount ± 5%
  if (note.principalAmount != null) {
    const lo = note.principalAmount * 0.95;
    const hi = note.principalAmount * 1.05;
    const nums = [...para.matchAll(/\$\s*([\d,]+(?:\.\d+)?)/g)]
      .map(m => parseFloat(m[1].replace(/,/g, '')));
    if (nums.some(n => n >= lo && n <= hi)) hits++;
  }

  // Investor name (first distinctive word, min 4 chars)
  if (note.investorName) {
    const keyword = note.investorName.split(/\s+/).find(w => w.length >= 4)?.toLowerCase();
    if (keyword && lower.includes(keyword)) hits++;
  }

  // Maturity date substring
  if (note.maturityDate) {
    const mat = note.maturityDate.toLowerCase();
    if (lower.includes(mat) || lower.includes(mat.slice(0, 10))) hits++;
  }

  // Execution date substring
  if (note.executionDate) {
    const exec = note.executionDate.toLowerCase();
    if (lower.includes(exec)) hits++;
  }

  // Require at least 1 anchor hit (2 if we have multiple anchors available)
  const anchorCount = [
    note.principalAmount != null,
    !!note.investorName,
    !!note.maturityDate,
    !!note.executionDate,
  ].filter(Boolean).length;

  return anchorCount >= 2 ? hits >= 2 : hits >= 1;
}

// ── Field application ─────────────────────────────────────────────────────────

/**
 * Tries to fill a single field from an enrichment instrument.
 * Respects the confidence cap and never overwrites higher-confidence values.
 */
function tryFill<T>(
  note:      ConvertibleNote,
  field:     string,
  extracted: ExtractedField<T> | undefined,
  assign:    (v: T) => void,
): void {
  if (!extracted || extracted.value == null) return;

  const currentConf = (note._fieldConfidence ?? {})[field] ?? 0;
  const noteField   = note[field as keyof ConvertibleNote];

  // Skip if already populated with confidence at or above the cap
  if (noteField != null && currentConf >= ENRICHMENT_CONF_CAP) return;

  // Cap enrichment confidence
  const newConf = Math.min(extracted.confidence, ENRICHMENT_CONF_CAP);

  // Only write if this is strictly better than what we have
  if (noteField == null || newConf > currentConf) {
    assign(extracted.value);
    if (!note._fieldConfidence) note._fieldConfidence = {};
    note._fieldConfidence[field] = newConf;
  }
}

/** Applies all enrichable fields from an instrument to a note. */
function applyInstrumentFields(inst: Instrument, note: ConvertibleNote): void {
  const f = inst.fields;
  const anchorPrincipal = note._anchorPrincipalAmount;

  /**
   * Like tryFill but runs a contamination check first for monetary fields.
   * If the source sentence contains an amount > RATIO × anchor principal, the
   * field is rejected and logged to _rejectedCandidates instead of being written.
   */
  function enrichFill<T>(
    field:     string,
    extracted: ExtractedField<T> | undefined,
    assign:    (v: T) => void,
  ): void {
    if (!extracted || extracted.value == null) return;

    if (anchorPrincipal != null && ENRICH_MONETARY_FIELDS.has(field)) {
      const srcSent = inst.sentences.find(s => s.sentenceIndex === extracted.sourceSentenceIndex);
      const srcText = srcSent?.text ?? '';
      const reason  = enrichContaminationReason(field, srcText, anchorPrincipal);
      if (reason) {
        if (!note._rejectedCandidates) note._rejectedCandidates = [];
        note._rejectedCandidates.push({
          field,
          value:         extracted.value,
          sourceText:    srcText,
          sentenceIndex: extracted.sourceSentenceIndex,
          reason,
        } satisfies RejectedCandidate);
        return;
      }
    }

    tryFill(note, field, extracted, assign);
  }

  tryFill(note, 'interestRate',            f.interestRate,            v => { note.interestRate            = v; });
  tryFill(note, 'defaultInterestRate',     f.defaultInterestRate,     v => { note.defaultInterestRate     = v; });
  tryFill(note, 'maturityDate',            f.maturityDate,            v => { note.maturityDate            = v; });
  tryFill(note, 'executionDate',           f.executionDate,           v => { note.executionDate           = v; });
  tryFill(note, 'discountRate',            f.discountRate,            v => { note.discountRate            = v; });
  tryFill(note, 'lookbackDays',            f.lookbackDays,            v => { note.lookbackDays            = v; });
  tryFill(note, 'conversionFormula',       f.conversionFormula,       v => { note.conversionFormula       = v; });
  tryFill(note, 'floorPrice',              f.floorPrice,              v => { note.floorPrice = v; note.hasFloorPrice = v !== null; });
  tryFill(note, 'ceilingPrice',            f.ceilingPrice,            v => { note.ceilingPrice            = v; });
  tryFill(note, 'exchangeCap',             f.exchangeCap,             v => { note.exchangeCap             = v; });
  tryFill(note, 'beneficialOwnershipBlocker', f.beneficialOwnershipBlocker, v => { note.beneficialOwnershipBlocker = v; });
  tryFill(note, 'hasResetProvisions',      f.hasResetProvisions,      v => { note.hasResetProvisions      = v; });
  tryFill(note, 'antiDilutionProvisions',  f.antiDilutionProvisions,  v => { note.antiDilutionProvisions  = v; });
  tryFill(note, 'hasAccelerationClause',   f.hasAccelerationClause,   v => { note.hasAccelerationClause   = v; });
  tryFill(note, 'penaltyRate',             f.penaltyRate,             v => { note.penaltyRate             = v; });
  tryFill(note, 'prepaymentPremium',       f.prepaymentPremium,       v => { note.prepaymentPremium       = v; });
  tryFill(note, 'redemptionPremium',       f.redemptionPremium,       v => { note.redemptionPremium       = v; });
  tryFill(note, 'originalIssueDiscount',   f.originalIssueDiscount,   v => { note.originalIssueDiscount   = v; });
  tryFill(note, 'legalFees',               f.legalFees,               v => { note.legalFees               = v; });
  tryFill(note, 'placementFees',           f.placementFees,           v => { note.placementFees           = v; });
  tryFill(note, 'investorName',            f.investorName,            v => { note.investorName            = v; });
  tryFill(note, 'instrumentType',          f.instrumentType,          v => { note.instrumentType          = v as ConvertibleNote['instrumentType']; });
  tryFill(note, 'instrumentName',          f.instrumentName,          v => { note.instrumentName          = v; });
  tryFill(note, 'status',                  f.status,                  v => { note.status                  = v as ConvertibleNote['status']; });

  // Monetary fields — contamination-checked
  enrichFill('netProceeds',       f.netProceeds,       v => { note.netProceeds       = v; });
  enrichFill('purchasePrice',     f.purchasePrice,     v => { note.purchasePrice     = v; });
  enrichFill('outstandingBalance', f.outstandingBalance, v => { note.outstandingBalance = v; });
  enrichFill('amountConverted',   f.amountConverted,   v => { note.amountConverted   = v; });
  enrichFill('amountRepaid',      f.amountRepaid,      v => { note.amountRepaid      = v; });

  // fixedConversionPrice: only if discountRate absent (avoids overriding variable-rate signal)
  if (!note.discountRate) {
    tryFill(note, 'fixedConversionPrice', f.fixedConversionPrice, v => { note.fixedConversionPrice = v; });
  }
}

// ── Enrichment core ───────────────────────────────────────────────────────────

function noteNeedsEnrichment(note: ConvertibleNote): boolean {
  return CRITICAL_FIELDS.some(f => note[f] == null);
}

function searchSectionForNote(
  sectionText: string,
  note:        ConvertibleNote,
  sectionKey:  string,
): void {
  // Split into paragraphs and collect anchor-matching ones
  const paras = sectionText.split(/\n{2,}/);
  const matchingParas: string[] = [];

  for (const para of paras) {
    if (para.trim().length < 30) continue;
    if (paragraphMatchesNote(para, note)) {
      matchingParas.push(para.trim());
    }
  }

  if (matchingParas.length === 0) return;

  // Run the instrument layer on matched paragraphs
  const corpus = matchingParas.join('\n\n');
  let instruments: Instrument[];
  try {
    instruments = buildInstrumentLayer(corpus);
  } catch {
    return;
  }

  if (instruments.length === 0) return;

  // Prefer 'note' type instruments; fall back to first
  const target = instruments.find(i => i.type === 'note') ?? instruments[0];

  const fieldsBefore = countPopulatedFields(note);
  applyInstrumentFields(target, note);
  const fieldsAfter = countPopulatedFields(note);

  const gained = fieldsAfter - fieldsBefore;
  if (gained > 0) {
    // Record provenance
    if (!note._sourceSentenceTexts) note._sourceSentenceTexts = [];
    note._sourceSentenceTexts.push(`[enriched +${gained} fields from §${sectionKey}]`);
  }
}

function countPopulatedFields(note: ConvertibleNote): number {
  const checkable: (keyof ConvertibleNote)[] = [
    'interestRate', 'defaultInterestRate', 'maturityDate', 'executionDate',
    'discountRate', 'fixedConversionPrice', 'lookbackDays', 'conversionFormula',
    'floorPrice', 'ceilingPrice', 'beneficialOwnershipBlocker', 'hasResetProvisions',
    'antiDilutionProvisions', 'hasAccelerationClause', 'penaltyRate',
    'prepaymentPremium', 'redemptionPremium', 'investorName', 'status',
  ];
  return checkable.filter(f => note[f] != null).length;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Enriches ConvertibleNote objects in-place by searching relevant filing sections
 * for fields missing from the primary extraction pass.
 *
 * @param notes    Notes from consolidateNotes() — mutated in place
 * @param sections Detected sections from the same filing
 */
export function enrichConvertibleNotes(
  notes:    ConvertibleNote[],
  sections: EnrichmentSection[],
): void {
  for (const note of notes) {
    if (!noteNeedsEnrichment(note)) continue;

    // Build a lookup of section texts
    const sectionMap = new Map<string, string>();
    for (const sec of sections) {
      if (!sectionMap.has(sec.key)) sectionMap.set(sec.key, sec.text);
    }

    // Search note's own section first, then others in priority order
    const noteSection = note._section ?? '';
    const searchOrder = [
      noteSection,
      ...ENRICHMENT_SECTION_KEYS.filter(k => k !== noteSection),
    ].filter(Boolean);

    for (const key of searchOrder) {
      const text = sectionMap.get(key);
      if (!text) continue;

      searchSectionForNote(text, note, key);

      // Stop early once critical fields are filled
      if (!noteNeedsEnrichment(note)) break;
    }
  }
}

// ── Completeness scoring ──────────────────────────────────────────────────────

export interface CompletenessReport {
  identity:   { pct: number; missing: string[] };
  economics:  { pct: number; missing: string[] };
  conversion: { pct: number; missing: string[] };
  defaults:   { pct: number; missing: string[] };
  status:     { pct: number; missing: string[] };
  overall:    number;
}

function score(note: ConvertibleNote, fields: (keyof ConvertibleNote)[]): { pct: number; missing: string[] } {
  const missing = fields.filter(f => {
    if (note[f] != null) return false;
    // floorPrice is definitively answered when hasFloorPrice === false
    if (f === 'floorPrice' && note.hasFloorPrice === false) return false;
    return true;
  });
  const pct = Math.round(((fields.length - missing.length) / fields.length) * 100);
  return { pct, missing: missing as string[] };
}

export function noteCompleteness(note: ConvertibleNote): CompletenessReport {
  const identity   = score(note, ['investorName', 'instrumentType', 'executionDate', 'instrumentName']);
  const economics  = score(note, ['principalAmount', 'interestRate', 'maturityDate', 'purchasePrice', 'originalIssueDiscount', 'netProceeds', 'prepaymentPremium']);
  const conversion = score(note, ['discountRate', 'fixedConversionPrice', 'lookbackDays', 'floorPrice', 'hasFloorPrice', 'ceilingPrice', 'beneficialOwnershipBlocker', 'conversionFormula', 'hasResetProvisions']);
  const defaults   = score(note, ['hasAccelerationClause', 'penaltyRate', 'defaultInterestRate']);
  const statScore  = score(note, ['status', 'amountConverted', 'amountRepaid']);

  // Weight: economics and conversion are most important
  const weights = { identity: 1, economics: 3, conversion: 3, defaults: 1, status: 1 };
  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
  const overall = Math.round(
    (identity.pct   * weights.identity +
     economics.pct  * weights.economics +
     conversion.pct * weights.conversion +
     defaults.pct   * weights.defaults +
     statScore.pct  * weights.status) / totalWeight,
  );

  return { identity, economics, conversion, defaults, status: statScore, overall };
}
