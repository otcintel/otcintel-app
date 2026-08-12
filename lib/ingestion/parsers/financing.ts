/**
 * Financing terms parser
 *
 * Extracts convertible note and equity line terms from SEC filing text.
 * Uses regex patterns that match common OTC financing disclosure language.
 *
 * Design: pure function — (text: string) → ExtractedFinancingTerms | undefined
 * Returns undefined if no financing-related language is detected.
 */

import type { ExtractedFinancingTerms, ExtractionConfidence, FinancingType } from '../types';

// ─── Pattern library ──────────────────────────────────────────────────────────

/**
 * Patterns for detecting financing type.
 * Checked in priority order — first match wins.
 */
const FINANCING_TYPE_PATTERNS: Array<{ type: FinancingType; patterns: RegExp[] }> = [
  {
    type: 'convertible_note',
    patterns: [
      /convertible\s+(?:promissory\s+)?note/i,
      /senior\s+convertible/i,
      /note\s+purchase\s+agreement/i,
      /securities\s+purchase\s+agreement.*convertible/i,
    ],
  },
  {
    type: 'equity_line',
    patterns: [
      /equity\s+line\s+of\s+credit/i,
      /equity\s+purchase\s+agreement/i,
      /committed\s+equity\s+facilit/i,
      /common\s+stock\s+purchase\s+agreement/i,
    ],
  },
  {
    type: 'preferred_stock',
    patterns: [
      /series\s+[a-z]\s+(?:convertible\s+)?preferred\s+stock/i,
      /preferred\s+stock\s+purchase\s+agreement/i,
    ],
  },
  {
    type: 'warrant_only',
    patterns: [
      /warrant\s+purchase\s+agreement/i,
      /standalone\s+warrant/i,
    ],
  },
];

/**
 * Discount rate patterns.
 * OTC notes typically express conversion as a % of VWAP (e.g. "78% of VWAP" = 22% discount)
 * or directly as a discount (e.g. "22% discount to VWAP").
 *
 * Form classification (determines inversion):
 *   Direct form  (indices 0, 1): number IS the discount   → discountRate = X / 100
 *   Inverse form (indices 2, 3): number IS % of reference → discountRate = (100 − X) / 100
 *
 * Inversion is determined by which pattern matched, NOT by re-inspecting the match
 * substring, which was unreliable when the match ended exactly at "of" with no
 * trailing whitespace (the previous bug that caused "90% of VWAP" → 0.90 instead of 0.10).
 */
const DISCOUNT_PATTERNS: RegExp[] = [
  // [0] Direct — "22% discount to VWAP" / "22% discount"
  /(\d+(?:\.\d+)?)\s*%\s*discount\s*(?:to|from|of)?\s*(?:the\s+)?(?:lowest\s+)?(?:VWAP|market|closing)/i,
  // [1] Direct — "discount of 22%"
  /discount\s+of\s+(\d+(?:\.\d+)?)\s*%/i,
  // [2] Inverse — "78% of the lowest VWAP" → (100 − 78) / 100 = 0.22
  /(\d+(?:\.\d+)?)\s*%\s*of\s*(?:the\s+)?(?:lowest|average|closing|market)/i,
  // [3] Inverse — "conversion price equal to 78% of VWAP" → (100 − 78) / 100 = 0.22
  /conversion\s+price\s+(?:equal\s+to|of|is)\s+(\d+(?:\.\d+)?)\s*%\s*of/i,
];

/** Pattern indices in DISCOUNT_PATTERNS that represent inverse form ("X% of reference"). */
const INVERSE_DISCOUNT_PATTERN_INDICES = new Set([2, 3]);

