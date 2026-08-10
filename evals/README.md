# OTCIntel — Evaluation System

This directory contains the golden evaluation dataset and runner for OTCIntel's SEC extraction system.

## Structure

```
evals/
  golden/             Golden cases, one JSON file per filing
    AITX/
    WXYZ/
    EFGH/
    ABCD/
  results/            Output directory for saved eval runs (gitignored artifacts)
  run.eval.ts         Vitest entry point — runs all golden cases
```

## Running Evaluations

```bash
npm run eval             # concise summary (pass/fail per case)
npm run eval:verbose     # field-level detail on every case
```

Exit code 0 = all verified fields match. Exit code 1 = at least one verified regression.

`needs_domain_review` field mismatches produce warnings but do NOT fail the run.

## Adding a Golden Case

See `docs/EVALUATION_FRAMEWORK.md` for the full workflow.

Quick checklist:
1. Add a JSON file under `evals/golden/<TICKER>/`
2. Set `fixtureSource` to `mock_rawFilings`, `file_snapshot`, or `stored_output_snapshot`
3. Mark only fields you have verified from primary source text as `"verified"`
4. Mark uncertain fields as `"needs_domain_review"`
5. Run `npm run eval` to confirm the new case passes

## Domain Review

Fields marked `needs_domain_review` require a human to:
- Read the original filing text
- Confirm the parser's interpretation is correct
- Update the golden case to `"verified"` and commit

See `docs/EVALUATION_FRAMEWORK.md` for the verification protocol.
