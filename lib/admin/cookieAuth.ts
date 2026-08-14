import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { timingSafeEqual } from 'node:crypto';

/** Call at the top of admin page server components. Redirects to /admin/login if not authenticated. */
export async function requireAdminCookie(): Promise<void> {
  const cookieStore = await cookies();
  const token  = cookieStore.get('admin_token')?.value ?? '';
  const secret = process.env.ADMIN_SECRET ?? '';

  let authorized = false;
  if (token && secret) {
    try {
      const a = Buffer.from(token, 'utf8');
      const b = Buffer.from(secret, 'utf8');
      authorized = a.length === b.length && timingSafeEqual(a, b);
    } catch { /* length mismatch handled by authorized = false */ }
  }

  if (!authorized) redirect('/admin/login');
}
