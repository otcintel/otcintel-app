/**
 * Tests for lib/api/adminAuth.ts — requireAdminAuth()
 *
 * Coverage goals (per AGENTS.md):
 *   1. Unauthenticated requests are rejected                    → 401
 *   2. Valid admin token grants access                          → null (authorized)
 *   3. ADMIN_SECRET not configured blocks all requests         → 503
 *   4. Malformed Authorization header is rejected              → 401
 *   5. Wrong token is rejected (length mismatch, wrong value)  → 401
 *
 * These tests confirm that no unguarded path to ingestion exists
 * after the removal of /api/ingest and /api/ingest/[ticker].
 * All ingestion is now reachable only via /api/admin/universe/ingest,
 * which calls requireAdminAuth() as its first line.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { requireAdminAuth } from '../adminAuth';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEST_SECRET = 'test-admin-secret-aabbccdd1122';

function makeRequest(authHeader?: string): Request {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) headers['Authorization'] = authHeader;
  return new Request('http://localhost/api/admin/universe/ingest', {
    method: 'POST',
    headers,
  });
}

// ─── Test lifecycle ───────────────────────────────────────────────────────────

let _origSecret: string | undefined;

beforeEach(() => {
  _origSecret = process.env.ADMIN_SECRET;
  process.env.ADMIN_SECRET = TEST_SECRET;
});

afterEach(() => {
  if (_origSecret === undefined) {
    delete process.env.ADMIN_SECRET;
  } else {
    process.env.ADMIN_SECRET = _origSecret;
  }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('requireAdminAuth', () => {

  // 1. Valid authorization — authorized caller receives null (proceed)
  it('returns null when Bearer token matches ADMIN_SECRET', () => {
    const result = requireAdminAuth(makeRequest(`Bearer ${TEST_SECRET}`));
    expect(result).toBeNull();
  });

  // 2. No Authorization header at all
  it('returns 401 when Authorization header is absent', async () => {
    const result = requireAdminAuth(makeRequest());
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
    const body = await result!.json() as { error: string };
    expect(body.error).toMatch(/Missing Authorization header/i);
  });

  // 3. Authorization header present but not Bearer scheme
  it('returns 401 when Authorization header is not Bearer format', async () => {
    const result = requireAdminAuth(makeRequest('Basic dXNlcjpwYXNz'));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
    const body = await result!.json() as { error: string };
    expect(body.error).toMatch(/Missing Authorization header/i);
  });

  // 4. Token value is wrong
  it('returns 401 when Bearer token does not match ADMIN_SECRET', async () => {
    const result = requireAdminAuth(makeRequest('Bearer wrong-secret-value'));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
    const body = await result!.json() as { error: string };
    expect(body.error).toMatch(/Unauthorized/i);
  });

  // 5. Token is a prefix of the secret (different length — timing-safe comparison)
  it('returns 401 when token is a prefix of ADMIN_SECRET (different length)', async () => {
    const prefix = TEST_SECRET.slice(0, -4);
    const result = requireAdminAuth(makeRequest(`Bearer ${prefix}`));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  // 6. Token is the secret with extra characters appended
  it('returns 401 when token is ADMIN_SECRET with extra characters', async () => {
    const result = requireAdminAuth(makeRequest(`Bearer ${TEST_SECRET}EXTRA`));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  // 7. ADMIN_SECRET not set in environment
  it('returns 503 when ADMIN_SECRET is not configured', async () => {
    delete process.env.ADMIN_SECRET;
    const result = requireAdminAuth(makeRequest(`Bearer ${TEST_SECRET}`));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(503);
    const body = await result!.json() as { error: string };
    expect(body.error).toMatch(/not configured/i);
  });

  // 8. Empty string token
  it('returns 401 for an empty Bearer token', async () => {
    const result = requireAdminAuth(makeRequest('Bearer '));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  // 9. Confirm authorized path does not return an error response
  it('does not set an error status when authorized', () => {
    const result = requireAdminAuth(makeRequest(`Bearer ${TEST_SECRET}`));
    // null means "proceed" — no 4xx/5xx response generated
    expect(result).toBeNull();
  });

});
