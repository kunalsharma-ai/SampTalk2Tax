import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { apiBaseUrl, MFA_CHALLENGE_COOKIE, REFRESH_COOKIE } from '@/lib/server-config';
import { clearSessionCookies, clientHeaders, setSessionCookies } from '@/lib/session-cookies';

/**
 * Backend-for-frontend session endpoint. The API's access and refresh tokens are kept in
 * httpOnly, SameSite=Lax cookies so browser JavaScript never sees them.
 *   POST   { mode: 'login' | 'register', email, password, name? }  → sets cookies
 *          With two-step sign-in on, login answers { mfaRequired: true } and keeps the API's
 *          challenge in an httpOnly cookie; then
 *   POST   { mode: 'code', code }                                   → sets cookies
 *   DELETE                                                          → ends the session in the API, clears cookies
 */
const Body = z.discriminatedUnion('mode', [
  z.object({
    mode: z.enum(['login', 'register']),
    email: z.string().max(254),
    password: z.string().max(256),
    name: z.string().max(120).optional(),
  }),
  z.object({ mode: z.literal('code'), code: z.string().max(20) }),
]);
const secure = () => process.env.NODE_ENV === 'production';

const csrf = () => NextResponse.json({ error: 'CSRF', message: 'Missing CSRF header' }, { status: 403 });

export async function POST(req: NextRequest) {
  if (req.headers.get('x-t2t-csrf') !== '1') return csrf();
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'VALIDATION_FAILED', message: 'Invalid request' }, { status: 400 });
  const { mode, ...rest } = parsed.data;
  let payload: Record<string, unknown> = rest;
  if (mode === 'code') {
    const challengeToken = req.cookies.get(MFA_CHALLENGE_COOKIE)?.value;
    if (!challengeToken) return NextResponse.json({ error: 'MFA_CHALLENGE_EXPIRED', message: 'This sign-in took too long. Sign in again.' }, { status: 401 });
    payload = { challengeToken, code: (parsed.data as { code: string }).code };
  }
  const path = mode === 'code' ? 'login/code' : mode;
  const upstream = await fetch(`${apiBaseUrl()}/v1/auth/${path}`, {
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
    // A challenge that is over (too slow, too many wrong codes) is forgotten: sign in again.
    if (body.error === 'MFA_CHALLENGE_EXPIRED') res.cookies.set(MFA_CHALLENGE_COOKIE, '', { httpOnly: true, sameSite: 'strict', path: '/api/session', maxAge: 0 });
    return res;
  }
  if (body.mfaRequired) {
    const res = NextResponse.json({ mfaRequired: true, expiresIn: body.expiresIn });
    res.cookies.set(MFA_CHALLENGE_COOKIE, body.challengeToken, { httpOnly: true, sameSite: 'strict', secure: secure(), path: '/api/session', maxAge: body.expiresIn });
    return res;
  }
  const res = NextResponse.json({ user: body.user });
  setSessionCookies(res, body);
  if (mode === 'code') res.cookies.set(MFA_CHALLENGE_COOKIE, '', { httpOnly: true, sameSite: 'strict', path: '/api/session', maxAge: 0 });
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
