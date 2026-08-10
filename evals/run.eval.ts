/**
 * OTCIntel — Golden Evaluation Runner (vitest entry point)
 *
 * Run with:
 *   npm run eval             — concise summary report
 *   npm run eval:verbose     — field-level detail for every case
 *
 * Exit code:
 *   0 — all verified golden expectations passed
 *   1 — one or more verified golden expectations regressed
 *
 * "needs_domain_review" mismatches produce console warnings but do NOT fail the run.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { loadAllGoldenCases } from '@/lib/evals/loader';
import { runAllEvalCases } from '@/lib/evals/runner';
import { computeMetrics, formatConciseReport, formatVerboseReport } from '@/lib/evals/metrics';
import type { GoldenCase, CaseResult, EvalMetrics } from '@/lib/evals/types';

// ─── Run all cases and collect results ───────────────────────────────────────

let allCases:   GoldenCase[]  = [];
let allResults: CaseResult[]  = [];
let metrics:    EvalMetrics | null = null;

const verbose = process.env.EVAL_VERBOSE === '1';

beforeAll(() => {
  allCases   = loadAllGoldenCases();
  allResults = runAllEvalCases(allCases);
  metrics    = computeMetrics(allResults);

  // Print the report once (not per-test)
  const report = verbose
    ? formatVerboseReport(allResults, metrics)
    : formatConciseReport(allResults, metrics);

  console.log(report);
});

// ─── One test per golden case ─────────────────────────────────────────────────

describe('Golden evaluation cases', () => {
  // The actual per-case tests are generated dynamically in the beforeAll suite.
  // We create placeholder it() blocks so each case appears in vitest output.
  // The real assertion is in the aggregate test below.
  it('eval cases loaded', () => {
    expect(allCases.length).toBeGreaterThan(0);
  });
});

describe('Per-case verified field assertions', () => {
  // This suite runs after beforeAll resolves. We use a late-binding pattern
  // because vitest requires it() to be declared at module scope (not inside beforeAll).
  // The assertion logic therefore depends on the shared allResults array.
  it('all verified golden expectations pass', () => {
    if (!metrics) throw new Error('metrics not computed');

    const failures = allResults.filter(r => !r.passed && !r.error);
    const errors   = allResults.filter(r => Boolean(r.error));

    if (errors.length > 0) {
      const summary = errors.map(r => `  [${r.case.id}] ${r.error}`).join('\n');
      console.error(`\nEval setup errors (${errors.length}):\n${summary}\n`);
    }

    if (failures.length > 0) {
      const failDetails = failures.flatMap(r =>
        r.fieldResults
          .filter(f => f.verificationStatus === 'verified' && f.status !== 'match')
          .map(f =>
            `  [${r.case.id}] ${f.fieldName}: expected ${JSON.stringify(f.normalizedExpected ?? f.expectedValue)}, got ${JSON.stringify(f.normalizedActual ?? f.actualValue)}`,
          ),
      );
      console.error(`\nRegressed verified fields (${failDetails.length}):\n${failDetails.join('\n')}\n`);
    }

    // Errors in fixture setup count as failures
    expect(errors, `${errors.length} eval case(s) errored during setup`).toHaveLength(0);
    expect(failures, `${failures.length} verified golden case(s) regressed`).toHaveLength(0);
  });

  it('needs_domain_review warnings are summarized (non-blocking)', () => {
    if (!metrics) return;
    const reviewWarnings = allResults.flatMap(r => r.reviewWarnings);
    if (reviewWarnings.length > 0 && verbose) {
      console.warn(`\n[domain review needed] ${reviewWarnings.length} field(s) have unresolved expectations. Run 'npm run eval:verbose' for details.\n`);
    }
    // Review warnings are never a failure condition
    expect(true).toBe(true);
  });
});
