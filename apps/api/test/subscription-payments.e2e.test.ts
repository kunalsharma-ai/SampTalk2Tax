import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPaymentsStandIn, type PaymentsStandIn } from '../../../test-support/payments-stand-in.mjs';
import { AdminService } from '../src/admin/admin.service';
import { RenewalsRunnerService } from '../src/billing/payments/renewals-runner.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Paying for a subscription online, against the real API and database, with the real Stripe and
 * Razorpay client code talking to a local stand-in for their APIs (test-support/payments-stand-in.mjs).
 */
let ctx: Ctx;
let gw: PaymentsStandIn;
let admin: TestUser;
let owner: TestUser;
let api: string;
const STRIPE_KEY = 'sk_test_standin12345';
const STRIPE_WH = 'whsec_standin12345';
const RZP = { keyId: 'rzp_test_standin12', secret: 'standin-razorpay-secret', webhook: 'standin-webhook-secret' };

beforeAll(async () => {
  gw = await startPaymentsStandIn(0);
  ctx = await bootApp({ PAYMENTS_STRIPE_API_URL: gw.url, PAYMENTS_RAZORPAY_API_URL: gw.url, BILLING_RUNNER_INTERVAL_SECONDS: '0' });
  await ctx.app.listen(0, '127.0.0.1');
  api = `http://127.0.0.1:${(ctx.app.getHttpServer().address() as AddressInfo).port}`;
  gw.webhooks.STRIPE = { url: `${api}/v1/billing/webhooks/stripe`, secret: STRIPE_WH };
  gw.webhooks.RAZORPAY = { url: `${api}/v1/billing/webhooks/razorpay`, secret: RZP.webhook };
  admin = await registerUser(ctx, 'Payments Admin');
  owner = await registerUser(ctx, 'Paying Owner');
  await ctx.app.get(AdminService).grant(admin.email, 'SUPER_ADMIN');
  // Other suites' gateways and seller details are replaced: these tests own them while they run.
  await ctx.prisma.platformPaymentGateway.deleteMany({});
});
afterAll(async () => {
  await ctx.prisma.platformPaymentGateway.deleteMany({});
  await ctx.app.close();
  await gw.close();
});

const profile = { legalName: 'Sampledge Technologies Pvt Ltd', address: 'Pune, Maharashtra', countryCode: 'IN', gstin: '27AAPFU0939F1ZV', email: 'billing@sampledge.test', gstRate: '18', sacCode: '998314', invoicePrefix: 'T2T' };

