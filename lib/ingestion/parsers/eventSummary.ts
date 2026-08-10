/**
 * 8-K event summary parser
 *
 * Extracts a 1–2 sentence plain-text description of the primary event
 * disclosed in an 8-K filing. Regex-only — fast and dependency-free.
 *
 * Strategy (in priority order):
 *   1. Identify the primary 8-K item from the `items` field or text headings.
 *   2. Extract the body text of that item section (inline — no line-break required).
 *   3. Strip the section title (capitalized header words before the body begins).
 *   4. Take the first 1–2 sentences, capped at MAX_CHARS.
 *   5. Fall back to scanning the full document for key event-action phrases.
 *   6. Last resort: synthesize one sentence from the item label.
 *
 * Returns undefined rather than throwing on malformed or empty input.
 */

// ─── HTML / entity cleaning ───────────────────────────────────────────────────

const HTML_TAG_RE = /<[^>]{0,500}>/g;

const ENTITY_MAP: [string, string][] = [
  ['&nbsp;',  ' '],
  ['&amp;',   '&'],
  ['&lt;',    '<'],
  ['&gt;',    '>'],
  ['&quot;',  '"'],
  ['&apos;',  "'"],
  ['&#8220;', '\u201C'],
  ['&#8221;', '\u201D'],
  ['&#8216;', '\u2018'],
  ['&#8217;', '\u2019'],
  ['&#8212;', '\u2014'],
  ['&#8211;', '\u2013'],
];

function stripHtml(raw: string): string {
  let s = raw.replace(HTML_TAG_RE, ' ');
  for (const [entity, char] of ENTITY_MAP) {
    // split/join avoids the need for the 'g' flag and is runtime-safe
    s = s.split(entity).join(char);
  }
  // Decode remaining numeric entities
  s = s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  return s.replace(/\s+/g, ' ').trim();
}

// ─── 8-K item registry ────────────────────────────────────────────────────────

/**
 * Substantive 8-K items in priority order.
 * Item 9.01 (exhibits) is intentionally excluded.
 */
const SIGNAL_ITEMS = [
  '1.01', '1.02',
  '2.01', '2.02', '2.03', '2.04',
  '3.01', '3.02',
  '4.01',
  '5.01', '5.02', '5.03', '5.07',
  '7.01', '8.01',
] as const;

/**
 * Fallback prose when body-text extraction yields nothing useful.
 */
const ITEM_LABELS: Record<string, string> = {
  '1.01': 'entered into a material definitive agreement',
  '1.02': 'terminated a material definitive agreement',
  '2.01': 'completed an acquisition or disposition of assets',
  '2.02': 'reported financial results',
  '2.03': 'incurred a direct financial obligation',
  '2.04': 'triggered an off-balance-sheet obligation',
  '3.01': 'received notice of delisting',
  '3.02': 'sold unregistered securities',
  '4.01': 'changed its independent auditor',
  '5.01': 'underwent a change of control',
  '5.02': 'made a director or officer change',
  '5.03': 'amended its charter or bylaws',
  '5.07': 'reported a shareholder vote result',
  '7.01': 'made a Regulation FD disclosure',
  '8.01': 'disclosed an other reportable event',
};

/**
 * Return the first signal item from the structured items string (e.g. "1.01,9.01")
 * or by scanning the cleaned text for "Item X.XX" headings.
 */
function findPrimaryItem(clean: string, items?: string): string | undefined {
  if (items) {
    const parts = items.split(',').map(s => s.trim());
    for (const signal of SIGNAL_ITEMS) {
      if (parts.includes(signal)) return signal;
    }
  }
  for (const signal of SIGNAL_ITEMS) {
    const escaped = signal.replace('.', '\\.');
    if (new RegExp(`Item\\s+${escaped}[^\\d]`, 'i').test(clean)) return signal;
  }
  return undefined;
}

// ─── Sentence extraction ──────────────────────────────────────────────────────

const MAX_CHARS = 300;

/**
 * Split text into sentences on ". " followed by a capital letter, digit, or
 * opening quote. Filters out very short fragments (likely headers / artefacts).
 */
