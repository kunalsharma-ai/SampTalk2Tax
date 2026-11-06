import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The payment gateways Talk2Tax takes subscription payments through, called over their REST
 * APIs: Stripe Checkout Sessions and Razorpay Payment Links. Both send the customer to a page the
 * gateway hosts (card and UPI details never reach Talk2Tax), notify the API by a signed webhook
 * when the payment succeeds, and can be asked for the state of a checkout, so a payment is
 * picked up even when a webhook is late or cannot reach the server.
 */

export type Provider = 'STRIPE' | 'RAZORPAY';
export const PROVIDERS: readonly Provider[] = ['STRIPE', 'RAZORPAY'];

export interface GatewayCreds {
  keyId: string | null;
  secret: string;
  webhookSecret: string | null;
}

export interface CheckoutRequest {
  /** Our payment request reference, shown to the customer and sent as the gateway's reference. */
  reference: string;
  invoiceId: string;
  orgId: string;
  amountMinor: number;
  currency: 'INR' | 'USD';
  description: string;
  customerName: string;
  customerEmail: string | null;
  /** Where the customer comes back to; the gateway may add its own query parameters. */
  returnUrl: string;
  cancelUrl: string;
}

export interface CheckoutResult {
  ref: string;
  url: string;
  expiresAt: Date | null;
}

export interface PaymentState {
  paid: boolean;
  /** open, paid, expired, cancelled… as the gateway says. */
  state: string;
  paymentId: string | null;
  amountMinor: number | null;
  currency: string | null;
}

