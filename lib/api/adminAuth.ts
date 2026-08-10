/**
 * Admin route authorization guard
 *
 * All /api/admin/* routes must call requireAdminAuth() before processing any
 * request. This is a temporary pre-authentication layer using a shared secret.
 * It will be replaced by full session-based authentication when Supabase Auth
 * is integrated.
 *
 * Configuration:
 *   ADMIN_SECRET — required environment variable containing the shared secret
 *
 * Usage in an API route handler:
 *   const unauthorized = requireAdminAuth(request);
 *   if (unauthorized) return unauthorized;
 *   // ... proceed with handler
 *
 * Caller must supply:
 *   Authorization: Bearer <ADMIN_SECRET>
 *
 * Returns:
 *   null          — request is authorized; proceed
 *   NextResponse  — request is rejected; return this immediately
 *
 * Error responses:
 *   503 — ADMIN_SECRET not configured in environment
 *   401 — Authorization header missing, malformed, or token does not match
 *
 * Security notes:
 *   - The secret is compared with constant-time equality (timingSafeEqual) to
 *     prevent timing attacks.
 *   - Never log the value of the Authorization header or the ADMIN_SECRET.
 *   - The secret should be at least 32 random bytes expressed as a hex or
 *     base64 string. Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

/**
 * Returns null if the request is authorized, or a NextResponse to return
 * immediately if it is not.
 */
export function requireAdminAuth(request: Request): NextResponse | null {
  const secret = process.env.ADMIN_SECRET;

  if (!secret) {
    console.error(
      '[adminAuth] ADMIN_SECRET environment variable is not set. ' +
      'All admin routes are inaccessible until this is configured.',
    );
    return NextResponse.json(
      { error: 'Admin authentication is not configured on this server.' },
      { status: 503 },
    );
  }

  const authHeader = request.headers.get('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return NextResponse.json(
      { error: 'Missing Authorization header. Expected: Bearer <ADMIN_SECRET>' },
      { status: 401 },
    );
  }

  // Constant-time comparison to prevent timing attacks
  let authorized = false;
  try {
    const secretBuf = Buffer.from(secret, 'utf8');
    const tokenBuf  = Buffer.from(token, 'utf8');
    // timingSafeEqual requires same-length buffers
    if (secretBuf.length === tokenBuf.length) {
      authorized = timingSafeEqual(secretBuf, tokenBuf);
    }
  } catch {
    authorized = false;
  }

  if (!authorized) {
    return NextResponse.json(
      { error: 'Unauthorized. Invalid admin secret.' },
      { status: 401 },
    );
  }

  return null; // authorized
}
