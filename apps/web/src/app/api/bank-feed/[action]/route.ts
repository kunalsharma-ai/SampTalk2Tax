import { NextRequest, NextResponse } from 'next/server';
import { apiBaseUrl } from '@/lib/server-config';
import { clientHeaders } from '@/lib/session-cookies';

/**
 * Bank feeds for senders, on the app's own address (BANK-004): /api/bank-feed/me, /transactions
 * and /statement are forwarded to the API's /v1/bank-feed/... with the feed's token. No session
 * cookie is read or set, so a browser's sign-in can never be used through this route.
 */
const ACTIONS: Record<string, string> = { me: 'GET', transactions: 'POST', statement: 'POST' };
const PASS_THROUGH = ['retry-after', 'x-request-id', 'cache-control'];

async function forward(req: NextRequest, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  if (ACTIONS[action] !== req.method) return NextResponse.json({ error: 'NOT_FOUND', message: 'Use GET /me, POST /transactions or POST /statement' }, { status: 404 });
  const auth = req.headers.get('authorization');
  if (!auth?.startsWith('Bearer t2tf_')) return NextResponse.json({ error: 'FEED_TOKEN_INVALID', message: 'Send the bank feed token as "Authorization: Bearer t2tf_..."' }, { status: 401 });
  const headers: Record<string, string> = { ...clientHeaders(req), authorization: auth };
  const ct = req.headers.get('content-type');
  if (ct) headers['content-type'] = ct;
  const body = req.method === 'GET' ? undefined : await req.arrayBuffer();
  const upstream = await fetch(`${apiBaseUrl()}/v1/bank-feed/${action}`, { method: req.method, headers, body, cache: 'no-store' });
  const out = new NextResponse(await upstream.arrayBuffer(), { status: upstream.status });
  const uct = upstream.headers.get('content-type');
  if (uct) out.headers.set('content-type', uct);
  for (const h of PASS_THROUGH) {
    const v = upstream.headers.get(h);
    if (v) out.headers.set(h, v);
  }
  return out;
}

export { forward as GET, forward as POST };
