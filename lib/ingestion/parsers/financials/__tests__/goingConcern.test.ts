/**
 * Tests for lib/ingestion/parsers/financials/goingConcern.ts
 *
 * Coverage:
 *   1.  Explicit "substantial doubt" → high confidence
 *   2.  "Our ability to continue as a going concern" → medium confidence
 *   3.  Management plans language → high confidence (alleviate substantial doubt)
 *   4.  Auditor going-concern opinion language → high confidence
 *   5.  10-Q going-concern disclosure → high confidence
 *   6.  Strongest sentence selected when multiple matches exist
 *   7.  Whitespace/newline normalization — sentence spans line breaks
 *   8.  Accounting-standard boilerplate filtered (ASU 2014-15, ASC 205-40, AS 2415)
 *   9.  Table-of-contents entry filtered
 *  10.  No going-concern language → flag false, no matched sentence
 *  11.  Weak ambiguous language → low confidence
 *  12.  matchedSentence is the normalized, full sentence containing the phrase
 *  13.  Empty / null-equivalent input → flag false
 *  14.  "Conditions and events" language → high confidence
 */

import { describe, it, expect } from 'vitest';
import { detectGoingConcern } from '../goingConcern';

// ─── Fixture helpers ──────────────────────────────────────────────────────────

/** Minimal going-concern paragraph. */
const HIGH_DOUBT_SENTENCE =
  'These conditions raise substantial doubt about the Company\'s ability to continue as a going concern.';

/** Full auditor note paragraph containing both boilerplate prep language and the opinion. */
const AUDITOR_NOTE = [
  'The accompanying financial statements have been prepared assuming that the Company will continue as a going concern.',
  'As discussed in Note 2 to the financial statements, the Company has incurred recurring losses from operations.',
  'These factors raise substantial doubt about the Company\'s ability to continue as a going concern.',
  'The financial statements do not include any adjustments that might result from the outcome of this uncertainty.',
].join(' ');

/** 10-Q going-concern note with specific numbers. */
const TEN_Q_NOTE = [
  'For the nine months ended September 30, 2025, the Company had a net loss of $4.2 million and used $2.8 million in operating activities.',
  'As of September 30, 2025, the Company had cash and cash equivalents of $0.6 million and an accumulated deficit of $31.4 million.',
  'These factors raise substantial doubt about the Company\'s ability to continue as a going concern within the next twelve months.',
  'Management intends to raise additional capital through private placements and strategic partnerships.',
].join(' ');

/** Management response to going concern — plans to alleviate the doubt. */
const MGMT_PLANS =
  'Management has evaluated these conditions and has developed plans to alleviate the substantial doubt about the Company\'s ability to continue as a going concern.';

/** Boilerplate sentence referencing ASU 2014-15. */
const ASU_BOILERPLATE =
  'Accounting Standards Update No. 2014-15 requires management to evaluate whether conditions and events that raise substantial doubt about a company\'s ability to continue as a going concern exist within one year after the date that the financial statements are issued.';

/** Boilerplate referencing ASC 205-40 directly. */
const ASC_BOILERPLATE =
  'In accordance with ASC 205-40, Presentation of Financial Statements—Going Concern, management must assess the ability to continue as a going concern for twelve months from the balance sheet date.';

/** AS 2415 boilerplate from an audit report. */
const AS_2415_BOILERPLATE =
  'The Company\'s independent auditors are required to evaluate going concern pursuant to AS No. 2415, Consideration of an Entity\'s Ability to Continue as a Going Concern.';

/** Table of contents style entry. */
const TOC_ENTRY = 'Going Concern .............. 24';

/** Table of contents with F-page numbering. */
const TOC_ENTRY_FPAGE = 'Going Concern F-12';

/** Sentence with only a mention of "going concern" — no explicit doubt. */
const WEAK_MENTION =
  'The Company annually assesses its operations and liquidity position in relation to going concern considerations under applicable accounting guidance.';

