/**
 * Cron route authorization guard
 *
 * /api/cron/* routes must call requireCronAuth() before doing any work.
 * Uses a separate CRON_SECRET so that a compromised cron caller cannot
 * perform admin operations, and vice-versa.
 *
 * Configuration:
 *   CRON_SECRET — required environment variable; must NOT equal ADMIN_SECRET
 *
 * Usage:
 *   const unauthorized = requireCronAuth(request);
 *   if (unauthorized) return unauthorized;
 *
 * Caller must supply:
 *   Authorization: Bearer <CRON_SECRET>
 *
 * Returns:
 *   null          — authorized; proceed
 *   NextResponse  — rejected; return immediately
 *
 * Error responses:
 *   503 — CRON_SECRET not configured
 *   401 — header missing, malformed, or token does not match
 *
 * Security notes:
 *   - Uses constant-time comparison (timingSafeEqual) to prevent timing attacks.
 *   - Never log the Authorization header or CRON_SECRET value.
 *   - Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

export function requireCronAuth(request: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    console.error(
      '[cronAuth] CRON_SECRET environment variable is not set. ' +
      'The cron ingestion route is inaccessible until this is configured.',
    );
    return NextResponse.json(
      { error: 'Cron authentication is not configured on this server.' },
      { status: 503 },
    );
  }

  const authHeader = request.headers.get('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return NextResponse.json(
      { error: 'Missing Authorization header. Expected: Bearer <CRON_SECRET>' },
      { status: 401 },
    );
  }

  let authorized = false;
  try {
    const secretBuf = Buffer.from(secret, 'utf8');
    const tokenBuf  = Buffer.from(token, 'utf8');
    if (secretBuf.length === tokenBuf.length) {
      authorized = timingSafeEqual(secretBuf, tokenBuf);
    }
  } catch {
    authorized = false;
  }

  if (!authorized) {
    return NextResponse.json(
      { error: 'Unauthorized. Invalid cron secret.' },
      { status: 401 },
    );
  }

  return null;
}
