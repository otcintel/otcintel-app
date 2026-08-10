# Architecture — OTCIntel

> Describes the actual architecture as implemented, not the intended target state.

---

## High-level structure

```
otcintel/app/
├── app/                    Next.js App Router pages and API routes
│   ├── page.tsx            Marketing landing page
│   ├── companies/          Companies list (mock only)
│   ├── company/[ticker]/   Company detail (mock OR live EDGAR)
│   ├── dashboard/          Dashboard (fully static/hardcoded)
│   ├── simulator/          Dilution calculator (standalone, no data deps)
│   ├── alerts/             Alerts page (not audited)
│   └── api/
│       ├── ingest/[ticker]         Single-ticker ingest
│       ├── filings/[ticker]        Filings lookup
│       ├── admin/universe/seed     Seed company universe
│       ├── admin/universe/ingest   Batch ingestion trigger
│       ├── admin/universe/status   Universe status
│       ├── admin/universe/audit    Quality report
│       ├── admin/universe/rederive Re-derive confidence
│       ├── admin/runs/[runId]      Run status
│       └── debug/cn-test/[ticker]  CN extraction QA
├── lib/
│   ├── data.ts             UI data assembler (mock only — reads from lib/mock/)
│   ├── types.ts            UI-facing type contracts
│   ├── schema.sql          Supabase schema (NOT connected)
│   ├── db/index.ts         File-based persistence layer
│   ├── ingestion/          Real EDGAR ingestion pipeline
│   │   ├── pipeline.ts     5-phase orchestrator
│   │   ├── store.ts        In-memory NormalizedFiling store (hydrates from file DB)
│   │   ├── types.ts        All ingestion type definitions
│   │   ├── scoring.ts      Risk scoring engine
│   │   ├── normalize.ts    ParsedFiling → NormalizedFiling
│   │   ├── fetcher.ts      IFilingFetcher factory
│   │   ├── fetchers/       edgar.ts, mock.ts, fallback.ts
│   │   ├── parsers/        All SEC form parsers
│   │   ├── enrichment/     otcMarkets.ts
│   │   └── intelligence/   companyIntelligence.ts, filingComparison.ts
│   ├── universe/
│   │   ├── types.ts        CompanyRecord, IngestionRun, etc.
│   │   ├── companies.ts    Confidence scoring, universe helpers
│   │   ├── batchIngestor.ts Batch orchestrator
│   │   └── seed.json       52 seed companies
│   └── mock/               profiles.ts, financing.ts, risk.ts, filings.ts, rawFilings.ts
├── data/                   File-based production database
│   ├── companies.json      Record<cik, CompanyRecord>
│   ├── filings/{TICKER}.json  NormalizedFiling[] per ticker
│   ├── intelligence/{TICKER}.json  CompanyIntelligence per ticker
│   ├── runs.json           IngestionRun[] (last 100)
│   └── runs/{runId}.json   RunResult[] per run
└── components/             Nav.tsx, Footer.tsx
```

---

## The critical disconnect: two parallel systems

**This is the most important architectural fact to understand.**

The codebase contains two completely parallel, disconnected systems that share zero data:

### System A — Mock/UI System
- Entry: `lib/data.ts`
- Data source: `lib/mock/profiles.ts`, `lib/mock/financing.ts`, `lib/mock/risk.ts`, `lib/mock/filings.ts`
- Tickers: WXYZ, EFGH, ABCD (full intelligence) + MNOP, QRST, UVWX, GLBX, NEXM (list only)
- Consumed by: `/companies` page, `/company/ABCD` (and other mock tickers)
- Purpose: Demo/marketing

### System B — Real Ingestion System
- Entry: `lib/ingestion/pipeline.ts` via `lib/universe/batchIngestor.ts`
- Data source: SEC EDGAR API (real HTTP)
- Persistence: `lib/db/index.ts` → `data/*.json`
- 24 real companies ingested
- Consumed by: `/company/[non-mock-ticker]` (dynamic path in company page), admin API routes
- Purpose: Actual product functionality

