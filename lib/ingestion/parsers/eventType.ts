/**
 * 8-K event type classifier
 *
 * Classifies an 8-K filing into one of six event categories:
 *   financing           — convertible notes, loans, equity lines, securities offerings
 *   partnership         — strategic alliances, JVs, license/distribution agreements
 *   product_launch      — product announcements, regulatory approvals, launches
 *   management_change   — director/officer appointments and departures (Item 5.02 only via override)
 *   operational_update  — revenue announcements, deployments, customer wins, press releases
 *   other               — catch-all when no category meets the confidence threshold
 *
 * Classification strategy (in priority order):
 *   1. Item-number overrides — deterministic mapping for unambiguous 8-K items
 *   2. Weighted keyword scan — counts weighted pattern hits across the stripped text
 *   3. Item-number hints     — score boost applied to one category for ambiguous items
 *   4. Default               — 'other' when no category reaches MIN_SCORE
 *
 * management_change notes:
 *   Only Item 5.02 is an override — all other management-related items fall through
 *   to keyword scoring so filings that merely mention officer titles in quotes
 *   (extremely common in press releases) do not get misclassified.
 *
 * Returns a value from the EventType union — never undefined.
 */

import type { EventType } from '../types';

// ─── HTML stripping ───────────────────────────────────────────────────────────

const HTML_TAG_RE = /<[^>]{0,500}>/g;

/** Strip HTML tags so keyword patterns match plain text content, not markup. */
function cleanText(raw: string): string {
  return raw.replace(HTML_TAG_RE, ' ').replace(/\s+/g, ' ');
}

// ─── Item-number overrides ────────────────────────────────────────────────────

/**
 * 8-K items that unambiguously identify the event type.
 * When one of these is the primary item, the keyword scan is skipped entirely.
 *
 * management_change is intentionally restricted to 5.02 only.
 * Items 4.01, 4.02, 5.01 are governance/control events that should fall through
 * to keyword scoring or land in 'other' — not be assumed management changes.
 */
const ITEM_OVERRIDES: Record<string, EventType> = {
  '2.03': 'financing',          // Creation of a Direct Financial Obligation
  '3.02': 'financing',          // Unregistered sale of equity securities
  '5.02': 'management_change',  // Departure / appointment of directors or principal officers
  '5.03': 'other',              // Amendments to articles of incorporation or bylaws
  '5.07': 'other',              // Submission of matters to a vote of security holders
  '3.01': 'other',              // Notice of delisting or failure to satisfy listing rule
  '1.02': 'other',              // Termination of a Material Definitive Agreement
};

// ─── Item-number hints ────────────────────────────────────────────────────────

type ScoredCategory = Exclude<EventType, 'other'>;

/**
 * Items that suggest (but don't lock) a category.
 * The hint adds HINT_BOOST to that category's keyword score so it wins on a tie
 * or when the text is sparse.
 */
const ITEM_HINTS: Record<string, ScoredCategory> = {
  '1.01': 'operational_update', // Material definitive agreement — often a customer contract for OTC cos
  '2.01': 'partnership',        // Completion of acquisition or disposition of assets
  '7.01': 'operational_update', // Regulation FD Disclosure — almost always a press release
  '8.01': 'operational_update', // Other Events — catch-all for announcements and press releases
};

const HINT_BOOST = 2;

// ─── Weighted keyword patterns ────────────────────────────────────────────────

/**
 * Weight meanings:
 *   3 — extremely specific; almost never appears outside this category
 *   2 — strong signal; occasionally overlaps with other categories
 *   1 — mild signal; useful in combination but alone inconclusive
 *
 * Pattern order within a category does not affect the result (all are tested).
 */
