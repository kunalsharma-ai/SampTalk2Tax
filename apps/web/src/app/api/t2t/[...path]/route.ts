import { NextRequest, NextResponse } from 'next/server';
import { apiBaseUrl, SESSION_COOKIE } from '@/lib/server-config';

/**
 * Same-origin proxy to the Talk2Tax API. Attaches the bearer token from the
 * httpOnly session cookie. Only /v1/* paths are forwarded. Mutating requests must
 * carry the x-t2t-csrf header, which a cross-site form or image cannot send.
 */
/** Response headers that matter to the browser (file downloads keep their name and sandbox). */
const PASS_THROUGH = ['idempotent-replay', 'content-disposition', 'x-content-type-options', 'content-security-policy', 'cache-control', 'x-checksum-sha256'];

async function forward(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  if (path[0] !== 'v1' || path.some((p) => p === '..' || p === '')) {
    return NextResponse.json({ error: 'NOT_FOUND', message: 'Unknown API path' }, { status: 404 });
  }
  if (req.method !== 'GET' && req.headers.get('x-t2t-csrf') !== '1') {
    return NextResponse.json({ error: 'CSRF', message: 'Missing CSRF header' }, { status: 403 });
  }
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return NextResponse.json({ error: 'UNAUTHENTICATED', message: 'Not signed in' }, { status: 401 });

  const url = `${apiBaseUrl()}/${path.map(encodeURIComponent).join('/')}${req.nextUrl.search}`;
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const ct = req.headers.get('content-type');
  if (ct) headers['content-type'] = ct;
  const idem = req.headers.get('idempotency-key');
  if (idem) headers['idempotency-key'] = idem;

  const upstream = await fetch(url, {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
    cache: 'no-store',
  });
  const out = new NextResponse(upstream.status === 204 ? null : await upstream.arrayBuffer(), { status: upstream.status });
  const uct = upstream.headers.get('content-type');
  if (uct) out.headers.set('content-type', uct);
  for (const h of PASS_THROUGH) {
    const v = upstream.headers.get(h);
    if (v) out.headers.set(h, v);
  }
  if (upstream.status === 401) out.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 });
  return out;
}

export { forward as GET, forward as POST, forward as PUT, forward as PATCH, forward as DELETE };