/** Principal / face value patterns */
const PRINCIPAL_PATTERNS: RegExp[] = [
  /aggregate\s+principal\s+(?:amount\s+)?of\s+\$([0-9,]+(?:\.[0-9]+)?)/i,
  /principal\s+(?:amount|sum|balance)\s+of\s+\$([0-9,]+(?:\.[0-9]+)?)/i,
  /principal\s+(?:amount\s+of\s+)?\$([0-9,]+(?:\.[0-9]+)?)/i,
  /\$([0-9,]+(?:\.[0-9]+)?)\s+(?:aggregate\s+)?(?:principal|face\s+value)/i,
  /(?:note|notes?)\s+in\s+(?:the\s+)?(?:aggregate\s+)?(?:principal\s+)?(?:amount\s+of\s+)?\$([0-9,]+)/i,
];

/** VWAP lookback window patterns */
const LOOKBACK_PATTERNS: RegExp[] = [
  /(\d+)\s+trading\s+day(?:s)?\s+(?:immediately\s+)?(?:preceding|prior\s+to|before)/i,
  /lowest\s+(?:closing\s+)?(?:VWAP|volume[- ]weighted)\s+(?:during\s+the\s+)?(\d+)\s+trading\s+day/i,
  /(\d+)[- ]day\s+VWAP/i,
  /VWAP\s+(?:for|during|of)\s+(?:the\s+)?(?:preceding\s+)?(\d+)\s+(?:trading\s+)?day/i,
];

/** Floor price patterns */
const FLOOR_PRICE_PATTERNS: RegExp[] = [
  /floor\s+(?:conversion\s+)?price\s+of\s+\$([0-9.]+)/i,
  /minimum\s+conversion\s+price\s+(?:of\s+)?\$([0-9.]+)/i,
  /conversion\s+price\s+shall\s+not\s+be\s+less\s+than\s+\$([0-9.]+)/i,
  /floor\s+price\s+of\s+\$([0-9.]+)/i,
  /\$([0-9.]+)\s+per\s+share\s+(?:\(the\s+)?"?[Ff]loor/i,
];

/** No-floor-price indicators */
const NO_FLOOR_PATTERNS: RegExp[] = [
  /no\s+(?:minimum\s+)?floor\s+(?:conversion\s+)?price/i,
  /does\s+not\s+(?:contain|include|have)\s+a\s+floor/i,
  /without\s+a\s+(?:minimum\s+)?floor/i,
  /no\s+floor\s+(?:price\s+)?(?:is\s+)?(?:set|stated|established)/i,
];

/** No-reset-provision indicators — checked before RESET_PATTERNS */
const NO_RESET_PATTERNS: RegExp[] = [
  /does\s+not\s+(?:contain|include|have)\s+(?:anti[- ]dilution|reset)\s+(?:reset\s+)?(?:provision|clause|adjustment)/i,
  /no\s+(?:anti[- ]dilution\s+)?reset\s+(?:provision|clause|adjustment)/i,
  /no\s+adjustment\s+to\s+the\s+conversion\s+price\s+will\s+occur/i,
  /not\s+(?:contain|include)\s+anti[- ]dilution/i,
  /absence\s+of\s+(?:any\s+)?(?:anti[- ]dilution|reset)/i,
];

/** Reset / anti-dilution provision patterns */
const RESET_PATTERNS: RegExp[] = [
  /anti[- ]dilution\s+(?:adjustment|provision|clause|reset)/i,
  /reset\s+(?:provision|clause|adjustment)/i,
  /full\s+ratchet/i,
  /weighted\s+average\s+anti[- ]dilution/i,
  /conversion\s+price\s+(?:shall\s+be\s+)?(?:adjusted|reset|reduced)\s+if/i,
  /price\s+(?:protection|adjustment)\s+provision/i,
];

/** Warrant share count patterns */
const WARRANT_SHARE_PATTERNS: RegExp[] = [
  /warrants?\s+to\s+purchase\s+([0-9,]+)\s+shares/i,
  /([0-9,]+)\s+(?:common\s+stock\s+)?warrants?\s+(?:to\s+purchase|exercisable)/i,
  /issue(?:d|s)?\s+warrants?\s+(?:to\s+(?:the\s+)?(?:investor|purchaser|holder)\s+)?(?:for|covering|to\s+purchase)\s+([0-9,]+)\s+shares/i,
];

/** Warrant exercise price patterns */
const WARRANT_PRICE_PATTERNS: RegExp[] = [
  /(?:warrant\s+)?exercise\s+price\s+of\s+\$([0-9.]+)\s+per\s+share/i,
  /warrants?\s+(?:are\s+)?exercisable\s+at\s+\$([0-9.]+)/i,
  /exercise\s+price\s+(?:equal\s+to\s+)?\$([0-9.]+)/i,
];

/** Maturity date patterns */
const MATURITY_PATTERNS: RegExp[] = [
  /matures?\s+(?:on|upon)\s+(.{5,30}?\d{4})/i,
  /maturity\s+date\s+of\s+(.{5,30}?\d{4})/i,
  /due\s+(?:on\s+|and\s+payable\s+on\s+)?(.{5,30}?\d{4})/i,
];

/** Investor name patterns */
const INVESTOR_PATTERNS: RegExp[] = [
  /with\s+([A-Z][A-Za-z\s,\.]+(?:LLC|LP|L\.P\.|Inc\.|Corp\.|Group|Capital|Partners|Fund|Management))/,
  /(?:the\s+)?"Investor"\s*[,)]\s+([A-Z][A-Za-z\s,\.]+(?:LLC|LP|L\.P\.|Inc\.|Corp\.))/,
  /(?:the\s+)?"Purchaser"\s*[,)]\s+([A-Z][A-Za-z\s,\.]+(?:LLC|LP|L\.P\.|Inc\.|Corp\.))/,
  /(?:the\s+)?"Holder"\s*[,)]\s+([A-Z][A-Za-z\s,\.]+(?:LLC|LP|L\.P\.|Inc\.|Corp\.))/,
  // "with Northfield Capital Group LLC (the "Investor")"
  /with\s+([A-Z][A-Za-z\s]+(?:LLC|LP|L\.P\.|Inc\.|Corp\.|Group|Capital|Partners))\s+\(the/,
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseNumber(raw: string): number {
  return parseFloat(raw.replace(/,/g, ''));
}

function firstMatch(text: string, patterns: RegExp[]): RegExpMatchArray | null {
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m) return m;
  }
  return null;
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Extract financing terms from raw SEC filing text.
 * Returns undefined if the text contains no recognizable financing language.
 */
