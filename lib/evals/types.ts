/**
 * OTCIntel — Golden Evaluation Framework Types
 *
 * Defines the schema for golden evaluation cases.
 * Golden cases contain manually verified (or marked-for-review) expected
 * extraction outputs that the parser must match to pass regression.
 */

// ─── Verification status ──────────────────────────────────────────────────────

/**
 * Verification status for a single expected field value.
 *
 * - "verified"            — Independently confirmed from the source filing text
 *                           by a human reviewer. Mismatches FAIL the eval.
 * - "needs_domain_review" — Parser output that has not yet been reviewed against
 *                           the source document. Mismatches produce warnings only.
 */
export type VerificationStatus = 'verified' | 'needs_domain_review';

// ─── Field expectation ────────────────────────────────────────────────────────

export interface FieldExpectation {
  /** Expected value after normalization */
  value: string | number | boolean | null;
  /** Whether this expectation is confirmed against the source document */
  status: VerificationStatus;
  /** Optional note — source quote, calculation, or domain explanation */
  note?: string;
}

// ─── Golden case schema ───────────────────────────────────────────────────────

/**
 * How the raw filing text is sourced for this evaluation case.
 *
 * - "mock_rawFilings"       — Text comes from lib/mock/rawFilings.ts; fully deterministic.
 *                            Parser is re-run every eval execution.
 * - "file_snapshot"         — Text snapshot stored in evals/fixtures/. Parser is re-run.
 * - "stored_output_snapshot" — Use the already-stored NormalizedFiling from data/filings/.
 *                             Parser is NOT re-run; output is compared against stored state.
 *                             Used when raw EDGAR text is not available locally.
 * - "xbrl_snapshot"         — CompanyFacts JSON stored in evals/fixtures/. extractXbrlConcepts
 *                             is re-run every eval execution. Used with FinancialSnapshot target.
 */
export type FixtureSource = 'mock_rawFilings' | 'file_snapshot' | 'stored_output_snapshot' | 'xbrl_snapshot';

/**
 * Which parser output is being evaluated in this case.
 *
 * - "ExtractedFinancingTerms" — Output of parseFinancingTerms() for 8-K/8-K/A filings.
 * - "ConvertibleNote"         — A single ConvertibleNote from FinancingReport.convertibleDebt[].
 * - "ExtractedShareStructure" — Output of parseShareStructure().
 * - "no_financing"            — Asserts that no financing was detected (for negative cases).
 * - "FinancialSnapshot"       — XbrlConceptsResult from extractXbrlConcepts() (xbrl_snapshot source).
 * - "GoingConcernResult"      — GoingConcernResult from detectGoingConcern() (file_snapshot source).
 */
export type EvaluationTarget =
  | 'ExtractedFinancingTerms'
  | 'ConvertibleNote'
  | 'ExtractedShareStructure'
  | 'no_financing'
  | 'FinancialSnapshot'
  | 'GoingConcernResult';

/**
 * A single golden evaluation case. Lives in evals/golden/<TICKER>/<id>.json.
 * Human-readable and suitable for founder/domain review.
 */
export interface GoldenCase {
  /** Schema version — bump when format changes materially */
  $schema: '1.0.0';

  /** Unique case identifier (file basename without .json) */
  id: string;

  /** Human-readable description of what this case tests */
  description: string;

  // ── Filing identity ──────────────────────────────────────────────────────

  ticker: string;
  cik: string;
  formType: string;
  filedAt: string;
  accessionNumber: string;

  // ── Fixture configuration ────────────────────────────────────────────────

  fixtureSource: FixtureSource;

  /**
   * For "mock_rawFilings": ticker key in mockRawFilings map (e.g. "WXYZ")
   * For "file_snapshot": path relative to evals/fixtures/ (e.g. "AITX-0001493152-26-033603.txt")
   */
  fixtureKey?: string;

  /**
   * For "mock_rawFilings": 0-indexed position in the RawFiling[] for this ticker
   * For "file_snapshot": not needed (entire file is the text)
   */
  fixtureIndex?: number;

  // ── Evaluation target ────────────────────────────────────────────────────

  evaluationTarget: EvaluationTarget;

  /**
   * For "ConvertibleNote" target: 0-indexed position in financingReport.convertibleDebt[]
   */
  noteIndex?: number;

  /**
   * For "FinancialSnapshot" target with "xbrl_snapshot" source: override the period
   * selection in extractXbrlConcepts. Required when testing an FY period when a more
   * recent 10-Q period is present in the same CompanyFacts document.
   */
  periodOverride?: { fp: string; fy: number; end: string };

  // ── Expected field values ────────────────────────────────────────────────

  /**
   * Expected output fields. Keys are field names on the target type.
   * Only listed fields are evaluated — omitted fields are not checked.
   *
   * status="verified" fields:   mismatch or missing → eval FAILS
   * status="needs_domain_review" fields: mismatch → warning only, does not fail
   */
  expected: Record<string, FieldExpectation>;
}

// ─── Eval results ─────────────────────────────────────────────────────────────

export type FieldResultStatus = 'match' | 'mismatch' | 'missing' | 'unexpected';

export interface FieldResult {
  fieldName: string;
  verificationStatus: VerificationStatus;
  status: FieldResultStatus;
  expectedValue: unknown;
  actualValue: unknown;
  normalizedExpected?: unknown;
  normalizedActual?: unknown;
  note?: string;
}

