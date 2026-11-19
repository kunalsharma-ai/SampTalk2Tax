import { randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { apiBaseUrl, SSO_BINDING_COOKIE } from '@/lib/server-config';
import { clientHeaders } from '@/lib/session-cookies';

/**
 * Starts single sign-on (SEC-006): POST { email } → { url } of the organisation's identity
 * provider. A random value is kept in an httpOnly cookie and only its hash goes to the API, so the
 * sign-in can be finished only in this browser (the callback sends it back).
 */
const Body = z.object({ email: z.string().max(254) });

export async function POST(req: NextRequest) {
  if (req.headers.get('x-t2t-csrf') !== '1') return NextResponse.json({ error: 'CSRF', message: 'Missing CSRF header' }, { status: 403 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'VALIDATION_FAILED', message: 'Enter your work email' }, { status: 400 });
  const binding = randomBytes(24).toString('base64url');
  const upstream = await fetch(`${apiBaseUrl()}/v1/auth/sso/start`, {
    method: 'POST',
    headers: { ...clientHeaders(req), 'content-type': 'application/json' },
    body: JSON.stringify({ email: parsed.data.email, binding }),
    cache: 'no-store',
  });
  const body = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    const res = NextResponse.json(body, { status: upstream.status });
    const retry = upstream.headers.get('retry-after');
    if (retry) res.headers.set('retry-after', retry);
    return res;
  }
  const res = NextResponse.json({ url: body.authorizationUrl });
  res.cookies.set(SSO_BINDING_COOKIE, binding, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/api/session/sso', maxAge: 600 });
  return res;
}
