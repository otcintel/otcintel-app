# Data Model — OTCIntel

> This document describes the actual data shapes in use. The Supabase schema at `lib/schema.sql` describes the intended future database — it is not connected.

---

## Primary entities

### CompanyRecord (`lib/universe/types.ts`)

The canonical company registry entry. Keyed by **CIK** in `data/companies.json`.

```typescript
interface CompanyRecord {
  cik: string;                    // SEC Central Index Key — primary DB key
  ticker: string;                 // Uppercase ticker symbol
  companyName: string;            // Resolved from EDGAR company_tickers.json
  active: boolean;

  ingestionStatus:
    | 'pending'        // Not yet ingested
    | 'ingesting'      // In progress
    | 'parsed'         // Successfully ingested, no errors
    | 'partial'        // Ingested with parse errors
    | 'failed'         // Ingestion threw unrecoverable error
    | 'stale'          // Previously parsed, needs refresh
    | 'needs_review';  // Manual review flag

  confidenceStatus:
    | 'high_confidence'
    | 'usable_with_warnings'
    | 'needs_review'
    | 'insufficient_data'
    | undefined;

  filingsDiscovered: number;
  filingsParsed: number;
  warningsCount: number;
  rejectedCandidatesCount: number;
  latestFilingDate?: string;       // ISO date string
  lastIngestionTime?: string;      // ISO datetime
  lastSuccessfulParseTime?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}
```

**Storage:** `data/companies.json` as `Record<cik, CompanyRecord>`

---

### NormalizedFiling (`lib/ingestion/types.ts`)

The primary per-filing intelligence record. Everything the system knows about a single SEC filing.

```typescript
interface NormalizedFiling {
  // Identity
  accessionNumber: string;         // SEC accession number — unique key
  ticker: string;
  cik: string;
  formType: SecFormType;           // '10-K' | '10-Q' | '8-K' | 'S-1' | ... (15 types)
  filedAt: string;                 // ISO date
  periodOfReport?: string;
  documentUrl: string;             // SEC EDGAR document URL
  fullTextUrl?: string;
  source: 'edgar' | 'mock' | 'third-party';
  parserVersion: string;           // '1.0.0'

  // Parser outputs
  parseErrors: string[];
  summary?: string;                // HTML string — narrative summary
  eventSummary?: string;           // Plain text — brief event description
  eventType?:
    | 'financing' | 'partnership' | 'product_launch'
    | 'management_change' | 'operational_update' | 'other';
  terms?: Array<{ label: string; value: string; className?: string }>;
  tags?: string[];

  // Structured data
  financing?: ExtractedFinancingTerms;    // 8-K financing event (old extractor)
  shareStructure?: ExtractedShareStructure;
  otcShareStructure?: OtcShareStructure;  // OTC Markets fallback (always undefined currently)
  financingReport?: FinancingReport;      // 10-K/10-Q full financing analysis
}
```

**Storage:** `data/filings/{TICKER}.json` as `NormalizedFiling[]` sorted newest-first

---

### FinancingReport (`lib/ingestion/types.ts`)

Extracted for 10-K and 10-Q filings. Contains all financing activity found in the filing.

```typescript
interface FinancingReport {
  convertibleDebt:          ConvertibleNote[];
  equityIssuances:          EquityIssuance[];
  conversions:              Conversion[];
  warrants:                 Warrant[];
  relatedPartyTransactions: RelatedPartyTransaction[];
  equityFacilities:         EquityFacility[];
  dilutionSummary:          DilutionSummary;
  financialStatements?:     FinancialStatements;
  reportText?:              string;    // Full analyst report narrative
  confidence?:              ExtractionConfidence;  // 'high' | 'medium' | 'low'
  warnings?:                string[];
}
```

---

### ConvertibleNote (`lib/ingestion/types.ts`)

The richest data structure in the system. ~50 fields. Extracted from 10-K/10-Q filings via multi-stage parser.

```typescript
interface ConvertibleNote {
  // Identity
  instrumentType?: 'convertible_note' | 'convertible_promissory_note' | 'debenture' | ...;
  instrumentName?: string;
  isAmendment?: boolean;
  investorName?: string;

  // Economics
  principalAmount?: number;
  purchasePrice?: number;
  originalIssueDiscount?: number;  // OID in dollars
  netProceeds?: number;
  legalFees?: number;
  placementFees?: number;
  outstandingBalance?: number;     // Current balance (from ARS tables)
  interestRate?: number;           // 0–1 fraction (e.g. 0.08 = 8%)
  defaultInterestRate?: number;
  maturityDate?: string;           // ISO date
  executionDate?: string;
  prepaymentPremium?: number;
  redemptionPremium?: number;

  // Conversion terms
  conversionFormula?: string;
  fixedConversionPrice?: number;   // Fixed price in dollars
  discountRate?: number;           // 0–1 fraction (e.g. 0.20 = 20% discount)
  lookbackDays?: number;
  floorPrice?: number;
  hasFloorPrice?: boolean;
  ceilingPrice?: number;
  exchangeCap?: number;
  beneficialOwnershipBlocker?: number;
  hasResetProvisions?: boolean;
  antiDilutionProvisions?: boolean;

  // Default terms
  hasAccelerationClause?: boolean;
  penaltyRate?: number;

  // Status
  status?: 'outstanding' | 'converted' | 'repaid' | 'amended' | 'matured';
  amountConverted?: number;
  amountRepaid?: number;

  // Provenance (internal — prefixed with _)
  _section?: string;
  _noteNumber?: number;
  _anchorPrincipalAmount?: number;
  _anchorSentenceIndex?: number;
  _sourceSentences?: number[];
  _sourceSentenceTexts?: string[];
  _fieldConfidence?: Record<string, number>;
  _fieldProvenance?: Record<string, FieldProvenanceEntry>;
  _validationWarnings?: string[];
  _rejectedCandidates?: RejectedCandidate[];
}
```

