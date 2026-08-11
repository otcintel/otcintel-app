/**
 * OTCIntel — Evaluation Runner
 *
 * Executes a single golden case:
 *   1. Load fixture text (mock, file snapshot, or stored output)
 *   2. Run the appropriate parser
 *   3. Extract the target object
 *   4. Compare against golden expected fields
 *   5. Return a CaseResult
 */

import type { GoldenCase, CaseResult, FieldResult } from './types';
import { compareFields, casePassedFromResults } from './comparator';
import {
  resolveMockFixtureText,
  loadFileSnapshotFixture,
  loadXbrlSnapshotFixture,
  loadStoredOutputSnapshot,
  findStoredFiling,
} from './loader';
import { parseFinancingTerms } from '../ingestion/parsers/financing';
import { parseShareStructure } from '../ingestion/parsers/shareStructure';
import { parseFinancingReport } from '../ingestion/parsers/financingReport';
import { extractXbrlConcepts } from '../ingestion/parsers/financials/xbrlConcepts';
import { detectGoingConcern } from '../ingestion/parsers/financials/goingConcern';

// ─── Target extraction ────────────────────────────────────────────────────────

/**
 * Run the correct parser and extract the target object from parser output.
 * Returns the extracted object or an error string.
 */
function extractTarget(
  goldenCase: GoldenCase,
  text: string,
): Record<string, unknown> | string {
  try {
    switch (goldenCase.evaluationTarget) {
      case 'ExtractedFinancingTerms': {
        const result = parseFinancingTerms(text);
        if (!result) return 'Parser returned undefined — no financing detected in text';
        return result as unknown as Record<string, unknown>;
      }

      case 'ExtractedShareStructure': {
        const result = parseShareStructure(text);
        if (!result) return 'Parser returned undefined — no share structure detected in text';
        return result as unknown as Record<string, unknown>;
      }

      case 'ConvertibleNote': {
        const report = parseFinancingReport(text);
        if (!report) return 'parseFinancingReport returned undefined';
        const noteIndex = goldenCase.noteIndex ?? 0;
        const note = report.convertibleDebt?.[noteIndex];
        if (!note) {
          return `No convertible note at index ${noteIndex} — convertibleDebt has ${report.convertibleDebt?.length ?? 0} entries`;
        }
        return note as unknown as Record<string, unknown>;
      }

      case 'no_financing': {
        const result = parseFinancingTerms(text);
        if (result) return 'Expected no financing but parser detected financing terms';
        // No extraction needed — pass an empty object; comparator will check "expected" has no entries
        return {};
      }

      case 'GoingConcernResult': {
        const result = detectGoingConcern(text);
        return result as unknown as Record<string, unknown>;
      }

      default:
        return `Unknown evaluation target: ${goldenCase.evaluationTarget}`;
    }
  } catch (err) {
    return `Parser threw: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Extract the target from a stored NormalizedFiling snapshot.
 */
function extractTargetFromSnapshot(
  goldenCase: GoldenCase,
  storedFiling: Record<string, unknown>,
): Record<string, unknown> | string {
  switch (goldenCase.evaluationTarget) {
    case 'ExtractedFinancingTerms': {
      const financing = storedFiling.financing;
      if (!financing) return 'No financing field in stored filing';
      return financing as Record<string, unknown>;
    }

    case 'ExtractedShareStructure': {
      const structure = storedFiling.shareStructure;
      if (!structure) return 'No shareStructure field in stored filing';
      return structure as Record<string, unknown>;
    }

    case 'ConvertibleNote': {
      const report = storedFiling.financingReport as {
        convertibleDebt?: Record<string, unknown>[];
      } | undefined;
      if (!report?.convertibleDebt) return 'No financingReport.convertibleDebt in stored filing';
      const noteIndex = goldenCase.noteIndex ?? 0;
      const note = report.convertibleDebt[noteIndex];
      if (!note) {
        return `No convertible note at index ${noteIndex} — convertibleDebt has ${report.convertibleDebt.length} entries`;
      }
      return note;
    }

    case 'no_financing': {
      const financing = storedFiling.financing;
      if (financing) return 'Expected no financing but stored filing has financing field';
      return {};
    }

    default:
      return `Unknown evaluation target: ${goldenCase.evaluationTarget}`;
  }
}

// ─── Main runner ──────────────────────────────────────────────────────────────

/**
 * Run a single golden evaluation case.
 * Always returns a CaseResult — never throws.
 */
export function runEvalCase(goldenCase: GoldenCase): CaseResult {
  let extractedTarget: Record<string, unknown> | string;

  try {
    if (goldenCase.fixtureSource === 'stored_output_snapshot') {
      const storedFilings = loadStoredOutputSnapshot(goldenCase);
      const storedFiling = findStoredFiling(storedFilings, goldenCase.accessionNumber);
      if (!storedFiling) {
        return errorResult(goldenCase, `Stored filing with accession ${goldenCase.accessionNumber} not found in data/filings/${goldenCase.ticker}.json`);
      }
      extractedTarget = extractTargetFromSnapshot(goldenCase, storedFiling);
    } else if (goldenCase.fixtureSource === 'xbrl_snapshot') {
      const fixtureKey = goldenCase.fixtureKey;
      if (!fixtureKey) {
        return errorResult(goldenCase, 'fixtureKey is required for xbrl_snapshot source');
      }
      if (goldenCase.evaluationTarget !== 'FinancialSnapshot') {
        return errorResult(goldenCase, `xbrl_snapshot source only supports FinancialSnapshot target, got: ${goldenCase.evaluationTarget}`);
      }
      const facts = loadXbrlSnapshotFixture(fixtureKey);
      const xbrlResult = extractXbrlConcepts(facts, goldenCase.periodOverride);
      extractedTarget = xbrlResult as unknown as Record<string, unknown>;
    } else {
      // Re-run parser on raw text
      let text: string;
      if (goldenCase.fixtureSource === 'mock_rawFilings') {
        text = resolveMockFixtureText(goldenCase);
      } else {
        const fixtureKey = goldenCase.fixtureKey;
        if (!fixtureKey) {
          return errorResult(goldenCase, 'fixtureKey is required for file_snapshot source');
        }
        text = loadFileSnapshotFixture(fixtureKey);
      }
      extractedTarget = extractTarget(goldenCase, text);
    }
  } catch (err) {
    return errorResult(goldenCase, `Setup error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // If extraction failed, return error
  if (typeof extractedTarget === 'string') {
    return errorResult(goldenCase, extractedTarget);
  }

  // Compare extracted against golden expectations
  const fieldResults = compareFields(goldenCase.expected, extractedTarget);
  const passed = casePassedFromResults(fieldResults);
  const verifiedResults = fieldResults.filter(r => r.verificationStatus === 'verified');
  const reviewWarnings = fieldResults.filter(
    r => r.verificationStatus === 'needs_domain_review' && r.status !== 'match',
  );

  return {
    case: goldenCase,
    fieldResults,
    passed,
    verifiedMatched: verifiedResults.filter(r => r.status === 'match').length,
    verifiedTotal: verifiedResults.length,
    reviewWarnings,
  };
}

/**
 * Run all provided golden cases and return results.
 */
export function runAllEvalCases(cases: GoldenCase[]): CaseResult[] {
  return cases.map(runEvalCase);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function errorResult(goldenCase: GoldenCase, error: string): CaseResult {
  const verifiedFields = Object.values(goldenCase.expected).filter(e => e.status === 'verified');
  const reviewFields   = Object.values(goldenCase.expected).filter(e => e.status === 'needs_domain_review');

  // Generate field results showing all expected as missing (due to error)
  const fieldResults: FieldResult[] = Object.entries(goldenCase.expected).map(([fieldName, exp]) => ({
    fieldName,
    verificationStatus: exp.status,
    status: 'missing' as const,
    expectedValue: exp.value,
    actualValue: undefined,
    note: exp.note,
  }));

  return {
    case: goldenCase,
    fieldResults,
    passed: false,
    verifiedMatched: 0,
    verifiedTotal: verifiedFields.length,
    reviewWarnings: reviewFields.map((exp, i) => ({
      fieldName: Object.keys(goldenCase.expected).filter(k => goldenCase.expected[k].status === 'needs_domain_review')[i],
      verificationStatus: 'needs_domain_review' as const,
      status: 'missing' as const,
      expectedValue: exp.value,
      actualValue: undefined,
    })),
    error,
  };
}
