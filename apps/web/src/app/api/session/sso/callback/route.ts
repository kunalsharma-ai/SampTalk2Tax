import { NextRequest, NextResponse } from 'next/server';
import { apiBaseUrl, DEVICE_COOKIE, SSO_BINDING_COOKIE } from '@/lib/server-config';
import { clientHeaders, setSessionCookies } from '@/lib/session-cookies';

/**
 * Where the identity provider sends the browser back (SEC-006): register this address with the
 * provider as the redirect URI. The API checks the state against this browser's cookie, swaps the
 * code for an ID token and checks it; on success the session cookies are set and the browser goes
 * to the organisation, otherwise back to the single sign-on page with the reason.
 */
const go = (location: string) => new NextResponse(null, { status: 303, headers: { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const binding = req.cookies.get(SSO_BINDING_COOKIE)?.value ?? '';
  const failed = (message: string) => {
    const res = go(`/login/sso?error=${encodeURIComponent(message.slice(0, 300))}`);
    res.cookies.set(SSO_BINDING_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/api/session/sso', maxAge: 0 });
    return res;
  };
  const state = q.get('state');
  if (!state || binding.length < 22) return failed('This sign-in has expired or was started in another browser. Start again.');
  const payload: Record<string, string> = { state: state.slice(0, 64), binding };
  for (const [k, from] of [['code', 'code'], ['error', 'error'], ['errorDescription', 'error_description']] as const) {
    const v = q.get(from);
    if (v) payload[k] = v.slice(0, k === 'code' ? 4096 : k === 'error' ? 200 : 1000);
  }
  const device = req.cookies.get(DEVICE_COOKIE)?.value;
  const upstream = await fetch(`${apiBaseUrl()}/v1/auth/sso/finish`, {
    method: 'POST',
    headers: { ...clientHeaders(req), ...(device && /^[A-Za-z0-9_-]{22,100}$/.test(device) ? { 'x-t2t-device': device } : {}), 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    cache: 'no-store',
  }).catch(() => null);
  const body = upstream ? await upstream.json().catch(() => ({})) : {};
  if (!upstream?.ok) return failed(typeof body.message === 'string' ? body.message : 'The sign-in did not work. Try again.');
  const res = go(`/orgs/${encodeURIComponent(body.orgId)}`);
  setSessionCookies(res, body);
  res.cookies.set(SSO_BINDING_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/api/session/sso', maxAge: 0 });
  return res;
}
