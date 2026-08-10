# Current State — OTCIntel

> Snapshot: 2026-08-07. Updated post-Phase 3 (Real Data → Real UI, Tasks 1–12 complete).

---

## What this application is

OTCIntel is an OTC/microcap market intelligence platform. Its stated goal is to extract, structure, and score the financing mechanics embedded in public SEC filings (convertible notes, equity lines, warrants, preferred stock) so that the analysis is systematic rather than ad hoc.

It is a **Next.js 16.2.4 / React 19.2.4** web application. It is in **pre-launch private development**. No users. No auth. No live database.

---

## What actually works today

### Real, production-ready systems

| System | Location | Status |
|---|---|---|
| EDGAR ingestion pipeline | `lib/ingestion/pipeline.ts` | Working — 5-phase, multi-form |
| Convertible note extraction | `lib/ingestion/parsers/` | Working — ~50 fields, provenance |
| File-based persistence | `lib/db/index.ts` | Working — atomic writes, `.bak` |
| Company universe registry | `lib/universe/` | Working — 24 companies ingested |
| Confidence scoring | `lib/universe/companies.ts` | Working — form-aware |
| Admin API surface | `app/api/admin/universe/*` | Working — seed, ingest, audit, status |
| Debug API | `app/api/debug/cn-test/[ticker]` | Working — CN extraction QA |
| Single-ticker ingest API | `app/api/ingest/[ticker]` | **Removed** (Phase 6 Task 3 — use `/api/admin/universe/ingest`) |
| Dynamic company page | `app/company/[ticker]/page.tsx` | Working — for non-mock tickers |
| Risk scoring engine | `lib/ingestion/scoring.ts` | Working |
| Intelligence generator | `lib/ingestion/intelligence/` | Working |
| Dilution simulator | `app/simulator/page.tsx` | Working — client-side math |

### What is broken or non-functional

| System | Problem |
|---|---|
| **OTC Markets enrichment** | Permanently blocked by Akamai; Phase 4 of pipeline always returns `undefined` |
| **Supabase schema** | `lib/schema.sql` exists but is not connected to anything |
| **Authentication** | No auth library in `package.json`; schema has `user_id` columns commented out |
| **Alerts page** | Exists as a route but not audited for functionality |
| **LLM / AI** | Platform is described as an "intelligence platform" but there is no Claude API, OpenAI, or any LLM SDK anywhere |
| **Market data** | Price, volume, OTC tier not ingested — these fields are not displayed (missing shown as missing) |

---

## Data snapshot (as of audit)

- **24 companies** ingested in `data/companies.json`
- **24 filings files** in `data/filings/{TICKER}.json`
- **24 intelligence files** in `data/intelligence/{TICKER}.json`
- **4 ingestion runs** recorded in `data/runs/`
- Tickers: ABVC, AITX, ATVK, BOXL, CANN, CENN, CLPS, CODA, CUEN, GFAI, GOVX, LCTX, LIQT, LQMT, MFON, NTRB, NVVE, RKDA, SHIP, SINT, SOBR, TUSK, VNRX, WRAP

---

## Confidence distribution (actual ingested data)

- **Foreign filers** (GFAI, SHIP, CLPS): `insufficient_data` — correctly classified; no parseable form types
- **Remaining 21 companies**: mix of `high_confidence`, `usable_with_warnings`, `needs_review`

---

## Running the application

```bash
cd app && npm run dev
```

- `EDGAR_FETCHER_MODE` env var controls ingestion source (`mock` | `edgar` | `edgar-with-fallback`)
- `OTC_ENRICHMENT_ENABLED=true` enables OTC enrichment (disabled by default — API is blocked by Akamai)
- `ADMIN_SECRET=<secret>` required to call any `/api/admin/*` route (returns 503 if unset)
- No `.env` file is required for mock mode

---

## Key URL routes

