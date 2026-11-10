import { NextRequest, NextResponse } from 'next/server';
import { apiBaseUrl } from '@/lib/server-config';
import { clientHeaders } from '@/lib/session-cookies';

/**
 * Same-origin proxy for the customer portal (AR-030). GET only, to /v1/portal/* only, and never
 * with anyone's session: the link's secret in the path is the only credential.
 */
const PASS_THROUGH = ['content-disposition', 'x-content-type-options', 'content-security-policy', 'cache-control', 'referrer-policy', 'retry-after'];

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  if (!path.length || path.some((p) => p === '..' || p === '' || p.length > 100)) {
    return NextResponse.json({ error: 'NOT_FOUND', message: 'Unknown portal path' }, { status: 404 });
  }
  const url = `${apiBaseUrl()}/v1/portal/${path.map(encodeURIComponent).join('/')}${req.nextUrl.search}`;
  const upstream = await fetch(url, { headers: clientHeaders(req), cache: 'no-store' });
  const out = new NextResponse(await upstream.arrayBuffer(), { status: upstream.status });
  const ct = upstream.headers.get('content-type');
  if (ct) out.headers.set('content-type', ct);
  for (const h of PASS_THROUGH) {
    const v = upstream.headers.get(h);
    if (v) out.headers.set(h, v);
  }
  out.headers.set('referrer-policy', 'no-referrer');
  return out;
}
