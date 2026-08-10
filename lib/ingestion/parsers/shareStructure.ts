/**
 * Share structure parser
 *
 * Extracts authorized shares, shares outstanding, float, and preferred shares
 * from SEC filing text. These disclosures appear in 8-K, 10-K, and 10-Q filings.
 *
 * Design: pure function — (text: string) → ExtractedShareStructure | undefined
 */

import type { ExtractedShareStructure, ExtractionConfidence } from '../types';

// ─── Pattern library ──────────────────────────────────────────────────────────

/** Shares outstanding patterns */
const SHARES_OUTSTANDING_PATTERNS: RegExp[] = [
  // "112,000,000 shares of our/the Company's common stock were issued and outstanding"
  /([0-9,]+)\s+shares\s+of\s+(?:our\s+|the\s+(?:company(?:'s)?\s+)?)common\s+stock\s+(?:were|are|is)\s+(?:issued\s+and\s+)?outstanding/i,
  // "shares outstanding: 112,000,000"
  /shares\s+(?:of\s+common\s+stock\s+)?outstanding[:\s]+([0-9,]+)/i,
  // "outstanding shares of common stock of 112,000,000"
  /outstanding\s+shares\s+of\s+common\s+stock\s+(?:of\s+|equal\s+to\s+)?([0-9,]+)/i,
  // "we had 112,000,000 shares of common stock outstanding"
  /we\s+had\s+([0-9,]+)\s+shares\s+of\s+(?:our\s+)?common\s+stock\s+outstanding/i,
  // "there were 112,000,000 shares of our/the Company's common stock issued and outstanding"
  /there\s+were\s+([0-9,]+)\s+shares\s+of\s+(?:our\s+|the\s+(?:company(?:'s)?\s+)?)common\s+stock\s+(?:issued\s+and\s+)?outstanding/i,
];

/** Authorized shares patterns */
const SHARES_AUTHORIZED_PATTERNS: RegExp[] = [
  // "authorized to issue 1,000,000,000 shares of common stock"
  /authorized\s+(?:to\s+issue\s+)?([0-9,]+)\s+shares\s+of\s+(?:our\s+|the\s+)?common\s+stock/i,
  // "1,000,000,000 shares of common stock authorized"
  /([0-9,]+)\s+shares\s+of\s+common\s+stock\s+authorized/i,
  // "common stock, $0.001 par value, 1,000,000,000 shares authorized"
  /common\s+stock.*?([0-9,]+)\s+shares\s+authorized/i,
  // "authorized capital stock of 1,000,000,000 shares"
  /authorized\s+(?:capital\s+stock|shares)\s+of\s+([0-9,]+)\s+shares/i,
];

/** Float / freely tradeable share patterns */
const FLOAT_PATTERNS: RegExp[] = [
  /(?:public\s+)?float\s+of\s+(?:approximately\s+)?([0-9,]+)\s+shares/i,
  /([0-9,]+)\s+shares\s+(?:of\s+common\s+stock\s+)?(?:in\s+the\s+)?(?:public\s+)?float/i,
  /freely\s+tradeable\s+(?:shares\s+of\s+)?(?:approximately\s+)?([0-9,]+)/i,
];

/** Preferred shares outstanding patterns */
const PREFERRED_PATTERNS: RegExp[] = [
  /([0-9,]+)\s+shares\s+of\s+(?:series\s+[a-z]\s+)?preferred\s+stock\s+(?:were\s+|are\s+|is\s+)?(?:issued\s+and\s+)?outstanding/i,
  /outstanding\s+(?:shares\s+of\s+)?(?:series\s+[a-z]\s+)?preferred\s+stock[:\s]+([0-9,]+)/i,
  /preferred\s+shares?\s+outstanding[:\s]+([0-9,]+)/i,
];

// ─── Helper ───────────────────────────────────────────────────────────────────

function parseShareCount(raw: string): number {
  return parseInt(raw.replace(/,/g, ''), 10);
}

function firstMatch(text: string, patterns: RegExp[]): RegExpMatchArray | null {
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m;
  }
  return null;
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Extract share structure data from raw SEC filing text.
 * Returns undefined if no share count disclosures are found.
 */
export function parseShareStructure(text: string): ExtractedShareStructure | undefined {
  const matchedPhrases: string[] = [];
  let confidencePoints = 0;

  // ── Shares outstanding ──
  let sharesOutstanding: number | undefined;
  const outstandingMatch = firstMatch(text, SHARES_OUTSTANDING_PATTERNS);
  if (outstandingMatch) {
    sharesOutstanding = parseShareCount(outstandingMatch[1]);
    matchedPhrases.push(outstandingMatch[0].trim());
    confidencePoints += 3;
  }

  // ── Authorized shares ──
  let sharesAuthorized: number | undefined;
  const authorizedMatch = firstMatch(text, SHARES_AUTHORIZED_PATTERNS);
  if (authorizedMatch) {
    sharesAuthorized = parseShareCount(authorizedMatch[1]);
    matchedPhrases.push(authorizedMatch[0].trim());
    confidencePoints += 2;
  }

  // ── Float ──
  let sharesFloat: number | undefined;
  const floatMatch = firstMatch(text, FLOAT_PATTERNS);
  if (floatMatch) {
    sharesFloat = parseShareCount(floatMatch[1]);
    matchedPhrases.push(floatMatch[0].trim());
    confidencePoints += 1;
  }

  // ── Preferred shares ──
  let preferredSharesOutstanding: number | undefined;
  const preferredMatch = firstMatch(text, PREFERRED_PATTERNS);
  if (preferredMatch) {
    preferredSharesOutstanding = parseShareCount(preferredMatch[1]);
    matchedPhrases.push(preferredMatch[0].trim());
    confidencePoints += 1;
  }

  // Nothing extracted
  if (confidencePoints === 0) return undefined;

  const confidence: ExtractionConfidence =
    confidencePoints >= 5 ? 'high' :
    confidencePoints >= 3 ? 'medium' : 'low';

  return {
    sharesAuthorized,
    sharesOutstanding,
    sharesFloat,
    preferredSharesOutstanding,
    confidence,
    matchedPhrases,
  };
}
