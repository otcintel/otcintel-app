/**
 * Tests for lib/universe/batchSelection.ts — pure partitioning functions.
 *
 * Coverage (maps to task requirements):
 *   1. One invocation targets only a subset (≤ CRON_BATCH_SIZE tickers)
 *   2. Different batch indices → different subsets
 *   3. All companies covered across a complete rotation (no gaps)
 *   4. No ticker duplicated within one subset
 *   + Edge: non-divisible universe, empty universe, single company
 */

import { describe, it, expect } from 'vitest';
import {
  selectBatch,
  batchCount,
  CRON_BATCH_SIZE,
} from '../batchSelection';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// Real 24-company universe (alphabetical)
const TICKERS_24 = [
  'ABVC', 'AITX', 'ATVK', 'BOXL', 'CANN', 'CENN',
  'CLPS', 'CODA', 'CUEN', 'GFAI', 'GOVX', 'LCTX',
  'LIQT', 'LQMT', 'MFON', 'NTRB', 'NVVE', 'RKDA',
  'SHIP', 'SINT', 'SOBR', 'TUSK', 'VNRX', 'WRAP',
];

// Shuffled order — selectBatch must sort internally
const TICKERS_24_SHUFFLED = [
  'WRAP', 'AITX', 'MFON', 'CODA', 'LCTX', 'SINT',
  'GOVX', 'ABVC', 'TUSK', 'CLPS', 'NVVE', 'GFAI',
  'CANN', 'RKDA', 'VNRX', 'ATVK', 'CUEN', 'SHIP',
  'BOXL', 'LQMT', 'SOBR', 'CENN', 'NTRB', 'LIQT',
];

// ─── batchCount ───────────────────────────────────────────────────────────────

describe('batchCount', () => {

  it('returns 4 for 24 companies with default batch size of 6', () => {
    expect(batchCount(24)).toBe(4);
  });

  it('rounds up for non-divisible universe sizes', () => {
    expect(batchCount(25)).toBe(5);  // 25/6 = 4.16… → 5 batches
    expect(batchCount(23)).toBe(4);  // 23/6 = 3.83… → 4 batches
  });

  it('returns 1 for an empty universe', () => {
    expect(batchCount(0)).toBe(1);
  });

  it('returns 1 for a single company', () => {
    expect(batchCount(1)).toBe(1);
  });

  it('respects a custom batchSize argument', () => {
    expect(batchCount(12, 4)).toBe(3);
    expect(batchCount(10, 3)).toBe(4); // ceil(10/3)
  });

});

// ─── selectBatch ─────────────────────────────────────────────────────────────

describe('selectBatch', () => {

  // 1. One invocation targets only a subset
  it('returns at most CRON_BATCH_SIZE tickers per call', () => {
    for (let i = 0; i < 4; i++) {
      const batch = selectBatch(TICKERS_24, i);
      expect(batch.length).toBeLessThanOrEqual(CRON_BATCH_SIZE);
    }
  });

  it('returns exactly CRON_BATCH_SIZE tickers when universe divides evenly', () => {
    for (let i = 0; i < 4; i++) {
      expect(selectBatch(TICKERS_24, i).length).toBe(CRON_BATCH_SIZE);
    }
  });

  // 2. Different batch indices produce different subsets
  it('different batch indices return non-overlapping subsets', () => {
    const b0 = new Set(selectBatch(TICKERS_24, 0));
    const b1 = new Set(selectBatch(TICKERS_24, 1));
    const b2 = new Set(selectBatch(TICKERS_24, 2));
    const b3 = new Set(selectBatch(TICKERS_24, 3));

    for (const t of b0) expect(b1.has(t)).toBe(false);
    for (const t of b0) expect(b2.has(t)).toBe(false);
    for (const t of b0) expect(b3.has(t)).toBe(false);
    for (const t of b1) expect(b2.has(t)).toBe(false);
    for (const t of b1) expect(b3.has(t)).toBe(false);
    for (const t of b2) expect(b3.has(t)).toBe(false);
  });

  it('batch 0 contains the first alphabetical slice', () => {
    expect(selectBatch(TICKERS_24, 0)).toEqual([
      'ABVC', 'AITX', 'ATVK', 'BOXL', 'CANN', 'CENN',
    ]);
  });

  it('batch 3 contains the last alphabetical slice', () => {
    expect(selectBatch(TICKERS_24, 3)).toEqual([
      'SHIP', 'SINT', 'SOBR', 'TUSK', 'VNRX', 'WRAP',
    ]);
  });

  // 3. All companies covered across a complete rotation
  it('union of all batches equals the complete universe', () => {
    const covered = new Set<string>();
    for (let i = 0; i < 4; i++) {
      for (const t of selectBatch(TICKERS_24, i)) covered.add(t);
    }
    expect(covered.size).toBe(24);
    for (const t of TICKERS_24) expect(covered.has(t)).toBe(true);
  });

  // 4. No ticker duplicated within one subset
  it('no ticker appears more than once within a batch', () => {
    for (let i = 0; i < 4; i++) {
      const batch = selectBatch(TICKERS_24, i);
      const unique = new Set(batch);
      expect(unique.size).toBe(batch.length);
    }
  });

  // Determinism: input order must not affect output
  it('produces the same output regardless of input order', () => {
    const fromSorted   = selectBatch(TICKERS_24,          0);
    const fromShuffled = selectBatch(TICKERS_24_SHUFFLED, 0);
    expect(fromSorted).toEqual(fromShuffled);
  });

  // Edge: empty universe
  it('returns an empty array for an empty ticker list', () => {
    expect(selectBatch([], 0)).toEqual([]);
  });

  // Edge: single company
  it('handles a single company gracefully', () => {
    expect(selectBatch(['WXYZ'], 0)).toEqual(['WXYZ']);
    expect(selectBatch(['WXYZ'], 7)).toEqual(['WXYZ']); // wraps to 0
  });

  // Edge: non-divisible universe (last batch is smaller)
  it('last batch is smaller when universe is not divisible by batchSize', () => {
    const tickers25 = [...TICKERS_24, 'ZZZZ']; // 25 tickers
    const lastBatch = selectBatch(tickers25, 4, 6); // batch 4 of 5
    expect(lastBatch.length).toBe(1);             // 25 - (4*6) = 1
    expect(lastBatch[0]).toBe('ZZZZ');
  });

  // Edge: negative batch index wraps correctly
  it('wraps negative batch indices to valid range', () => {
    const b3_explicit = selectBatch(TICKERS_24, 3);
    const b3_wrapped  = selectBatch(TICKERS_24, -1); // -1 % 4 + 4 = 3
    expect(b3_wrapped).toEqual(b3_explicit);
  });

});
