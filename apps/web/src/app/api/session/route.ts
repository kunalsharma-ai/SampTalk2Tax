import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { apiBaseUrl, REFRESH_COOKIE } from '@/lib/server-config';
import { clearSessionCookies, clientHeaders, setSessionCookies } from '@/lib/session-cookies';

/**
 * Backend-for-frontend session endpoint. The API's access and refresh tokens are kept in
 * httpOnly, SameSite=Lax cookies so browser JavaScript never sees them.
 *   POST   { mode: 'login' | 'register', email, password, name? }  → sets cookies
 *   DELETE                                                          → ends the session in the API, clears cookies
 */
const Body = z.object({
  mode: z.enum(['login', 'register']),
  email: z.string().max(254),
  password: z.string().max(256),
  name: z.string().max(120).optional(),
});

const csrf = () => NextResponse.json({ error: 'CSRF', message: 'Missing CSRF header' }, { status: 403 });

export async function POST(req: NextRequest) {
  if (req.headers.get('x-t2t-csrf') !== '1') return csrf();
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'VALIDATION_FAILED', message: 'Invalid request' }, { status: 400 });
  const { mode, ...payload } = parsed.data;
  const upstream = await fetch(`${apiBaseUrl()}/v1/auth/${mode}`, {
    method: 'POST',
    headers: { ...clientHeaders(req), 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    cache: 'no-store',
  });
  const body = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    const res = NextResponse.json(body, { status: upstream.status });
    const retry = upstream.headers.get('retry-after');
    if (retry) res.headers.set('retry-after', retry);
    return res;
  }
  const res = NextResponse.json({ user: body.user });
  setSessionCookies(res, body);
  return res;
}

export async function DELETE(req: NextRequest) {
  if (req.headers.get('x-t2t-csrf') !== '1') return csrf();
  const refreshToken = req.cookies.get(REFRESH_COOKIE)?.value;
  if (refreshToken) {
    // Ending the session in the API makes the access token stop working too, not just the cookie.
    await fetch(`${apiBaseUrl()}/v1/auth/logout`, {
      method: 'POST',
      headers: { ...clientHeaders(req), 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      cache: 'no-store',
    }).catch(() => undefined);
  }
  const res = new NextResponse(null, { status: 204 });
  clearSessionCookies(res);
  return res;
}
