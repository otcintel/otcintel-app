/**
 * OTCIntel — Evaluation Metrics
 *
 * Computes aggregate metrics from eval case results and formats
 * human-readable reports for engineers and founder review.
 */

import type { CaseResult, EvalMetrics, CategoryMetrics, FieldResult } from './types';
import { FIELD_CATEGORIES, ALL_CATEGORIES } from './types';

// ─── Metric computation ───────────────────────────────────────────────────────

/** Get the reporting category for a field name, defaulting to "OTHER" */
function getCategory(fieldName: string): string {
  return FIELD_CATEGORIES[fieldName] ?? 'OTHER';
}

/**
 * Compute aggregate metrics from a list of CaseResults.
 */
export function computeMetrics(results: CaseResult[]): EvalMetrics {
  const totalCases    = results.length;
  const casesPassed   = results.filter(r => r.passed && !r.error).length;
  const casesErrored  = results.filter(r => Boolean(r.error)).length;
  const casesFailed   = totalCases - casesPassed - casesErrored;

  let totalVerifiedFields   = 0;
  let verifiedFieldsMatched = 0;
  let verifiedFieldsMissing = 0;
  let verifiedFieldsMismatched = 0;
  let totalReviewFields   = 0;
  let reviewFieldsMatched = 0;
  let reviewFieldsMismatched = 0;

  // Collect all field results across all cases
  const allFieldResults: FieldResult[] = [];
  for (const r of results) {
    allFieldResults.push(...r.fieldResults);
  }

  for (const f of allFieldResults) {
    if (f.verificationStatus === 'verified') {
      totalVerifiedFields++;
      if (f.status === 'match')    verifiedFieldsMatched++;
      if (f.status === 'missing')  verifiedFieldsMissing++;
      if (f.status === 'mismatch') verifiedFieldsMismatched++;
    } else {
      totalReviewFields++;
      if (f.status === 'match')    reviewFieldsMatched++;
      if (f.status !== 'match')    reviewFieldsMismatched++;
    }
  }

  // Per-category breakdown
  const categoryMap = new Map<string, { evaluated: number; matched: number; missing: number; mismatched: number }>();
  for (const cat of [...ALL_CATEGORIES, 'OTHER']) {
    categoryMap.set(cat, { evaluated: 0, matched: 0, missing: 0, mismatched: 0 });
  }

  for (const f of allFieldResults) {
    const cat = getCategory(f.fieldName);
    const entry = categoryMap.get(cat) ?? { evaluated: 0, matched: 0, missing: 0, mismatched: 0 };
    entry.evaluated++;
    if (f.status === 'match')    entry.matched++;
    if (f.status === 'missing')  entry.missing++;
    if (f.status === 'mismatch') entry.mismatched++;
    categoryMap.set(cat, entry);
  }

  const byCategory: CategoryMetrics[] = [];
  for (const [cat, counts] of categoryMap.entries()) {
    if (counts.evaluated === 0) continue;
    byCategory.push({
      category: cat,
      fieldsEvaluated: counts.evaluated,
      fieldsMatched:   counts.matched,
      fieldsMissing:   counts.missing,
      fieldsMismatched: counts.mismatched,
      accuracy: counts.evaluated > 0 ? counts.matched / counts.evaluated : 0,
    });
  }

  byCategory.sort((a, b) => a.category.localeCompare(b.category));

  return {
    totalCases,
    casesPassed,
    casesFailed,
    casesErrored,
    casePassRate: totalCases > 0 ? casesPassed / totalCases : 0,
    totalVerifiedFields,
    verifiedFieldsMatched,
    verifiedFieldsMissing,
    verifiedFieldsMismatched,
    verifiedFieldAccuracy: totalVerifiedFields > 0 ? verifiedFieldsMatched / totalVerifiedFields : 0,
    totalReviewFields,
    reviewFieldsMatched,
    reviewFieldsMismatched,
    byCategory,
    evaluatedAt: new Date().toISOString(),
  };
}

// ─── Report formatting ────────────────────────────────────────────────────────

const LINE  = '─'.repeat(70);
const THICK = '═'.repeat(70);

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function padEnd(s: string, n: number): string {
  return s.slice(0, n).padEnd(n);
}

function padStart(s: string, n: number): string {
  return s.slice(0, n).padStart(n);
}

/**
 * Format the concise (default) eval report.
 */
