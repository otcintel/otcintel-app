/**
 * OTCIntel — Data migration: filesystem → PostgreSQL
 *
 * Reads all current data from data/*.json files and upserts into PostgreSQL.
 * Safe to rerun — uses upsert/unique constraints, never duplicates rows.
 * Does NOT delete source JSON files after migration.
 *
 * Usage:
 *   npm run db:migrate-data
 *
 * Required env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Optional:
 *   MIGRATE_RUNS=1   — also migrate ingestion run history (default: skipped)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import type { CompanyRecord } from '../lib/universe/types';
import type { NormalizedFiling, CompanyIntelligence } from '../lib/ingestion/types';

// ─── Config ───────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MIGRATE_RUNS = process.env.MIGRATE_RUNS === '1';

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
  console.error('These credentials must be kept server-side and never exposed to clients.');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const DATA_DIR         = path.resolve(process.cwd(), 'data');
const FILINGS_DIR      = path.join(DATA_DIR, 'filings');
const INTELLIGENCE_DIR = path.join(DATA_DIR, 'intelligence');

// ─── Utilities ────────────────────────────────────────────────────────────────

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch (err) {
    console.warn(`  [warn] Could not read ${path.basename(filePath)}: ${err}`);
    return null;
  }
}

function fmt(n: number): string { return n.toLocaleString(); }

// ─── Step 1: Migrate companies ────────────────────────────────────────────────

async function migrateCompanies(companies: CompanyRecord[]): Promise<void> {
  console.log(`\nStep 1 — Companies (${fmt(companies.length)} records)`);

  const rows = companies.map(c => ({
    cik:                        c.cik,
    ticker:                     c.ticker.toUpperCase(),
    company_name:               c.companyName,
    exchange:                   c.exchange ?? null,
    sec_reporting_status:       c.secReportingStatus ?? null,
    active:                     c.active,
    ingestion_status:           c.ingestionStatus,
    confidence_status:          c.confidenceStatus ?? null,
    filings_discovered:         c.filingsDiscovered,
    filings_parsed:             c.filingsParsed,
    warnings_count:             c.warningsCount,
    rejected_candidates_count:  c.rejectedCandidatesCount,
    latest_filing_date:         c.latestFilingDate ?? null,
    last_ingestion_time:        c.lastIngestionTime ?? null,
    last_successful_parse_time: c.lastSuccessfulParseTime ?? null,
    error_message:              c.errorMessage ?? null,
    created_at:                 c.createdAt,
    updated_at:                 c.updatedAt,
  }));

  const { error } = await db.from('companies').upsert(rows, { onConflict: 'cik' });
  if (error) throw new Error(`companies upsert failed: ${error.message}`);
  console.log(`  ✓ Upserted ${fmt(rows.length)} companies`);
}

// ─── Step 2: Migrate filings ──────────────────────────────────────────────────

async function migrateFilings(companies: CompanyRecord[]): Promise<void> {
  console.log(`\nStep 2 — Filings`);

  // Build CIK → company_id map from the DB
  const { data: companyRows, error: cidErr } = await db
    .from('companies')
    .select('id, cik');
  if (cidErr) throw new Error(`could not fetch company IDs: ${cidErr.message}`);
  const companyIdByCik = new Map(
    (companyRows as { id: string; cik: string }[]).map(r => [r.cik, r.id]),
  );

  let totalFilings     = 0;
  let totalNotes       = 0;
  let filesProcessed   = 0;

  for (const company of companies) {
    const ticker      = company.ticker.toUpperCase();
    const filingsFile = path.join(FILINGS_DIR, `${ticker}.json`);
    const filings     = readJson<NormalizedFiling[]>(filingsFile);
    if (!filings || filings.length === 0) continue;

    const companyId = companyIdByCik.get(company.cik);
    if (!companyId) {
      console.warn(`  [warn] No DB row for CIK ${company.cik} (${ticker}) — skipping filings`);
      continue;
    }

    // Build filing rows
    const filingRows = filings.map(f => {
      const ft = f.financing;
      const ss = f.shareStructure;
      return {
        accession_number:               f.accessionNumber,
        company_id:                     companyId,
        cik:                            f.cik,
        ticker:                         f.ticker.toUpperCase(),
        form_type:                      f.formType,
        filed_at:                       f.filedAt,
        period_of_report:               f.periodOfReport || null,
        document_url:                   f.documentUrl,
        full_text_url:                  null,
        source:                         f.source,
        parser_version:                 f.parserVersion,
        parse_errors:                   f.parseErrors,
        summary:                        f.summary ?? null,
        event_summary:                  f.eventSummary ?? null,
        event_type:                     f.eventType ?? null,
        terms:                          f.terms ?? null,
        tags:                           f.tags ?? null,
        financing_type:                 ft?.financingType ?? null,
        financing_principal_amount:     ft?.principalAmount ?? null,
        financing_discount_rate:        ft?.discountRate ?? null,
        financing_lookback_days:        ft?.lookbackDays ?? null,
        financing_has_floor_price:      ft?.hasFloorPrice ?? null,
        financing_floor_price:          ft?.floorPrice ?? null,
        financing_has_reset_provisions: ft?.hasResetProvisions ?? null,
        financing_warrant_shares:       ft?.warrantShares ?? null,
        financing_warrant_exercise_price: ft?.warrantExercisePrice ?? null,
        financing_maturity_date:        ft?.maturityDate ?? null,
        financing_investor_name:        ft?.investorName ?? null,
        financing_confidence:           ft?.confidence ?? null,
        shares_authorized:              ss?.sharesAuthorized ?? null,
        shares_outstanding:             ss?.sharesOutstanding ?? null,
        shares_float:                   ss?.sharesFloat ?? null,
        preferred_shares_outstanding:   ss?.preferredSharesOutstanding ?? null,
        share_structure_confidence:     ss?.confidence ?? null,
        financing_raw:                  f.financing ?? null,
        share_structure_raw:            f.shareStructure ?? null,
        financing_report_raw:           f.financingReport ?? null,
      };
    });

    const { data: upsertedFilings, error: fErr } = await db
      .from('filings')
      .upsert(filingRows, { onConflict: 'accession_number' })
      .select('id, accession_number');
    if (fErr) {
      console.warn(`  [warn] Filings upsert failed for ${ticker}: ${fErr.message}`);
      continue;
    }

    totalFilings += filingRows.length;
    filesProcessed++;

    // Migrate convertible notes
    const filingIdMap = new Map(
      (upsertedFilings as { id: string; accession_number: string }[]).map(r => [r.accession_number, r.id]),
    );

    const noteRows = [];
    for (const f of filings) {
      const notes = f.financingReport?.convertibleDebt;
      if (!notes || notes.length === 0) continue;
      const filingId = filingIdMap.get(f.accessionNumber);
      if (!filingId) continue;

      for (let i = 0; i < notes.length; i++) {
        const n = notes[i] as unknown as Record<string, unknown>;
        noteRows.push({
          filing_id:                    filingId,
          company_id:                   companyId,
          note_index:                   i,
          instrument_type:              (n.instrumentType as string) ?? null,
          instrument_name:              (n.instrumentName as string) ?? null,
          is_amendment:                 (n.isAmendment as boolean) ?? null,
          investor_name:                (n.investorName as string) ?? null,
          principal_amount:             (n.principalAmount as number) ?? null,
          purchase_price:               (n.purchasePrice as number) ?? null,
          original_issue_discount:      (n.originalIssueDiscount as number) ?? null,
          net_proceeds:                 (n.netProceeds as number) ?? null,
          outstanding_balance:          (n.outstandingBalance as number) ?? null,
          interest_rate:                (n.interestRate as number) ?? null,
          default_interest_rate:        (n.defaultInterestRate as number) ?? null,
          maturity_date:                (n.maturityDate as string) ?? null,
          execution_date:               (n.executionDate as string) ?? null,
          prepayment_premium:           (n.prepaymentPremium as number) ?? null,
          redemption_premium:           (n.redemptionPremium as number) ?? null,
          conversion_formula:           (n.conversionFormula as string) ?? null,
          fixed_conversion_price:       (n.fixedConversionPrice as number) ?? null,
          discount_rate:                (n.discountRate as number) ?? null,
          lookback_days:                (n.lookbackDays as number) ?? null,
          floor_price:                  (n.floorPrice as number) ?? null,
          has_floor_price:              (n.hasFloorPrice as boolean) ?? null,
          ceiling_price:                (n.ceilingPrice as number) ?? null,
          exchange_cap:                 (n.exchangeCap as number) ?? null,
          beneficial_ownership_blocker: (n.beneficialOwnershipBlocker as number) ?? null,
          has_reset_provisions:         (n.hasResetProvisions as boolean) ?? null,
          anti_dilution_provisions:     (n.antiDilutionProvisions as boolean) ?? null,
          has_acceleration_clause:      (n.hasAccelerationClause as boolean) ?? null,
          penalty_rate:                 (n.penaltyRate as number) ?? null,
          status:                       (n.status as string) ?? null,
          amount_converted:             (n.amountConverted as number) ?? null,
          amount_repaid:                (n.amountRepaid as number) ?? null,
          raw_payload:                  n,
        });
        totalNotes++;
      }
    }

    if (noteRows.length > 0) {
      const { error: nErr } = await db
        .from('convertible_notes')
        .upsert(noteRows, { onConflict: 'filing_id,note_index' });
      if (nErr) console.warn(`  [warn] Convertible notes upsert failed for ${ticker}: ${nErr.message}`);
    }
  }

  console.log(`  ✓ Upserted ${fmt(totalFilings)} filings from ${filesProcessed} tickers`);
  console.log(`  ✓ Upserted ${fmt(totalNotes)} convertible notes`);
}

// ─── Step 3: Migrate intelligence ────────────────────────────────────────────

async function migrateIntelligence(companies: CompanyRecord[]): Promise<void> {
  console.log(`\nStep 3 — Company intelligence`);

  const { data: companyRows } = await db.from('companies').select('id, ticker');
  const companyIdByTicker = new Map(
    (companyRows as { id: string; ticker: string }[]).map(r => [r.ticker, r.id]),
  );

  let count = 0;
  for (const company of companies) {
    const ticker = company.ticker.toUpperCase();
    const intFile = path.join(INTELLIGENCE_DIR, `${ticker}.json`);
    const intel   = readJson<CompanyIntelligence>(intFile);
    if (!intel) continue;

    const companyId = companyIdByTicker.get(ticker);
    if (!companyId) continue;

    const fp = intel.financingProfile;
    const ov = intel.overview;
    const { error } = await db.from('company_intelligence').upsert({
      company_id:                       companyId,
      ticker,
      generated_at:                     intel.generatedAt,
      filings_analyzed:                 intel.filingsAnalyzed,
      dilution_risk:                    ov.dilutionRisk ?? null,
      latest_shares_outstanding:        ov.latestSharesOutstanding ?? null,
      latest_authorized_shares:         ov.latestAuthorizedShares ?? null,
      total_convertible_principal:      fp.totalConvertiblePrincipal ?? null,
      toxic_note_count:                 fp.toxicNoteCount ?? null,
      no_floor_note_count:              fp.noFloorNoteCount ?? null,
      has_active_eloc:                  fp.hasActiveEloc ?? null,
      total_equity_facility_commitment: fp.totalEquityFacilityCommitment ?? null,
      total_warrant_shares:             fp.totalWarrantShares ?? null,
      raw_payload:                      intel,
    }, { onConflict: 'company_id' });
    if (error) console.warn(`  [warn] Intelligence upsert failed for ${ticker}: ${error.message}`);
    else count++;
  }

  console.log(`  ✓ Upserted ${fmt(count)} intelligence records`);
}

// ─── Step 4: Migrate runs (optional) ─────────────────────────────────────────

async function migrateRuns(): Promise<void> {
  if (!MIGRATE_RUNS) {
    console.log(`\nStep 4 — Ingestion runs: skipped (set MIGRATE_RUNS=1 to include)`);
    return;
  }
  console.log(`\nStep 4 — Ingestion runs`);

  const runsFile = path.join(DATA_DIR, 'runs.json');
  const runs = readJson<Array<Record<string, unknown>>>(runsFile);
  if (!runs || runs.length === 0) {
    console.log('  (no runs found)');
    return;
  }

  const runRows = runs.map(r => ({
    run_id:              r.runId,
    started_at:          r.startedAt,
    ended_at:            r.endedAt ?? null,
    parser_version:      r.parserVersion ?? '1.0.0',
    status:              r.status,
    companies_attempted: r.companiesAttempted ?? 0,
    companies_completed: r.companiesCompleted ?? 0,
    companies_partial:   r.companiesPartial ?? 0,
    companies_failed:    r.companiesFailed ?? 0,
    filings_discovered:  r.filingsDiscovered ?? 0,
    filings_downloaded:  r.filingsDownloaded ?? 0,
    filings_parsed:      r.filingsParsed ?? 0,
    warnings_count:      r.warningsCount ?? 0,
    errors:              r.errors ?? [],
  }));

  const { error } = await db.from('ingestion_runs').upsert(runRows, { onConflict: 'run_id' });
  if (error) throw new Error(`runs upsert failed: ${error.message}`);
  console.log(`  ✓ Upserted ${fmt(runRows.length)} ingestion runs`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════');
  console.log('  OTCIntel — Data Migration (FS → Postgres)');
  console.log('═══════════════════════════════════════════');
  console.log(`  Source: ${DATA_DIR}`);
  console.log(`  Target: ${SUPABASE_URL?.substring(0, 40)}...`);

  // Load all companies from filesystem
  const companiesFile = path.join(DATA_DIR, 'companies.json');
  const companiesMap  = readJson<Record<string, CompanyRecord>>(companiesFile);
  if (!companiesMap) {
    console.error(`ERROR: Could not read ${companiesFile}`);
    process.exit(1);
  }
  const companies = Object.values(companiesMap);
  console.log(`\n  Found ${fmt(companies.length)} companies in filesystem`);

  const start = Date.now();

  await migrateCompanies(companies);
  await migrateFilings(companies);
  await migrateIntelligence(companies);
  await migrateRuns();

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n═══════════════════════════════════════════`);
  console.log(`  Migration complete in ${elapsed}s`);
  console.log(`  Source JSON files have NOT been deleted.`);
  console.log(`  Run npm run db:verify to confirm parity.`);
  console.log('═══════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('\nMigration failed:', err);
  process.exit(1);
});
