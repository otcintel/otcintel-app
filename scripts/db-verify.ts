/**
 * OTCIntel — Filesystem ↔ PostgreSQL parity checker
 *
 * Compares the current data/*.json filesystem state against PostgreSQL
 * and reports any mismatches. The PostgreSQL backend should not become
 * the production default until this check passes with no errors.
 *
 * Usage:
 *   npm run db:verify
 *
 * Required env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Exit codes:
 *   0 — all checks passed (parity confirmed)
 *   1 — mismatches found or check failed
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import type { CompanyRecord } from '../lib/universe/types';
import type { NormalizedFiling } from '../lib/ingestion/types';

// ─── Config ───────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const DATA_DIR    = path.resolve(process.cwd(), 'data');
const FILINGS_DIR = path.join(DATA_DIR, 'filings');

// ─── Utilities ────────────────────────────────────────────────────────────────

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch { return null; }
}

let errors = 0;
let warnings = 0;

function error(msg: string): void {
  console.error(`  ✗ ERROR: ${msg}`);
  errors++;
}

function warn(msg: string): void {
  console.warn(`  ⚠ WARN:  ${msg}`);
  warnings++;
}

function ok(msg: string): void {
  console.log(`  ✓ ${msg}`);
}

// ─── Check 1: Company counts ──────────────────────────────────────────────────

async function checkCompanyCount(fsCompanies: CompanyRecord[]): Promise<void> {
  console.log('\nCheck 1 — Company count');

  const { count, error: dbErr } = await db
    .from('companies').select('*', { count: 'exact', head: true });
  if (dbErr) { error(`DB query failed: ${dbErr.message}`); return; }

  const fsCount = fsCompanies.length;
  const pgCount = count ?? 0;

  if (fsCount !== pgCount) {
    error(`Company count mismatch: filesystem=${fsCount}, postgres=${pgCount}`);
  } else {
    ok(`Company count matches: ${fsCount}`);
  }
}

// ─── Check 2: Company identities ─────────────────────────────────────────────

async function checkCompanyIdentities(fsCompanies: CompanyRecord[]): Promise<void> {
  console.log('\nCheck 2 — Company identities (CIK + ticker)');

  const { data, error: dbErr } = await db.from('companies').select('cik, ticker');
  if (dbErr) { error(`DB query failed: ${dbErr.message}`); return; }

  const pgByCik = new Map((data as { cik: string; ticker: string }[]).map(r => [r.cik, r.ticker]));
  let mismatches = 0;

  for (const c of fsCompanies) {
    if (!pgByCik.has(c.cik)) {
      error(`Company CIK ${c.cik} (${c.ticker}) missing from postgres`);
      mismatches++;
    } else if (pgByCik.get(c.cik) !== c.ticker.toUpperCase()) {
      warn(`Ticker mismatch for CIK ${c.cik}: fs=${c.ticker}, pg=${pgByCik.get(c.cik)}`);
    }
  }

  if (mismatches === 0) ok(`All ${fsCompanies.length} company CIKs present in postgres`);

  // Check for postgres-only companies (unexpected)
  for (const [pgCik] of pgByCik) {
    if (!fsCompanies.find(c => c.cik === pgCik)) {
      warn(`CIK ${pgCik} in postgres but not in filesystem (possibly from a prior migration run)`);
    }
  }
}

// ─── Check 3: Filing counts ───────────────────────────────────────────────────

async function checkFilingCounts(fsCompanies: CompanyRecord[]): Promise<void> {
  console.log('\nCheck 3 — Filing counts per ticker');

  const { data, error: dbErr } = await db
    .from('filings').select('ticker');
  if (dbErr) { error(`DB query failed: ${dbErr.message}`); return; }

  const pgCountByTicker = new Map<string, number>();
  for (const row of (data as { ticker: string }[])) {
    pgCountByTicker.set(row.ticker, (pgCountByTicker.get(row.ticker) ?? 0) + 1);
  }

  let totalFsFilings = 0;
  let totalPgFilings = 0;
  let mismatchCount  = 0;

  for (const c of fsCompanies) {
    const ticker    = c.ticker.toUpperCase();
    const fsFilings = readJson<NormalizedFiling[]>(path.join(FILINGS_DIR, `${ticker}.json`)) ?? [];
    const fsCount   = fsFilings.length;
    const pgCount   = pgCountByTicker.get(ticker) ?? 0;

    totalFsFilings += fsCount;
    totalPgFilings += pgCount;

    if (fsCount !== pgCount) {
      error(`Filing count mismatch for ${ticker}: fs=${fsCount}, pg=${pgCount}`);
      mismatchCount++;
    }
  }

  if (mismatchCount === 0) {
    ok(`Filing counts match for all tickers (total: ${totalFsFilings})`);
  } else {
    error(`${mismatchCount} tickers have filing count mismatches`);
  }
}

// ─── Check 4: Accession number parity ────────────────────────────────────────

async function checkAccessionNumbers(fsCompanies: CompanyRecord[]): Promise<void> {
  console.log('\nCheck 4 — Accession number parity (sample)');

  const { data, error: dbErr } = await db
    .from('filings').select('accession_number, ticker');
  if (dbErr) { error(`DB query failed: ${dbErr.message}`); return; }

  const pgAccessions = new Set((data as { accession_number: string }[]).map(r => r.accession_number));
  let missing = 0;

  for (const c of fsCompanies) {
    const ticker    = c.ticker.toUpperCase();
    const fsFilings = readJson<NormalizedFiling[]>(path.join(FILINGS_DIR, `${ticker}.json`)) ?? [];
    for (const f of fsFilings) {
      if (!pgAccessions.has(f.accessionNumber)) {
        error(`Accession ${f.accessionNumber} (${ticker}) missing from postgres`);
        missing++;
        if (missing >= 10) { warn('Stopping accession check after 10 errors'); return; }
      }
    }
  }

  if (missing === 0) ok(`All accession numbers present in postgres`);
}

// ─── Check 5: Parser version parity ──────────────────────────────────────────

async function checkParserVersions(fsCompanies: CompanyRecord[]): Promise<void> {
  console.log('\nCheck 5 — Parser version consistency');

  const { data, error: dbErr } = await db
    .from('filings').select('accession_number, parser_version');
  if (dbErr) { error(`DB query failed: ${dbErr.message}`); return; }

  const pgVersionByAcc = new Map(
    (data as { accession_number: string; parser_version: string }[]).map(r => [r.accession_number, r.parser_version]),
  );

  let mismatches = 0;
  for (const c of fsCompanies) {
    const ticker    = c.ticker.toUpperCase();
    const fsFilings = readJson<NormalizedFiling[]>(path.join(FILINGS_DIR, `${ticker}.json`)) ?? [];
    for (const f of fsFilings) {
      const pgVersion = pgVersionByAcc.get(f.accessionNumber);
      if (pgVersion && pgVersion !== f.parserVersion) {
        error(`Parser version mismatch for ${f.accessionNumber}: fs=${f.parserVersion}, pg=${pgVersion}`);
        mismatches++;
      }
    }
  }

  if (mismatches === 0) ok('Parser versions consistent across filesystem and postgres');
}

// ─── Check 6: Key field spot-checks ──────────────────────────────────────────

async function checkKeyFields(fsCompanies: CompanyRecord[]): Promise<void> {
  console.log('\nCheck 6 — Key field spot-checks (financing + share structure)');

  // Pick up to 5 filings that have financing data
  const sampledFilings: { ticker: string; filing: NormalizedFiling }[] = [];
  for (const c of fsCompanies) {
    const ticker    = c.ticker.toUpperCase();
    const fsFilings = readJson<NormalizedFiling[]>(path.join(FILINGS_DIR, `${ticker}.json`)) ?? [];
    for (const f of fsFilings) {
      if (f.financing && sampledFilings.length < 5) {
        sampledFilings.push({ ticker, filing: f });
      }
    }
    if (sampledFilings.length >= 5) break;
  }

  if (sampledFilings.length === 0) {
    ok('No filings with financing data found — skipping field spot-check');
    return;
  }

  let fieldErrors = 0;
  for (const { filing: f } of sampledFilings) {
    const { data, error: dbErr } = await db
      .from('filings')
      .select('financing_type, financing_principal_amount, financing_discount_rate, financing_confidence, financing_raw')
      .eq('accession_number', f.accessionNumber)
      .maybeSingle();

    if (dbErr || !data) {
      error(`Could not fetch PG row for ${f.accessionNumber}`);
      fieldErrors++;
      continue;
    }

    const row = data as Record<string, unknown>;
    const ft  = f.financing!;

    if (row.financing_type !== ft.financingType) {
      error(`financing_type mismatch for ${f.accessionNumber}: fs=${ft.financingType}, pg=${row.financing_type}`);
      fieldErrors++;
    }
    if (row.financing_raw === null && ft !== undefined) {
      error(`financing_raw is null in postgres but financing exists in filesystem for ${f.accessionNumber}`);
      fieldErrors++;
    }
    // Verify raw JSONB round-trips the financingType
    const rawFt = (row.financing_raw as Record<string, unknown> | null)?.financingType;
    if (rawFt && rawFt !== ft.financingType) {
      error(`financing_raw.financingType mismatch for ${f.accessionNumber}: fs=${ft.financingType}, pg_raw=${rawFt}`);
      fieldErrors++;
    }
  }

  if (fieldErrors === 0) {
    ok(`Field spot-check passed for ${sampledFilings.length} sampled filings`);
  }
}

// ─── Check 7: Provenance availability ────────────────────────────────────────

async function checkProvenance(fsCompanies: CompanyRecord[]): Promise<void> {
  console.log('\nCheck 7 — Provenance preservation in convertible_notes');

  const { count: noteCount, error: dbErr } = await db
    .from('convertible_notes')
    .select('*', { count: 'exact', head: true });
  if (dbErr) { error(`DB query failed: ${dbErr.message}`); return; }

  // Count filesystem convertible notes
  let fsNoteCount = 0;
  for (const c of fsCompanies) {
    const ticker    = c.ticker.toUpperCase();
    const fsFilings = readJson<NormalizedFiling[]>(path.join(FILINGS_DIR, `${ticker}.json`)) ?? [];
    for (const f of fsFilings) {
      fsNoteCount += f.financingReport?.convertibleDebt?.length ?? 0;
    }
  }

  const pgNoteCount = noteCount ?? 0;
  if (fsNoteCount !== pgNoteCount) {
    error(`Convertible note count mismatch: fs=${fsNoteCount}, pg=${pgNoteCount}`);
  } else {
    ok(`Convertible note count matches: ${fsNoteCount}`);
  }

  // Spot-check that raw_payload contains provenance fields
  const { data: sampleNotes } = await db
    .from('convertible_notes')
    .select('raw_payload')
    .limit(3);

  if (sampleNotes && sampleNotes.length > 0) {
    let hasProvenance = 0;
    for (const row of sampleNotes as { raw_payload: Record<string, unknown> }[]) {
      if (row.raw_payload._fieldProvenance || row.raw_payload._sourceSentenceTexts || row.raw_payload._validationWarnings) {
        hasProvenance++;
      }
    }
    if (hasProvenance > 0) ok(`Provenance fields present in raw_payload (${hasProvenance}/${sampleNotes.length} sampled)`);
    else warn('Sampled convertible notes have no provenance fields — may be expected if parser did not extract them');
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════');
  console.log('  OTCIntel — Database Parity Verification');
  console.log('═══════════════════════════════════════════');

  const companiesFile = path.join(DATA_DIR, 'companies.json');
  const companiesMap  = readJson<Record<string, CompanyRecord>>(companiesFile);
  if (!companiesMap) {
    console.error(`ERROR: Could not read ${companiesFile}`);
    process.exit(1);
  }
  const fsCompanies = Object.values(companiesMap);
  console.log(`  Filesystem: ${fsCompanies.length} companies`);
  console.log(`  Postgres:   ${SUPABASE_URL?.substring(0, 40)}...`);

  await checkCompanyCount(fsCompanies);
  await checkCompanyIdentities(fsCompanies);
  await checkFilingCounts(fsCompanies);
  await checkAccessionNumbers(fsCompanies);
  await checkParserVersions(fsCompanies);
  await checkKeyFields(fsCompanies);
  await checkProvenance(fsCompanies);

  console.log('\n═══════════════════════════════════════════');
  if (errors === 0 && warnings === 0) {
    console.log('  ✓ All parity checks passed — Postgres and filesystem are in sync.');
    console.log('  You may now set PERSISTENCE_BACKEND=postgres for the UI layer.');
  } else if (errors === 0) {
    console.log(`  ✓ No errors. ${warnings} warning(s) — review above.`);
    console.log('  Postgres is likely usable but review warnings before switching.');
  } else {
    console.log(`  ✗ ${errors} error(s), ${warnings} warning(s) found.`);
    console.log('  Do NOT switch to PERSISTENCE_BACKEND=postgres until errors are resolved.');
    console.log('  Re-run npm run db:migrate-data and then npm run db:verify.');
  }
  console.log('═══════════════════════════════════════════\n');

  process.exit(errors > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\nVerification failed:', err);
  process.exit(1);
});
