/**
 * OTCIntel — Ingestion layer public API
 *
 * Import from here for all ingestion functionality.
 * Internal modules (parsers, fetchers, normalize) are not part of the public API
 * and should not be imported directly by lib/data.ts or UI pages.
 */

// Pipeline — primary entry point for running ingestion
export { ingestTicker, ingestTickers } from './pipeline';

// Fetcher factory — for manual fetcher instantiation
export { createFilingFetcher } from './fetcher';

// Risk scorer — derives RiskScoreRecord from parsed financing terms
export { scoreFinancingRisk } from './scoring';

// Company intelligence generator
export { generateCompanyIntelligence } from './intelligence/companyIntelligence';

// Filing comparison engine
export { enrichWithComparisons, findPriorFiling, compareFilings, buildFinancingTimeline } from './intelligence/filingComparison';

// Normalized filing store — in-process persistence (swap for Supabase in prod)
export { normalizedFilingStore } from './store';

// Form-type tier constants — exported for use in filtering and UI
export { TIER_1_FORM_TYPES, TIER_2_FORM_TYPES, FINANCING_FORM_TYPES, STRUCTURE_FORM_TYPES } from './types';

// Types — everything consumers may need
export type {
  // Raw
  RawFiling,
  SecFormType,
  // Parsed
  ParsedFiling,
  ExtractedFinancingTerms,
  ExtractedShareStructure,
  ExtractedDilutionLanguage,
  // Normalized
  NormalizedFiling,
  // Config
  FetcherMode,
  FilingFetcherConfig,
  FetchOptions,
  PipelineOptions,
  PipelineResult,
  // Scoring / confidence
  ExtractionConfidence,
  FinancingType,
  EventType,
  // Enrichment
  OtcShareStructure,
  // Financing report (10-K / 10-Q)
  FinancingReport,
  ConvertibleNote,
  EquityIssuance,
  ConversionRecord,
  WarrantRecord,
  RelatedPartyTransaction,
  EquityFacility,
  DilutionSummary,
  // Financial statements
  FinancialStatements,
  // Company intelligence
  CompanyIntelligence,
  DilutionRiskLevel,
  RiskSeverity,
  CompanyRiskFactor,
  CompanyPositiveSignal,
  ShareTrendPeriod,
  ShareStructureTrend,
  AggregatedFinancingProfile,
} from './types';
