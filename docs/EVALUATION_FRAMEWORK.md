# OTCIntel — Evaluation Framework

This document describes OTCIntel's golden evaluation system for SEC extraction regression testing.

---

## What Is a Golden Case?

A golden case is a manually verified record of what the parser **should** extract from a specific SEC filing. It answers: "Given this exact filing text, what are the correct output values for these fields?"

Golden cases serve as a regression contract. When parser logic changes, the eval run flags regressions before they reach production data. Unlike unit tests that verify parser mechanics, golden cases verify **parser accuracy against real financial text**.

Golden case files live in `evals/golden/<TICKER>/<CASE_ID>.json`.

---

## Why OTCIntel Uses This Approach

OTC filings are adversarially ambiguous. Issuers use non-standard language, bury material terms in exhibits, and reference external documents. The only reliable source of truth is the original filing text read by a human who understands OTC financing instruments.

Unit tests verify that the parser *runs correctly*. Golden cases verify that it *extracts correctly*.

---

## Field Verification Status

Every field expectation has one of two statuses:

### `"verified"`
The expected value has been independently confirmed by reading the source filing text. A `verified` mismatch is a regression — it means the parser used to get this right and now doesn't, or the parser never got it right and the golden case was wrong.

**`verified` mismatches fail the eval run (non-zero exit code).**

### `"needs_domain_review"`
The expected value is the parser's output or a reasonable guess, but has not been confirmed by reading the source text. These exist to track known uncertainties.

**`needs_domain_review` mismatches produce warnings but do NOT fail the eval run.**

---

## How to Add a New Golden Case

### Step 1 — Choose a Filing

Pick a filing that exercises a specific parser path:
- An 8-K or 8-K/A with a convertible note → `ExtractedFinancingTerms`
- A 10-K or 10-Q with multiple notes → `FinancingReport` → `ConvertibleNote`
- A 10-Q or 10-K with share structure → `ExtractedShareStructure`

### Step 2 — Choose a Fixture Source

| Source | When to use |
|--------|-------------|
| `mock_rawFilings` | Filing text exists in `lib/mock/rawFilings.ts`. Use `fixtureKey` + `fixtureIndex`. |
| `file_snapshot` | You have a copy of the raw EDGAR text saved to `evals/fixtures/`. |
| `stored_output_snapshot` | No raw text available; compare against already-stored `NormalizedFiling` output in `data/filings/`. |

### Step 3 — Write the Case File

```json
{
  "$schema": "1.0.0",
  "id": "TICK-8K-0001234567-26-000001",
  "description": "8-K convertible note — Funder Inc, $500K principal, 78% VWAP",
  "ticker": "TICK",
  "cik": "0001234567",
  "formType": "8-K",
  "filedAt": "2026-01-15",
  "accessionNumber": "0001234567-26-000001",
  "fixtureSource": "mock_rawFilings",
  "fixtureKey": "TICK",
  "fixtureIndex": 0,
  "evaluationTarget": "ExtractedFinancingTerms",
  "expected": {
    "financingType": { "value": "convertible_note", "status": "verified" },
    "principalAmount": { "value": 500000, "status": "verified" },
    "discountRate": {
      "value": 0.22,
      "status": "verified",
      "note": "Text says '78% of VWAP' → discount = 1 - 0.78 = 0.22"
    },
    "investorName": {
      "value": "Funder Inc",
      "status": "needs_domain_review",
      "note": "Parser-extracted; source text not yet reviewed"
    }
  }
}
```

### Step 4 — Verify Fields from Primary Source

For each `"needs_domain_review"` field:
1. Open the EDGAR filing at `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=<CIK>&type=8-K`
2. Find the specific accession number
3. Read the relevant exhibit or section
4. If the parser value is correct, change `"status": "verified"`
5. If the parser value is wrong, correct `"value"` and set `"status": "verified"`
6. Add a `"note"` explaining the exact source sentence

### Step 5 — Run and Confirm

```bash
npm run eval
```

The new case must pass (all `verified` fields match) before committing.

---

## Founder / Domain Review Workflow

When a field's correct value requires judgment about OTC financing conventions (e.g. whether a "65% of lowest trading price" clause represents a conversion factor or a discount rate), it stays `needs_domain_review` until the founder reviews it.

**Review process:**

1. Run `npm run eval:verbose` to see all `needs_domain_review` warnings
2. Read the original filing text for each flagged field
3. Apply the domain interpretation (e.g. "discount rate = 1 - conversion factor" vs "discount rate = conversion factor")
4. Update the golden case JSON and the relevant field to `"verified"`
5. If the parser was wrong, file a parser bug and do NOT mark it `verified` until the parser is fixed

---

## How Parser Changes Should Be Tested

**Before any change to extraction logic:**

1. Run `npm run eval` — record current pass/fail state
2. Make the parser change
3. Run `npm run eval` again
4. If any `verified` field regresses, the change broke a known-correct extraction

**Material parser changes must not be merged if verified golden cases regress** without explicit domain approval and a documented reason.

Minor changes (cosmetic, unused code paths, unrelated logic) do not need eval confirmation, but running it costs nothing and should be a habit.

---

## When to Increment PARSER_VERSION

`PARSER_VERSION` is defined in `lib/universe/types.ts` and stamped on every `NormalizedFiling`. It triggers automatic reprocessing of stale filings on the next ingest run.

**Increment when:**
- A field's extraction logic changes materially (different algorithm, different regex)
- A field's *interpretation* changes (e.g. discount vs. conversion factor)
- A previously unsupported field is now extracted
- A field is removed or renamed

**Do NOT increment when:**
- Changes are test-only
- Changes are documentation-only
- Changes are UI-only
- Changes refactor internals without changing field outputs
- Changes fix a bug that affects only filings not yet in `data/`

When you increment, note in the commit message which fields changed and why.

---

## How to Interpret Evaluation Metrics

The eval report prints two sections:

### Case summary

| Column | Meaning |
|--------|---------|
| `PASS` | All verified fields matched |
| `FAIL` | One or more verified fields mismatched or were missing |
| `ERROR` | Fixture could not be loaded — likely a missing file or wrong key |

### Category breakdown

Fields are grouped by category (IDENTITY, FINANCIAL_TERMS, CONVERSION_TERMS, TIMING, WARRANTS, SHARE_STRUCTURE). The breakdown shows how many verified fields matched per category — useful for spotting systematic parser failures (e.g. all CONVERSION_TERMS fail after a regex change).

### Review warnings

Fields with `needs_domain_review` status are listed separately. They are never a failure. They exist to remind the reviewer that those fields still need human confirmation.

---

## Why Unverified Parser Output Cannot Become Golden Automatically

If we allowed the parser's own output to auto-populate golden cases, we would be testing that the parser is consistent with itself — not that it's correct. A parser that always extracts `discountRate: 0.65` when the text says "65% of lowest trading price" would pass all its own golden cases while being systematically wrong.

Golden cases must be anchored to primary source text read by a human. The verification process is intentionally manual and friction-ful to preserve the signal.

---

## CI Integration (Target State)

The desired CI sequence when CI is added:

```
npm test          → all unit tests pass
npm run eval      → all verified golden expectations pass  
npx tsc --noEmit  → TypeScript clean
npm run lint      → 0 errors
npm run build     → Next.js production build clean
```

The eval step must run after unit tests (it depends on the compiled parser modules) and before type-check (catches parser logic issues before catching type issues).

No CI infrastructure exists yet. These scripts can be run locally in the sequence above.
