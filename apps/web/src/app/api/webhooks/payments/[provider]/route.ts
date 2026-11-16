import { NextRequest, NextResponse } from 'next/server';
import { apiBaseUrl } from '@/lib/server-config';

/**
 * Where Stripe and Razorpay send their payment notices. Passes the exact bytes and the signature
 * headers to the API, which checks the signature; nothing here is trusted or changed.
 */
const SIGNATURE_HEADERS = ['stripe-signature', 'x-razorpay-signature', 'x-razorpay-event-id'];

export async function POST(req: NextRequest, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  if (provider !== 'stripe' && provider !== 'razorpay') return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
  const headers: Record<string, string> = { 'content-type': req.headers.get('content-type') ?? 'application/json' };
  for (const h of SIGNATURE_HEADERS) {
    const v = req.headers.get(h);
    if (v) headers[h] = v;
  }
  const upstream = await fetch(`${apiBaseUrl()}/v1/billing/webhooks/${provider}`, { method: 'POST', headers, body: await req.arrayBuffer(), cache: 'no-store' });
  return new NextResponse(await upstream.arrayBuffer(), { status: upstream.status, headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' } });
}