const KEYWORD_PATTERNS: Record<ScoredCategory, Array<[RegExp, number]>> = {

  financing: [
    [/\bconvertible\s+(?:note|loan|debt|promissory)\b/i,     3],
    [/\bsecurities\s+purchase\s+agreement\b/i,                3],
    [/\bequity\s+line\s+of\s+credit\b/i,                     3],
    [/\bpromissory\s+note\b/i,                                3],
    [/\bprivate\s+placement\b/i,                              2],
    [/\bconversion\s+price\b/i,                               2],
    [/\bprincipal\s+amount\b/i,                               2],
    [/\bcredit\s+(?:facility|agreement|line)\b/i,             1],
    [/\bloan\s+agreement\b/i,                                 1],
    [/\bregistration\s+rights\b/i,                            1],
    [/\bwarrant[s]?\s+to\s+purchase\b/i,                     1],
    [/\binterest\s+rate\b/i,                                  1],
    [/\bmaturity\s+date\b/i,                                  1],
    [/\baccredited\s+investor[s]?\b/i,                        1],
    [/\bplacement\s+agent\b/i,                                1],
  ],

  partnership: [
    [/\bjoint\s+venture\b/i,                                  3],
    [/\bletter\s+of\s+intent\b/i,                             3],
    [/\bmemorandum\s+of\s+understanding\b/i,                  3],
    [/\bcollaboration\s+agreement\b/i,                        3],
    [/\blicense\s+agreement\b/i,                              2],
    [/\bdistribution\s+agreement\b/i,                         2],
    [/\bsupply\s+agreement\b/i,                               2],
    [/\bstrategic\s+(?:alliance|partnership)\b/i,             2],
    [/\bpartnership\s+agreement\b/i,                          2],
    [/\bjoint\s+development\s+agreement\b/i,                  2],
    [/\bexclusive\s+license\b/i,                              1],
    [/\bacquisition\s+agreement\b/i,                          1],
    [/\bmerger\s+agreement\b/i,                               1],
    [/\breseller\s+agreement\b/i,                             1],
  ],

  product_launch: [
    [/\bFDA\s+(?:approval|clearance|authorization)\b/i,       3],
    [/\b510\(k\)\b/i,                                         3],
    [/\bclinical\s+trial[s]?\b/i,                             2],
    [/\bregulatory\s+(?:approval|clearance)\b/i,              2],
    [/\bproduct\s+launch\b/i,                                 2],
    [/\bPhase\s+[123I]{1,3}\s+(?:trial|study|clinical)\b/i,  2],
    [/\bcommercial(?:ize|ization|ly\s+available)\b/i,         1],
    [/\bnew\s+product\b/i,                                    1],
    [/\bintellectual\s+property\b/i,                          1],
    [/\btechnology\s+(?:platform|solution)\b/i,               1],
    [/\blaunch(?:ed|ing)?\s+(?:its|the|a|new)\b/i,           1],
    [/\bpatent(?:ed)?\s+(?:technology|product)\b/i,           1],
  ],

  management_change: [
    // Weight-3: highly specific — require both the action verb and the title/role
    [/\bappoint(?:ed|ment)\s+(?:of\s+)?(?:a\s+new\s+)?(?:CEO|CFO|COO|president|director|officer)\b/i, 3],
    [/\bresign(?:ation|ed)\s+(?:of|as|from)\b/i,              3],
    [/\bdeparture\s+of\s+(?:(?:the|its|our)\s+)?(?:CEO|CFO|COO|president|chief)\b/i, 3],
    // Weight-2: strong — pairing of action + role
    [/\bnamed\s+(?:as\s+)?(?:CEO|CFO|COO|president|director|chairman)\b/i, 2],
    [/\belected\s+(?:to\s+the\s+board|as\s+(?:chairman|director))\b/i, 2],
    [/\binterim\s+(?:CEO|CFO|COO|president|officer)\b/i,     2],
    [/\btermination\s+of\s+employment\b/i,                    2],
    // Weight-1: title mentions alone — only contribute when combined with other signals.
    // Intentionally low so that press releases quoting a CEO do not reach MIN_SCORE alone.
    [/\bchief\s+executive\s+officer\b/i,                      1],
    [/\bchief\s+financial\s+officer\b/i,                      1],
    [/\bchief\s+operating\s+officer\b/i,                      1],
    // NOTE: "board of directors" removed — appears in too much boilerplate
    // NOTE: "separation agreement" removed — ambiguous with financing contexts
  ],

  operational_update: [
    // Revenue / financial performance announcements
    [/\brecurring\s+(?:monthly\s+)?revenue\b/i,               3],
    [/\brevenue\s+run\s+rate\b/i,                              3],
    [/\bannual\s+recurring\s+revenue\b/i,                     3],
    [/\brevenue\s+(?:milestone|record|forecast|growth)\b/i,   3],
    [/\bsales\s+(?:growth|forecast|milestone|target|record)\b/i, 3],
    // Device / unit deployments (common in robotics, IoT, SaaS-hardware companies)
    [/\bdevices?\s+(?:deployed|delivered|installed|contracted)\b/i, 3],
    [/\bunits?\s+(?:deployed|delivered|installed|shipped|sold)\b/i, 3],
    [/\bdeployment\s+(?:update|milestone|status|of)\b/i,      2],
    // Customer / contract wins (non-financing)
    [/\bpurchase\s+order[s]?\b/i,                             3],
    [/\bclient\s+(?:acceptance|win|deployment|contract)\b/i,  2],
    [/\bcustomer\s+(?:win|deployment|installation|contract)\b/i, 2],
    [/\bservice\s+agreement[s]?\b/i,                          2],
    // General operational press-release signals
    [/\boperational\s+(?:update|milestone|result|success)\b/i, 2],
    [/\bannounces?\s+(?:sales|revenue|deployment|contract|record|growth|result|milestone|forecast)\b/i, 2],
    [/\bproduction\s+(?:update|milestone|capacity|growth)\b/i, 2],
    [/\bquarterly\s+(?:update|revenue|results|report)\b/i,    1],
    [/\bpress\s+release\b/i,                                  1],
    [/\bregulation\s+fd\b/i,                                  1],
    [/\bbusiness\s+(?:update|development|expansion)\b/i,      1],
  ],

};

