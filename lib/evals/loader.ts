/**
 * OTCIntel — Golden Case Loader
 *
 * Loads golden evaluation cases from evals/golden/<TICKER>/<id>.json
 * and resolves the corresponding fixture text or stored output.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { GoldenCase } from './types';
import { mockRawFilings } from '../mock/rawFilings';
import type { CompanyFacts } from '../ingestion/fetchers/edgar/companyFacts';

const EVALS_DIR = path.resolve(process.cwd(), 'evals');
const GOLDEN_DIR = path.join(EVALS_DIR, 'golden');
const FIXTURES_DIR = path.join(EVALS_DIR, 'fixtures');

// ─── Golden case loading ──────────────────────────────────────────────────────

/**
 * Load a single golden case from its JSON file.
 * Throws if the file does not exist or is not valid JSON.
 */
export function loadGoldenCase(filePath: string): GoldenCase {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as GoldenCase;
  if (!parsed.id || !parsed.ticker || !parsed.evaluationTarget) {
    throw new Error(`Invalid golden case at ${filePath}: missing required fields (id, ticker, evaluationTarget)`);
  }
  return parsed;
}

/**
 * Load all golden cases from evals/golden/.
 * Recurses into subdirectories (one per ticker).
 * Returns cases in alphabetical order by id.
 */
export function loadAllGoldenCases(): GoldenCase[] {
  if (!fs.existsSync(GOLDEN_DIR)) return [];

  const cases: GoldenCase[] = [];
  for (const tickerDir of fs.readdirSync(GOLDEN_DIR)) {
    const tickerPath = path.join(GOLDEN_DIR, tickerDir);
    if (!fs.statSync(tickerPath).isDirectory()) continue;
    for (const file of fs.readdirSync(tickerPath)) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(tickerPath, file);
      cases.push(loadGoldenCase(filePath));
    }
  }

  return cases.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Load all golden cases for a specific ticker.
 */
export function loadGoldenCasesForTicker(ticker: string): GoldenCase[] {
  const tickerDir = path.join(GOLDEN_DIR, ticker.toUpperCase());
  if (!fs.existsSync(tickerDir)) return [];

  return fs.readdirSync(tickerDir)
    .filter(f => f.endsWith('.json'))
    .map(f => loadGoldenCase(path.join(tickerDir, f)))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// ─── Fixture text resolution ──────────────────────────────────────────────────

/**
 * Load a file-snapshot fixture from evals/fixtures/.
 * Throws if the fixture file does not exist.
 */
export function loadFileSnapshotFixture(fixtureKey: string): string {
  const fixturePath = path.join(FIXTURES_DIR, fixtureKey);
  if (!fs.existsSync(fixturePath)) {
    throw new Error(`Fixture file not found: ${fixturePath}`);
  }
  return fs.readFileSync(fixturePath, 'utf-8');
}

/**
 * Load an XBRL CompanyFacts snapshot from evals/fixtures/.
 * Throws if the fixture file does not exist or is not valid JSON.
 */
export function loadXbrlSnapshotFixture(fixtureKey: string): CompanyFacts {
  const fixturePath = path.join(FIXTURES_DIR, fixtureKey);
  if (!fs.existsSync(fixturePath)) {
    throw new Error(`XBRL fixture not found: ${fixturePath}`);
  }
  return JSON.parse(fs.readFileSync(fixturePath, 'utf-8')) as CompanyFacts;
}

/**
 * Resolve fixture text for a golden case with source "mock_rawFilings".
 * Dynamically imports lib/mock/rawFilings.ts to get the fixture.
 */
export function resolveMockFixtureText(goldenCase: GoldenCase): string {
  const fixtureKey = goldenCase.fixtureKey ?? goldenCase.ticker;
  const filings = mockRawFilings[fixtureKey];
  if (!filings) {
    throw new Error(`No mock fixture found for ticker "${fixtureKey}"`);
  }

  const index = goldenCase.fixtureIndex ?? 0;
  const filing = filings[index];
  if (!filing) {
    throw new Error(`Mock fixture index ${index} out of range for ticker "${fixtureKey}" (length: ${filings.length})`);
  }

  if (!filing.text) {
    throw new Error(`Mock fixture at index ${index} for "${fixtureKey}" has no text field`);
  }

  return filing.text;
}

/**
 * Load the stored NormalizedFiling output for a golden case with source "stored_output_snapshot".
 * Reads from data/filings/<TICKER>.json.
 */
export function loadStoredOutputSnapshot(goldenCase: GoldenCase): Record<string, unknown>[] {
  const dataDir = path.resolve(process.cwd(), 'data', 'filings');
  const filePath = path.join(dataDir, `${goldenCase.ticker}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Stored filing snapshot not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as Record<string, unknown>[];
}

/**
 * Find the specific NormalizedFiling entry that matches the golden case by accession number.
 */
export function findStoredFiling(
  filings: Record<string, unknown>[],
  accessionNumber: string,
): Record<string, unknown> | undefined {
  return filings.find(f => f.accessionNumber === accessionNumber);
}