describe('setting up payments in Platform administration', () => {
  it('stores keys sealed, checks them with the gateway, and keeps each currency on one gateway', async () => {
    const before = (await ctx.http().get('/v1/admin/payments').set(admin.auth).expect(200)).body;
    expect(before.gateways.map((g: { provider: string; configured: boolean }) => [g.provider, g.configured])).toEqual([['RAZORPAY', false], ['STRIPE', false]]);
    await ctx.http().get('/v1/admin/payments').set(owner.auth).expect(403);
    await ctx.http().put('/v1/admin/payments/profile').set(admin.auth).send({ ...profile, gstin: '27BAD' }).expect(422);
    const p = (await ctx.http().put('/v1/admin/payments/profile').set(admin.auth).send(profile).expect(200)).body.profile;
    expect(p).toMatchObject({ gstin: '27AAPFU0939F1ZV', stateCode: '27', gstRate: '18' });

    const bad = await ctx.http().put('/v1/admin/payments/gateways/stripe').set(admin.auth).send({ enabled: true, mode: 'TEST', currencies: ['USD'], secret: 'sk_live_abcdefghij', webhookSecret: STRIPE_WH }).expect(422);
    expect(bad.body.message).toMatch(/sk_test_/);
    await ctx.http().put('/v1/admin/payments/gateways/stripe').set(admin.auth).send({ enabled: true, mode: 'TEST', currencies: ['USD'], secret: 'sk_test_wrongkey99', webhookSecret: STRIPE_WH }).expect(200);
    const refused = (await ctx.http().post('/v1/admin/payments/gateways/stripe/test').set(admin.auth).expect(200)).body;
    expect(refused).toMatchObject({ ok: false, message: 'Stripe refused: Invalid API Key provided' });
    const saved = (await ctx.http().put('/v1/admin/payments/gateways/stripe').set(admin.auth).send({ enabled: true, mode: 'TEST', currencies: ['USD'], secret: STRIPE_KEY }).expect(200)).body;
    const stripe = saved.gateways.find((g: { provider: string }) => g.provider === 'STRIPE');
    expect(stripe).toMatchObject({ enabled: true, secretHint: '…2345', webhookHint: '…2345', lastTest: null, webhookUrl: 'http://localhost:3000/api/webhooks/payments/stripe' });
    expect(JSON.stringify(saved)).not.toContain(STRIPE_KEY);
    const row = await ctx.prisma.platformPaymentGateway.findUniqueOrThrow({ where: { provider: 'STRIPE' } });
    expect(row.secretCipher).not.toContain('sk_test');
    expect((await ctx.http().post('/v1/admin/payments/gateways/stripe/test').set(admin.auth).expect(200)).body).toEqual({ ok: true, message: 'Connected to Stripe (test mode)' });

    const clash = await ctx.http().put('/v1/admin/payments/gateways/razorpay').set(admin.auth).send({ enabled: true, mode: 'TEST', currencies: ['INR', 'USD'], keyId: RZP.keyId, secret: RZP.secret, webhookSecret: RZP.webhook }).expect(409);
    expect(clash.body.error).toBe('GATEWAY_CURRENCY_TAKEN');
    await ctx.http().put('/v1/admin/payments/gateways/razorpay').set(admin.auth).send({ enabled: true, mode: 'TEST', currencies: ['INR'], keyId: RZP.keyId, secret: RZP.secret, webhookSecret: RZP.webhook }).expect(200);
    expect((await ctx.http().post('/v1/admin/payments/gateways/razorpay/test').set(admin.auth).expect(200)).body.ok).toBe(true);
  });
});