/**
 * Minimum total keyword score required for a category to win over 'other'.
 * Score 2 is reached by: one weight-3 match, one weight-2 match,
 * two weight-1 matches, or a weight-1 match combined with a HINT_BOOST.
 */
const MIN_SCORE = 2;

/**
 * Compute weighted keyword scores for each category against the cleaned text.
 * Each distinct-pattern match contributes its weight exactly once.
 */
function scoreCategories(text: string): Record<ScoredCategory, number> {
  const scores: Record<ScoredCategory, number> = {
    financing:          0,
    partnership:        0,
    product_launch:     0,
    management_change:  0,
    operational_update: 0,
  };
  for (const [cat, patterns] of Object.entries(KEYWORD_PATTERNS) as [ScoredCategory, Array<[RegExp, number]>][]) {
    for (const [pattern, weight] of patterns) {
      if (pattern.test(text)) scores[cat] += weight;
    }
  }
  return scores;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Classify the primary event type of an 8-K or 8-K/A filing.
 *
 * @param text   Full filing text (HTML or plain; may contain SGML fragments)
 * @param items  Comma-separated 8-K item numbers from the EDGAR index (e.g. "1.01,9.01")
 * @returns      EventType — always defined; defaults to 'other'
 */
export function parseEventType(text: string, items?: string): EventType {
  // 1. Item overrides — deterministic; bypass keyword scan when present.
  //    Only the first matching override fires (items are checked in declaration order).
  if (items) {
    for (const item of items.split(',').map(s => s.trim())) {
      const override = ITEM_OVERRIDES[item];
      if (override) return override;
    }
  }

  // 2. Keyword scoring on stripped text
  const clean  = cleanText(text);
  const scores = scoreCategories(clean);

  // 3. Item hints — boost one category's score for ambiguous items (e.g. 1.01, 7.01)
  if (items) {
    for (const item of items.split(',').map(s => s.trim())) {
      const hint = ITEM_HINTS[item];
      if (hint) scores[hint] += HINT_BOOST;
    }
  }

  // 4. Pick the category with the highest score above the minimum threshold
  let best: ScoredCategory | undefined;
  let bestScore = MIN_SCORE - 1;
  for (const [cat, score] of Object.entries(scores) as [ScoredCategory, number][]) {
    if (score > bestScore) {
      bestScore = score;
      best      = cat;
    }
  }

  return best ?? 'other';
}
