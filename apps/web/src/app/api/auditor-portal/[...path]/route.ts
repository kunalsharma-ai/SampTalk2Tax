import { NextRequest, NextResponse } from 'next/server';
import { apiBaseUrl } from '@/lib/server-config';
import { clientHeaders } from '@/lib/session-cookies';

/**
 * Same-origin proxy for the external auditor portal (AUDIT-002), to /v1/auditor-portal/* only and
 * never with anyone's session: the link's secret in the path is the only credential. Read-only:
 * GET the portal, or GET /<token>/files/<id> for an accepted evidence file.
 */
const PASS_THROUGH = ['content-disposition', 'x-content-type-options', 'content-security-policy', 'cache-control', 'referrer-policy', 'retry-after'];
const notFound = () => NextResponse.json({ error: 'NOT_FOUND', message: 'Unknown portal path' }, { status: 404 });
const badPath = (path: string[]) => !path.length || path.some((p) => p === '..' || p === '.' || p === '' || p.length > 100);

export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  if (badPath(path) || !(path.length === 1 || (path.length === 3 && path[1] === 'files'))) return notFound();
  const upstream = await fetch(`${apiBaseUrl()}/v1/auditor-portal/${path.map(encodeURIComponent).join('/')}`, { method: 'GET', headers: new Headers(clientHeaders(req)), cache: 'no-store' });
  const out = new NextResponse(await upstream.arrayBuffer(), { status: upstream.status });
  const ct = upstream.headers.get('content-type');
  if (ct) out.headers.set('content-type', ct);
  for (const h of PASS_THROUGH) {
    const v = upstream.headers.get(h);
    if (v) out.headers.set(h, v);
  }
  out.headers.set('referrer-policy', 'no-referrer');
  out.headers.set('cache-control', 'private, no-store');
  return out;
}