export function formatConciseReport(results: CaseResult[], metrics: EvalMetrics): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(THICK);
  lines.push('  OTCIntel Extraction Eval');
  lines.push(THICK);

  // Summary bar
  const passIcon  = metrics.casesPassed   > 0 ? '✓' : ' ';
  const failIcon  = metrics.casesFailed   > 0 ? '✗' : ' ';
  const errorIcon = metrics.casesErrored  > 0 ? '!' : ' ';
  lines.push('');
  lines.push(`  ${passIcon} Passed  ${String(metrics.casesPassed).padStart(3)}   ${failIcon} Failed  ${String(metrics.casesFailed).padStart(3)}   ${errorIcon} Error  ${String(metrics.casesErrored).padStart(3)}`);
  lines.push(`  Case pass rate:          ${pct(metrics.casePassRate).padStart(7)}`);
  lines.push(`  Verified field accuracy: ${pct(metrics.verifiedFieldAccuracy).padStart(7)}  (${metrics.verifiedFieldsMatched}/${metrics.totalVerifiedFields} fields)`);
  if (metrics.totalReviewFields > 0) {
    lines.push(`  Review field accuracy:   ${pct(metrics.reviewFieldsMatched / (metrics.totalReviewFields || 1)).padStart(7)}  (${metrics.reviewFieldsMatched}/${metrics.totalReviewFields} pending review)`);
  }

  // Per-case summary
  lines.push('');
  lines.push(LINE);
  lines.push('  CASES');
  lines.push(LINE);
  for (const r of results) {
    const status = r.error ? '!' : r.passed ? '✓' : '✗';
    const label  = r.error ? 'ERROR ' : r.passed ? 'PASS  ' : 'FAIL  ';
    const detail = r.error
      ? r.error.slice(0, 55)
      : `${r.verifiedMatched}/${r.verifiedTotal} verified`;
    lines.push(`  ${status} ${label} ${padEnd(r.case.id, 46)} ${detail}`);
  }

  // Category breakdown
  lines.push('');
  lines.push(LINE);
  lines.push('  ACCURACY BY CATEGORY');
  lines.push(LINE);
  lines.push(`  ${'Category'.padEnd(22)} ${'Evaluated'.padStart(9)} ${'Matched'.padStart(8)} ${'Accuracy'.padStart(9)}`);
  lines.push(`  ${'─'.repeat(22)} ${'─'.repeat(9)} ${'─'.repeat(8)} ${'─'.repeat(9)}`);
  for (const c of metrics.byCategory) {
    lines.push(
      `  ${padEnd(c.category, 22)} ${padStart(String(c.fieldsEvaluated), 9)} ${padStart(String(c.fieldsMatched), 8)} ${padStart(pct(c.accuracy), 9)}`,
    );
  }

  // Review warnings summary
  const allWarnings = results.flatMap(r => r.reviewWarnings);
  if (allWarnings.length > 0) {
    lines.push('');
    lines.push(LINE);
    lines.push(`  PENDING DOMAIN REVIEW  (${allWarnings.length} mismatch${allWarnings.length !== 1 ? 'es' : ''} — not failures)`);
    lines.push(LINE);
    for (const r of results) {
      for (const w of r.reviewWarnings) {
        lines.push(`  ⚠  ${r.case.id}  →  ${w.fieldName}`);
        lines.push(`       expected: ${JSON.stringify(w.normalizedExpected ?? w.expectedValue)}`);
        lines.push(`         actual: ${JSON.stringify(w.normalizedActual  ?? w.actualValue)}`);
        if (w.note) lines.push(`           note: ${w.note}`);
      }
    }
  }

  lines.push('');
  lines.push(THICK);
  lines.push('');

  return lines.join('\n');
}

/**
 * Format the verbose eval report (shows all field details for every case).
 */
export function formatVerboseReport(results: CaseResult[], metrics: EvalMetrics): string {
  const base = formatConciseReport(results, metrics);
  const verbose: string[] = [base];

  verbose.push('');
  verbose.push(THICK);
  verbose.push('  VERBOSE FIELD DETAIL');
  verbose.push(THICK);

  for (const r of results) {
    verbose.push('');
    const status = r.error ? '!' : r.passed ? '✓' : '✗';
    verbose.push(`  ${status} ${r.case.id}`);
    verbose.push(`    ${r.case.description}`);

    if (r.error) {
      verbose.push(`    ERROR: ${r.error}`);
      continue;
    }

    for (const f of r.fieldResults) {
      const icon = f.status === 'match' ? '✓' : f.status === 'missing' ? '?' : '✗';
      const reviewTag = f.verificationStatus === 'needs_domain_review' ? ' [review]' : '';
      verbose.push(`    ${icon} ${f.fieldName}${reviewTag}`);
      if (f.status !== 'match') {
        verbose.push(`        expected: ${JSON.stringify(f.normalizedExpected ?? f.expectedValue)}`);
        verbose.push(`          actual: ${JSON.stringify(f.normalizedActual  ?? f.actualValue)}`);
        if (f.note) verbose.push(`            note: ${f.note}`);
      }
    }
  }

  verbose.push('');
  verbose.push(THICK);
  verbose.push('');

  return verbose.join('\n');
}
