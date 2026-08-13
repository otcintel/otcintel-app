-- =============================================================
-- OTCIntel — Review Items Table
-- Migration: 004_review_items
-- Supabase / PostgreSQL 15+
--
-- Persists anomaly detector output. One row per unique (dedup_key).
-- The detector runs after each company pipeline and emits ReviewItemInput
-- records; the repository upserts them, incrementing recurrence_count
-- when the same anomaly re-fires on the same filing.
--
-- Dedup key format: TICKER:anomalyType:accession-or-none:source.path
-- This is stable across ingestion runs for the same filing/anomaly pair.
-- =============================================================

CREATE TABLE IF NOT EXISTS review_items (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Deduplication
  dedup_key         TEXT        UNIQUE NOT NULL,

  -- Company identity
  ticker            TEXT        NOT NULL,
  cik               TEXT,

  -- Filing provenance
  accession_number  TEXT,

  -- Anomaly classification
  anomaly_type      TEXT        NOT NULL,
  category          TEXT        NOT NULL
    CHECK (category IN (
      'financing_extraction',
      'financial_statement',
      'provenance',
      'scoring',
      'system'
    )),
  severity          TEXT        NOT NULL
    CHECK (severity IN ('critical', 'high', 'medium', 'low')),

  -- Human display
  title             TEXT        NOT NULL,
  description       TEXT        NOT NULL,

  -- Evidence (JSONB — holds any shape appropriate for the rule)
  current_value     JSONB,
  expected_behavior JSONB,

  -- Source pointer
  source_path       TEXT,

  -- Provenance
  parser_version    TEXT,
  confidence        TEXT,
  run_id            UUID,

  -- Lifecycle
  status            TEXT        NOT NULL DEFAULT 'open'
    CHECK (status IN (
      'open',
      'investigating',
      'confirmed_bug',
      'expected_behavior',
      'resolved',
      'ignored'
    )),
  recurrence_count  INTEGER     NOT NULL DEFAULT 1,
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at       TIMESTAMPTZ,
  resolution_note   TEXT
);

-- ─── Indexes ──────────────────────────────────────────────────────────────────

-- Primary dashboard query: open items sorted by severity
CREATE INDEX IF NOT EXISTS ri_status_severity
  ON review_items (status, severity);

-- Per-company lookup
CREATE INDEX IF NOT EXISTS ri_ticker
  ON review_items (ticker);

-- Filter by rule type
CREATE INDEX IF NOT EXISTS ri_anomaly_type
  ON review_items (anomaly_type);

-- Filter by category
CREATE INDEX IF NOT EXISTS ri_category
  ON review_items (category);

-- Newest-first ordering
CREATE INDEX IF NOT EXISTS ri_last_seen_at
  ON review_items (last_seen_at DESC);
