import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { apiBaseUrl, SESSION_COOKIE } from '@/lib/server-config';

/**
 * Backend-for-frontend session endpoint. The API's access token is kept in an
 * httpOnly, SameSite=Lax cookie so browser JavaScript never sees it.
 *   POST   { mode: 'login' | 'register', email, password, name? }  → sets cookie
 *   DELETE                                                          → clears cookie
 */
const Body = z.object({
  mode: z.enum(['login', 'register']),
  email: z.string().max(254),
  password: z.string().max(256),
  name: z.string().max(120).optional(),
});

export async function POST(req: NextRequest) {
  if (req.headers.get('x-t2t-csrf') !== '1') return NextResponse.json({ error: 'CSRF', message: 'Missing CSRF header' }, { status: 403 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'VALIDATION_FAILED', message: 'Invalid request' }, { status: 400 });
  const { mode, ...payload } = parsed.data;
  const upstream = await fetch(`${apiBaseUrl()}/v1/auth/${mode}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    cache: 'no-store',
  });
  const body = await upstream.json().catch(() => ({}));
  if (!upstream.ok) return NextResponse.json(body, { status: upstream.status });
  const res = NextResponse.json({ user: body.user });
  res.cookies.set(SESSION_COOKIE, body.accessToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: body.expiresIn,
  });
  return res;
}

export async function DELETE(req: NextRequest) {
  if (req.headers.get('x-t2t-csrf') !== '1') return NextResponse.json({ error: 'CSRF', message: 'Missing CSRF header' }, { status: 403 });
  const res = new NextResponse(null, { status: 204 });
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
  return res;
}