export interface WebhookNotice {
  eventId: string;
  type: string;
  /** The checkout (session or payment link) it is about, when it is about one. */
  ref: string | null;
  payment: PaymentState | null;
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

export class SignatureError extends Error {}

export interface PaymentGateway {
  readonly provider: Provider;
  test(): Promise<string>;
  createCheckout(r: CheckoutRequest): Promise<CheckoutResult>;
  status(ref: string): Promise<PaymentState>;
  /** Ends a checkout that is no longer wanted (best effort; a paid one cannot be ended). */
  cancel(ref: string): Promise<void>;
  /** Checks the signature and reads the notice; throws SignatureError when it is not genuine. */
  webhook(raw: Buffer, headers: Record<string, string | string[] | undefined>, now: Date): WebhookNotice;
}

const header = (h: Record<string, string | string[] | undefined>, name: string) => {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

const safeEqualHex = (a: string, b: string) => {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};

async function call(url: string, init: RequestInit, timeoutMs: number, read: (body: Record<string, unknown>) => string): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const err = e as Error;
    throw new GatewayError(err.name === 'TimeoutError' ? `No answer within ${timeoutMs / 1000} seconds` : `Could not reach the gateway: ${err.message}`);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new GatewayError(read(body) || `The gateway answered ${res.status}`, res.status);
  return body;
}

// ------------------------------------------------------------------------------------- Stripe

/** Stripe's form encoding of nested parameters: a[b][c]=v. */
function form(params: Record<string, unknown>, prefix = '', out = new URLSearchParams()): URLSearchParams {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v as Record<string, unknown>, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export class StripeGateway implements PaymentGateway {
  readonly provider = 'STRIPE' as const;
  constructor(
    private readonly creds: GatewayCreds,
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  private req(method: string, path: string, params?: Record<string, unknown>, idempotencyKey?: string) {
    const headers: Record<string, string> = { authorization: `Bearer ${this.creds.secret}` };
    if (params) headers['content-type'] = 'application/x-www-form-urlencoded';
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    return call(`${this.baseUrl}${path}`, { method, headers, body: params ? form(params).toString() : undefined }, this.timeoutMs, (b) => String((b.error as { message?: string } | undefined)?.message ?? ''));
  }

  async test() {
    const b = await this.req('GET', '/v1/balance');
    return `Connected to Stripe (${b.livemode ? 'live' : 'test'} mode)`;
  }

  async createCheckout(r: CheckoutRequest): Promise<CheckoutResult> {
    // A session can stay open for at most 24 hours; a new one is made when the customer comes back later.
    const expires = Math.floor(Date.now() / 1000) + 23 * 3600;
    const b = await this.req(
      'POST',
      '/v1/checkout/sessions',
      {
        mode: 'payment',
        success_url: r.returnUrl,
        cancel_url: r.cancelUrl,
        client_reference_id: r.invoiceId,
        customer_email: r.customerEmail ?? undefined,
        expires_at: expires,
        line_items: { 0: { quantity: 1, price_data: { currency: r.currency.toLowerCase(), unit_amount: r.amountMinor, product_data: { name: r.description } } } },
        metadata: { invoice_id: r.invoiceId, org_id: r.orgId, reference: r.reference },
        payment_intent_data: { description: `${r.reference} ${r.description}`.slice(0, 1000), metadata: { invoice_id: r.invoiceId, reference: r.reference } },
      },
      `t2t-${r.invoiceId}-${expires}`,
    );
    if (typeof b.id !== 'string' || typeof b.url !== 'string') throw new GatewayError('Stripe did not return a checkout page');
    return { ref: b.id, url: b.url, expiresAt: typeof b.expires_at === 'number' ? new Date(b.expires_at * 1000) : null };
  }

  private session(o: Record<string, unknown>): PaymentState {
    const paid = o.payment_status === 'paid';
    const pi = o.payment_intent;
    return {
      paid,
      state: paid ? 'paid' : String(o.status ?? 'open'),
      paymentId: typeof pi === 'string' ? pi : pi && typeof pi === 'object' ? String((pi as { id?: string }).id ?? '') || null : null,
      amountMinor: typeof o.amount_total === 'number' ? o.amount_total : null,
      currency: typeof o.currency === 'string' ? o.currency.toUpperCase() : null,
    };
  }

  async status(ref: string) {
    return this.session(await this.req('GET', `/v1/checkout/sessions/${encodeURIComponent(ref)}`));
  }

  async cancel(ref: string) {
    await this.req('POST', `/v1/checkout/sessions/${encodeURIComponent(ref)}/expire`, {}).catch(() => undefined);
  }

  /** Stripe-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">; older than 5 minutes is refused. */
  webhook(raw: Buffer, headers: Record<string, string | string[] | undefined>, now: Date): WebhookNotice {
    if (!this.creds.webhookSecret) throw new SignatureError('No signing secret is set for Stripe');
    const sig = header(headers, 'stripe-signature') ?? '';
    const parts = sig.split(',').map((p) => p.trim().split('='));
    const t = parts.find(([k]) => k === 't')?.[1];
    const v1 = parts.filter(([k]) => k === 'v1').map(([, v]) => v ?? '');
    if (!t || !v1.length) throw new SignatureError('The Stripe-Signature header is missing or malformed');
    const expected = createHmac('sha256', this.creds.webhookSecret).update(`${t}.`).update(raw).digest('hex');
    if (!v1.some((v) => safeEqualHex(v, expected))) throw new SignatureError('The signature does not match the signing secret');
    if (Math.abs(now.getTime() / 1000 - Number(t)) > 300) throw new SignatureError('The notice is more than 5 minutes old');
    const ev = JSON.parse(raw.toString('utf8')) as { id?: string; type?: string; data?: { object?: Record<string, unknown> } };
    const o = ev.data?.object ?? {};
    const about = typeof ev.type === 'string' && ev.type.startsWith('checkout.session.');
    return { eventId: String(ev.id ?? ''), type: String(ev.type ?? ''), ref: about && typeof o.id === 'string' ? o.id : null, payment: about ? this.session(o) : null };
  }
}

// ----------------------------------------------------------------------------------- Razorpay

export class RazorpayGateway implements PaymentGateway {
  readonly provider = 'RAZORPAY' as const;
  constructor(
    private readonly creds: GatewayCreds,
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  private req(method: string, path: string, body?: unknown) {
    const auth = Buffer.from(`${this.creds.keyId ?? ''}:${this.creds.secret}`).toString('base64');
    return call(
      `${this.baseUrl}${path}`,
      { method, headers: { authorization: `Basic ${auth}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined },
      this.timeoutMs,
      (b) => String((b.error as { description?: string } | undefined)?.description ?? ''),
    );
  }

  async test() {
    await this.req('GET', '/v1/payments?count=1');
    return `Connected to Razorpay (${this.creds.keyId?.startsWith('rzp_live_') ? 'live' : 'test'} key)`;
  }

  async createCheckout(r: CheckoutRequest): Promise<CheckoutResult> {
    const expireBy = Math.floor(Date.now() / 1000) + 7 * 86400;
    const b = await this.req('POST', '/v1/payment_links', {
      amount: r.amountMinor,
      currency: r.currency,
      accept_partial: false,
      description: r.description.slice(0, 2048),
      reference_id: `${r.reference}-${expireBy.toString(36)}`.slice(0, 40),
      customer: { name: r.customerName.slice(0, 100), ...(r.customerEmail ? { email: r.customerEmail } : {}) },
      notify: { sms: false, email: false },
      reminder_enable: false,
      callback_url: r.returnUrl,
      callback_method: 'get',
      expire_by: expireBy,
      notes: { invoice_id: r.invoiceId, org_id: r.orgId, reference: r.reference },
    });
    if (typeof b.id !== 'string' || typeof b.short_url !== 'string') throw new GatewayError('Razorpay did not return a payment link');
    return { ref: b.id, url: b.short_url, expiresAt: typeof b.expire_by === 'number' ? new Date(b.expire_by * 1000) : null };
  }

  private link(o: Record<string, unknown>, payment?: Record<string, unknown>): PaymentState {
    const paid = o.status === 'paid';
    const payments = Array.isArray(o.payments) ? (o.payments as Record<string, unknown>[]) : [];
    const p = payment ?? payments.find((x) => x.status === 'captured') ?? payments[0];
    return {
      paid,
      state: String(o.status ?? 'created'),
      paymentId: p ? String(p.payment_id ?? p.id ?? '') || null : null,
      amountMinor: typeof o.amount_paid === 'number' && paid ? o.amount_paid : typeof o.amount === 'number' && paid ? o.amount : null,
      currency: typeof o.currency === 'string' ? o.currency : null,
    };
  }

  async status(ref: string) {
    return this.link(await this.req('GET', `/v1/payment_links/${encodeURIComponent(ref)}`));
  }

  async cancel(ref: string) {
    await this.req('POST', `/v1/payment_links/${encodeURIComponent(ref)}/cancel`).catch(() => undefined);
  }

  /** X-Razorpay-Signature: hex HMAC-SHA256 of the raw body with the webhook secret. */
  webhook(raw: Buffer, headers: Record<string, string | string[] | undefined>): WebhookNotice {
    if (!this.creds.webhookSecret) throw new SignatureError('No webhook secret is set for Razorpay');
    const sig = header(headers, 'x-razorpay-signature') ?? '';
    const expected = createHmac('sha256', this.creds.webhookSecret).update(raw).digest('hex');
    if (!safeEqualHex(sig, expected)) throw new SignatureError('The signature does not match the webhook secret');
    const ev = JSON.parse(raw.toString('utf8')) as { event?: string; payload?: { payment_link?: { entity?: Record<string, unknown> }; payment?: { entity?: Record<string, unknown> } } };
    const link = ev.payload?.payment_link?.entity;
    const payment = ev.payload?.payment?.entity;
    const type = String(ev.event ?? '');
    const eventId = header(headers, 'x-razorpay-event-id') ?? `${type}:${String(payment?.id ?? link?.id ?? '')}`;
    return { eventId, type, ref: link && typeof link.id === 'string' ? link.id : null, payment: link ? this.link(link, payment) : null };
  }
}
