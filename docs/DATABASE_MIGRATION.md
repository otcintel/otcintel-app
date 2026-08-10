# OTCIntel — Database Migration Guide

This document covers migrating from filesystem JSON persistence to PostgreSQL (Supabase), running locally without Supabase, and rolling back.

---

## Overview

Phase 5 introduced a dual-backend persistence layer. The filesystem backend (`PERSISTENCE_BACKEND=filesystem`, the default) continues to work unchanged. The Postgres backend reads through the repository interfaces in `lib/db/repositories.ts`.

**The write path (batch ingestor) is still filesystem-only.** It continues writing to `data/*.json`. The Postgres layer is read-only from the UI's perspective. Migration syncs the current JSON state into Postgres on demand.

---

## Environment variables

| Variable | Required for | Notes |
|----------|-------------|-------|
| `SUPABASE_URL` | Postgres backend | Your project URL from Supabase dashboard |
| `SUPABASE_SERVICE_ROLE_KEY` | Postgres backend | **Server-side only. Never expose to clients or NEXT_PUBLIC_*** |
| `PERSISTENCE_BACKEND` | Switching backends | `filesystem` (default) or `postgres` |
| `MIGRATE_RUNS=1` | Optional | Include ingestion run history in migration |

**Security**: `SUPABASE_SERVICE_ROLE_KEY` bypasses Row Level Security. It must never appear in:
- `NEXT_PUBLIC_*` environment variables
- Client components or browser bundles
- Public repositories or `.env` files committed to git

Store it in `.env.local` (gitignored) for local development.

---

## Running locally without Supabase

The default `PERSISTENCE_BACKEND=filesystem` requires no database. All UI pages read from `data/*.json` through the filesystem wrappers in `lib/db/filesystem.ts`. No env vars needed.

To develop against a local Postgres instance instead of Supabase cloud:
1. Run `supabase start` (requires [Supabase CLI](https://supabase.com/docs/guides/cli))
2. Apply the migration: `supabase db push`
3. Set `SUPABASE_URL=http://localhost:54321` and use the local service role key printed by `supabase start`

---

## Migration process

### Step 1 — Apply the schema

```bash
supabase db push
# or for manual apply:
psql $DATABASE_URL < supabase/migrations/001_initial_schema.sql
```

### Step 2 — Migrate data

```bash
npm run db:migrate-data
```

This reads all `data/*.json` files and upserts into Postgres. Safe to rerun — all operations use `onConflict` upserts. The source JSON files are **not** deleted.

To also migrate ingestion run history:

```bash
MIGRATE_RUNS=1 npm run db:migrate-data
```

### Step 3 — Verify parity

```bash
npm run db:verify
```

This runs 7 checks comparing filesystem state against Postgres:
1. Company count
2. Company identities (CIK + ticker)
3. Filing counts per ticker
4. Accession number presence
5. Parser version consistency
6. Key field spot-checks (financing type, JSONB presence)
7. Convertible note count + provenance field availability

Exit code 0 = all checks passed. Exit code 1 = mismatches found.

### Step 4 — Switch the UI to Postgres

Only after `db:verify` exits 0:

```bash
# In .env.local
PERSISTENCE_BACKEND=postgres
```

Restart the Next.js dev server or redeploy.

---

## Keeping Postgres in sync

After each ingestion run (which writes to `data/*.json`), re-run the migration:

```bash
npm run db:migrate-data
npm run db:verify
```

This is idempotent — existing rows are updated, new rows are inserted. There is no incremental sync mechanism yet; the full upsert approach is fast enough for current data volumes.

---

## Rollback

To revert to filesystem persistence, remove (or set to `filesystem`) the `PERSISTENCE_BACKEND` env var and restart. No data loss — the JSON files were never deleted.

To wipe Postgres and start over:

```bash
supabase db reset  # drops and recreates the database locally
# or
psql $DATABASE_URL -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
# then re-apply migration and re-run db:migrate-data
```

---

## Backend selection logic

`lib/db/repositories.ts` reads `process.env.PERSISTENCE_BACKEND` at module load time. Repositories are lazy-loaded singletons — the first call to `getCompaniesRepo()` instantiates the backend; subsequent calls return the cached instance.

Call `resetRepositories()` (exported from `lib/db/repositories.ts`) in tests to clear the singleton cache between test cases.

---

## Testing without a live database

All unit tests mock `lib/db/repositories` or `lib/db/postgres/client`. No test requires a real Supabase instance. See:
- `lib/__tests__/server-data.test.ts` — mocks repository layer
- `lib/db/__tests__/postgres-companies.test.ts` — mocks Supabase client
- `lib/db/__tests__/postgres-filings.test.ts` — structural contract tests

To test against a real local Supabase instance, use `supabase start` and set the env vars before running `npm test`.

---

## Security considerations

- The service role key is only loaded server-side in `lib/db/postgres/client.ts`
- The client is never instantiated in Next.js client components or middleware
- `server-only` is imported in `lib/server-data.ts` to enforce server-only access at build time
- Row Level Security (RLS) is not enforced in the current schema — the service role key bypasses it. RLS policies can be added later without schema changes
- Admin routes continue to require `Authorization: Bearer <ADMIN_SECRET>` regardless of persistence backend