These two systems have no bridge. `lib/data.ts` has a comment saying "In production, buildCompanyData would be replaced by Supabase RPC calls" — that bridge has not been built.

---

## Data flow

### Ingestion flow (System B)
```
seed.json
  → batchIngestor.seedCompanyUniverse() [CIK resolution via EDGAR company_tickers.json]
  → batchIngestor.runBatchIngestion()
    → per company: ingestOneCompany()
      → ingestTicker() [pipeline.ts]
        → Phase 1: fetcher.fetchFilingsIndex() [recent scan]
        → Phase 2: fetcher.fetchFilingsIndex() [extended scan: 10-K/Q + financing forms]
        → Phase 3: for each filing:
            → fetcher.fetchFilingText()
            → parseRawFiling() [all parsers]
            → normalizeParsedFiling()
        → Phase 4: fetchOtcShareStructure() [always returns undefined — Akamai blocked]
        → Phase 5: enrichWithComparisons() [filing-over-filing diff]
      → companiesDb.upsert() [companies.json]
      → filingsDb.upsertAll() [filings/{TICKER}.json]
      → generateCompanyIntelligence()
      → intelligenceDb.upsert() [intelligence/{TICKER}.json]
```

### UI render flow (System A — mock)
```
/companies → lib/data.companiesList → lib/mock/profiles → hardcoded data
/company/ABCD → lib/data.companies['ABCD'] → lib/mock/* → hardcoded data
```

### UI render flow (System B — live)
```
/company/AITX [not in mock companies dict]
  → normalizedFilingStore.getByTicker('AITX')
  → [if empty] ingestTicker('AITX') [live EDGAR fetch]
  → aggregateShareStructure(liveFilings)
  → selectBestFinancingFiling(liveFilings)
  → scoreFinancingRisk()
  → generateCompanyIntelligence()
  → render company detail page
```

---

## Ingestion pipeline detail

### Phase 1 — Recent scan
Calls `fetcher.fetchFilingsIndex(ticker, options)`. Returns the N most recent filings matching optional form type filter. Populates `filingMap` keyed by accessionNumber.

### Phase 2 — Extended scan
Two additional index calls to scan deeper (500-entry window):
- Structure scan: 10-K, 10-K/A, 10-Q, 10-Q/A (limit 4)
- Financing scan: all `FINANCING_FORM_TYPES` (limit 5)

Deduplicates against Phase 1 by accessionNumber. Failures are non-fatal.

### Phase 3 — Fetch → Parse → Normalize
For each unique filing:
1. `fetcher.fetchFilingText(filing)` — HTTP GET to EDGAR full-text
2. `parseRawFiling(filing)` — runs all applicable parsers
3. `normalizeParsedFiling(parsed, source)` → `NormalizedFiling`

### Phase 4 — OTC Enrichment
Only runs if no SEC filing produced share structure data. Calls `fetchOtcShareStructure(ticker)`. Currently always returns `undefined` because the OTC Markets backend API requires browser session cookies that the server cannot obtain. Non-fatal.

### Phase 5 — Comparison enrichment
`enrichWithComparisons(normalized)` injects period-over-period change sections into 10-K/10-Q `reportText`. Non-fatal.

---

## Persistence layer

Two backends exist behind a common repository interface (`lib/db/types.ts`). The active backend is selected by `PERSISTENCE_BACKEND` env var.

### Filesystem (default — `PERSISTENCE_BACKEND=filesystem`)

All state lives in `data/` as JSON files. `lib/db/index.ts` is the write path. `lib/db/filesystem.ts` provides async wrappers satisfying the repository interfaces.

| File | Type | Key |
|---|---|---|
| `data/companies.json` | `Record<cik, CompanyRecord>` | CIK string |
| `data/filings/{TICKER}.json` | `NormalizedFiling[]` | sorted newest-first |
| `data/intelligence/{TICKER}.json` | `CompanyIntelligence` | single object |
| `data/runs.json` | `IngestionRun[]` | capped at 100, newest-first |
| `data/runs/{runId}.json` | `RunResult[]` | one per company per run |