/** Document with no going concern language at all. */
const NO_GC_TEXT =
  'The Company recognized revenue of $12.3 million for the year ended December 31, 2025, compared to $9.8 million in 2024.';

// ─── 1. Explicit substantial doubt (high confidence) ─────────────────────────

describe('detectGoingConcern — high confidence detection', () => {
  it('detects explicit "raise substantial doubt about ability to continue" → high', () => {
    const result = detectGoingConcern(HIGH_DOUBT_SENTENCE);

    expect(result.goingConcernFlag).toBe(true);
    expect(result.confidence).toBe('high');
    expect(result.sourceType).toBe('filing_text');
  });

  it('detects "raised substantial doubt about our ability to continue as a going concern"', () => {
    const text = 'Net recurring losses from operations raised substantial doubt about our ability to continue as a going concern.';
    const result = detectGoingConcern(text);

    expect(result.goingConcernFlag).toBe(true);
    expect(result.confidence).toBe('high');
  });

  it('detects "substantial doubt about the Company\'s ability to continue as a going concern"', () => {
    const text = 'Management concluded that substantial doubt about the Company\'s ability to continue as a going concern existed as of December 31, 2025.';
    const result = detectGoingConcern(text);

    expect(result.goingConcernFlag).toBe(true);
    expect(result.confidence).toBe('high');
  });

  it('detects "substantial doubt exists about" variant', () => {
    const text = 'As of the balance sheet date, substantial doubt exists about whether the entity can continue as a going concern through the next fiscal year.';
    const result = detectGoingConcern(text);

    expect(result.goingConcernFlag).toBe(true);
    expect(result.confidence).toBe('high');
  });
});

// ─── 2. Ability language without "substantial doubt" (medium confidence) ──────

describe('detectGoingConcern — medium confidence detection', () => {
  it('detects "ability to continue as a going concern" without explicit doubt → medium', () => {
    const text = 'The Board of Directors is evaluating our ability to continue as a going concern through the end of fiscal 2026.';
    const result = detectGoingConcern(text);

    expect(result.goingConcernFlag).toBe(true);
    expect(result.confidence).toBe('medium');
  });

  it('detects "going concern uncertainty" phrasing → medium', () => {
    const text = 'The Company disclosed a going concern uncertainty in its most recent 10-K filing dated March 15, 2025.';
    const result = detectGoingConcern(text);

    expect(result.goingConcernFlag).toBe(true);
    expect(result.confidence).toBe('medium');
  });

  it('detects auditor-note "prepared assuming the Company will continue as a going concern" → medium', () => {
    const text = 'The financial statements have been prepared assuming that the Company will continue as a going concern.';
    const result = detectGoingConcern(text);

    expect(result.goingConcernFlag).toBe(true);
    expect(result.confidence).toBe('medium');
  });
});

// ─── 3. Management plans language (high confidence) ───────────────────────────

describe('detectGoingConcern — management plans language', () => {
  it('detects "plans to alleviate the substantial doubt" → high', () => {
    const result = detectGoingConcern(MGMT_PLANS);

    expect(result.goingConcernFlag).toBe(true);
    expect(result.confidence).toBe('high');
  });

  it('detects "plans to mitigate the substantial doubt" → high', () => {
    const text = 'Management has implemented plans to mitigate the substantial doubt about our ability to continue as a going concern by securing a $5 million revolving credit facility.';
    const result = detectGoingConcern(text);

    expect(result.goingConcernFlag).toBe(true);
    expect(result.confidence).toBe('high');
  });
});

// ─── 4. Auditor going-concern opinion language ────────────────────────────────

describe('detectGoingConcern — auditor opinion language', () => {
  it('detects the high-confidence phrase within a full auditor note paragraph', () => {
    const result = detectGoingConcern(AUDITOR_NOTE);

    expect(result.goingConcernFlag).toBe(true);
    expect(result.confidence).toBe('high');
  });

  it('includes the matched sentence in the result', () => {
    const result = detectGoingConcern(AUDITOR_NOTE);

    expect(result.matchedSentence).toBeDefined();
    expect(result.matchedSentence!.toLowerCase()).toContain('substantial doubt');
  });
});

