/**
 * File-based persistence layer
 *
 * All persistent state lives in app/data/ as JSON files.
 * No external database or npm packages required.
 *
 *   data/companies.json          — Record<cik, CompanyRecord>
 *   data/filings/{TICKER}.json   — NormalizedFiling[] newest-first
 *   data/runs.json               — IngestionRun[] newest-first (capped at 100)
 *   data/runs/{runId}.json       — RunResult[] for a single run
 *
 * Writes use write-to-temp + rename for crash safety within a single drive.
 * All reads return a typed fallback on any error — never throws.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { CompanyRecord, IngestionRun, RunResult } from '../universe/types';
import type { NormalizedFiling, CompanyIntelligence } from '../ingestion/types';

// ─── Paths ────────────────────────────────────────────────────────────────────

const DATA_DIR         = path.join(process.cwd(), 'data');
const FILINGS_DIR      = path.join(DATA_DIR, 'filings');
const RUNS_DIR         = path.join(DATA_DIR, 'runs');
const INTELLIGENCE_DIR = path.join(DATA_DIR, 'intelligence');

function ensureDirs(): void {
  for (const d of [DATA_DIR, FILINGS_DIR, RUNS_DIR, INTELLIGENCE_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

// ─── Atomic read / write ──────────────────────────────────────────────────────

function readJson<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (err) {
    // Log corruption so it surfaces in server console — never silently return empty fallback
    // when the file exists, as a subsequent write would overwrite the corrupted data.
    if (fs.existsSync(filePath)) {
      console.error(`[db] Failed to parse ${path.basename(filePath)}: ${err instanceof Error ? err.message : String(err)}. Returning fallback — DO NOT write over this file without inspecting it.`);
    }
    return fallback;
  }
}

function writeJson(filePath: string, data: unknown): void {
  ensureDirs();
  // Back up the existing file before overwriting so corruption is recoverable
  if (fs.existsSync(filePath)) {
    try { fs.copyFileSync(filePath, filePath + '.bak'); } catch { /* non-fatal */ }
  }
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  try {
    fs.renameSync(tmp, filePath);
  } catch {
    // rename can fail across drives on Windows; fall back to copy+delete
    fs.copyFileSync(tmp, filePath);
    fs.unlinkSync(tmp);
  }
}

// ─── Companies ────────────────────────────────────────────────────────────────

const COMPANIES_FILE = path.join(DATA_DIR, 'companies.json');

function readCompanies(): Record<string, CompanyRecord> {
  return readJson<Record<string, CompanyRecord>>(COMPANIES_FILE, {});
}

export const companiesDb = {
  getAll(): CompanyRecord[] {
    return Object.values(readCompanies()).sort((a, b) => a.ticker.localeCompare(b.ticker));
  },

  getByCik(cik: string): CompanyRecord | undefined {
    return readCompanies()[cik];
  },

  getByTicker(ticker: string): CompanyRecord | undefined {
    const upper = ticker.toUpperCase();
    return Object.values(readCompanies()).find(c => c.ticker === upper);
  },

  upsert(company: CompanyRecord): void {
    const all = readCompanies();
    all[company.cik] = { ...company, updatedAt: new Date().toISOString() };
    writeJson(COMPANIES_FILE, all);
  },

  upsertAll(companies: CompanyRecord[]): void {
    const all = readCompanies();
    const now = new Date().toISOString();
    for (const c of companies) {
      all[c.cik] = { ...c, updatedAt: now };
    }
    writeJson(COMPANIES_FILE, all);
  },

  updateStatus(cik: string, updates: Partial<CompanyRecord>): void {
    const all = readCompanies();
    if (!all[cik]) return;
    all[cik] = { ...all[cik], ...updates, updatedAt: new Date().toISOString() };
    writeJson(COMPANIES_FILE, all);
  },

  count(): number {
    return Object.keys(readCompanies()).length;
  },
};

// ─── Filings ──────────────────────────────────────────────────────────────────

function filingsPath(ticker: string): string {
  return path.join(FILINGS_DIR, `${ticker.toUpperCase()}.json`);
}

export const filingsDb = {
  getByTicker(ticker: string): NormalizedFiling[] {
    return readJson<NormalizedFiling[]>(filingsPath(ticker), []);
  },

  hasAccession(ticker: string, accessionNumber: string): boolean {
    return this.getByTicker(ticker).some(f => f.accessionNumber === accessionNumber);
  },

  /** Returns the set of accession numbers already stored for a ticker. */
  knownAccessions(ticker: string): Set<string> {
    return new Set(this.getByTicker(ticker).map(f => f.accessionNumber));
  },

  upsertAll(ticker: string, incoming: NormalizedFiling[]): void {
    if (incoming.length === 0) return;
    const existing = this.getByTicker(ticker);
    const byAcc = new Map(existing.map(f => [f.accessionNumber, f]));
    for (const f of incoming) byAcc.set(f.accessionNumber, f);
    const sorted = [...byAcc.values()].sort((a, b) => b.filedAt.localeCompare(a.filedAt));
    writeJson(filingsPath(ticker), sorted);
  },

  getAllTickers(): string[] {
    ensureDirs();
    try {
      return fs.readdirSync(FILINGS_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => f.slice(0, -5));
    } catch {
      return [];
    }
  },

  totalCount(): number {
    return this.getAllTickers().reduce((sum, t) => sum + this.getByTicker(t).length, 0);
  },
};

// ─── Ingestion runs ───────────────────────────────────────────────────────────

const RUNS_FILE = path.join(DATA_DIR, 'runs.json');

export const runsDb = {
  getAll(): IngestionRun[] {
    return readJson<IngestionRun[]>(RUNS_FILE, []);
  },

  getById(runId: string): IngestionRun | undefined {
    return this.getAll().find(r => r.runId === runId);
  },

  upsert(run: IngestionRun): void {
    const all = this.getAll();
    const idx = all.findIndex(r => r.runId === run.runId);
    if (idx >= 0) all[idx] = run;
    else all.unshift(run);
    writeJson(RUNS_FILE, all.slice(0, 100));
  },

  getResults(runId: string): RunResult[] {
    return readJson<RunResult[]>(path.join(RUNS_DIR, `${runId}.json`), []);
  },

  upsertResult(result: RunResult): void {
    const all = this.getResults(result.runId);
    const idx = all.findIndex(r => r.cik === result.cik);
    if (idx >= 0) all[idx] = result;
    else all.push(result);
    writeJson(path.join(RUNS_DIR, `${result.runId}.json`), all);
  },
};

// ─── Company intelligence ─────────────────────────────────────────────────────

function intelligencePath(ticker: string): string {
  return path.join(INTELLIGENCE_DIR, `${ticker.toUpperCase()}.json`);
}

export const intelligenceDb = {
  getByTicker(ticker: string): CompanyIntelligence | undefined {
    const result = readJson<CompanyIntelligence | null>(intelligencePath(ticker), null);
    return result ?? undefined;
  },

  upsert(intelligence: CompanyIntelligence): void {
    writeJson(intelligencePath(intelligence.ticker.toUpperCase()), intelligence);
  },

  getAllTickers(): string[] {
    ensureDirs();
    try {
      return fs.readdirSync(INTELLIGENCE_DIR)
        .filter(f => f.endsWith('.json') && !f.endsWith('.bak'))
        .map(f => f.slice(0, -5));
    } catch {
      return [];
    }
  },
};