describe('an Indian organisation paying through Razorpay', () => {
  let org: Awaited<ReturnType<typeof createOrg>>;
  beforeAll(async () => {
    org = await createOrg(ctx, owner, { name: 'Razor Paying Traders Pvt Ltd' });
  });

  it('quotes the price with GST and keeps the trial days', async () => {
    const q = (await ctx.http().get(`${org.base}/subscription/quote?plan=GROWTH&interval=MONTHLY`).set(owner.auth).expect(200)).body;
    expect(q).toMatchObject({ kind: 'NEW', currency: 'INR', subtotal: '1499.00', lines: [{ code: 'CGST', amount: '134.91' }, { code: 'SGST', amount: '134.91' }], total: '1768.82', payOnline: true });
    const s = await ctx.prisma.subscription.findUniqueOrThrow({ where: { orgId: org.orgId } });
    expect(q.periodStart).toBe(s.trialEndsAt!.toISOString());
  });

  it('pays on the gateway page; the signed webhook activates the plan and numbers the tax invoice', async () => {
    const c = (await ctx.http().post(`${org.base}/subscription/checkout`).set(owner.auth).send({ plan: 'GROWTH', interval: 'MONTHLY' }).expect(201)).body;
    expect(c.url).toMatch(/\/pay\/plink_/);
    expect(c.invoice).toMatchObject({ status: 'OPEN', number: null, kind: 'NEW', total: '1768.82', gateway: 'RAZORPAY' });
    const link = [...gw.links.values()].at(-1)!;
    expect(link).toMatchObject({ amount: 176882, currency: 'INR', notes: { invoice_id: c.invoice.id } });
    expect(link.callback_url).toBe(`http://localhost:3000/orgs/${org.orgId}/settings/subscription?invoice=${c.invoice.id}`);

    const r = await gw.pay(link.id);
    expect(gw.sent.at(-1)).toMatchObject({ provider: 'RAZORPAY', type: 'payment_link.paid', status: 200 });
    expect(r!.redirect).toContain('razorpay_payment_link_status=paid');
    const inv = (await ctx.http().get(`${org.base}/subscription/invoices/${c.invoice.id}`).set(owner.auth).expect(200)).body;
    expect(inv).toMatchObject({ status: 'PAID', gateway: 'RAZORPAY', seller: { gstin: '27AAPFU0939F1ZV' }, buyer: { name: 'Razor Paying Traders Pvt Ltd', countryCode: 'IN' } });
    expect(inv.number).toMatch(/^T2T\/\d{2}-\d{2}\/\d{5}$/);
    expect(inv.paymentRef).toMatch(/^pay_/);
    const s = (await ctx.http().get(`${org.base}/subscription`).set(owner.auth).expect(200)).body;
    expect(s).toMatchObject({ status: 'ACTIVE', plan: { code: 'GROWTH' }, billingInterval: 'MONTHLY', price: '1499.00' });
    expect(s.history.slice(0, 3).map((h: { kind: string }) => h.kind)).toEqual(['PAYMENT_RECEIVED', 'CHECKOUT_STARTED', 'INVOICE_ISSUED']);

    // The same notice again (gateways retry) is acknowledged and changes nothing.
    const again = (await ctx.http().post(`${org.base}/subscription/invoices/${c.invoice.id}/check`).set(owner.auth).expect(200)).body;
    expect(again.state).toBe('paid');
    await expect(ctx.prisma.subscriptionInvoice.update({ where: { id: c.invoice.id }, data: { subtotal: '1' } })).rejects.toThrow(/cannot be changed/);
  });

  it('charges an upgrade for the days left, and schedules a cheaper plan for the renewal', async () => {
    const q = (await ctx.http().get(`${org.base}/subscription/quote?plan=PROFESSIONAL&interval=MONTHLY`).set(owner.auth).expect(200)).body;
    expect(q.kind).toBe('UPGRADE');
    expect(Number(q.subtotal)).toBeGreaterThan(0);
    expect(Number(q.subtotal)).toBeLessThanOrEqual(2000);
    const down = (await ctx.http().post(`${org.base}/subscription/checkout`).set(owner.auth).send({ plan: 'STARTER', interval: 'MONTHLY' }).expect(201)).body;
    expect(down).toMatchObject({ scheduled: true, url: null, subscription: { request: { plan: { code: 'STARTER' } }, plan: { code: 'GROWTH' } } });
  });

  it('refuses a webhook whose signature is wrong, and records it', async () => {
    const body = JSON.stringify({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: 'plink_forged', status: 'paid' } } } });
    const r = await ctx.http().post('/v1/billing/webhooks/razorpay').set('content-type', 'application/json').set('x-razorpay-signature', createHmac('sha256', 'not-the-secret').update(body).digest('hex')).send(body).expect(400);
    expect(r.body.error).toBe('SIGNATURE_INVALID');
    const log = (await ctx.http().get('/v1/admin/invoices').set(admin.auth).expect(200)).body.webhooks;
    expect(log[0]).toMatchObject({ provider: 'RAZORPAY', signatureOk: false, outcome: 'The signature does not match the webhook secret' });
  });
});

