/**
 * Normalized filing store
 *
 * An in-memory store for NormalizedFiling records produced by the ingestion
 * pipeline. In production this would be replaced by Supabase upserts and
 * queries; here it provides a consistent interface that lets the rest of the
 * code treat storage as a black box.
 *
 * The store is a module-level singleton — it persists across requests within a
 * single Node.js process (i.e. a single Next.js dev-server run), which is the
 * right behavior for mock mode. In production, replace get/upsert with
 * Supabase client calls.
 *
 * Public API:
 *   store.upsert(filing)          — add or replace by accessionNumber
 *   store.getByTicker(ticker)     — latest filings for a ticker, newest first
 *   store.getByAccession(id)      — exact lookup
 *   store.getAllTickers()         — distinct ticker symbols with stored data
 *   store.count()                 — total records in store
 */

import type { NormalizedFiling } from './types';

class NormalizedFilingStore {
  /** Primary index: accessionNumber → NormalizedFiling */
  private readonly byAccession = new Map<string, NormalizedFiling>();

  /** Secondary index: ticker (uppercase) → Set of accessionNumbers */
  private readonly byTicker = new Map<string, Set<string>>();

  /** Whether we have loaded the persistent DB into memory yet */
  private hydrated = false;

  /**
   * Hydrate the in-memory store from the persistent file-based DB.
   * Called lazily on first read so that cold-start API routes always see
   * previously ingested data.  Safe to call multiple times — only runs once.
   */
  private hydrate(): void {
    if (this.hydrated) return;
    this.hydrated = true;
    try {
      // Lazy import avoids circular dependency issues at module load time
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { filingsDb } = require('../db') as typeof import('../db');
      const tickers = filingsDb.getAllTickers();
      for (const ticker of tickers) {
        const filings = filingsDb.getByTicker(ticker);
        for (const f of filings) this._upsertMemory(f);
      }
    } catch {
      // DB may not exist yet (first run) — proceed with empty store
    }
  }

  /** Internal upsert into the in-memory Maps only (no DB write). */
  private _upsertMemory(filing: NormalizedFiling): void {
    const ticker = filing.ticker.toUpperCase();
    const existing = this.byAccession.get(filing.accessionNumber);
    if (existing && existing.ticker !== ticker) {
      this.byTicker.get(existing.ticker)?.delete(filing.accessionNumber);
    }
    this.byAccession.set(filing.accessionNumber, filing);
    if (!this.byTicker.has(ticker)) this.byTicker.set(ticker, new Set());
    this.byTicker.get(ticker)!.add(filing.accessionNumber);
  }

  /**
   * Upsert a NormalizedFiling into the in-memory store AND the persistent DB.
   * If a filing with the same accessionNumber already exists it is replaced.
   */
  upsert(filing: NormalizedFiling): void {
    this._upsertMemory(filing);
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { filingsDb } = require('../db') as typeof import('../db');
      filingsDb.upsertAll(filing.ticker, [filing]);
    } catch { /* DB write failure is non-fatal — data still lives in memory */ }
  }

  /**
   * Upsert multiple filings at once.
   */
  upsertAll(filings: NormalizedFiling[]): void {
    for (const f of filings) this._upsertMemory(f);
    // Batch DB writes by ticker
    const byTicker = new Map<string, NormalizedFiling[]>();
    for (const f of filings) {
      const t = f.ticker.toUpperCase();
      if (!byTicker.has(t)) byTicker.set(t, []);
      byTicker.get(t)!.push(f);
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { filingsDb } = require('../db') as typeof import('../db');
      for (const [ticker, tFilings] of byTicker) filingsDb.upsertAll(ticker, tFilings);
    } catch { /* non-fatal */ }
  }

  /**
   * Return all stored filings for a ticker, sorted newest-first by filedAt.
   * Hydrates from the persistent DB on first call after a server restart.
   */
  getByTicker(ticker: string): NormalizedFiling[] {
    this.hydrate();
    const upper = ticker.toUpperCase();
    const accessions = this.byTicker.get(upper);
    if (!accessions) return [];
    return [...accessions]
      .map(acc => this.byAccession.get(acc)!)
      .filter(Boolean)
      .sort((a, b) => b.filedAt.localeCompare(a.filedAt));
  }

  /**
   * Return the most recent filing for a ticker by filedAt, or undefined.
   */
  getMostRecent(ticker: string): NormalizedFiling | undefined {
    return this.getByTicker(ticker)[0];
  }

  /**
   * Exact lookup by SEC accession number.
   */
  getByAccession(accessionNumber: string): NormalizedFiling | undefined {
    this.hydrate();
    return this.byAccession.get(accessionNumber);
  }

  /**
   * All distinct ticker symbols that have at least one stored filing.
   */
  getAllTickers(): string[] {
    this.hydrate();
    return [...this.byTicker.keys()].sort();
  }

  /** Total number of filings in the store. */
  count(): number {
    this.hydrate();
    return this.byAccession.size;
  }

  /** Remove all filings for a specific ticker. */
  clearTicker(ticker: string): void {
    const upper = ticker.toUpperCase();
    const accessions = this.byTicker.get(upper);
    if (!accessions) return;
    for (const acc of accessions) this.byAccession.delete(acc);
    this.byTicker.delete(upper);
  }

  /** Remove all filings from the store. */
  clearAll(): void {
    this.byAccession.clear();
    this.byTicker.clear();
    this.hydrated = false;
  }
}

/**
 * Singleton store instance shared across all API routes in this process.
 *
 * In production: swap this module out for a Supabase client wrapper that
 * implements the same interface against the real `filings` table.
 */
export const normalizedFilingStore = new NormalizedFilingStore();
