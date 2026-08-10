# OTCIntel — Database Schema

PostgreSQL schema via Supabase. Migration file: `supabase/migrations/001_initial_schema.sql`.

---

## Tables

### `companies`

One row per tracked company.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | Server-generated |
| `cik` | `text` UNIQUE | SEC Central Index Key, zero-padded to 10 chars |
| `ticker` | `text` | Always uppercase |
| `company_name` | `text` | From SEC EDGAR |
| `exchange` | `text` | Nullable — not always available |
| `sec_reporting_status` | `text` | Nullable |
| `active` | `boolean` | `true` if still tracked |
| `ingestion_status` | `text` | CHECK: `pending \| ingesting \| parsed \| partial \| failed \| stale \| needs_review` |
| `confidence_status` | `text` | Nullable CHECK: `high_confidence \| usable_with_warnings \| needs_review \| insufficient_data` |
| `filings_discovered` | `integer` | From latest ingestion run |
| `filings_parsed` | `integer` | Filings successfully extracted |
| `warnings_count` | `integer` | Parse warnings accumulated |
| `rejected_candidates_count` | `integer` | Financing candidates rejected |
| `latest_filing_date` | `text` | ISO date string, nullable |
| `last_ingestion_time` | `timestamptz` | Nullable |
| `last_successful_parse_time` | `timestamptz` | Nullable |
| `error_message` | `text` | Nullable — last error if any |
| `created_at` | `timestamptz` | Set on insert |
| `updated_at` | `timestamptz` | Auto-updated by trigger |

**Identifier strategy**: `cik` is the canonical identity key, not `ticker`. Tickers change; CIKs do not. All upserts use `onConflict: 'cik'`.

---

### `filings`

One row per SEC filing accession number. A company can have many filings.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | |
| `accession_number` | `text` UNIQUE | e.g. `0001234567-26-000001` |
| `company_id` | `uuid` FK → `companies.id` | CASCADE delete |
| `cik` | `text` | Denormalized for query convenience |
| `ticker` | `text` | Denormalized, uppercase |
| `form_type` | `text` | `8-K`, `10-K`, etc. |
| `filed_at` | `text` | ISO date |
| `period_of_report` | `text` | Nullable |
| `document_url` | `text` | Primary SEC filing URL |
| `full_text_url` | `text` | Nullable |
| `source` | `text` | `edgar` or future sources |
| `parser_version` | `text` | `PARSER_VERSION` stamp |
| `parse_errors` | `jsonb` | Array of parse errors |
| `summary` | `text` | Nullable |
| `event_summary` | `text` | Nullable |
| `event_type` | `text` | Nullable |
| `terms` | `text` | Nullable |
| `tags` | `jsonb` | Nullable — array |
| `financing_type` | `text` | Nullable — for SQL filtering |
| `financing_principal_amount` | `numeric` | Nullable |
| `financing_discount_rate` | `numeric` | Nullable |
| `financing_lookback_days` | `integer` | Nullable |
| `financing_has_floor_price` | `boolean` | Nullable |
| `financing_floor_price` | `numeric` | Nullable |
| `financing_has_reset_provisions` | `boolean` | Nullable |
| `financing_warrant_shares` | `numeric` | Nullable |
| `financing_warrant_exercise_price` | `numeric` | Nullable |
| `financing_maturity_date` | `text` | Nullable |
| `financing_investor_name` | `text` | Nullable |
| `financing_confidence` | `text` | Nullable |
| `shares_authorized` | `numeric` | Nullable |
| `shares_outstanding` | `numeric` | Nullable |
| `shares_float` | `numeric` | Nullable |
| `preferred_shares_outstanding` | `numeric` | Nullable |
| `share_structure_confidence` | `text` | Nullable |
| `financing_raw` | `jsonb` | Full `ExtractedFinancingTerms` including provenance |
| `share_structure_raw` | `jsonb` | Full `ExtractedShareStructure` |
| `financing_report_raw` | `jsonb` | Full `FinancingReport` including convertible notes |
| `created_at` / `updated_at` | `timestamptz` | Auto-managed |