---

### ExtractedFinancingTerms (`lib/ingestion/types.ts`)

Simpler financing extraction used for 8-K filings (older extractor). Used by the risk scorer.

```typescript
interface ExtractedFinancingTerms {
  financingType: 'convertible_note' | 'equity_line' | 'preferred_stock' | 'warrant_only' | 'unknown';
  principalAmount?: number;
  discountRate?: number;
  lookbackDays?: number;
  hasFloorPrice?: boolean;
  floorPrice?: number;
  hasResetProvisions?: boolean;
  warrantShares?: number;
  warrantExercisePrice?: number;
  maturityDate?: string;
  investorName?: string;
  confidence: 'high' | 'medium' | 'low';
}
```

---

### ExtractedShareStructure (`lib/ingestion/types.ts`)

Share structure data extracted from SEC filings.

```typescript
interface ExtractedShareStructure {
  sharesAuthorized?: number;
  sharesOutstanding?: number;
  sharesFloat?: number;
  preferredSharesOutstanding?: number;
  confidence: 'high' | 'medium' | 'low';
}
```

---

### OtcShareStructure (`lib/ingestion/types.ts`)

Share structure from OTC Markets (currently always undefined in production).

```typescript
interface OtcShareStructure {
  sharesOutstanding?: number;
  sharesFloat?: number;
  authorizedShares?: number;
  fetchedAt: string;   // ISO datetime of fetch
  sourceUrl: string;
}
```

---

### CompanyIntelligence (`lib/ingestion/types.ts`)

Aggregated intelligence record generated after each ingestion run. One per company.

```typescript
interface CompanyIntelligence {
  ticker: string;
  generatedAt: string;
  filingsAnalyzed: number;

  overview: {
    dilutionRisk: 'severe' | 'high' | 'moderate' | 'low';
    financingProfile: string;      // Plain text description
    latestSharesOutstanding?: number;
    latestAuthorizedShares?: number;
  };

  shareStructureTrend: {
    periods: Array<{ formType: string; filedAt: string; sharesOutstanding: number }>;
    periodicGrowthRates: number[];
    totalGrowthPct?: number;
    narrative: string;
  };

  financingProfile: {
    totalConvertiblePrincipal: number;
    toxicNoteCount: number;
    noFloorNoteCount: number;
    hasActiveEloc: boolean;
    totalEquityFacilityCommitment: number;
    totalWarrantShares: number;
    extractionWarningCount: number;
    relatedPartyDataWarnings: string[];
  };

  keyRisks: Array<{
    severity: 'critical' | 'high' | 'moderate' | 'low';
    label: string;
    detail: string;
  }>;

  positiveSignals: Array<{ label: string; detail: string }>;
  executiveSummary: string;
}
```

**Storage:** `data/intelligence/{TICKER}.json`

---

### IngestionRun (`lib/universe/types.ts`)

Metadata for a batch ingestion run.

```typescript
interface IngestionRun {
  runId: string;           // UUID
  startedAt: string;       // ISO datetime
  endedAt?: string;
  status: 'running' | 'completed' | 'failed' | 'partial';
  companiesAttempted: number;
  companiesCompleted: number;
  companiesPartial: number;
  companiesFailed: number;
  filingsDiscovered: number;
  filingsDownloaded: number;
  filingsParsed: number;
  warningsCount: number;
  errors: string[];
}
```

**Storage:** `data/runs.json` (capped at 100)

---

### RunResult (`lib/universe/types.ts`)

Per-company result within a batch run.

```typescript
interface RunResult {
  runId: string;
  cik: string;
  ticker: string;
  status: 'completed' | 'partial' | 'failed';
  filingsDiscovered: number;
  filingsDownloaded: number;
  filingsParsed: number;
  warningsCount: number;
  durationMs: number;
  stages: Record<IngestionStage, StageResult>;
  errors: string[];
}
```

**Storage:** `data/runs/{runId}.json`

---

## Mock data model (UI-only, `lib/types.ts`)

The mock UI system uses a separate type hierarchy that maps to the same frontend components. It is not derived from the ingestion types.

Key types: `CompanyProfile`, `FinancingDeal`, `DilutionEstimate`, `WarrantRecord`, `RiskScoreRecord`, `FilingRecord`, `CompanyData`.

These types carry aspirational comments like "DB table: companies" that reflect future intent, not current reality.

---

## Intended future database (Supabase schema, `lib/schema.sql`)

Tables defined but not connected:
- `companies` — CIK, ticker, name, market data
- `filings` — accession number, form type, filing metadata
- `financing_deals` — extracted deal terms
- `risk_scores` — scored risk records
- `alerts` — alert definitions
- `alert_preferences` — user alert subscriptions
- `watchlist` — user company watchlists

Row-level security is defined but commented out. `user_id` foreign keys are commented out (no auth yet).

---

## Data flow summary

```
EDGAR API
  ↓ EdgarFilingFetcher
RawFiling (index metadata + raw text)
  ↓ parseRawFiling()
ParsedFiling
  ↓ normalizeParsedFiling()
NormalizedFiling  ←→  data/filings/{TICKER}.json
  ↓ generateCompanyIntelligence()
CompanyIntelligence  ←→  data/intelligence/{TICKER}.json
  ↓ applyIngestionResult()
CompanyRecord  ←→  data/companies.json
```

The UI reads from this chain only via the dynamic `/company/[ticker]` path. The mock `/companies` list and `/company/ABCD` etc. bypass this entire chain.