| Route | Description |
|---|---|
| `/` | Marketing landing page (example link → `/company/AITX`) |
| `/companies` | Company list — **real data** from `data/companies.json` via `lib/server-data.ts` |
| `/company/[ticker]` | Company detail page — **real data** for all 24 ingested tickers; 404 for unknowns |
| `/dashboard` | Dashboard — **real data** via `getDashboardStats()` |
| `/simulator` | Dilution calculator (functional, standalone) |
| `/api/admin/universe/status` | Universe status JSON |
| `/api/admin/universe/audit` | Full quality report JSON |
| `/api/admin/universe/ingest` | POST to trigger batch ingestion |
| `/api/debug/cn-test/[ticker]` | Convertible note QA report |

---

## Phase 3 changes — Real Data → Real UI (2026-08-07)

The UI-ingestion disconnect (TD-01) was resolved. The 24 real ingested companies are now visible in all public routes. Mock data is no longer used by any production page.

| Change | File(s) | Detail |
|---|---|---|
| Server data access layer | `lib/server-data.ts` (new) | Single server-only module bridging `lib/db` → UI pages. `getCompanies()`, `getCompanyRecord()`, `getCompanyFilings()`, `getDashboardStats()` |
| Companies list — real data | `app/companies/page.tsx` (server), `app/companies/CompaniesClient.tsx` (client) | Reads 24 real companies; confidence badge filter; no mock imports |
| Company page — real data | `app/company/[ticker]/page.tsx` | Removed mock precedence (`companies[symbol]` lookup removed entirely). All tickers now use `filingsDb` / `companiesDb`. Proper not-found and pending-ingestion states |
| Dashboard — real data | `app/dashboard/page.tsx` | Replaced hardcoded fake tickers/numbers with `getDashboardStats()`. Shows real company count, filings count, confidence breakdown, actual recent filings with SEC links |
| Landing page example link | `app/page.tsx` | `See an example →` now links to `/company/AITX` (real ingested company) |
| `lib/data.ts` marked dev-only | `lib/data.ts` | Header comment updated; no production page imports it |
| Tests for server-data.ts | `lib/__tests__/server-data.test.ts` (new) | 22 tests covering: company mapping, missing field preservation, ticker lookup, filing provenance, dashboard aggregation, no fabrication |

### Canonical UI data access pattern (post-Phase 3)

```
Server component page
  → import from 'lib/server-data'        (server-only)
  → reads lib/db/index.ts
  → reads data/*.json
```

Client components receive pre-fetched data as props. They never import `lib/server-data` or `lib/db` directly.

### Known missing datasets (not displayed, not fabricated)

- Market price and volume (no market data feed)
- OTC tier / listing status (OTC Markets API blocked)
- Beneficial ownership / insider holdings
- Total potential dilution (displayed only when extractable from filings)

---

## Stabilization changes (2026-08-07)

The following changes were made during the foundation stabilization phase. All domain rules are preserved.

| Change | File(s) | Detail |
|---|---|---|
| OTC kill-switch flipped to opt-in | `lib/ingestion/enrichment/otcMarkets.ts` | Now requires `OTC_ENRICHMENT_ENABLED=true` (was `!== 'false'`) |
| Admin auth guard | `lib/api/adminAuth.ts` (new), all 6 `/api/admin/*` routes | `Bearer <ADMIN_SECRET>` required; constant-time compare |
| `PARSEABLE_FORMS` de-duplicated | `lib/universe/companies.ts`, `app/api/admin/universe/audit/route.ts` | Single export; audit route now imports it |
| Synthetic risk scores removed | `app/company/[ticker]/page.tsx` | Hardcoded `{ severe: 88, high: 72, ... }` → "Insufficient Data" display per domain rule 6 |
| Vitest infrastructure | `vitest.config.ts`, `package.json` | `npm test` / `npm run test:watch` / `npm run test:coverage` |
| Tests — 38 passing | `lib/universe/__tests__/companies.test.ts`, `lib/ingestion/__tests__/scoring.test.ts` | Covers `deriveConfidenceStatus`, `PARSEABLE_FORMS`, staleness detection, `scoreFinancingRisk` |
| Parser version staleness | `lib/universe/companies.ts`, `lib/universe/batchIngestor.ts` | Stale filings (wrong `parserVersion`) removed from skip-set and re-parsed automatically |

---

## Phase 4 changes — Evaluation Framework (2026-08-07)

Golden evaluation dataset and extraction regression framework added.