export function parseFinancingTerms(text: string): ExtractedFinancingTerms | undefined {
  const matchedPhrases: string[] = [];
  let confidence: ExtractionConfidence = 'low';
  let confidencePoints = 0;

  // ── Detect financing type ──
  let financingType: FinancingType = 'unknown';
  for (const { type, patterns } of FINANCING_TYPE_PATTERNS) {
    if (patterns.some(p => p.test(text))) {
      financingType = type;
      confidencePoints += 2;
      break;
    }
  }

  // No financing language found — bail early
  if (financingType === 'unknown' && !text.match(/convertible|equity\s+line|principal\s+amount/i)) {
    return undefined;
  }

  // ── Principal amount ──
  let principalAmount: number | undefined;
  const principalMatch = firstMatch(text, PRINCIPAL_PATTERNS);
  if (principalMatch) {
    principalAmount = parseNumber(principalMatch[1]);
    matchedPhrases.push(principalMatch[0].trim());
    confidencePoints += 2;
  }

  // ── Discount rate ──
  let discountRate: number | undefined;
  for (let i = 0; i < DISCOUNT_PATTERNS.length; i++) {
    const m = text.match(DISCOUNT_PATTERNS[i]);
    if (m) {
      const raw = parseFloat(m[1]);
      // Inversion is determined by which pattern matched, not by re-inspecting the
      // match substring. Patterns 2 and 3 express "X% of reference" (inverse form);
      // patterns 0 and 1 express "X% discount" (direct form).
      const isInverseForm = INVERSE_DISCOUNT_PATTERN_INDICES.has(i);
      discountRate = isInverseForm ? (100 - raw) / 100 : raw / 100;
      matchedPhrases.push(m[0].trim());
      confidencePoints += 2;
      break;
    }
  }

  // ── Lookback window ──
  let lookbackDays: number | undefined;
  const lookbackMatch = firstMatch(text, LOOKBACK_PATTERNS);
  if (lookbackMatch) {
    lookbackDays = parseInt(lookbackMatch[1], 10);
    matchedPhrases.push(lookbackMatch[0].trim());
    confidencePoints += 1;
  }

  // ── Floor price ──
  let floorPrice: number | null | undefined;
  let hasFloorPrice = false;
  let hasFloorPriceDetermined = false;
  const noFloorMatch = NO_FLOOR_PATTERNS.some(p => p.test(text));
  if (noFloorMatch) {
    floorPrice = null;
    hasFloorPrice = false;
    hasFloorPriceDetermined = true;  // explicit no-floor statement found
    matchedPhrases.push('(no floor price stated)');
  } else {
    const floorMatch = firstMatch(text, FLOOR_PRICE_PATTERNS);
    if (floorMatch) {
      floorPrice = parseFloat(floorMatch[1]);
      hasFloorPrice = true;
      hasFloorPriceDetermined = true;  // explicit floor price found
      matchedPhrases.push(floorMatch[0].trim());
      confidencePoints += 1;
    }
    // else: neither pattern matched — hasFloorPriceDetermined remains false (silence)
  }

  // ── Reset provisions ──
  // Check for explicit negation first — "does not contain anti-dilution provisions" etc.
  const noResetExplicit = NO_RESET_PATTERNS.some(p => p.test(text));
  const hasResetProvisions = !noResetExplicit && RESET_PATTERNS.some(p => p.test(text));
  const hasResetProvisionsDetermined = hasResetProvisions || noResetExplicit;
  if (hasResetProvisions) {
    const resetMatch = firstMatch(text, RESET_PATTERNS);
    if (resetMatch) matchedPhrases.push(resetMatch[0].trim());
  } else if (noResetExplicit) {
    matchedPhrases.push('(no reset provisions stated)');
  }
  // else: neither pattern matched — hasResetProvisionsDetermined remains false (silence)

  // ── Warrants ──
  let warrantShares: number | undefined;
  let warrantExercisePrice: number | undefined;
  const warrantShareMatch = firstMatch(text, WARRANT_SHARE_PATTERNS);
  if (warrantShareMatch) {
    warrantShares = parseNumber(warrantShareMatch[1]);
    matchedPhrases.push(warrantShareMatch[0].trim());
    confidencePoints += 1;
  }
  const warrantPriceMatch = firstMatch(text, WARRANT_PRICE_PATTERNS);
  if (warrantPriceMatch) {
    warrantExercisePrice = parseFloat(warrantPriceMatch[1]);
    matchedPhrases.push(warrantPriceMatch[0].trim());
  }

  // ── Maturity date ──
  let maturityDate: string | undefined;
  const maturityMatch = firstMatch(text, MATURITY_PATTERNS);
  if (maturityMatch) {
    maturityDate = maturityMatch[1].trim().replace(/\s+/g, ' ');
    matchedPhrases.push(maturityMatch[0].trim());
    confidencePoints += 1;
  }

  // ── Investor name ──
  let investorName: string | undefined;
  const investorMatch = firstMatch(text, INVESTOR_PATTERNS);
  if (investorMatch) {
    investorName = investorMatch[1].trim();
    matchedPhrases.push(investorMatch[0].trim());
  }

  // ── Overall confidence ──
  if (confidencePoints >= 7) confidence = 'high';
  else if (confidencePoints >= 4) confidence = 'medium';
  else confidence = 'low';

  return {
    financingType,
    principalAmount,
    discountRate,
    lookbackDays,
    floorPrice,
    hasFloorPrice,
    hasFloorPriceDetermined,
    hasResetProvisions,
    hasResetProvisionsDetermined,
    warrantShares,
    warrantExercisePrice,
    maturityDate,
    investorName,
    confidence,
    matchedPhrases,
  };
}
