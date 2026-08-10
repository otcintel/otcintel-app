# Technical Debt — OTCIntel

> Ranked by severity and impact on the path to a shippable product.

---

## Critical — blocks launch

### TD-01: UI and ingestion systems are completely disconnected

**Files:** `lib/data.ts`, `lib/mock/profiles.ts`, `lib/mock/financing.ts`, `lib/mock/risk.ts`, `lib/mock/filings.ts`, `app/companies/page.tsx`

The companies list and most company detail pages read from `lib/mock/` with fake tickers (WXYZ, EFGH, ABCD). The 24 real ingested companies in `data/filings/` are never displayed in the UI. A visitor to the public site cannot see any real data.

**Path forward:** Replace `lib/data.ts` with a server-side reader that loads from `data/companies.json` + `data/filings/` and maps to the UI types. The company detail page already has the dynamic path logic — extend it to the list page.

---

### TD-02: No authentication

**Files:** `lib/schema.sql`, `package.json`

There is no auth library in `package.json`. The Supabase schema has `user_id` columns commented out. The admin API routes (`/api/admin/*`) have no access control — anyone who discovers the URL can trigger a full ingestion run or read the entire company database.

**Path forward:** Add NextAuth.js or Supabase Auth. Enable RLS in schema. Gate admin routes behind a session check. Gate user-facing routes behind a signup wall if the platform is invitation-only.

---

### TD-03: No database — file-based JSON is not production-safe

**Files:** `lib/db/index.ts`, `data/`

All production data lives in JSON files on the local filesystem. This means:
- No concurrent-write safety beyond single-process (atomic rename is not sufficient for concurrent Node.js processes)
- No horizontal scaling (Vercel serverless functions each have their own filesystem)
- `data/` files must be committed to git or managed separately
- No query capability — full file reads for every lookup

**Path forward:** Connect the existing Supabase schema. `lib/db/index.ts` exports a clean interface (`companiesDb`, `filingsDb`, `runsDb`, `intelligenceDb`) — swapping each to Supabase client calls is the natural migration path.

---

### TD-04: OTC Markets enrichment always fails

**Files:** `lib/ingestion/enrichment/otcMarkets.ts`, `lib/ingestion/pipeline.ts`

Phase 4 of the pipeline calls the OTC Markets backend API which is permanently blocked by Akamai. Every run logs warnings and returns `undefined`. The code path is correct and non-fatal, but the data source is unavailable.

**Path forward (short term):** Set `OTC_ENRICHMENT_ENABLED=false` in production to eliminate the wasted HTTP attempt per company per run. The existing kill-switch handles this.

**Path forward (long term):** Either scrape OTC Markets via a browser automation layer (fragile), subscribe to the OTC Disclosure API via EDGAR Online (`saber.api.edgar-online.com`, commercial), or accept that share structure comes from SEC filings only.

---

## High priority — degrades data quality or user trust

### TD-05: Dashboard is entirely static/hardcoded

**File:** `app/dashboard/page.tsx`

The dashboard shows hardcoded numbers ("8 companies tracked", "3 active dilution risk", "6 recent filings") and a hardcoded filing table with fake tickers (ABCD, WXYZ, EFGH, MNOP, QRST, UVWX). None of these reflect the real company universe.

**Path forward:** Replace with server component that reads from `companiesDb` and `filingsDb`.

---

### TD-06: No tests of any kind

**File:** `package.json`

There is no jest, vitest, or any test runner in the dependencies. There are no test files anywhere in the repository. The ingestion pipeline, parser, scoring engine, and confidence model are all untested code.

**Path forward:** Add vitest (or jest). Start with unit tests for `deriveConfidenceStatus`, `scoreFinancingRisk`, and the ConvertibleNote extractor — these are the most complex and most consequential. Integration tests for the pipeline require mocked EDGAR responses (fixtures already exist in `lib/mock/rawFilings.ts`).

---

### TD-07: Risk score is synthetic for the intelligence path

**File:** `app/company/[ticker]/page.tsx` (lines ~616–620)

When `scoreFinancingRisk()` returns `undefined` (no extractable 8-K financing terms), the company page falls back to a synthetic score derived from `intelligence.overview.dilutionRisk` via a hardcoded map (`severe → 88, high → 72, moderate → 45, low → 18`). This is displayed to users as an "OTCIntel risk score" without disclosing that it is a bucketed approximation.

**Path forward:** Either label the score clearly as "estimate" or drive the risk score from the `financingProfile` data in `CompanyIntelligence` rather than a four-value map.

---

### TD-08: Parser version is not checked at read time

**File:** `lib/db/index.ts`, `lib/universe/types.ts`

`PARSER_VERSION = '1.0.0'` is stamped on each filing at parse time. But no code checks this version when reading filings back. If the parser is updated to fix a field extraction bug, old filings continue to be served with stale data until a force-reparse run is triggered.

**Path forward:** Add a stale-data check in `batchIngestor` that re-parses filings whose `parserVersion` differs from `PARSER_VERSION`.

---

### TD-09: Two `PARSEABLE_FORMS` sets defined independently