| Change | File(s) | Detail |
|---|---|---|
| Eval config | `vitest.eval.config.ts`, `vitest.eval.verbose.config.ts` | Separate vitest configs for eval vs test suite |
| Eval runner | `lib/evals/runner.ts` | ESM-compatible; runs parser against golden fixtures |
| Eval loader | `lib/evals/loader.ts` | Resolves fixture text from mock or real filing |
| Golden case schema | `lib/evals/schema.ts` | `GoldenCase`, `EvalResult`, `VerificationStatus` types |
| Results directory | `evals/results/.gitkeep` | Placeholder for CI output |
| Eval documentation | `docs/EVALUATION_FRAMEWORK.md` | Full protocol including domain review workflow |
| `AGENTS.md` rule | `AGENTS.md` | `npm run eval` required before merging extraction changes |

```bash
npm run eval             # fails on verified regressions
npm run eval:verbose     # field-level detail
```

---

## Phase 5 changes — Postgres / Supabase Persistence Foundation (2026-08-07)

PostgreSQL persistence layer added alongside filesystem. The filesystem backend remains the default and the write path is unchanged.

| Change | File(s) | Detail |
|---|---|---|
| SQL migration | `supabase/migrations/001_initial_schema.sql` | Full schema: companies, filings, convertible_notes, company_intelligence, ingestion_runs, ingestion_run_results |
| Repository interfaces | `lib/db/types.ts` | `ICompaniesRepository`, `IFilingsRepository`, `IRunsRepository`, `IIntelligenceRepository` |
| Filesystem wrappers | `lib/db/filesystem.ts` | Async wrappers over `lib/db/index.ts` satisfying the repository interfaces |
| Supabase client | `lib/db/postgres/client.ts` | Server-side only; throws with clear message if env vars missing |
| Postgres repositories | `lib/db/postgres/companies.ts`, `filings.ts`, `runs.ts`, `intelligence.ts` | Full implementations with JSONB round-trip fidelity |
| Backend factory | `lib/db/repositories.ts` | Lazy-loaded singletons; `PERSISTENCE_BACKEND` env var selects backend |
| Server data layer | `lib/server-data.ts` | Rewritten async; now imports from `lib/db/repositories` |
| UI pages | `app/dashboard/page.tsx`, `app/companies/page.tsx`, `app/company/[ticker]/page.tsx` | All converted to `async function` using `await` |
| Migration script | `scripts/db-migrate-data.ts` | Filesystem → Postgres, idempotent, does not delete source JSON |
| Parity verifier | `scripts/db-verify.ts` | 7-check script; must exit 0 before switching `PERSISTENCE_BACKEND=postgres` |
| Tests | `lib/db/__tests__/postgres-companies.test.ts`, `postgres-filings.test.ts` | Mocked Supabase client; no live DB required |
| Documentation | `docs/DATABASE_SCHEMA.md`, `docs/DATABASE_MIGRATION.md` | Schema reference and migration runbook |

**Env vars added:**
- `SUPABASE_URL` — required for Postgres backend
- `SUPABASE_SERVICE_ROLE_KEY` — required for Postgres backend; **server-side only, never expose to clients**
- `PERSISTENCE_BACKEND` — `filesystem` (default) or `postgres`

**The filesystem backend remains the default.** The write path (batch ingestor) is still filesystem-only. To switch the UI to Postgres: run `npm run db:migrate-data`, verify with `npm run db:verify` (exit 0), then set `PERSISTENCE_BACKEND=postgres`.

---

## Dependency summary

| Category | Package | Notes |
|---|---|---|
| Framework | `next@16.2.4`, `react@19.2.4` | Cutting-edge; may have breaking changes |
| Styling | `@tailwindcss/postcss@^4` | Tailwind v4 |
| Language | TypeScript | Full coverage |
| Database | `@supabase/supabase-js@^2.112.2` | Server-side only; filesystem is still default |
| Auth | (none) | Not implemented |
| LLM | (none) | Not implemented |
| Tests | `vitest@^4.1.10` | 121+ tests; run `npm test` |
| ORM | (none) | File I/O in `lib/db/index.ts`; Supabase client for Postgres path |
| Scripts | `tsx@^4.23.11` | Runs `scripts/*.ts` directly |
