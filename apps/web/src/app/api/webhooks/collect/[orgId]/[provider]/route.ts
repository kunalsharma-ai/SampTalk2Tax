import { NextRequest, NextResponse } from 'next/server';
import { apiBaseUrl } from '@/lib/server-config';

/**
 * Where an organisation's own Stripe or Razorpay account sends notices about its payment links.
 * Passes the exact bytes and the signature headers to the API, which checks the signature with
 * that organisation's webhook secret; nothing here is trusted or changed.
 */
const SIGNATURE_HEADERS = ['stripe-signature', 'x-razorpay-signature', 'x-razorpay-event-id'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest, ctx: { params: Promise<{ orgId: string; provider: string }> }) {
  const { orgId, provider } = await ctx.params;
  if (!UUID.test(orgId) || (provider !== 'stripe' && provider !== 'razorpay')) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
  const headers: Record<string, string> = { 'content-type': req.headers.get('content-type') ?? 'application/json' };
  for (const h of SIGNATURE_HEADERS) {
    const v = req.headers.get(h);
    if (v) headers[h] = v;
  }
  const upstream = await fetch(`${apiBaseUrl()}/v1/payment-links/webhooks/${orgId}/${provider}`, { method: 'POST', headers, body: await req.arrayBuffer(), cache: 'no-store' });
  return new NextResponse(await upstream.arrayBuffer(), { status: upstream.status, headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' } });
}