// ─── 5. 10-Q going-concern disclosure ────────────────────────────────────────

describe('detectGoingConcern — 10-Q disclosure', () => {
  it('detects high confidence in a typical 10-Q going-concern note', () => {
    const result = detectGoingConcern(TEN_Q_NOTE);

    expect(result.goingConcernFlag).toBe(true);
    expect(result.confidence).toBe('high');
  });

  it('matchedPhrase contains the specific trigger text from the 10-Q', () => {
    const result = detectGoingConcern(TEN_Q_NOTE);

    expect(result.matchedPhrase).toBeDefined();
    expect(result.matchedPhrase!.toLowerCase()).toContain('substantial doubt');
  });
});

// ─── 6. Highest-confidence sentence selected when multiple exist ──────────────

describe('detectGoingConcern — best-sentence selection', () => {
  it('selects the high-confidence sentence even when a weaker sentence appears first', () => {
    const text = [
      'The Company annually assesses going concern risks as part of its reporting process.',
      'Management concluded that these factors raise substantial doubt about the Company\'s ability to continue as a going concern.',
    ].join(' ');

    const result = detectGoingConcern(text);

    expect(result.goingConcernFlag).toBe(true);
    expect(result.confidence).toBe('high');
    expect(result.matchedSentence!.toLowerCase()).toContain('substantial doubt');
  });

  it('returns high over medium when both tiers are present', () => {
    const text = [
      'The financial statements have been prepared assuming the Company will continue as a going concern.',
      'These recurring losses raise substantial doubt about our ability to continue as a going concern.',
    ].join(' ');

    const result = detectGoingConcern(text);

    expect(result.confidence).toBe('high');
  });
});

// ─── 7. Whitespace and newline normalization ──────────────────────────────────

describe('detectGoingConcern — whitespace normalization', () => {
  it('detects the phrase across line breaks and tabs', () => {
    const text =
      'These conditions\n\t  raise substantial\n  doubt about\n  the Company\'s ability to\n  continue as a going\n  concern.';

    const result = detectGoingConcern(text);

    expect(result.goingConcernFlag).toBe(true);
    expect(result.confidence).toBe('high');
  });

  it('normalizes the matchedSentence to a single-space form', () => {
    const text = 'These  factors   raise  substantial   doubt   about  our   ability  to  continue  as  a  going  concern.';
    const result = detectGoingConcern(text);

    expect(result.matchedSentence).toBeDefined();
    expect(result.matchedSentence).not.toMatch(/\s{2,}/);
  });
});

// ─── 8. Accounting-standard boilerplate filtered ──────────────────────────────

describe('detectGoingConcern — boilerplate filtering', () => {
  it('does not flag ASU 2014-15 standard description language', () => {
    const result = detectGoingConcern(ASU_BOILERPLATE);

    expect(result.goingConcernFlag).toBe(false);
  });

  it('does not flag ASC 205-40 reference sentence', () => {
    const result = detectGoingConcern(ASC_BOILERPLATE);

    expect(result.goingConcernFlag).toBe(false);
  });

  it('does not flag AS 2415 auditing standard reference', () => {
    const result = detectGoingConcern(AS_2415_BOILERPLATE);

    expect(result.goingConcernFlag).toBe(false);
  });

  it('still detects a real disclosure in a document that also contains boilerplate', () => {
    const text = [
      ASU_BOILERPLATE,
      HIGH_DOUBT_SENTENCE,
    ].join(' ');

    const result = detectGoingConcern(text);

    expect(result.goingConcernFlag).toBe(true);
    expect(result.confidence).toBe('high');
  });
});

// ─── 9. Table-of-contents entries filtered ───────────────────────────────────

