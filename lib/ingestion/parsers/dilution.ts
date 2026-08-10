/**
 * Dilution language parser
 *
 * Extracts dilution warnings, estimates, and risk-related language from SEC filings.
 * Captures verbatim phrases for display and computes rough numerical estimates
 * where disclosures are specific enough to support them.
 *
 * Design: pure function — (text: string) → ExtractedDilutionLanguage | undefined
 */

import type { ExtractedDilutionLanguage, ExtractionConfidence } from '../types';

// ─── Pattern library ──────────────────────────────────────────────────────────

/** Patterns that indicate a dilution risk warning exists in the filing */
const DILUTION_WARNING_PATTERNS: RegExp[] = [
  /(?:significant(?:ly)?|substantial(?:ly)?|material(?:ly)?)\s+dilut/i,
  /dilution\s+(?:of|to|in)\s+(?:the\s+)?(?:interest|ownership|equity|value)/i,
  /(?:holders?\s+of\s+)?common\s+stock\s+(?:may|will|could)\s+(?:experience|suffer|incur)\s+dilution/i,
  /dilutive\s+effect/i,
  /dilution\s+(?:risk|concern|warning)/i,
  /may\s+result\s+in\s+(?:significant\s+)?dilution/i,
  /could\s+(?:significantly|materially|substantially)\s+dilute/i,
];

/**
 * Patterns for extracting the specific dilution phrases to quote.
 * Each captures a meaningful surrounding context window.
 */
const DILUTION_PHRASE_PATTERNS: RegExp[] = [
  // "significant dilution to existing stockholders"
  /.{0,60}(?:significant|substantial|material)\s+dilution.{0,80}/gi,
  // "dilution of up to X%"
  /.{0,40}dilution\s+of\s+(?:up\s+to\s+)?[\d.]+\s*%.{0,40}/gi,
  // "could dilute the interests of existing holders"
  /.{0,60}(?:dilute|dilution)\s+the\s+(?:interests?|ownership|equity|value)\s+of.{0,60}/gi,
  // "conversion of the Note would result in dilution"
  /.{0,60}conversion\s+of\s+(?:the\s+)?(?:Note|notes?|securities?)\s+(?:would|will|may|could)\s+result\s+in.{0,60}/gi,
];

/** Patterns for numerical dilution estimates */
const DILUTION_ESTIMATE_PATTERNS: RegExp[] = [
  // "dilution of approximately 26.1%"
  /dilution\s+of\s+(?:approximately\s+|up\s+to\s+)?(\d+(?:\.\d+)?)\s*%/i,
  // "approximately 26.1% dilutive"
  /(?:approximately\s+)?(\d+(?:\.\d+)?)\s*%\s+dilutiv/i,
  // "ownership dilution ... 30.9%"
  /(?:ownership|equity)\s+dilution\s+of\s+(?:approximately\s+)?(\d+(?:\.\d+)?)\s*%/i,
];

/** New share count patterns within dilution context */
const NEW_SHARE_PATTERNS: RegExp[] = [
  // "issue up to X shares" in context of conversion/dilution
  /issue\s+(?:up\s+to\s+)?([0-9,]+)\s+(?:additional\s+)?shares\s+of\s+common\s+stock/i,
  // "additional X shares"
  /(?:additional|new)\s+([0-9,]+)\s+shares\s+(?:of\s+common\s+stock\s+)?(?:may\s+be\s+)?(?:issued|issuable)/i,
  // "conversion into X shares"
  /convert(?:ible|ed|ible\s+into)\s+(?:up\s+to\s+)?([0-9,]+)\s+shares/i,
];

// ─── Helper ───────────────────────────────────────────────────────────────────

function extractPhrases(text: string, patterns: RegExp[]): string[] {
  const found: string[] = [];
  for (const pattern of patterns) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const phrase = m[0].replace(/\s+/g, ' ').trim();
      if (phrase.length > 10 && !found.includes(phrase)) {
        found.push(phrase);
      }
      if (!pattern.global) break;
    }
  }
  return found.slice(0, 5); // cap at 5 excerpts
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Extract dilution-related language from raw SEC filing text.
 * Returns undefined if no dilution language is detected at all.
 */
export function parseDilutionLanguage(text: string): ExtractedDilutionLanguage | undefined {
  // Quick check — bail early if no dilution language present
  if (!/dilut/i.test(text)) return undefined;

  const hasDilutionWarning = DILUTION_WARNING_PATTERNS.some(p => p.test(text));
  const dilutionPhrases = extractPhrases(text, DILUTION_PHRASE_PATTERNS);

  // ── Numerical estimate ──
  let estimatedDilutionPct: number | undefined;
  for (const p of DILUTION_ESTIMATE_PATTERNS) {
    const m = text.match(p);
    if (m) {
      estimatedDilutionPct = parseFloat(m[1]);
      break;
    }
  }

  // ── New share count ──
  let estimatedNewShares: number | undefined;
  for (const p of NEW_SHARE_PATTERNS) {
    const m = text.match(p);
    if (m) {
      estimatedNewShares = parseInt(m[1].replace(/,/g, ''), 10);
      break;
    }
  }

  // Confidence — based on how many signals were found
  let confidence: ExtractionConfidence = 'low';
  const signals =
    (hasDilutionWarning ? 2 : 0) +
    (dilutionPhrases.length > 0 ? 1 : 0) +
    (estimatedDilutionPct !== undefined ? 2 : 0) +
    (estimatedNewShares !== undefined ? 1 : 0);

  if (signals >= 5) confidence = 'high';
  else if (signals >= 3) confidence = 'medium';

  return {
    hasDilutionWarning,
    dilutionPhrases,
    estimatedNewShares,
    estimatedDilutionPct,
    confidence,
  };
}