**JSONB dual-store pattern**: Normalized columns exist for SQL analytics and filtering. The `_raw` JSONB columns are the authoritative source for reads — the repository reconstructs `NormalizedFiling` from them, preserving all provenance fields (`_fieldProvenance`, `_sourceSentenceTexts`, `_validationWarnings`).

**Upsert key**: `accession_number`. Re-ingesting the same filing overwrites the row (newer `parser_version` wins).

---

### `convertible_notes`

Individual convertible notes extracted from `FinancingReport.convertibleDebt`. A filing can have multiple notes.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | |
| `filing_id` | `uuid` FK → `filings.id` | CASCADE delete |
| `company_id` | `uuid` FK → `companies.id` | Denormalized |
| `note_index` | `integer` | 0-based position in the convertibleDebt array |
| Normalized note fields | Various | `instrument_type`, `principal_amount`, `discount_rate`, `floor_price`, etc. |
| `raw_payload` | `jsonb` | Full `ConvertibleNote` object — preserves all `_` prefixed provenance fields |
| `created_at` / `updated_at` | `timestamptz` | Auto-managed |

**Upsert key**: `(filing_id, note_index)`. This preserves the original parse order while allowing idempotent re-migration.

---

### `company_intelligence`

Denormalized intelligence snapshot per company. One row per company.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | |
| `company_id` | `uuid` UNIQUE FK → `companies.id` | |
| `ticker` | `text` | Denormalized |
| `generated_at` | `timestamptz` | When the intelligence was computed |
| `filings_analyzed` | `integer` | |
| `dilution_risk` | `text` | Nullable |
| `latest_shares_outstanding` | `numeric` | Nullable |
| `latest_authorized_shares` | `numeric` | Nullable |
| `total_convertible_principal` | `numeric` | Nullable |
| `toxic_note_count` | `integer` | Nullable |
| `no_floor_note_count` | `integer` | Nullable |
| `has_active_eloc` | `boolean` | Nullable |
| `total_equity_facility_commitment` | `numeric` | Nullable |
| `total_warrant_shares` | `numeric` | Nullable |
| `raw_payload` | `jsonb` | Full `CompanyIntelligence` object |
| `created_at` / `updated_at` | `timestamptz` | Auto-managed |

**Upsert key**: `company_id`. Reads return `raw_payload` as the authoritative `CompanyIntelligence` object.

---

### `ingestion_runs`

Metadata about each ingest execution.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | |
| `run_id` | `text` UNIQUE | Timestamp-based ID from the batch ingestor |
| `started_at`, `ended_at` | `timestamptz` | `ended_at` nullable (in-flight runs) |
| `parser_version` | `text` | Version used for this run |
| `status` | `text` | `running \| completed \| failed \| partial` |
| Counts | `integer` | `companies_attempted`, `companies_completed`, etc. |
| `errors` | `jsonb` | Array of error strings |

---

### `ingestion_run_results`

Per-company result within a run.

| Column | Type | Notes |
|--------|------|-------|
| `run_id` | `text` FK → `ingestion_runs.run_id` | |
| `cik` | `text` | |
| `ticker` | `text` | |
| `status` | `text` | `completed \| partial \| failed \| skipped` |
| `filings_discovered` | `integer` | |
| `filings_downloaded` | `integer` | |
| `filings_parsed` | `integer` | |
| `warnings` | `jsonb` | |
| `errors` | `jsonb` | |

**Upsert key**: `(run_id, cik)`.

---

## Indexes

- `companies`: `ticker`, `ingestion_status`, `confidence_status`
- `filings`: `company_id`, `ticker`, `filed_at DESC`, `parser_version`, `financing_type`
- `convertible_notes`: `company_id`, `filing_id`
- `company_intelligence`: covered by UNIQUE on `company_id`

---

## Instrument identity problem

OTC convertible notes often lack persistent identifiers. Two notes from different filings may refer to the same underlying instrument (amendment, partial repayment) with no structural linkage in the SEC document. This schema does **not** attempt to deduplicate across filings — each note is stored per-filing, per-index.

Cross-filing note identity is a future analytics problem. Do not add deduplication logic without explicit domain approval.

---

## Triggers

`set_updated_at()` trigger applied to: `companies`, `filings`, `convertible_notes`, `company_intelligence`. Fires on every UPDATE and sets `updated_at = now()`.
