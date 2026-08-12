/**
 * Going-concern text extractor — Phase 7 Step 3
 *
 * Pure function: scans the normalized text of a 10-K, 10-K/A, 10-Q, or 10-Q/A
 * for genuine going-concern disclosures, extracting the strongest matching
 * sentence and assigning a confidence tier.
 *
 * Detection strategy:
 *   Tier 1 (high)   — Explicit "substantial doubt" + "going concern" language
 *                     or management-plans-to-alleviate language.
 *   Tier 2 (medium) — "ability to continue as a going concern" or auditor-opinion
 *                     language without the explicit doubt phrase.
 *   Tier 3 (low)    — Any "going concern" mention in a non-trivial, non-boilerplate
 *                     sentence. Allows downstream consumers to decide.
 *
 * False-positive suppression:
 *   Sentences that reference accounting/auditing standards (ASU 2014-15,
 *   ASC 205-40, AS 2415) or contain the standard's definition language are
 *   discarded before scoring. Table-of-contents entries are also discarded.
 *   Sentences that explicitly negate or resolve the substantial doubt are
 *   discarded via NEGATION_PATTERNS before tier scoring.
 *
 * Domain rule (from Phase 7 architecture):
 *   Liquidity, losses, or negative cash flow alone do NOT trigger detection.
 *   Going-concern language must be explicit.
 */

// ─── Result type ──────────────────────────────────────────────────────────────

export interface GoingConcernResult {
  /** True when genuine going-concern language is found outside boilerplate. */
  goingConcernFlag:  boolean;
  /** Full normalized sentence containing the strongest match. */
  matchedSentence?:  string;
  /** The specific phrase within the sentence that drove detection. */
  matchedPhrase?:    string;
  /** Confidence tier determined by the highest-priority pattern that matched. */
  confidence:        'high' | 'medium' | 'low';
  sourceType:        'filing_text';
}

// ─── Detection patterns ───────────────────────────────────────────────────────

interface Tier {
  confidence: 'high' | 'medium' | 'low';
  patterns:   RegExp[];
}

/**
 * Patterns are tried in tier order (high → medium → low).
 * Within a tier, each pattern is tried against each candidate sentence.
 * The first sentence+pattern combination that matches and is not boilerplate wins.
 *
 * Note: all patterns are case-insensitive (flag i) and may span collapsed
 * whitespace (filing text is normalized before matching).
 */