**Files:** `lib/universe/companies.ts:19`, `app/api/admin/universe/audit/route.ts:88`

The same constant is defined twice. If one is updated and the other is not, confidence scoring and audit quality reports will diverge silently.

**Path forward:** Export `PARSEABLE_FORMS` from `lib/universe/companies.ts` and import it in the audit route. One definition.

---

### TD-10: `normalizedFilingStore` hydration has a race condition on cold start

**File:** `lib/ingestion/store.ts`

The store's `hydrate()` method sets `this.hydrated = true` before the DB read completes (the DB read is synchronous `fs.readFileSync`, so this is not actually async-racy). However, if multiple requests arrive simultaneously before the first hydration completes in a truly async future implementation, they would each trigger a hydration. The current synchronous implementation avoids this, but the guard is fragile.

**Path forward:** When migrating to async DB reads (Supabase), replace the boolean guard with a Promise that is resolved once and awaited by subsequent callers.

---

## Medium priority — code quality and maintainability

### TD-11: `lib/data.ts` mixes list-only and detail-company concerns

**File:** `lib/data.ts`

The file exports `companies` (full `CompanyData`), `companiesList` (summary), and `INTELLIGENCE_TICKERS` / `LIST_TICKERS` constants. All are fake. The mock system will need to be completely replaced rather than incrementally migrated, which increases risk.

**Path forward:** Keep the type contracts from `lib/types.ts` but replace the data assembly functions one at a time — `companiesList` first (list page), then `companies` per-ticker (detail page).

---

### TD-12: The `dangerouslySetInnerHTML` pattern is used for filing summaries

**File:** `app/company/[ticker]/page.tsx` (lines 278, 907, 1459, etc.)

The `summary` field of `NormalizedFiling` is stored and rendered as raw HTML. If the parser generates unexpected HTML or a future code path injects untrusted content, this is an XSS vector.

**Path forward:** Store summaries as plain text or use a sanitization library (DOMPurify) before rendering. Since summaries are generated internally by the parser, the risk is low today but should be addressed before any user-uploaded content is supported.

---

### TD-13: Admin API routes have no auth guard

**Files:** `app/api/admin/**/*.ts`

The admin routes (`/api/admin/universe/seed`, `/api/admin/universe/ingest`, `/api/admin/universe/rederive`) can be called by anyone. Triggering a full batch ingestion run is non-destructive but expensive (many EDGAR HTTP requests, disk writes). The seed route could alter the company registry.

**Path forward:** Add a simple shared-secret header check (`Authorization: Bearer $ADMIN_SECRET`) as a minimum before auth is fully implemented.

---

### TD-14: `next.config.ts` is empty

**File:** `next.config.ts`

No configuration is set. No image domains, no environment variable validation, no output mode, no bundle analysis. This is not a bug but will need to be configured before production deployment.

---

### TD-15: No deployment configuration exists

**Files:** (none)

There is no Dockerfile, no `vercel.json`, no GitHub Actions CI, and no deployment documentation. The project cannot be deployed to any target environment without building this infrastructure.

**Path forward:** Add a `vercel.json` or equivalent, and set up a CI workflow that runs `next build` on PRs.

---

## Low priority — cleanup

### TD-16: `.bak` files accumulate without cleanup

**File:** `lib/db/index.ts`

The `writeJson()` function creates a `.bak` file on every write. With frequent ingestion runs, the `data/` directory accumulates stale `.bak` files indefinitely. Currently 5 `.bak` files exist.

**Path forward:** Rotate `.bak` files (keep last N) or delete them after a successful rename.

---

### TD-17: `getActiveRuns()` relies on a timing assumption

**File:** `app/api/admin/universe/ingest/route.ts:55-57`

The async ingestion route uses `setImmediate()` + `getActiveRuns()` to extract the run ID after starting a background run. This is fragile — if the background function hasn't registered itself yet, `runId` will be `'unknown'`.

**Path forward:** Have `runBatchIngestion()` return the run ID synchronously (before the first `await`) so it can be captured without the timing hack.

---

### TD-18: `lib/schema.sql` references features that don't match current usage

**File:** `lib/schema.sql`

The schema references separate `financing_deals`, `risk_scores` tables in a normalized relational structure, but the actual data model stores everything in flat JSON blobs. When connecting a real database, significant schema design work will be needed to reconcile the two.

**Path forward:** Treat `lib/schema.sql` as aspirational documentation only. Redesign the schema from the actual `NormalizedFiling` and `CompanyRecord` types when database connection begins.

---

## Seed data gaps

The 52 seed companies in `lib/universe/seed.json` include:
- 27 **rejected** (acquired, bankrupt, wound_down, foreign_filer, dark, ticker_changed, merged)
- 10 **not_in_edgar** — tickers that exist on OTC Markets but have no EDGAR presence: CYBL, GTII, AABB, TAUG, ILUS, SFOR, TSOI, THER, USLY, GIGA

These 10 companies cannot be ingested via EDGAR and would require OTC Markets ARS data (commercial API) or manual data entry to cover.
