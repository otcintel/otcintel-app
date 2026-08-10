<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

---

## Project overview

OTCIntel is an OTC/microcap market intelligence platform. It extracts, structures, and scores financing mechanics from public SEC filings — convertible notes, equity lines, warrants, preferred stock.

See `docs/CURRENT_STATE.md` for the full system state. See `docs/ARCHITECTURE.md` for the full architecture. See `docs/DATA_MODEL.md` for type definitions. See `docs/TECHNICAL_DEBT.md` for ranked problems.

---

## UI data access pattern

All production UI pages read real data through `lib/server-data.ts` (server-only).
The canonical path is:

```
Server component page
  → import { getCompanies, getCompanyRecord, getCompanyFilings, getDashboardStats } from 'lib/server-data'
  → lib/db/index.ts (companiesDb, filingsDb)
  → data/*.json
```

Client components receive data as props from their server component parent. They never import `lib/server-data` or `lib/db` directly.

**`lib/data.ts` is dev/test-only.** It provides mock fixtures (WXYZ, EFGH, ABCD) for dev tooling and tests. No production page imports it. `lib/mock/rawFilings.ts` is still used by `lib/ingestion/fetchers/mock.ts` for mock-mode ingestion.

Do not read from `lib/mock/` when working on ingestion or UI pages.

---

## Key constraints

- **Persistence backend** — `PERSISTENCE_BACKEND=filesystem` (default) uses `lib/db/index.ts` writing JSON in `data/`. `PERSISTENCE_BACKEND=postgres` routes UI reads through Supabase via `lib/db/repositories.ts`. The **write path (batch ingestor) always writes to filesystem first**, then also dual-writes to Postgres via `lib/db/postgresSync.ts` when `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are present. Postgres sync errors surface as `partial` status in the run result — they do not abort the batch. `createPostgresSync()` returns `null` when credentials are absent, so local dev without Supabase works unchanged.
- **No auth** — No auth library exists. Do not add one without explicit instruction.
- **No LLM SDK** — No model API is integrated. Do not add one without explicit instruction.
- **EDGAR rate limits** — Process tickers sequentially. Do not add parallel EDGAR fetches.
- **SUPABASE_SERVICE_ROLE_KEY** must NEVER be exposed to clients, client components, browser bundles, `NEXT_PUBLIC_*` env vars, or public repositories. It is server-side only in `lib/db/postgres/client.ts`.

---

## Data directory

`data/` contains the production JSON database. Do not delete or overwrite files directly. All writes must go through `lib/db/index.ts`. The atomic write pattern (`.tmp` → rename, `.bak` backup) is required.

---

## Key type locations

- **Ingestion types:** `lib/ingestion/types.ts` — `NormalizedFiling`, `FinancingReport`, `ConvertibleNote`, `CompanyIntelligence`
- **UI/mock types:** `lib/types.ts` — `CompanyData`, `CompanyProfile`, `FilingRecord`

These hierarchies are not related. Ingestion code does not use `lib/types.ts`.

---

## Confidence model

`deriveConfidenceStatus()` in `lib/universe/companies.ts` requires at least one filing with a parseable form type (`PARSEABLE_FORMS` — defined there). Companies with only foreign-filer forms (6-K, 20-F) correctly return `insufficient_data`. Do not change this logic without re-running the audit.

---

## OTC Markets API

`lib/ingestion/enrichment/otcMarkets.ts` is permanently blocked by Akamai. Phase 4 of the ingestion pipeline always silently skips. The enrichment function returns `undefined` immediately unless `OTC_ENRICHMENT_ENABLED=true` is set — disabled by default, not opt-out. Do not attempt to fix the block by adding new headers — it requires browser session cookies.

---

## Admin routes

All six routes under `/api/admin/` are guarded by `lib/api/adminAuth.ts`. Every request must include `Authorization: Bearer <ADMIN_SECRET>`. The guard uses constant-time comparison (`timingSafeEqual`) to prevent timing attacks. If `ADMIN_SECRET` is not set, the server returns 503.

To call any admin route:
```
Authorization: Bearer <your-ADMIN_SECRET>
```

Do not remove or bypass the auth guard.

---

## Parser version and automatic reprocessing

`PARSER_VERSION = '1.0.0'` in `lib/universe/types.ts`. Stamped on every `NormalizedFiling` at normalization time.

**Staleness detection**: `getStaleFilings()` and `hasStaleFilings()` in `lib/universe/companies.ts` identify filings whose `parserVersion` does not match the current `PARSER_VERSION`. The batch ingestor automatically removes stale filings from the skip-set so they are re-fetched and re-parsed.

**When to increment**: increment `PARSER_VERSION` whenever field extraction logic changes materially (new fields, changed field semantics, parser algorithm changes). This triggers automatic reprocessing on the next ingest run.

---

## Risk scoring — domain rules

These rules are non-negotiable and must not be silently violated:

1. **Never fabricate missing financial values.** If a value cannot be extracted from the source text, it must remain `undefined`.
2. **"Insufficient Data" is the required output when a valid quantitative risk score cannot be supported** — not a synthetic fallback number, not a bucketed proxy.
3. **Every extracted financing/security term must retain source provenance** — `_fieldProvenance`, `_sourceSentenceTexts`, `_validationWarnings`.
4. **Do not silently modify financial scoring logic.** `scoreFinancingRisk()` in `lib/ingestion/scoring.ts` has exact factor weights; changing them is a domain decision.
5. **Do not redefine financial/security concepts** (e.g. discount rate, VWAP, reset provision) without explicit domain approval.
6. **Missing information is preferable to an unsupported assumption.**
7. **Preserve future capability for non-SEC OTC disclosure sources** — the ingestion architecture must not assume SEC filings are the only data source.

---

## Evaluation framework

Any change to extraction logic **must** run `npm run eval` before the change is merged. Material parser changes must not be merged if verified golden cases regress without explicit domain approval.

Golden cases live in `evals/golden/<TICKER>/`. See `docs/EVALUATION_FRAMEWORK.md` for the full protocol.

```bash
npm run eval             # concise — fails on verified regressions
npm run eval:verbose     # field-level detail + domain review warnings
```

---

## Testing

Test runner: Vitest v4.1.10. Config: `vitest.config.ts`. Tests live in `**/__tests__/**/*.test.ts`.

```bash
npm test              # single run
npm run test:watch    # watch mode
npm run test:coverage # coverage report (html + text)
```

Coverage targets: `lib/universe/companies.ts`, `lib/ingestion/scoring.ts`, `lib/ingestion/parsers/**/*.ts`, `lib/api/adminAuth.ts`.

When adding new tests, follow the pattern in `lib/universe/__tests__/companies.test.ts` (no globals, explicit imports from vitest). Financial logic tests must verify exact expected outputs, not snapshots.

---

## When writing code

1. Read the relevant section of `docs/ARCHITECTURE.md` before modifying any system boundary.
2. Check `docs/TECHNICAL_DEBT.md` to see if the problem you're solving is already tracked.
3. Check whether a ticker is real by looking at `data/companies.json`. Mock tickers (WXYZ, EFGH, ABCD) are only in `lib/data.ts` and are not production-relevant.
4. Do not add npm packages without checking compatibility with Next.js 16.x.
5. `PARSEABLE_FORMS` must not be duplicated — import from `lib/universe/companies.ts`.
6. Run `npm test && npx tsc --noEmit && npm run lint && npm run build` before reporting any change as complete.

