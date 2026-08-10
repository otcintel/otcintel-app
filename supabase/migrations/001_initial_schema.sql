-- =============================================================
-- OTCIntel — Initial PostgreSQL Schema
-- Migration: 001_initial_schema
-- Supabase / PostgreSQL 15+
--
-- Design principles:
--   1. CIK (not ticker) is the canonical issuer identity.
--   2. Accession number is the canonical SEC filing identity.
--   3. Ticker is indexed but NOT the relational primary key.
--   4. Structured columns for queryability; JSONB raw payloads for auditability.
--   5. Provenance is preserved — raw extraction output is never discarded.
--   6. Parser version is tracked per filing for controlled reprocessing.
--   7. Multiple filings may reference the same financing instrument;
--      we do not eagerly merge across filings without confirmed identity.
-- =============================================================

-- =============================================================
-- COMPANIES
-- Canonical issuer registry. One row per SEC entity (CIK-keyed).
-- Ticker is non-unique over time (companies change tickers),
-- but for the current active company record, ticker + CIK form
-- the usable identity pair.
-- =============================================================
CREATE TABLE IF NOT EXISTS companies (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cik                        TEXT UNIQUE NOT NULL,      -- SEC Central Index Key (zero-padded 10 digits)
  ticker                     TEXT NOT NULL,             -- Current ticker symbol (uppercase)
  company_name               TEXT NOT NULL,
  exchange                   TEXT,                      -- e.g. 'Pink Sheets', 'OTCQB', 'OTCQX'
  sec_reporting_status       TEXT,                      -- SEC filer status if known
  active                     BOOLEAN NOT NULL DEFAULT true,

  -- Ingestion metadata
  ingestion_status           TEXT NOT NULL DEFAULT 'pending'
    CHECK (ingestion_status IN ('pending','ingesting','parsed','partial','failed','stale','needs_review')),
  confidence_status          TEXT
    CHECK (confidence_status IN ('high_confidence','usable_with_warnings','needs_review','insufficient_data')),
  filings_discovered         INTEGER NOT NULL DEFAULT 0,
  filings_parsed             INTEGER NOT NULL DEFAULT 0,
  warnings_count             INTEGER NOT NULL DEFAULT 0,
  rejected_candidates_count  INTEGER NOT NULL DEFAULT 0,
  latest_filing_date         DATE,
  last_ingestion_time        TIMESTAMPTZ,
  last_successful_parse_time TIMESTAMPTZ,
  error_message              TEXT,

  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================
-- FILINGS
-- One row per SEC filing (accession-number keyed).
-- Stores both normalized queryable fields and full JSONB payloads
-- so extraction results are auditable without parsing again.
--
-- A filing is NOT the same entity as a financing instrument.
-- Multiple filings may discuss the same note/warrant.
-- =============================================================
CREATE TABLE IF NOT EXISTS filings (
  id                             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  accession_number               TEXT UNIQUE NOT NULL,  -- e.g. '0001234567-26-000001'
  company_id                     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  cik                            TEXT NOT NULL,
  ticker                         TEXT NOT NULL,         -- Denormalized for fast lookups
  form_type                      TEXT NOT NULL,         -- '8-K', '10-K', '10-Q', etc.
  filed_at                       DATE NOT NULL,
  period_of_report               DATE,
  document_url                   TEXT NOT NULL,
  full_text_url                  TEXT,
  source                         TEXT NOT NULL DEFAULT 'edgar'
    CHECK (source IN ('edgar','mock','third-party')),
  parser_version                 TEXT NOT NULL,         -- '1.0.0' — bump triggers reprocessing
  parse_errors                   JSONB NOT NULL DEFAULT '[]',

  -- Narrative parser outputs
  summary                        TEXT,                  -- HTML narrative summary
  event_summary                  TEXT,                  -- Plain-text brief
  event_type                     TEXT
    CHECK (event_type IN ('financing','partnership','product_launch','management_change','operational_update','other')),
  terms                          JSONB,                 -- Array of {label, value, className?}
  tags                           JSONB,                 -- String array

  -- Normalized: ExtractedFinancingTerms (from 8-K/8-K/A)
  -- Stored as columns for analytics; raw payload is authoritative for reads
  financing_type                 TEXT,
  financing_principal_amount     NUMERIC(18,2),
  financing_discount_rate        NUMERIC(10,8),         -- 0–1 fraction e.g. 0.22 = 22% discount
  financing_lookback_days        INTEGER,
  financing_has_floor_price      BOOLEAN,
  financing_floor_price          NUMERIC(18,6),
  financing_has_reset_provisions BOOLEAN,
  financing_warrant_shares       BIGINT,
  financing_warrant_exercise_price NUMERIC(18,6),
  financing_maturity_date        DATE,
  financing_investor_name        TEXT,
  financing_confidence           TEXT CHECK (financing_confidence IN ('high','medium','low')),

  -- Normalized: ExtractedShareStructure
  shares_authorized              BIGINT,
  shares_outstanding             BIGINT,
  shares_float                   BIGINT,
  preferred_shares_outstanding   BIGINT,
  share_structure_confidence     TEXT CHECK (share_structure_confidence IN ('high','medium','low')),

  -- Raw extraction payloads — authoritative source for reading back full objects
  -- These preserve all provenance fields (_fieldProvenance, _sourceSentenceTexts, etc.)
  financing_raw                  JSONB,   -- Full ExtractedFinancingTerms
  share_structure_raw            JSONB,   -- Full ExtractedShareStructure
  financing_report_raw           JSONB,   -- Full FinancingReport (complex nested structure)

  ingested_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================
-- CONVERTIBLE_NOTES
-- Normalized rows extracted from financingReport.convertibleDebt.
-- One row per note per filing (note_index tracks position in array).
--
-- Identity resolution problem (documented):
-- The same convertible note may appear in multiple filings (e.g. a 10-Q that
-- references notes from a prior 8-K). We do NOT attempt to deduplicate across
-- filings in Phase 5 — each filing's extraction produces its own rows.
-- Future work: add an optional `instrument_id` foreign key once identity
-- resolution logic is implemented and validated.
--
-- Provenance: raw_payload stores the complete ConvertibleNote object including
-- all _ prefixed fields (_fieldProvenance, _sourceSentenceTexts, etc.).
-- Never discard these — they are the evidentiary trail.
-- =============================================================
CREATE TABLE IF NOT EXISTS convertible_notes (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filing_id                  UUID NOT NULL REFERENCES filings(id) ON DELETE CASCADE,
  company_id                 UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  note_index                 INTEGER NOT NULL DEFAULT 0,  -- Position in convertibleDebt[]

  -- Identity fields
  instrument_type            TEXT,   -- 'convertible_note' | 'debenture' | ...
  instrument_name            TEXT,
  is_amendment               BOOLEAN,
  investor_name              TEXT,

  -- Economics
  principal_amount           NUMERIC(18,2),
  purchase_price             NUMERIC(18,2),
  original_issue_discount    NUMERIC(18,2),
  net_proceeds               NUMERIC(18,2),
  outstanding_balance        NUMERIC(18,2),
  interest_rate              NUMERIC(10,8),              -- 0–1 fraction (e.g. 0.08 = 8%)
  default_interest_rate      NUMERIC(10,8),
  maturity_date              DATE,
  execution_date             DATE,
  prepayment_premium         NUMERIC(10,8),
  redemption_premium         NUMERIC(10,8),

  -- Conversion terms
  conversion_formula         TEXT,
  fixed_conversion_price     NUMERIC(18,6),
  discount_rate              NUMERIC(10,8),              -- 0–1 fraction (e.g. 0.20 = 20% discount)
  lookback_days              INTEGER,
  floor_price                NUMERIC(18,6),
  has_floor_price            BOOLEAN,
  ceiling_price              NUMERIC(18,6),
  exchange_cap               NUMERIC(18,2),
  beneficial_ownership_blocker NUMERIC(10,8),
  has_reset_provisions       BOOLEAN,
  anti_dilution_provisions   BOOLEAN,

  -- Default / penalty terms
  has_acceleration_clause    BOOLEAN,
  penalty_rate               NUMERIC(10,8),

  -- Status
  status                     TEXT CHECK (status IN ('outstanding','converted','repaid','settled','cancelled','matured','unknown')),
  amount_converted           NUMERIC(18,2),
  amount_repaid              NUMERIC(18,2),

  -- Full ConvertibleNote object including all _ provenance fields
  -- This is the authoritative source — structured columns are for querying only
  raw_payload                JSONB NOT NULL,

  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A note is uniquely identified by (filing, position)
  UNIQUE(filing_id, note_index)
);

-- =============================================================
-- COMPANY_INTELLIGENCE
-- Aggregated intelligence record generated after each ingestion run.
-- One active record per company (upserted on each run).
-- raw_payload is the full CompanyIntelligence object.
-- =============================================================
CREATE TABLE IF NOT EXISTS company_intelligence (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  ticker                          TEXT NOT NULL,
  generated_at                    TIMESTAMPTZ NOT NULL,
  filings_analyzed                INTEGER NOT NULL DEFAULT 0,

  -- Overview (denormalized for dashboard queries)
  dilution_risk                   TEXT CHECK (dilution_risk IN ('severe','high','moderate','low')),
  latest_shares_outstanding       BIGINT,
  latest_authorized_shares        BIGINT,

  -- Financing profile metrics (denormalized for analytics)
  total_convertible_principal     NUMERIC(18,2),
  toxic_note_count                INTEGER,
  no_floor_note_count             INTEGER,
  has_active_eloc                 BOOLEAN,
  total_equity_facility_commitment NUMERIC(18,2),
  total_warrant_shares            BIGINT,

  -- Full CompanyIntelligence object for auditability and full reads
  raw_payload                     JSONB NOT NULL,

  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(company_id)
);

-- =============================================================
-- INGESTION_RUNS
-- Tracks each batch ingestion run. Operational / audit table.
-- =============================================================
CREATE TABLE IF NOT EXISTS ingestion_runs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                TEXT UNIQUE NOT NULL,   -- Application-generated UUID
  started_at            TIMESTAMPTZ NOT NULL,
  ended_at              TIMESTAMPTZ,
  parser_version        TEXT NOT NULL DEFAULT '1.0.0',
  status                TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','completed','failed','partial')),
  companies_attempted   INTEGER NOT NULL DEFAULT 0,
  companies_completed   INTEGER NOT NULL DEFAULT 0,
  companies_partial     INTEGER NOT NULL DEFAULT 0,
  companies_failed      INTEGER NOT NULL DEFAULT 0,
  filings_discovered    INTEGER NOT NULL DEFAULT 0,
  filings_downloaded    INTEGER NOT NULL DEFAULT 0,
  filings_parsed        INTEGER NOT NULL DEFAULT 0,
  warnings_count        INTEGER NOT NULL DEFAULT 0,
  errors                JSONB NOT NULL DEFAULT '[]',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =============================================================
-- INGESTION_RUN_RESULTS
-- Per-company result within a batch run.
-- =============================================================
CREATE TABLE IF NOT EXISTS ingestion_run_results (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              TEXT NOT NULL REFERENCES ingestion_runs(run_id) ON DELETE CASCADE,
  cik                 TEXT NOT NULL,
  ticker              TEXT NOT NULL,
  status              TEXT NOT NULL
    CHECK (status IN ('completed','partial','failed','skipped')),
  failed_stage        TEXT,
  filings_discovered  INTEGER NOT NULL DEFAULT 0,
  filings_downloaded  INTEGER NOT NULL DEFAULT 0,
  filings_parsed      INTEGER NOT NULL DEFAULT 0,
  warnings_count      INTEGER NOT NULL DEFAULT 0,
  duration_ms         INTEGER,
  error_message       TEXT,
  started_at          TIMESTAMPTZ NOT NULL,
  ended_at            TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(run_id, cik)
);

-- =============================================================
-- INDEXES
-- =============================================================

-- companies
CREATE INDEX IF NOT EXISTS idx_companies_ticker
  ON companies(ticker);
CREATE INDEX IF NOT EXISTS idx_companies_confidence_status
  ON companies(confidence_status);
CREATE INDEX IF NOT EXISTS idx_companies_ingestion_status
  ON companies(ingestion_status);
CREATE INDEX IF NOT EXISTS idx_companies_updated_at
  ON companies(updated_at DESC);

-- filings
CREATE INDEX IF NOT EXISTS idx_filings_company_id
  ON filings(company_id);
CREATE INDEX IF NOT EXISTS idx_filings_ticker
  ON filings(ticker);
CREATE INDEX IF NOT EXISTS idx_filings_filed_at
  ON filings(filed_at DESC);
CREATE INDEX IF NOT EXISTS idx_filings_form_type
  ON filings(form_type);
CREATE INDEX IF NOT EXISTS idx_filings_parser_version
  ON filings(parser_version);
CREATE INDEX IF NOT EXISTS idx_filings_cik
  ON filings(cik);

-- convertible_notes
CREATE INDEX IF NOT EXISTS idx_cn_filing_id
  ON convertible_notes(filing_id);
CREATE INDEX IF NOT EXISTS idx_cn_company_id
  ON convertible_notes(company_id);
CREATE INDEX IF NOT EXISTS idx_cn_investor_name
  ON convertible_notes(investor_name);
CREATE INDEX IF NOT EXISTS idx_cn_status
  ON convertible_notes(status);

-- company_intelligence
CREATE INDEX IF NOT EXISTS idx_ci_company_id
  ON company_intelligence(company_id);
CREATE INDEX IF NOT EXISTS idx_ci_ticker
  ON company_intelligence(ticker);
CREATE INDEX IF NOT EXISTS idx_ci_dilution_risk
  ON company_intelligence(dilution_risk);

-- ingestion_runs
CREATE INDEX IF NOT EXISTS idx_ir_started_at
  ON ingestion_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ir_status
  ON ingestion_runs(status);

-- ingestion_run_results
CREATE INDEX IF NOT EXISTS idx_irr_run_id
  ON ingestion_run_results(run_id);
CREATE INDEX IF NOT EXISTS idx_irr_cik
  ON ingestion_run_results(cik);

-- =============================================================
-- UPDATED_AT TRIGGER
-- Keeps updated_at current on any row modification.
-- =============================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_companies_updated_at
  BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER trg_filings_updated_at
  BEFORE UPDATE ON filings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER trg_cn_updated_at
  BEFORE UPDATE ON convertible_notes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE TRIGGER trg_ci_updated_at
  BEFORE UPDATE ON company_intelligence
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================
-- ROW LEVEL SECURITY (scaffold — enable when auth is implemented)
-- =============================================================
-- Companies, filings, convertible_notes, and intelligence are
-- read-only for all authenticated users; writes require service role.
-- When auth is added:
--   ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
--   CREATE POLICY "Public read" ON companies FOR SELECT USING (true);
--   [etc.]
--
-- alert_preferences and watchlist tables will need per-user RLS
-- once user_id columns are added.
