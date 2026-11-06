import { NextRequest, NextResponse } from 'next/server';
import { apiBaseUrl, REFRESH_COOKIE, SESSION_COOKIE } from '@/lib/server-config';
import { clearSessionCookies, clientHeaders, IssuedSession, refreshSession, setSessionCookies } from '@/lib/session-cookies';

/**
 * Same-origin proxy to the Talk2Tax API. Attaches the bearer token from the httpOnly
 * session cookie, and renews it with the refresh cookie when it has expired (once per
 * request). Only /v1/* paths are forwarded. Mutating requests must carry the x-t2t-csrf
 * header, which a cross-site form or image cannot send.
 */
/** Response headers that matter to the browser (file downloads keep their name and sandbox). */
const PASS_THROUGH = ['idempotent-replay', 'content-disposition', 'x-content-type-options', 'content-security-policy', 'cache-control', 'x-checksum-sha256', 'x-report-sha256', 'retry-after', 'x-request-id'];

function unauthenticated(body: unknown = { error: 'UNAUTHENTICATED', message: 'Not signed in' }) {
  const res = NextResponse.json(body, { status: 401 });
  clearSessionCookies(res);
  return res;
}

async function forward(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  if (path[0] !== 'v1' || path.some((p) => p === '..' || p === '')) {
    return NextResponse.json({ error: 'NOT_FOUND', message: 'Unknown API path' }, { status: 404 });
  }
  if (req.method !== 'GET' && req.headers.get('x-t2t-csrf') !== '1') {
    return NextResponse.json({ error: 'CSRF', message: 'Missing CSRF header' }, { status: 403 });
  }
  const client = clientHeaders(req);
  const refreshToken = req.cookies.get(REFRESH_COOKIE)?.value;
  let token = req.cookies.get(SESSION_COOKIE)?.value;
  const state: { renewed: IssuedSession | null } = { renewed: null };

  const renew = async () => {
    if (!refreshToken) return false;
    const r = await refreshSession(refreshToken, client);
    if (!r.ok) return false;
    state.renewed = r.session;
    token = r.session.accessToken;
    return true;
  };

  if (!token && !(await renew())) return unauthenticated();

  const url = `${apiBaseUrl()}/${path.map(encodeURIComponent).join('/')}${req.nextUrl.search}`;
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
  const call = () => {
    const headers: Record<string, string> = { ...client, authorization: `Bearer ${token}` };
    const ct = req.headers.get('content-type');
    if (ct) headers['content-type'] = ct;
    const idem = req.headers.get('idempotency-key');
    if (idem) headers['idempotency-key'] = idem;
    return fetch(url, { method: req.method, headers, body, cache: 'no-store' });
  };

  let upstream = await call();
  if (upstream.status === 401 && !state.renewed) {
    const err = (await upstream.clone().json().catch(() => ({}))) as { error?: string };
    // Only an expired access token is worth renewing; a revoked session means sign in again.
    if (err.error === 'TOKEN_EXPIRED' && (await renew())) upstream = await call();
  }
  if (upstream.status === 401) return unauthenticated(await upstream.json().catch(() => undefined));

  const out = new NextResponse(upstream.status === 204 ? null : await upstream.arrayBuffer(), { status: upstream.status });
  const uct = upstream.headers.get('content-type');
  if (uct) out.headers.set('content-type', uct);
  for (const h of PASS_THROUGH) {
    const v = upstream.headers.get(h);
    if (v) out.headers.set(h, v);
  }
  if (state.renewed) setSessionCookies(out, state.renewed);
  return out;
}

export { forward as GET, forward as POST, forward as PUT, forward as PATCH, forward as DELETE };