const TIERS: Tier[] = [
  {
    confidence: 'high',
    patterns: [
      // "[subject] raise(s/d) substantial doubt about [the/our/its] ability to continue as a going concern"
      /raises?\s+substantial\s+doubt\s+about\s+(?:the\s+)?(?:\w+'?s?\s+)?ability\s+to\s+continue\s+as\s+a\s+going\s+concern/i,
      // "substantial doubt about [the/our/its] ability to continue as a going concern"
      /substantial\s+doubt\s+about\s+(?:the\s+)?(?:\w+'?s?\s+)?ability\s+to\s+continue\s+as\s+a\s+going\s+concern/i,
      // "substantial doubt exists/remains about [the company's] ability…"
      /substantial\s+doubt\s+(?:exists?|remains?|has\s+arisen?)\s+(?:about|regarding|as\s+to)/i,
      // "conditions [and/or] events that raise substantial doubt" — requires "going concern" in same sentence
      /conditions?\s+(?:and\s+|or\s+)?events?\s+that\s+raise\s+substantial\s+doubt/i,
      // "plans to alleviate/mitigate/address the substantial doubt" — genuine management response
      /plans?\s+to\s+(?:alleviate|mitigate|address)\s+(?:the\s+)?substantial\s+doubt/i,
      // "alleviate the substantial doubt about our ability to continue as a going concern"
      /alleviate\s+(?:the\s+)?substantial\s+doubt/i,
    ],
  },
  {
    confidence: 'medium',
    patterns: [
      // "ability to continue as a going concern" (without "substantial doubt")
      /ability\s+to\s+continue\s+as\s+a\s+going\s+concern/i,
      // "prepared assuming that the Company will continue as a going concern" — auditor note
      /prepared\s+assuming\s+(?:the|that\s+the)\s+\w+\s+will\s+continue\s+as\s+a\s+going\s+concern/i,
      // "going concern uncertainty/doubt/risk/opinion/qualification"
      /going\s+concern\s+(?:uncertainty|doubt|issue|risk|opinion|qualification)/i,
      // "to continue as a going concern" standalone
      /to\s+continue\s+as\s+a\s+going\s+concern/i,
    ],
  },
  {
    confidence: 'low',
    patterns: [
      // Any mention of "going concern" — catch-all, still subject to boilerplate filter
      /going\s+concern/i,
    ],
  },
];

// ─── False-positive suppression ───────────────────────────────────────────────

/**
 * Sentences matching any of these markers are discarded before scoring.
 * Covers:
 *   - Accounting/auditing standard references (ASU 2014-15, ASC 205-40, AS 2415)
 *   - Table-of-contents entries
 */
const BOILERPLATE_MARKERS: RegExp[] = [
  // ASU 2014-15 — FASB update that codified going-concern evaluation requirements
  /ASU\s+(?:No\.\s+)?2014[-–]15/i,
  // ASC Subtopic 205-40 — the GAAP accounting standard
  /Subtopic\s+205[-–]40/i,
  /ASC\s*205[-–]40/i,
  // "Accounting Standards Codification Topic 205" style references
  /Accounting\s+Standards?\s+(?:Codification|Update)\s+(?:(?:No\.\s+)?\d+[-–]\d+|Topic\s+205)/i,
  // PCAOB Auditing Standard AS 2415 — going concern standard for public company audits
  /\bAS\s+(?:No\.\s+)?2415\b/i,
  // "requires management to evaluate" — standard requirement description, not a company assertion
  /requires\s+(?:the\s+)?(?:company|management|us|registrant)\s+to\s+(?:evaluate|assess|consider)/i,
  // Verbatim ASC 205-40 definition language
  /within\s+one\s+year\s+after\s+the\s+date\s+that\s+the\s+financial\s+statements\s+are\s+(?:issued|available)/i,
];

/**
 * Sentences matching any of these patterns assert that the going-concern
 * doubt does NOT exist or has been fully resolved. They must be discarded
 * before tier scoring to prevent false positives.
 *
 * Conservative "mitigated" rule: only suppress when the sentence states the
 * doubt itself has been mitigated (past-tense completion), NOT when describing
 * management plans intended to mitigate it (future/in-progress intention).
 */
const NEGATION_PATTERNS: RegExp[] = [
  // "no substantial doubt" — the most direct negation
  /\bno\s+substantial\s+doubt\b/i,
  // "no longer raises/has/creates substantial doubt"
  /\bno\s+longer\s+(?:raises?|has|have|creates?|constitutes?)\s+(?:a\s+)?substantial\s+doubt\b/i,
  // "have/has/had alleviated/resolved/eliminated the substantial doubt" (completed)
  /(?:have|has|had)\s+(?:been\s+)?(?:alleviated|resolved|eliminated)\s+(?:the\s+)?(?:substantial\s+)?doubt\b/i,
  // "the substantial doubt has been/was alleviated/resolved/eliminated/mitigated" (passive)
  /(?:the\s+)?(?:substantial\s+)?doubt\s+(?:has\s+been|was|were)\s+(?:alleviated|resolved|eliminated|mitigated)\b/i,
  // "have/has mitigated the substantial doubt" (past completion — conservative)
  /(?:have|has|had)\s+(?:been\s+)?mitigated\s+(?:the\s+)?(?:substantial\s+)?doubt\b/i,
  // "concluded/determined that there is no [substantial] doubt"
  /\b(?:concluded|determined)\s+that\s+there\s+(?:is|was|are|were)\s+no\s+(?:substantial\s+)?doubt\b/i,
  // "no conditions [or/and] events [that/which] raise substantial doubt"
  /\bno\s+(?:conditions?|events?|factors?)\b(?:\s+(?:or|and)\s+(?:conditions?|events?|factors?)\b)?\s+(?:(?:that|which)\s+)?raise[sd]?\s+substantial\s+doubt\b/i,
];

/** Pattern identifying table-of-contents / index entries (dotleaders + page ref). */
const TOC_RE = /(?:\.{3,}|\s{3,})\s*(?:[A-Z]?[-–]?\d+|F[-–]\d+)\s*$/;

/** Minimum meaningful sentence length for a going-concern assertion. */
const MIN_SENTENCE_LENGTH = 40;

function isBoilerplate(sentence: string): boolean {
  return BOILERPLATE_MARKERS.some(m => m.test(sentence));
}

function isTocEntry(sentence: string): boolean {
  return sentence.length < 150 && TOC_RE.test(sentence);
}

function isNegated(sentence: string): boolean {
  return NEGATION_PATTERNS.some(p => p.test(sentence));
}

function shouldDiscard(sentence: string): boolean {
  return (
    sentence.length < MIN_SENTENCE_LENGTH ||
    isBoilerplate(sentence) ||
    isTocEntry(sentence) ||
    isNegated(sentence)
  );
}

// ─── Text pre-processing ──────────────────────────────────────────────────────

/**
 * Strip HTML markup from filing text before normalization.
 *
 * Strategy:
 *   1. Block closing tags → space. The period already present at the end of
 *      the preceding sentence provides the sentence boundary; adding another
 *      '.' would create spurious double-periods.
 *   2. <br> → space.
 *   3. Decode named HTML entities common in SEC filings (apostrophe, dashes,
 *      non-breaking space, ampersand). Explicit before generic cleanup.
 *   4. All remaining tags → space.
 *   5. Remaining numeric entities (&#NNN;) → space so they never appear in
 *      matchedSentence.
 *   6. Remaining named entities → space.
 *
 * Safe for plain-text input: every replacement is a no-op when no `<`, `>`,
 * or `&` characters are present.
 */
function stripHtml(text: string): string {
  return text
    // Block closing tags → space (paragraph/section boundaries)
    .replace(/<\/(?:p|div|li|tr|td|th|h[1-6]|blockquote|pre|section|article)\s*>/gi, ' ')
    // Line break → space
    .replace(/<br\s*\/?>/gi, ' ')
    // Named entities used frequently in SEC EDGAR filings
    .replace(/&amp;/gi,  '&')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#160;/g,  ' ')   // non-breaking space
    .replace(/&#8217;/g, "'")   // right single quotation mark / apostrophe
    .replace(/&#8216;/g, "'")   // left single quotation mark
    .replace(/&#8220;/g, '"')   // left double quotation mark
    .replace(/&#8221;/g, '"')   // right double quotation mark
    .replace(/&#8211;/g, '–') // en dash
    .replace(/&#8212;/g, '—') // em dash
    .replace(/&#8230;/g, '…') // horizontal ellipsis
    // All remaining tags → space (catches opening tags, attributes, etc.)
    .replace(/<[^>]+>/g, ' ')
    // Remaining numeric entities → space
    .replace(/&#\d+;/g, ' ')
    // Remaining named entities (2–8 char names) → space
    .replace(/&[a-z]{2,8};/gi, ' ');
}

/**
 * Normalize filing text for matching:
 *   1. Strip HTML markup and decode entities (handles raw SEC EDGAR HTML).
 *   2. Collapse all whitespace (newlines, tabs, multi-spaces) to a single space.
 *   3. Trim leading/trailing whitespace.
 *
 * Preserves sentence-ending periods so sentence splitting still works.
 * Safe for plain-text input — stripHtml is a no-op when no HTML is present.
 */
function normalizeText(text: string): string {
  return stripHtml(text).replace(/\s+/g, ' ').trim();
}

/**
 * Split normalized text into sentences.
 *
 * Heuristic: insert a NUL boundary at `. ` / `! ` / `? ` followed by an
 * uppercase letter, double-quote, or opening parenthesis (common sentence
 * starts in financial filings). Then split on NUL.
 *
 * Trade-off: abbreviations like "Inc. reported" will occasionally produce a
 * spurious split, but going-concern sentences are self-contained and unaffected.
 */
function splitSentences(normalized: string): string[] {
  const marked = normalized.replace(/([.!?])\s+([A-Z"(])/g, '$1\x00$2');
  return marked
    .split('\x00')
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

// ─── Extractor ────────────────────────────────────────────────────────────────

const FALSE_RESULT: GoingConcernResult = {
  goingConcernFlag: false,
  confidence:       'low',
  sourceType:       'filing_text',
};

/**
 * Detect going-concern disclosures in SEC filing text.
 *
 * @param filingText - Raw text of a 10-K, 10-K/A, 10-Q, or 10-Q/A. May include
 *                    HTML markup — stripHtml() handles it before sentence detection.
 * @returns GoingConcernResult with flag, matched sentence/phrase, and confidence.
 */
export function detectGoingConcern(filingText: string): GoingConcernResult {
  if (!filingText || filingText.trim().length === 0) {
    return FALSE_RESULT;
  }

  const normalized   = normalizeText(filingText);
  const sentences    = splitSentences(normalized);

  // Fast path: skip the entire document if "going concern" never appears
  if (!/going\s+concern/i.test(normalized)) {
    return FALSE_RESULT;
  }

  // Collect candidate sentences: those containing "going concern" and not discarded
  const candidates = sentences.filter(
    s => /going\s+concern/i.test(s) && !shouldDiscard(s),
  );

  if (candidates.length === 0) {
    return FALSE_RESULT;
  }

  // Score each candidate against tier patterns, highest confidence wins.
  // Within the same tier, earlier candidates (i.e., first in document) are preferred.
  for (const tier of TIERS) {
    for (const sentence of candidates) {
      for (const pattern of tier.patterns) {
        const match = pattern.exec(sentence);
        if (match) {
          return {
            goingConcernFlag: true,
            matchedSentence:  sentence,
            matchedPhrase:    match[0].replace(/\s+/g, ' ').trim(),
            confidence:       tier.confidence,
            sourceType:       'filing_text',
          };
        }
      }
    }
  }

  // Candidates exist but no tier pattern matched — should not happen given the
  // low-tier "going concern" catch-all, but defend against it.
  return FALSE_RESULT;
}