Write safety: `.bak` backup before every write; writes go to `.tmp` first, then `rename()` (falls back to copy+delete on Windows cross-drive failure).

### PostgreSQL (`PERSISTENCE_BACKEND=postgres`)

Supabase-hosted PostgreSQL. Read path only — the ingestion write path always uses filesystem. See `docs/DATABASE_SCHEMA.md` for the full schema and `docs/DATABASE_MIGRATION.md` for the migration runbook.

Key implementation files:
- `lib/db/postgres/client.ts` — Supabase client (server-side only)
- `lib/db/postgres/companies.ts`, `filings.ts`, `runs.ts`, `intelligence.ts` — repository implementations
- `lib/db/repositories.ts` — backend factory with lazy-loaded singletons

**JSONB dual-store**: filings table has both normalized columns (for SQL filtering) and JSONB raw payload columns (`financing_raw`, `share_structure_raw`, `financing_report_raw`). Reads reconstruct from JSONB to preserve provenance fields.

### Repository selection

```typescript
// lib/db/repositories.ts
const BACKEND = process.env.PERSISTENCE_BACKEND ?? 'filesystem';
// getCompaniesRepo() / getFilingsRepo() / getRunsRepo() / getIntelligenceRepo()
// return cached singleton for the active backend
```

`lib/server-data.ts` is the only UI-facing consumer of the repository layer. All pages go through it.

---

## In-memory store

`lib/ingestion/store.ts` exports a singleton `normalizedFilingStore`. On first read after server restart, it hydrates from the file DB. API routes and the dynamic company page use this store rather than calling `filingsDb` directly. Writes propagate to both memory and file DB.

---

## Fetcher architecture

`createFilingFetcher()` returns an `IFilingFetcher` based on the `EDGAR_FETCHER_MODE` env var:
- `mock` — returns hardcoded fixture data from `lib/mock/rawFilings.ts`
- `edgar` — live EDGAR API (`lib/ingestion/fetchers/edgar.ts`)
- `edgar-with-fallback` — tries EDGAR, falls back to mock on failure
- `third-party` — reserved, not implemented

Default in production: `edgar-with-fallback`.

---

## Company identity

Companies are keyed by **CIK** (SEC Central Index Key) in the database. Ticker is stored as a non-unique field. CIK resolution happens at seed time via EDGAR's `company_tickers.json` bulk file.

The `normalizedFilingStore` uses **ticker** as the secondary index for UI lookups.

---

## Confidence model

`deriveConfidenceStatus(filings)` — four levels:
- `high_confidence` — ≥1 parseable annual OR ≥2 parseable quarterly, zero warnings/rejections/parseErrors
- `usable_with_warnings` — passes coverage but has warnings ≤2 or parseErrors ≤1
- `needs_review` — warnings >5 or parseErrors >3
- `insufficient_data` — no parseable form types at all (catches foreign filers: GFAI, SHIP, CLPS)

`PARSEABLE_FORMS = {10-K, 10-K/A, 10-Q, 10-Q/A, 8-K, 8-K/A, S-1, S-1/A, S-3, S-3/A, S-8, 1-A, 1-A/A}`

---

## Risk scoring model

Five factor scores (each 0–100), weighted average:
- Discount depth: 30%
- Lookback window: 20%
- Warrant coverage: 20%
- Reset provisions: 20%
- Floor price: 10%

Thresholds: ≥70 high, 40–69 med, <40 low.

---

## What is not implemented

- **Database (write path)** — the ingestion system still writes to `data/*.json`; Supabase is read-path only for the UI when `PERSISTENCE_BACKEND=postgres`
- **Auth** — no auth library; schema has commented-out RLS and user_id columns
- **LLM/AI** — no model API calls anywhere in the codebase
- **Real-time data** — no WebSocket, no polling, no price feeds
- **Email/alerts** — schema has alerts table but no delivery mechanism
- **Watchlists** — schema has watchlist table but no UI or API
- **Search** — no full-text search
- **OTC Markets data** — API permanently blocked; no alternative source wired up
