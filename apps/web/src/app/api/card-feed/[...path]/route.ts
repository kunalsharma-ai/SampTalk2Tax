import { NextRequest, NextResponse } from 'next/server';
import { apiBaseUrl } from '@/lib/server-config';
import { clientHeaders } from '@/lib/session-cookies';

/**
 * The company card feed for card providers, on the app's own address (EXP-011/012): /api/card-feed/me,
 * /cards, /cards/{cardId}/issued and /transactions are forwarded to the API's /v1/card-feed/...
 * with the programme's token. No session cookie is read or set, so a browser's sign-in can never
 * be used through this route.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PASS_THROUGH = ['retry-after', 'x-request-id', 'cache-control'];

function route(method: string, path: string[]): string | null {
  if (method === 'GET' && path.length === 1 && (path[0] === 'me' || path[0] === 'cards')) return path[0];
  if (method === 'POST' && path.length === 1 && path[0] === 'transactions') return 'transactions';
  if (method === 'POST' && path.length === 3 && path[0] === 'cards' && UUID.test(path[1]!) && path[2] === 'issued') return `cards/${path[1]!.toLowerCase()}/issued`;
  return null;
}

async function forward(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const target = route(req.method, path);
  if (!target) return NextResponse.json({ error: 'NOT_FOUND', message: 'Use GET /me, GET /cards, POST /cards/{cardId}/issued or POST /transactions' }, { status: 404 });
  const auth = req.headers.get('authorization');
  if (!auth?.startsWith('Bearer t2tc_')) return NextResponse.json({ error: 'CARD_TOKEN_INVALID', message: 'Send the card programme token as "Authorization: Bearer t2tc_..."' }, { status: 401 });
  const headers: Record<string, string> = { ...clientHeaders(req), authorization: auth };
  const ct = req.headers.get('content-type');
  if (ct) headers['content-type'] = ct;
  const body = req.method === 'GET' ? undefined : await req.arrayBuffer();
  const upstream = await fetch(`${apiBaseUrl()}/v1/card-feed/${target}`, { method: req.method, headers, body, cache: 'no-store' });
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