describe('detectGoingConcern — table-of-contents filtering', () => {
  it('does not flag a dotleader TOC entry', () => {
    const result = detectGoingConcern(TOC_ENTRY);

    expect(result.goingConcernFlag).toBe(false);
  });

  it('does not flag an F-page TOC entry', () => {
    const result = detectGoingConcern(TOC_ENTRY_FPAGE);

    expect(result.goingConcernFlag).toBe(false);
  });
});

// ─── 10. No going-concern language ───────────────────────────────────────────

describe('detectGoingConcern — no going-concern language', () => {
  it('returns flag false when the text contains no going-concern language', () => {
    const result = detectGoingConcern(NO_GC_TEXT);

    expect(result.goingConcernFlag).toBe(false);
    expect(result.matchedSentence).toBeUndefined();
    expect(result.matchedPhrase).toBeUndefined();
    expect(result.sourceType).toBe('filing_text');
  });

  it('returns flag false for an empty string', () => {
    const result = detectGoingConcern('');

    expect(result.goingConcernFlag).toBe(false);
  });

  it('returns flag false for whitespace-only input', () => {
    const result = detectGoingConcern('   \n\t  ');

    expect(result.goingConcernFlag).toBe(false);
  });
});

// ─── 11. Weak / ambiguous language (low confidence) ──────────────────────────

describe('detectGoingConcern — low confidence', () => {
  it('assigns low confidence to a passing mention of "going concern" without explicit doubt', () => {
    const result = detectGoingConcern(WEAK_MENTION);

    expect(result.goingConcernFlag).toBe(true);
    expect(result.confidence).toBe('low');
  });
});

// ─── 12. matchedSentence is the full normalized sentence ─────────────────────

describe('detectGoingConcern — provenance (matchedSentence)', () => {
  it('matchedSentence contains the full normalized sentence, not just the trigger phrase', () => {
    const result = detectGoingConcern(HIGH_DOUBT_SENTENCE);

    expect(result.matchedSentence).toBeDefined();
    // Should contain more than just "raise substantial doubt about..."
    expect(result.matchedSentence!.toLowerCase()).toContain('these conditions');
    expect(result.matchedSentence!.toLowerCase()).toContain('going concern');
  });

  it('matchedPhrase is a substring of matchedSentence', () => {
    const result = detectGoingConcern(HIGH_DOUBT_SENTENCE);

    expect(result.matchedSentence).toBeDefined();
    expect(result.matchedPhrase).toBeDefined();
    expect(result.matchedSentence!.toLowerCase()).toContain(
      result.matchedPhrase!.toLowerCase(),
    );
  });
});

// ─── 13. Empty / null-equivalent input ───────────────────────────────────────

describe('detectGoingConcern — edge case inputs', () => {
  it('handles a string of punctuation without crashing', () => {
    expect(() => detectGoingConcern('...')).not.toThrow();
  });

  it('handles a very large block of unrelated text without crashing', () => {
    const longText = 'Revenue increased year over year. '.repeat(5000);
    expect(() => detectGoingConcern(longText)).not.toThrow();
  });
});

// ─── 14. "Conditions and events" language (high confidence) ──────────────────

describe('detectGoingConcern — conditions-and-events disclosure', () => {
  it('detects "conditions and events that raise substantial doubt" with going concern in same sentence → high', () => {
    const text =
      'Management identified conditions and events that raise substantial doubt about the Company\'s ability to continue as a going concern.';
    const result = detectGoingConcern(text);

    expect(result.goingConcernFlag).toBe(true);
    expect(result.confidence).toBe('high');
  });
});

// ─── 15. Negation / resolution suppression ───────────────────────────────────

describe('detectGoingConcern — negation: LQMT exact wording', () => {
  it('does not flag the exact LQMT sentence: "no substantial doubt about ability to continue"', () => {
    const text =
      "Accordingly, we have concluded that there is no substantial doubt about the Company's ability to continue as a going concern.";
    const result = detectGoingConcern(text);

    expect(result.goingConcernFlag).toBe(false);
  });
});

