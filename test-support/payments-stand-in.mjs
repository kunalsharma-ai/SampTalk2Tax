/**
 * A local stand-in for the parts of Stripe's and Razorpay's REST APIs that Talk2Tax calls, for
 * tests and previews only. The API's real gateway code talks to it when it runs with
 * PAYMENTS_STRIPE_API_URL and PAYMENTS_RAZORPAY_API_URL pointing here. It checks keys, keeps
 * checkouts in memory, serves a plain "payment page", and on payment sends a webhook signed the
 * way each gateway signs. No money moves and nothing reaches Stripe or Razorpay.
 *
 *   const pay = await startPaymentsStandIn(4557);
 *   pay.keys.STRIPE = 'sk_test_standin12345';               // the key the API must send
 *   pay.webhooks.STRIPE = { url: 'http://127.0.0.1:4000/v1/billing/webhooks/stripe', secret: 'whsec_standin12345' };
 *   await pay.pay('cs_test_…');                             // as if the customer paid
 *
 * Run on its own for the browser tests and previews: node test-support/payments-stand-in.mjs
 * (port 4557; keys and webhook targets from STANDIN_* environment variables, see the bottom).
 */
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const id = (prefix) => `${prefix}${randomBytes(9).toString('base64url')}`;

export async function startPaymentsStandIn(port = 0, opts = {}) {
  const keys = { STRIPE: opts.stripeKey ?? 'sk_test_standin12345', RAZORPAY: { keyId: opts.razorpayKeyId ?? 'rzp_test_standin12', secret: opts.razorpaySecret ?? 'standin-razorpay-secret' } };
  const webhooks = { STRIPE: opts.stripeWebhook ?? null, RAZORPAY: opts.razorpayWebhook ?? null };
  const sessions = new Map();
  const links = new Map();
  const requests = [];
  /** Webhooks sent, with the API's answer. */
  const sent = [];
  let base = '';

  const json = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

  async function notify(provider, event, headers) {
    const target = webhooks[provider];
    if (!target) return null;
    const raw = JSON.stringify(event);
    const h = { 'content-type': 'application/json', ...headers(raw, target.secret) };
    try {
      const r = await fetch(target.url, { method: 'POST', headers: h, body: raw });
      const out = { provider, type: event.type ?? event.event, status: r.status, body: await r.text() };
      sent.push(out);
      return out;
    } catch (e) {
      const out = { provider, type: event.type ?? event.event, status: null, body: String(e) };
      sent.push(out);
      return out;
    }
  }

  async function pay(ref, { webhook = true, amount } = {}) {
    if (sessions.has(ref)) {
      const s = sessions.get(ref);
      s.status = 'complete';
      s.payment_status = 'paid';
      s.payment_intent = id('pi_');
      if (amount !== undefined) s.amount_total = amount;
      if (webhook) {
        const ev = { id: id('evt_'), object: 'event', type: 'checkout.session.completed', data: { object: s } };
        await notify('STRIPE', ev, (raw, secret) => {
          const t = Math.floor(Date.now() / 1000);
          return { 'stripe-signature': `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}` };
        });
      }
      return { redirect: s.success_url };
    }
    if (links.has(ref)) {
      const l = links.get(ref);
      const paymentId = id('pay_');
      l.status = 'paid';
      l.amount_paid = amount ?? l.amount;
      l.payments = [{ payment_id: paymentId, amount: l.amount_paid, status: 'captured' }];
      if (webhook) {
        const ev = { entity: 'event', event: 'payment_link.paid', payload: { payment_link: { entity: l }, payment: { entity: { id: paymentId, amount: l.amount_paid, currency: l.currency, status: 'captured' } } }, created_at: Math.floor(Date.now() / 1000) };
        await notify('RAZORPAY', ev, (raw, secret) => ({ 'x-razorpay-signature': createHmac('sha256', secret).update(raw).digest('hex'), 'x-razorpay-event-id': id('evt_') }));
      }
      const q = new URLSearchParams({ razorpay_payment_id: paymentId, razorpay_payment_link_id: l.id, razorpay_payment_link_reference_id: l.reference_id, razorpay_payment_link_status: 'paid' });
      return { redirect: `${l.callback_url}${l.callback_url.includes('?') ? '&' : '?'}${q}` };
    }
    return null;
  }

  const page = (title, amount, currency, action, cancel) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:16px system-ui,sans-serif;background:#f4f4f6;margin:0;display:grid;place-items:center;min-height:100vh}main{background:#fff;border:1px solid #ddd;border-radius:12px;padding:32px;width:min(420px,90vw)}h1{font-size:18px;margin:0 0 4px}p{color:#555}.amt{font-size:32px;font-weight:600;color:#111;margin:16px 0}.note{font-size:13px;color:#a15c00;background:#fff6e5;border-radius:8px;padding:8px 10px}button{font:inherit;background:#111;color:#fff;border:0;border-radius:8px;padding:12px 16px;width:100%;cursor:pointer;margin-top:16px}a{display:block;text-align:center;margin-top:12px;color:#555}</style></head>
<body><main><h1>${title}</h1><p>Test payment page (local stand-in)</p><div class="amt">${currency} ${(amount / 100).toFixed(2)}</div><div class="note">Test mode: no card is charged and no money moves.</div>
<form method="post" action="${action}"><button type="submit">Pay (test)</button></form>${cancel ? `<a href="${cancel}">Cancel and go back</a>` : ''}</main></body></html>`;

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const url = new URL(req.url, base);
      const auth = req.headers.authorization ?? '';
      requests.push({ method: req.method, path: url.pathname, headers: req.headers, body: raw });
      const p = url.pathname;

      // ----- the customer's payment page
      let m = /^\/pay\/(cs_[\w-]+|plink_[\w-]+)$/.exec(p);
      if (m) {
        const ref = m[1];
        const s = sessions.get(ref);
        const l = links.get(ref);
        if (!s && !l) return res.writeHead(404).end('No such checkout');
        if (req.method === 'POST') {
          const r = await pay(ref);
          return res.writeHead(303, { location: r.redirect }).end();
        }
        const html = s ? page(s.line_items[0].price_data.product_data.name, s.amount_total, s.currency.toUpperCase(), `/pay/${ref}`, s.cancel_url) : page(l.description, l.amount, l.currency, `/pay/${ref}`, null);
        return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
      }

      // ----- Stripe
      if (p.startsWith('/v1/balance') || p.startsWith('/v1/checkout/')) {
        if (auth !== `Bearer ${keys.STRIPE}`) return json(res, 401, { error: { type: 'invalid_request_error', message: 'Invalid API Key provided' } });
        if (p === '/v1/balance' && req.method === 'GET') return json(res, 200, { object: 'balance', livemode: false, available: [] });
        if (p === '/v1/checkout/sessions' && req.method === 'POST') {
          const f = new URLSearchParams(raw);
          const sid = id('cs_test_');
          const s = {
            id: sid,
            object: 'checkout.session',
            url: `${base}/pay/${sid}`,
            mode: f.get('mode'),
            status: 'open',
            payment_status: 'unpaid',
            success_url: f.get('success_url'),
            cancel_url: f.get('cancel_url'),
            client_reference_id: f.get('client_reference_id'),
            customer_email: f.get('customer_email'),
            amount_total: Number(f.get('line_items[0][price_data][unit_amount]')),
            currency: f.get('line_items[0][price_data][currency]'),
            expires_at: Number(f.get('expires_at')),
            metadata: { invoice_id: f.get('metadata[invoice_id]'), reference: f.get('metadata[reference]') },
            line_items: [{ price_data: { product_data: { name: f.get('line_items[0][price_data][product_data][name]') } } }],
            payment_intent: null,
          };
          if (!s.amount_total || !s.currency || !s.success_url) return json(res, 400, { error: { type: 'invalid_request_error', message: 'Missing required param' } });
          sessions.set(sid, s);
          return json(res, 200, s);
        }
        m = /^\/v1\/checkout\/sessions\/([\w-]+)(\/expire)?$/.exec(p);
        if (m && sessions.has(m[1])) {
          const s = sessions.get(m[1]);
          if (m[2]) {
            if (s.status !== 'open') return json(res, 400, { error: { message: 'Only open sessions can be expired' } });
            s.status = 'expired';
          }
          return json(res, 200, s);
        }
        return json(res, 404, { error: { type: 'invalid_request_error', message: 'No such checkout.session' } });
      }

      // ----- Razorpay
      if (p.startsWith('/v1/payments') || p.startsWith('/v1/payment_links')) {
        const want = `Basic ${Buffer.from(`${keys.RAZORPAY.keyId}:${keys.RAZORPAY.secret}`).toString('base64')}`;
        if (auth !== want) return json(res, 401, { error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } });
        if (p === '/v1/payments' && req.method === 'GET') return json(res, 200, { entity: 'collection', count: 0, items: [] });
        if (p === '/v1/payment_links' && req.method === 'POST') {
          const b = JSON.parse(raw || '{}');
          if (!b.amount || !b.currency) return json(res, 400, { error: { code: 'BAD_REQUEST_ERROR', description: 'The amount field is required.' } });
          const lid = id('plink_');
          const l = { id: lid, short_url: `${base}/pay/${lid}`, status: 'created', amount: b.amount, amount_paid: 0, currency: b.currency, description: b.description, reference_id: b.reference_id, callback_url: b.callback_url, expire_by: b.expire_by, notes: b.notes, payments: null };
          links.set(lid, l);
          return json(res, 200, l);
        }
        m = /^\/v1\/payment_links\/([\w-]+)(\/cancel)?$/.exec(p);
        if (m && links.has(m[1])) {
          const l = links.get(m[1]);
          if (m[2]) {
            if (l.status !== 'created') return json(res, 400, { error: { description: 'Payment link cannot be cancelled' } });
            l.status = 'cancelled';
          }
          return json(res, 200, l);
        }
        return json(res, 404, { error: { code: 'BAD_REQUEST_ERROR', description: 'The id provided does not exist' } });
      }
      json(res, 404, { error: { message: 'Not in the stand-in' } });
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  return { url: base, keys, webhooks, sessions, links, requests, sent, pay, close: () => new Promise((r) => server.close(r)) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.STANDIN_PORT ?? 4557);
  const hooks = process.env.STANDIN_WEBHOOK_BASE ?? 'http://127.0.0.1:3000/api/webhooks/payments';
  const s = await startPaymentsStandIn(port, {
    stripeWebhook: { url: `${hooks}/stripe`, secret: process.env.STANDIN_STRIPE_WEBHOOK_SECRET ?? 'whsec_standin12345' },
    razorpayWebhook: { url: `${hooks}/razorpay`, secret: process.env.STANDIN_RAZORPAY_WEBHOOK_SECRET ?? 'standin-webhook-secret' },
  });
  console.log(`Payments stand-in on ${s.url}`);
}