describe('an organisation outside India paying through Stripe', () => {
  it('is charged without GST (export of services), confirmed by asking Stripe when the webhook is missed', async () => {
    const uk = await createOrg(ctx, owner, { name: 'Stripe Paying Ltd', countryCode: 'GB', functionalCurrency: 'GBP', fiscalYearStartMonth: 4 });
    await ctx.prisma.subscription.update({ where: { orgId: uk.orgId }, data: { trialEndsAt: new Date(Date.now() - 86_400_000) } });
    // Read-only after the trial, but paying still works.
    await ctx.http().post(`${uk.base}/contacts`).set(owner.auth).send({ name: 'Blocked Ltd', isCustomer: true }).expect(402);
    const c = (await ctx.http().post(`${uk.base}/subscription/checkout`).set(owner.auth).send({ plan: 'PROFESSIONAL', interval: 'ANNUAL' }).expect(201)).body;
    expect(c.invoice).toMatchObject({ total: '590.00', taxTotal: '0.00', placeOfSupply: 'Outside India', gateway: 'STRIPE' });
    expect(c.invoice.taxNote).toMatch(/export/);
    const session = [...gw.sessions.values()].at(-1)!;
    expect(session).toMatchObject({ amount_total: 59000, currency: 'usd', client_reference_id: c.invoice.id });
    await gw.pay(session.id, { webhook: false });
    const checked = (await ctx.http().post(`${uk.base}/subscription/invoices/${c.invoice.id}/check`).set(owner.auth).expect(200)).body;
    expect(checked).toMatchObject({ state: 'paid', invoice: { status: 'PAID' } });
    const s = (await ctx.http().get(`${uk.base}/subscription`).set(owner.auth).expect(200)).body;
    expect(s).toMatchObject({ status: 'ACTIVE', plan: { code: 'PROFESSIONAL' }, billingInterval: 'ANNUAL', access: { level: 'FULL' } });
    await ctx.http().post(`${uk.base}/contacts`).set(owner.auth).send({ name: 'Allowed Ltd', isCustomer: true }).expect(201);

    // A Stripe webhook for the same session afterwards is accepted once and changes nothing.
    const ev = JSON.stringify({ id: `evt_late_${Date.now()}`, type: 'checkout.session.completed', data: { object: { ...session } } });
    const t = Math.floor(Date.now() / 1000);
    const sig = `t=${t},v1=${createHmac('sha256', STRIPE_WH).update(`${t}.${ev}`).digest('hex')}`;
    const first = (await ctx.http().post('/v1/billing/webhooks/stripe').set('content-type', 'application/json').set('stripe-signature', sig).send(ev).expect(200)).body;
    expect(first).toMatchObject({ received: true, duplicate: false, outcome: 'Already paid' });
    expect((await ctx.http().post('/v1/billing/webhooks/stripe').set('content-type', 'application/json').set('stripe-signature', sig).send(ev).expect(200)).body.duplicate).toBe(true);
    const old = `t=${t - 600},v1=${createHmac('sha256', STRIPE_WH).update(`${t - 600}.${ev}`).digest('hex')}`;
    await ctx.http().post('/v1/billing/webhooks/stripe').set('content-type', 'application/json').set('stripe-signature', old).send(ev).expect(400);
  });

  it('does not apply a payment of the wrong amount', async () => {
    const o = await createOrg(ctx, owner, { name: 'Short Paying Ltd', countryCode: 'GB', functionalCurrency: 'GBP', fiscalYearStartMonth: 4 });
    const c = (await ctx.http().post(`${o.base}/subscription/checkout`).set(owner.auth).send({ plan: 'STARTER', interval: 'MONTHLY' }).expect(201)).body;
    const session = [...gw.sessions.values()].at(-1)!;
    await gw.pay(session.id, { amount: 100 });
    const inv = (await ctx.http().get(`${o.base}/subscription/invoices/${c.invoice.id}`).set(owner.auth).expect(200)).body;
    expect(inv.status).toBe('OPEN');
    const s = (await ctx.http().get(`${o.base}/subscription`).set(owner.auth).expect(200)).body;
    expect(s.status).toBe('TRIALING');
    expect(s.history[0]).toMatchObject({ kind: 'PAYMENT_MISMATCH' });
  });
});