describe('detectGoingConcern — negation: "no substantial doubt" variant', () => {
  it('does not flag "there is no substantial doubt about our ability to continue"', () => {
    const text =
      'As of the balance sheet date, there is no substantial doubt about our ability to continue as a going concern.';
    const result = detectGoingConcern(text);

    expect(result.goingConcernFlag).toBe(false);
  });
});

describe('detectGoingConcern — negation: "concluded/determined that there is no substantial doubt"', () => {
  it('does not flag "we have concluded that there is no substantial doubt"', () => {
    const text =
      "Based on the foregoing, we have concluded that there is no substantial doubt about the Company's ability to continue as a going concern.";
    expect(detectGoingConcern(text).goingConcernFlag).toBe(false);
  });

  it('does not flag "management determined that there is no substantial doubt"', () => {
    const text =
      "Management determined that there is no substantial doubt about the entity's ability to continue as a going concern for twelve months from the reporting date.";
    expect(detectGoingConcern(text).goingConcernFlag).toBe(false);
  });
});

describe('detectGoingConcern — negation: "no longer raises substantial doubt"', () => {
  it('does not flag when management states plans no longer raise substantial doubt', () => {
    const text =
      "Management has assessed its plans and has determined that those conditions and events no longer raise substantial doubt about the entity's ability to continue as a going concern.";
    expect(detectGoingConcern(text).goingConcernFlag).toBe(false);
  });
});

describe('detectGoingConcern — negation: doubt has been alleviated/resolved/eliminated', () => {
  it('does not flag "have alleviated the substantial doubt"', () => {
    const text =
      "Management believes the plans described above have alleviated the substantial doubt about the Company's ability to continue as a going concern.";
    expect(detectGoingConcern(text).goingConcernFlag).toBe(false);
  });

  it('does not flag "the substantial doubt has been resolved"', () => {
    const text =
      "The substantial doubt has been resolved through the completion of a $15 million equity offering and the Company's return to positive operating cash flow.";
    expect(detectGoingConcern(text).goingConcernFlag).toBe(false);
  });

  it('does not flag "the substantial doubt was eliminated"', () => {
    const text =
      'As a result of the subsequent financing events, the substantial doubt was eliminated prior to issuance of these financial statements.';
    expect(detectGoingConcern(text).goingConcernFlag).toBe(false);
  });
});

describe('detectGoingConcern — negation: "no conditions or events that raise substantial doubt"', () => {
  it('does not flag "no conditions or events that raise substantial doubt"', () => {
    const text =
      "Management has evaluated relevant conditions and events and has determined that there are no conditions or events that raise substantial doubt about the entity's ability to continue as a going concern.";
    expect(detectGoingConcern(text).goingConcernFlag).toBe(false);
  });
});

// ─── 16. Conservative "mitigated" — true positives not suppressed ─────────────

describe('detectGoingConcern — conservative mitigated: plans to mitigate → true', () => {
  it('does not suppress "plans intended to mitigate the substantial doubt" (in-progress intention)', () => {
    const text =
      "Management's plans are intended to mitigate the substantial doubt about the Company's ability to continue as a going concern through equity raises and cost reductions.";
    const result = detectGoingConcern(text);

    expect(result.goingConcernFlag).toBe(true);
  });

  it('does not suppress "plans to mitigate substantial doubt" (existing Tier-1 pattern)', () => {
    const text =
      "Management has implemented plans to mitigate the substantial doubt about our ability to continue as a going concern by securing a $5 million revolving credit facility.";
    const result = detectGoingConcern(text);

    expect(result.goingConcernFlag).toBe(true);
    expect(result.confidence).toBe('high');
  });
});

// ─── 17. True-positive regression guards ─────────────────────────────────────

