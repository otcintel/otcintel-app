/**
 * OTCIntel — Supabase / PostgreSQL client (server-only)
 *
 * Required environment variables:
 *   SUPABASE_URL             — Supabase project URL (e.g. https://xyz.supabase.co)
 *   SUPABASE_SERVICE_ROLE_KEY — Service role key — bypasses RLS, NEVER expose to clients
 *
 * The service role key must be kept server-side. It must never appear in:
 *   - NEXT_PUBLIC_* environment variables
 *   - Client components
 *   - Browser bundles
 *   - Public repositories
 *
 * When PERSISTENCE_BACKEND=filesystem (the default), this module is never
 * imported and the credentials are never required.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let _client: SupabaseClient | null = null;

/** Returns a cached Supabase client. Throws with a clear message if unconfigured. */
export function getClient(): SupabaseClient {
  if (_client) return _client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) {
    throw new Error(
      '[OTCIntel] SUPABASE_URL is not set.\n' +
      'Set PERSISTENCE_BACKEND=filesystem to use file-based storage, or\n' +
      'provide SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for PostgreSQL.',
    );
  }
  if (!key) {
    throw new Error(
      '[OTCIntel] SUPABASE_SERVICE_ROLE_KEY is not set.\n' +
      'This key is required for server-side database access. Never expose it to clients.',
    );
  }

  _client = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return _client;
}

/** Reset the cached client (useful in tests). */
export function resetClient(): void {
  _client = null;
}

/** Throw a formatted error for Supabase query failures. */
export function assertNoError(error: { message: string } | null, context: string): void {
  if (error) {
    throw new Error(`[OTCIntel/postgres] ${context}: ${error.message}`);
  }
}