describe('renewals and reminders', () => {
  it('issues the renewal a week ahead, reminds once per stage, and a late payment starts from the day paid', async () => {
    const o = await createOrg(ctx, owner, { name: 'Renewing Traders Pvt Ltd' });
    const start = new Date(Date.now() - 25 * 86_400_000);
    const end = new Date(Date.now() + 5 * 86_400_000);
    const plan = await ctx.prisma.plan.findUniqueOrThrow({ where: { code: 'STARTER' } });
    await ctx.prisma.subscription.update({ where: { orgId: o.orgId }, data: { status: 'ACTIVE', planId: plan.id, billingInterval: 'MONTHLY', price: '499', currentPeriodStart: start, currentPeriodEnd: end } });
    const runner = ctx.app.get(RenewalsRunnerService);
    expect(await runner.tick({ orgIds: [o.orgId] })).toEqual({ issued: 1, reminded: 1 });
    expect(await runner.tick({ orgIds: [o.orgId] })).toEqual({ issued: 0, reminded: 0 });
    const [inv] = (await ctx.http().get(`${o.base}/subscription/invoices`).set(owner.auth).expect(200)).body;
    expect(inv).toMatchObject({ kind: 'RENEWAL', status: 'OPEN', subtotal: '499.00', total: '588.82', periodStart: end.toISOString(), checkout: null });
    // Grace, then the final reminder.
    expect(await runner.tick({ orgIds: [o.orgId], now: new Date(end.getTime() + 86_400_000) })).toEqual({ issued: 0, reminded: 1 });
    expect(await runner.tick({ orgIds: [o.orgId], now: new Date(end.getTime() + 6 * 86_400_000) })).toEqual({ issued: 0, reminded: 1 });
    const kinds = (await ctx.http().get(`${o.base}/subscription`).set(owner.auth).expect(200)).body.history.map((h: { kind: string }) => h.kind);
    expect(kinds.slice(0, 4)).toEqual(['REMINDER_FINAL', 'REMINDER_DUE', 'REMINDER_UPCOMING', 'INVOICE_ISSUED']);

    // Paid by bank transfer, recorded by staff.
    await ctx.http().post(`/v1/admin/invoices/${inv.id}/mark-paid`).set(admin.auth).send({ reference: 'x' }).expect(422);
    const paid = (await ctx.http().post(`/v1/admin/invoices/${inv.id}/mark-paid`).set(admin.auth).send({ reference: 'NEFT UTR 99812' }).expect(200)).body;
    expect(paid).toMatchObject({ status: 'PAID', gateway: 'MANUAL', paymentRef: 'NEFT UTR 99812' });
    const s = await ctx.prisma.subscription.findUniqueOrThrow({ where: { orgId: o.orgId } });
    expect(s.currentPeriodStart!.toISOString()).toBe(end.toISOString());
    await ctx.http().post(`/v1/admin/invoices/${inv.id}/void`).set(admin.auth).send({ reason: 'Too late' }).expect(409);
  });

  it('pays an open renewal online from the organisation', async () => {
    const o = await createOrg(ctx, owner, { name: 'Online Renewing Pvt Ltd' });
    const plan = await ctx.prisma.plan.findUniqueOrThrow({ where: { code: 'GROWTH' } });
    const end = new Date(Date.now() + 3 * 86_400_000);
    await ctx.prisma.subscription.update({ where: { orgId: o.orgId }, data: { status: 'ACTIVE', planId: plan.id, billingInterval: 'MONTHLY', price: '1499', currentPeriodStart: new Date(Date.now() - 27 * 86_400_000), currentPeriodEnd: end } });
    await ctx.app.get(RenewalsRunnerService).tick({ orgIds: [o.orgId] });
    const [inv] = (await ctx.http().get(`${o.base}/subscription/invoices`).set(owner.auth).expect(200)).body;
    const p = (await ctx.http().post(`${o.base}/subscription/invoices/${inv.id}/pay`).set(owner.auth).expect(201)).body;
    expect(p.url).toMatch(/\/pay\/plink_/);
    const again = (await ctx.http().post(`${o.base}/subscription/invoices/${inv.id}/pay`).set(owner.auth).expect(201)).body;
    expect(again.url).toBe(p.url);
    await gw.pay([...gw.links.values()].at(-1)!.id);
    const s = await ctx.prisma.subscription.findUniqueOrThrow({ where: { orgId: o.orgId } });
    expect(s.currentPeriodStart!.toISOString()).toBe(end.toISOString());
    expect(s.currentPeriodEnd! > end).toBe(true);
  });
});