export interface CaseResult {
  case: GoldenCase;
  /** All field comparison results */
  fieldResults: FieldResult[];
  /** Whether all verified expectations passed */
  passed: boolean;
  /** How many verified fields matched */
  verifiedMatched: number;
  /** How many verified fields were expected */
  verifiedTotal: number;
  /** Fields marked needs_domain_review that did not match */
  reviewWarnings: FieldResult[];
  /** Any error that prevented evaluation (e.g. fixture not found) */
  error?: string;
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

export interface CategoryMetrics {
  category: string;
  fieldsEvaluated: number;
  fieldsMatched: number;
  fieldsMissing: number;
  fieldsMismatched: number;
  accuracy: number;  // matched / evaluated, 0–1
}

export interface EvalMetrics {
  totalCases: number;
  casesPassed: number;
  casesFailed: number;
  casesErrored: number;
  casePassRate: number;

  totalVerifiedFields: number;
  verifiedFieldsMatched: number;
  verifiedFieldsMissing: number;
  verifiedFieldsMismatched: number;
  verifiedFieldAccuracy: number;

  totalReviewFields: number;
  reviewFieldsMatched: number;
  reviewFieldsMismatched: number;

  byCategory: CategoryMetrics[];

  /** ISO timestamp when this eval was run */
  evaluatedAt: string;
}

// ─── Field category map ───────────────────────────────────────────────────────

/**
 * Which reporting category each field belongs to.
 * Used for grouped metric reporting.
 */
export const FIELD_CATEGORIES: Record<string, string> = {
  // IDENTITY
  financingType:      'IDENTITY',
  instrumentType:     'IDENTITY',
  instrumentName:     'IDENTITY',
  investorName:       'IDENTITY',
  isAmendment:        'IDENTITY',

  // FINANCIAL TERMS
  principalAmount:    'FINANCIAL_TERMS',
  purchasePrice:      'FINANCIAL_TERMS',
  originalIssueDiscount: 'FINANCIAL_TERMS',
  netProceeds:        'FINANCIAL_TERMS',
  interestRate:       'FINANCIAL_TERMS',
  defaultInterestRate:'FINANCIAL_TERMS',
  outstandingBalance: 'FINANCIAL_TERMS',
  prepaymentPremium:  'FINANCIAL_TERMS',

  // CONVERSION TERMS
  discountRate:       'CONVERSION_TERMS',
  lookbackDays:       'CONVERSION_TERMS',
  fixedConversionPrice: 'CONVERSION_TERMS',
  conversionFormula:  'CONVERSION_TERMS',
  floorPrice:         'CONVERSION_TERMS',
  ceilingPrice:       'CONVERSION_TERMS',
  exchangeCap:        'CONVERSION_TERMS',
  hasFloorPrice:      'CONVERSION_TERMS',
  hasResetProvisions: 'CONVERSION_TERMS',

  // RESTRICTIONS
  beneficialOwnershipBlocker: 'RESTRICTIONS',
  antiDilutionProvisions: 'RESTRICTIONS',

  // TIMING
  maturityDate:       'TIMING',
  executionDate:      'TIMING',

  // WARRANTS
  warrantShares:      'WARRANTS',
  warrantExercisePrice: 'WARRANTS',

  // SHARE STRUCTURE
  sharesAuthorized:   'SHARE_STRUCTURE',
  sharesOutstanding:  'SHARE_STRUCTURE',
  sharesFloat:        'SHARE_STRUCTURE',
  preferredSharesOutstanding: 'SHARE_STRUCTURE',

  // CONFIDENCE
  confidence:         'CONFIDENCE',

  // XBRL PERIOD
  fiscalPeriod:            'XBRL_PERIOD',
  fiscalYear:              'XBRL_PERIOD',
  periodEndDate:           'XBRL_PERIOD',
  accessionNumber:         'XBRL_PERIOD',

  // BALANCE SHEET (XBRL)
  cashAndEquivalents:      'BALANCE_SHEET',
  currentLiabilities:      'BALANCE_SHEET',
  accumulatedDeficit:      'BALANCE_SHEET',
  totalDebt:               'BALANCE_SHEET',
  totalDebtComponents:     'BALANCE_SHEET',

  // CASH FLOW (XBRL)
  operatingCashFlow:       'CASH_FLOW',
  operatingCashFlowMonths: 'CASH_FLOW',

  // DERIVED LIQUIDITY
  monthlyBurnRate:         'DERIVED',
  cashRunwayMonths:        'DERIVED',

  // XBRL DATA QUALITY
  xbrlAvailable:           'XBRL_QUALITY',
  missingConcepts:         'XBRL_QUALITY',

  // GOING CONCERN
  goingConcernFlag:        'GOING_CONCERN',
  matchedSentence:         'GOING_CONCERN',
  matchedPhrase:           'GOING_CONCERN',
  sourceType:              'GOING_CONCERN',
};

export const ALL_CATEGORIES = [
  'IDENTITY',
  'FINANCIAL_TERMS',
  'CONVERSION_TERMS',
  'RESTRICTIONS',
  'TIMING',
  'WARRANTS',
  'SHARE_STRUCTURE',
  'CONFIDENCE',
  'XBRL_PERIOD',
  'BALANCE_SHEET',
  'CASH_FLOW',
  'DERIVED',
  'XBRL_QUALITY',
  'GOING_CONCERN',
];
