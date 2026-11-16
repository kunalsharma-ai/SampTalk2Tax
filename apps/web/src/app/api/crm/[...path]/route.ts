import { NextRequest, NextResponse } from 'next/server';
import { apiBaseUrl } from '@/lib/server-config';
import { clientHeaders } from '@/lib/session-cookies';

/**
 * The CRM API for other systems, on the app's own address: /api/crm/<path> is forwarded to the
 * API's /v1/crm-api/<path> with the caller's API key. No session cookie is read or set, so a
 * browser's sign-in can never be used through this route; only an API key works.
 */
const PASS_THROUGH = ['retry-after', 'x-request-id', 'cache-control'];

async function forward(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  if (path.some((p) => p === '..' || p === '' || p === '.')) return NextResponse.json({ error: 'NOT_FOUND', message: 'Unknown API path' }, { status: 404 });
  const auth = req.headers.get('authorization');
  if (!auth?.startsWith('Bearer t2t_')) return NextResponse.json({ error: 'INVALID_API_KEY', message: 'Send an API key as "Authorization: Bearer t2t_…"' }, { status: 401 });
  const headers: Record<string, string> = { ...clientHeaders(req), authorization: auth };
  const ct = req.headers.get('content-type');
  if (ct) headers['content-type'] = ct;
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
  const upstream = await fetch(`${apiBaseUrl()}/v1/crm-api/${path.map(encodeURIComponent).join('/')}${req.nextUrl.search}`, { method: req.method, headers, body, cache: 'no-store' });
  const out = new NextResponse(upstream.status === 204 ? null : await upstream.arrayBuffer(), { status: upstream.status });
  const uct = upstream.headers.get('content-type');
  if (uct) out.headers.set('content-type', uct);
  for (const h of PASS_THROUGH) {
    const v = upstream.headers.get(h);
    if (v) out.headers.set(h, v);
  }
  return out;
}

export { forward as GET, forward as POST, forward as PUT };