function splitSentences(text: string): string[] {
  return text
    .split(/\.(?=\s+[A-Z0-9\u201C"'])/)
    .map(s => s.trim())
    .filter(s => s.length > 25);
}

/**
 * Take the first 1–2 sentences from a block of text, capped at MAX_CHARS.
 */
function takeSentences(block: string): string | undefined {
  const sentences = splitSentences(block);
  if (sentences.length === 0) return undefined;

  let result = sentences[0].trimEnd() + '.';

  if (sentences.length > 1 && result.length < MAX_CHARS / 2) {
    const extended = result + ' ' + sentences[1].trimEnd() + '.';
    if (extended.length <= MAX_CHARS) result = extended;
  }

  if (result.length > MAX_CHARS) {
    result = result.slice(0, MAX_CHARS - 1).trimEnd() + '\u2026';
  }

  return result;
}

/**
 * Patterns that identify where the body of an 8-K item section begins.
 *
 * After HTML stripping, an item section looks like:
 *   "Item 1.01 Entry into a Material Definitive Agreement On March 5, 2026,
 *    the Company entered into..."
 *
 * The title words ("Entry into a Material Definitive Agreement") precede the
 * body. These patterns anchor on common 8-K body openers so we can skip the
 * title and start from the actual narrative.
 */
const BODY_START_PATTERNS: RegExp[] = [
  /On\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d/i,
  /The\s+(?:Company|Registrant|Board|Corporation|following)/i,
  /Pursuant\s+to/i,
  /Effective\s+/i,
  /As\s+previously\s+(?:disclosed|announced|reported)/i,
  /In\s+connection\s+with/i,
  /We\s+(?:have|are|will|entered|completed|announced)/i,
  /On\s+(?:or\s+about|the\s+date)/i,
];

/**
 * Locate the body of the primary item section in the cleaned text.
 *
 * Unlike a naive line-split approach, this handles the common case where EDGAR
 * renders the item heading and body inline on a single line after HTML stripping.
 */
function extractFromItemSection(clean: string, item: string): string | undefined {
  const escaped = item.replace('.', '\\.');

  // Match "Item X.XX" and capture everything that follows.
  // No line-break required — the section may be entirely inline after stripping.
  const sectionRe = new RegExp(`Item\\s+${escaped}\\s+([\\s\\S]{20,})`, 'i');
  const match = clean.match(sectionRe);
  if (!match) return undefined;

  let body = match[1];

  // Trim at the next item heading so we don't bleed into the following section
  const nextItemIdx = body.search(/Item\s+\d+\.\d+/i);
  if (nextItemIdx > 0) body = body.slice(0, nextItemIdx);

  body = body.trim();
  if (body.length < 30) return undefined;

  // Strip the section title by finding the first body-start pattern.
  // Search only the first 250 chars — the title is always short.
  const searchWindow = body.slice(0, 250);
  let bodyStart = -1;
  for (const pattern of BODY_START_PATTERNS) {
    const m = searchWindow.match(pattern);
    if (m && m.index !== undefined) {
      if (bodyStart === -1 || m.index < bodyStart) bodyStart = m.index;
    }
  }
  if (bodyStart > 0) body = body.slice(bodyStart);

  body = body.trim();
  if (body.length < 30) return undefined;

  const result = takeSentences(body);
  if (!result) return undefined;

  // Reject boilerplate cross-reference and Reg FD safe-harbour text.
  // These patterns appear in Item 7.01 / 8.01 "furnished" filings and in
  // Item 2.03 cross-references where the body only points at Item 1.01.
  const BOILERPLATE = [
    /The information (?:set forth|contained) (?:in|under)/i,  // cross-refs (any form)
    /is (?:being )?furnished pursuant to/i,
    /incorporated herein by reference/i,
    /shall not be deemed to be .filed./i,
    /The following information is furnished/i,
  ];
  if (BOILERPLATE.some(p => p.test(result))) return undefined;

  // Reject pure section-title echoes — a real event sentence always contains
  // an action verb; a title noun phrase does not.  No length gate: titles can
  // be long ("Creation of a Direct Financial Obligation...").
  const hasVerb = /\b(?:entered|completed|announced|appointed|issued|terminated|amended|acquired|sold|approved|authorized|reported|declared|granted|increased|decreased|changed|disclosed|filed|executed|closed|issuing|providing|winning|expanding|completes|received|signed|raised|agreed|elected|hired|resigned|updated|extended|converted|redeemed)\b/i.test(result);
  if (!hasVerb) return undefined;

  return result;
}

// ─── Key-phrase fallback ──────────────────────────────────────────────────────

/**
 * Patterns that capture the primary event sentence anywhere in the document.
 * Ordered from most specific to most generic — first match wins.
 *
 * Includes date-prefixed patterns (e.g. "On April 24, 2026, we will be
 * issuing...") which are extremely common in 8-K filings for press releases
 * and event notifications.
 */
const EVENT_PHRASE_PATTERNS: RegExp[] = [
  // Date-prefixed announcements — most common 8-K opener
  /On\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4},[^.]{10,250}\./i,
  // Entry into agreement
  /[A-Z][^.]{0,80}entered\s+into\s+(?:a\s+|an\s+|the\s+)?[^.]{10,200}\./i,
  // Completion of transaction
  /[A-Z][^.]{0,80}completed\s+(?:the\s+|its\s+|a\s+)?[^.]{10,200}\./i,
  // Director / officer appointment
  /[A-Z][^.]{0,80}(?:appointed|elected|named)\s+[^.]{10,100}(?:\s+as\s+|\s+to\s+)[^.]{5,100}\./i,
  // Termination / amendment
  /[A-Z][^.]{0,80}(?:terminated|amended|modified)\s+[^.]{10,100}(?:agreement|arrangement|contract|note)[^.]{0,100}\./i,
  // Acquisition / disposal
  /[A-Z][^.]{0,80}(?:acquired|sold|disposed\s+of)\s+[^.]{10,200}\./i,
  // Securities issuance
  /[A-Z][^.]{0,80}(?:issued|will\s+issue|agreed\s+to\s+issue)\s+[^.]{10,150}(?:shares|notes|warrants|securities)[^.]{0,80}\./i,
  // Press release reference (8.01 filings often attach one)
  /[A-Z][^.]{0,80}(?:issuing|issued)\s+a\s+press\s+release[^.]{0,200}\./i,
  // General announcement
  /[A-Z][^.]{0,80}announced\s+[^.]{10,200}\./i,
  // Board / shareholder approval
  /[A-Z][^.]{0,80}(?:approved|authorized)\s+[^.]{10,200}\./i,
];

function extractEventPhrase(clean: string): string | undefined {
  for (const pattern of EVENT_PHRASE_PATTERNS) {
    const match = clean.match(pattern);
    if (match) {
      let sentence = match[0].trim();
      if (sentence.length > MAX_CHARS) {
        sentence = sentence.slice(0, MAX_CHARS - 1).trimEnd() + '\u2026';
      }
      return sentence;
    }
  }
  return undefined;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Extract a 1–2 sentence plain-text event summary from an 8-K filing.
 *
 * @param text   Full filing text (HTML or plain; may contain SGML fragments)
 * @param items  Comma-separated 8-K item numbers from the EDGAR index (e.g. "1.01,9.01")
 * @returns      Plain-text summary, or undefined if no useful text could be extracted
 */
export function parseEventSummary(text: string, items?: string): string | undefined {
  if (!text || text.length < 50) return undefined;

  const clean = stripHtml(text);
  const primaryItem = findPrimaryItem(clean, items);

  // 1. Section-based extraction (most precise — scoped to the right item)
  if (primaryItem) {
    const fromSection = extractFromItemSection(clean, primaryItem);
    if (fromSection) return fromSection;
  }

  // 2. Key-phrase scan across the full document
  const fromPhrase = extractEventPhrase(clean);
  if (fromPhrase) {
    const isBoilerphrase =
      /incorporated herein by reference/i.test(fromPhrase) ||
      /(?:is|being) furnished pursuant to/i.test(fromPhrase);
    if (!isBoilerphrase) return fromPhrase;
  }

  // 3. Synthesize from item label (always produces something if item is known)
  if (primaryItem && ITEM_LABELS[primaryItem]) {
    return `The company ${ITEM_LABELS[primaryItem]}.`;
  }

  return undefined;
}