describe('detectGoingConcern — true-positive regressions after negation fix', () => {
  it('still flags "raises substantial doubt about ability to continue as a going concern"', () => {
    const text =
      "These conditions raise substantial doubt about the Company's ability to continue as a going concern.";
    const result = detectGoingConcern(text);

    expect(result.goingConcernFlag).toBe(true);
    expect(result.confidence).toBe('high');
  });

  it('still flags "substantial doubt exists about" variant', () => {
    const text =
      'As of the balance sheet date, substantial doubt exists about whether the entity can continue as a going concern through the next fiscal year.';
    const result = detectGoingConcern(text);

    expect(result.goingConcernFlag).toBe(true);
    expect(result.confidence).toBe('high');
  });

  it('still flags "conditions and events that raise substantial doubt"', () => {
    const text =
      "Management identified conditions and events that raise substantial doubt about the Company's ability to continue as a going concern.";
    const result = detectGoingConcern(text);

    expect(result.goingConcernFlag).toBe(true);
    expect(result.confidence).toBe('high');
  });

  it('boilerplate + genuine disclosure in same document: still flags true', () => {
    const boilerplate =
      'ASU No. 2014-15 requires management to evaluate whether conditions and events that raise substantial doubt about a company\'s ability to continue as a going concern exist.';
    const genuine =
      'These recurring losses raise substantial doubt about the Company\'s ability to continue as a going concern.';
    const result = detectGoingConcern(`${boilerplate} ${genuine}`);

    expect(result.goingConcernFlag).toBe(true);
    expect(result.confidence).toBe('high');
    expect(result.matchedSentence!).toContain('recurring losses');
  });
});

// ─── 18. HTML pre-processing ─────────────────────────────────────────────────

describe('detectGoingConcern — HTML: paragraph boundary does not bleed into matchedSentence', () => {
  it('matchedSentence contains no HTML tags and no text from subsequent paragraphs', () => {
    const html =
      '<p>These factors raise substantial doubt about the Company\'s ability to continue as a going concern.</p>' +
      '<p>The Company generated revenue of $2.1 million in the period ended March 31, 2026.</p>';
    const result = detectGoingConcern(html);

    expect(result.goingConcernFlag).toBe(true);
    expect(result.matchedSentence).toBeDefined();
    expect(result.matchedSentence!).not.toContain('</p>');
    expect(result.matchedSentence!).not.toContain('<p>');
    expect(result.matchedSentence!).not.toContain('revenue');
    expect(result.matchedSentence!).toContain('substantial doubt');
  });
});

describe('detectGoingConcern — HTML: &#8217; decoded to apostrophe in matchedSentence', () => {
  it('decodes &#8217; so matchedSentence contains a readable apostrophe', () => {
    const text =
      "These factors raise substantial doubt about the Company&#8217;s ability to continue as a going concern.";
    const result = detectGoingConcern(text);

    expect(result.goingConcernFlag).toBe(true);
    expect(result.matchedSentence!).not.toContain('&#8217;');
    expect(result.matchedSentence!).toContain("Company's");
  });
});

describe('detectGoingConcern — HTML: &#160; (non-breaking space) treated as whitespace', () => {
  it('detects the phrase even when &#160; appears between words', () => {
    const text =
      "These conditions raise substantial&#160;doubt about the Company&#8217;s ability to continue as a going concern.";
    const result = detectGoingConcern(text);

    expect(result.goingConcernFlag).toBe(true);
    expect(result.matchedSentence!).not.toContain('&#160;');
    expect(result.matchedSentence!).not.toContain('&#8217;');
  });
});

// ─── 19. Plain-text input unchanged ──────────────────────────────────────────

describe('detectGoingConcern — plain-text input produces identical results after HTML step', () => {
  it('plain-text high-confidence sentence still returns true/high with no mutation', () => {
    const text =
      "These conditions raise substantial doubt about the Company's ability to continue as a going concern.";
    const result = detectGoingConcern(text);

    expect(result.goingConcernFlag).toBe(true);
    expect(result.confidence).toBe('high');
    expect(result.matchedSentence).toBe(text);
  });

  it('plain-text no-GC document still returns false with no crash', () => {
    const text =
      'The Company recognized revenue of $12.3 million for the year ended December 31, 2025, compared to $9.8 million in 2024.';
    expect(detectGoingConcern(text).goingConcernFlag).toBe(false);
  });
});
