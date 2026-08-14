import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    return NextResponse.redirect(new URL('/admin/login?error=1', request.url));
  }

  const formData = await request.formData();
  const password = String(formData.get('password') ?? '');

  let authorized = false;
  try {
    const a = Buffer.from(password, 'utf8');
    const b = Buffer.from(secret, 'utf8');
    authorized = a.length === b.length && timingSafeEqual(a, b);
  } catch { /* mismatch */ }

  if (!authorized) {
    return NextResponse.redirect(new URL('/admin/login?error=1', request.url));
  }

  const response = NextResponse.redirect(new URL('/admin/review', request.url));
  response.cookies.set('admin_token', secret, {
    httpOnly: true,
    sameSite: 'strict',
    path:     '/admin',
    maxAge:   60 * 60 * 8,
  });
  return response;
}
