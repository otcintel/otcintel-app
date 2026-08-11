-- =============================================================
-- OTCIntel — Financial Snapshots Table
-- Migration: 003_financial_snapshots
-- Supabase / PostgreSQL 15+
--
-- Stores one FinancialSnapshot per filing (accession-number keyed)
-- with full historical support. The XBRL + going-concern extraction
-- result for each 10-K/10-Q is preserved as a row so history is never
-- overwritten, unlike the single-row company_intelligence record.
--
-- Uniqueness: (company_id, accession_number) when accession is known.
-- PostgreSQL's standard UNIQUE constraint allows multiple NULLs, so
-- snapshots without a known accession number are always inserted as
-- new rows. The application-level upsert uses this column pair as the
-- conflict target and only updates on accession-matched rows.
-- =============================================================

CREATE TABLE IF NOT EXISTS financial_snapshots (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Company identity
  company_id                 UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  ticker                     TEXT NOT NULL,
  cik                        TEXT NOT NULL,

  -- Filing provenance
  accession_number           TEXT,          -- SEC accession (e.g. '0001234567-26-000001')
  form_type                  TEXT NOT NULL DEFAULT '',
  fiscal_period              TEXT,          -- 'Q1' | 'Q2' | 'Q3' | 'FY' etc.
  fiscal_year                INTEGER,
  period_end_date            DATE,
  filed_at                   DATE,

  -- Balance-sheet snapshot
  cash_and_equivalents       NUMERIC(20,2),
  current_liabilities        NUMERIC(20,2),
  accumulated_deficit        NUMERIC(20,2),
  total_debt                 NUMERIC(20,2),
  total_debt_components      JSONB NOT NULL DEFAULT '[]',   -- string[]

  -- Cash-flow snapshot
  operating_cash_flow        NUMERIC(20,2),
  operating_cash_flow_months INTEGER,
  monthly_burn_rate          NUMERIC(20,6),
  cash_runway_months         NUMERIC(10,2),

  -- Going-concern analysis
  going_concern_flag         BOOLEAN NOT NULL DEFAULT false,
  going_concern_sentence     TEXT,

  -- Extraction metadata
  xbrl_available             BOOLEAN NOT NULL DEFAULT false,
  missing_concepts           JSONB NOT NULL DEFAULT '[]',   -- string[]
  data_source                TEXT NOT NULL DEFAULT 'text'
    CHECK (data_source IN ('xbrl', 'text', 'xbrl+text')),
  extracted_at               TIMESTAMPTZ NOT NULL,

  -- Full FinancialSnapshot object — authoritative for reads
  raw_payload                JSONB NOT NULL,

  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One snapshot per filing per company (when accession is known).
  -- PostgreSQL UNIQUE allows multiple NULLs, so snapshots without an
  -- accession number are inserted as separate rows without conflict.
  UNIQUE(company_id, accession_number)
);

-- =============================================================
-- INDEXES
-- =============================================================

-- Latest snapshot lookup per company (most common read path)
CREATE INDEX IF NOT EXISTS idx_fs_company_id_filed
  ON financial_snapshots(company_id, filed_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_fs_ticker
  ON financial_snapshots(ticker);

CREATE INDEX IF NOT EXISTS idx_fs_cik
  ON financial_snapshots(cik);

CREATE INDEX IF NOT EXISTS idx_fs_period_end_date
  ON financial_snapshots(period_end_date DESC NULLS LAST);

-- Flag analytics
CREATE INDEX IF NOT EXISTS idx_fs_going_concern
  ON financial_snapshots(going_concern_flag)
  WHERE going_concern_flag = true;

-- =============================================================
-- UPDATED_AT TRIGGER
-- =============================================================

CREATE OR REPLACE TRIGGER trg_fs_updated_at
  BEFORE UPDATE ON financial_snapshots
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
