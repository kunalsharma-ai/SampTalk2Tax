import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPaymentsStandIn, type PaymentsStandIn } from '../../../test-support/payments-stand-in.mjs';
import { AdminService } from '../src/admin/admin.service';
import { RenewalsRunnerService } from '../src/billing/payments/renewals-runner.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Add-on modules (SUBS-017): priced in Platform administration, bought with a plan at checkout,
 * opening the module, charged for the days left when added mid-period, and dropped at the
 * renewal when removed. Razorpay is played by a local stand-in.
 */
let ctx: Ctx;
let gw: PaymentsStandIn;
let admin: TestUser;
let owner: TestUser;
const RZP = { keyId: 'rzp_test_standin12', secret: 'standin-razorpay-secret', webhook: 'standin-webhook-secret' };
const PAYROLL = { INR: { monthly: '999', annual: '9990' }, USD: { monthly: '15', annual: '150' } };
const FX = { INR: { monthly: '499', annual: '4990' }, USD: { monthly: '9', annual: '90' } };

beforeAll(async () => {
  gw = await startPaymentsStandIn(0);
  ctx = await bootApp({ PAYMENTS_STRIPE_API_URL: gw.url, PAYMENTS_RAZORPAY_API_URL: gw.url, BILLING_RUNNER_INTERVAL_SECONDS: '0' });
  await ctx.app.listen(0, '127.0.0.1');
  const api = `http://127.0.0.1:${(ctx.app.getHttpServer().address() as AddressInfo).port}`;
  gw.webhooks.RAZORPAY = { url: `${api}/v1/billing/webhooks/razorpay`, secret: RZP.webhook };
  admin = await registerUser(ctx, 'Add-on Admin');
  owner = await registerUser(ctx, 'Add-on Owner');
  await ctx.app.get(AdminService).grant(admin.email, 'SUPER_ADMIN');
  await ctx.prisma.platformPaymentGateway.deleteMany({});
  // Add-on prices are platform-wide and the test database is kept between runs: start from none.
  await ctx.prisma.addOnPrice.deleteMany({});
  await ctx.http().put('/v1/admin/payments/profile').set(admin.auth).send({ legalName: 'Sampledge Technologies Pvt Ltd', address: 'Pune, Maharashtra', countryCode: 'IN', gstin: '27AAPFU0939F1ZV', email: 'billing@sampledge.test', gstRate: '18', sacCode: '998314', invoicePrefix: 'T2T' }).expect(200);
  await ctx.http().put('/v1/admin/payments/gateways/razorpay').set(admin.auth).send({ enabled: true, mode: 'TEST', currencies: ['INR'], keyId: RZP.keyId, secret: RZP.secret, webhookSecret: RZP.webhook }).expect(200);
});
afterAll(async () => {
  await ctx.prisma.addOnPrice.deleteMany({});
  await ctx.prisma.platformPaymentGateway.deleteMany({});
  await ctx.app.close();
  await gw.close();
});

describe('add-on modules', () => {
  let org: Awaited<ReturnType<typeof createOrg>>;

  it('are priced by platform administrators', async () => {
    const before = (await ctx.http().get('/v1/admin/add-ons').set(admin.auth).expect(200)).body;
    expect(before.map((a: { feature: string; prices: unknown }) => [a.feature, a.prices])).toEqual([['PAYROLL', null], ['MULTI_CURRENCY', null], ['CONSOLIDATION', null]]);
    await ctx.http().put('/v1/admin/add-ons/payroll').set(owner.auth).send({ prices: PAYROLL, isActive: true }).expect(403);
    expect((await ctx.http().put('/v1/admin/add-ons/ai').set(admin.auth).send({ prices: PAYROLL, isActive: true }).expect(422)).body.message).toBe('AI cannot be bought as an add-on');
    expect((await ctx.http().put('/v1/admin/add-ons/payroll').set(admin.auth).send({ prices: { INR: PAYROLL.INR }, isActive: true }).expect(422)).body.message).toBe('A USD price is needed');
    const saved = (await ctx.http().put('/v1/admin/add-ons/payroll').set(admin.auth).send({ prices: PAYROLL, isActive: true }).expect(200)).body;
    expect(saved[0]).toMatchObject({ feature: 'PAYROLL', label: 'Payroll', prices: PAYROLL, isActive: true, subscriptions: 0 });
    await ctx.http().put('/v1/admin/add-ons/multi_currency').set(admin.auth).send({ prices: FX, isActive: true }).expect(200);
    expect(await ctx.prisma.auditEvent.findFirst({ where: { action: 'platform.add_on_saved', entityId: 'PAYROLL' } })).not.toBeNull();
  });

  it('are bought with a plan at checkout and open their module', async () => {
    org = await createOrg(ctx, owner, { name: 'Add-on Buying Pvt Ltd' });
    const s = (await ctx.http().get(`${org.base}/subscription`).set(owner.auth).expect(200)).body;
    expect(s.addOnOffers).toEqual([
      { feature: 'PAYROLL', label: 'Payroll', monthly: '999', annual: '9990' },
      { feature: 'MULTI_CURRENCY', label: 'Exchange rates and revaluation', monthly: '499', annual: '4990' },
    ]);
    const q = (await ctx.http().get(`${org.base}/subscription/quote?plan=GROWTH&interval=MONTHLY&addOns=PAYROLL`).set(owner.auth).expect(200)).body;
    expect(q).toMatchObject({ kind: 'NEW', addOns: ['PAYROLL'], addOnLines: [{ feature: 'PAYROLL', label: 'Payroll', price: '999.00' }], listPrice: '2498.00', amount: '2498.00', subtotal: '2498.00', total: '2947.64' });
    expect((await ctx.http().get(`${org.base}/subscription/quote?plan=PROFESSIONAL&interval=MONTHLY&addOns=PAYROLL`).set(owner.auth).expect(422)).body).toMatchObject({ error: 'ADD_ON_INVALID', message: 'The plan already includes Payroll' });
    expect((await ctx.http().get(`${org.base}/subscription/quote?plan=GROWTH&interval=MONTHLY&addOns=CONSOLIDATION`).set(owner.auth).expect(422)).body.message).toBe('Group consolidation and intercompany is not offered as an add-on');

    const c = (await ctx.http().post(`${org.base}/subscription/checkout`).set(owner.auth).send({ plan: 'GROWTH', interval: 'MONTHLY', addOns: ['PAYROLL'] }).expect(201)).body;
    expect(c.invoice).toMatchObject({ addOns: ['PAYROLL'], addOnLines: [{ feature: 'PAYROLL', price: '999.00' }], listPrice: '2498.00', total: '2947.64' });
    await gw.pay([...gw.links.values()].at(-1)!.id);
    const after = (await ctx.http().get(`${org.base}/subscription`).set(owner.auth).expect(200)).body;
    expect(after).toMatchObject({ status: 'ACTIVE', plan: { code: 'GROWTH' }, price: '2498.00', addOns: ['PAYROLL'], features: ['AI', 'PAYROLL'] });
    const listed = (await ctx.http().get('/v1/orgs').set(owner.auth).expect(200)).body.find((o: { id: string }) => o.id === org.orgId);
    expect(listed.subscription.plan.features).toEqual(['AI', 'PAYROLL']);

    // Payroll is open (the request reaches validation); foreign currencies are not.
    expect((await ctx.http().post(`${org.base}/payroll/leave-types`).set(owner.auth).send({})).status).not.toBe(403);
    expect((await ctx.http().put(`${org.base}/fx/rates`).set(owner.auth).send({}).expect(403)).body.error).toBe('FEATURE_NOT_IN_PLAN');
  });

  it('charge an added module for the days left, and drop a removed one at the renewal', async () => {
    const start = new Date(Date.now() - 15 * 86_400_000);
    const end = new Date(Date.now() + 15 * 86_400_000);
    await ctx.prisma.subscription.update({ where: { orgId: org.orgId }, data: { currentPeriodStart: start, currentPeriodEnd: end } });
    const more = (await ctx.http().get(`${org.base}/subscription/quote?plan=GROWTH&interval=MONTHLY&addOns=PAYROLL,MULTI_CURRENCY`).set(owner.auth).expect(200)).body;
    expect(more).toMatchObject({ kind: 'UPGRADE', listPrice: '2997.00', addOns: ['PAYROLL', 'MULTI_CURRENCY'] });
    // About half of the 499 a month for foreign currencies.
    expect(Number(more.subtotal)).toBeGreaterThan(240);
    expect(Number(more.subtotal)).toBeLessThan(260);

    const fewer = (await ctx.http().post(`${org.base}/subscription/checkout`).set(owner.auth).send({ plan: 'GROWTH', interval: 'MONTHLY', addOns: [] }).expect(201)).body;
    expect(fewer).toMatchObject({ scheduled: true, reason: 'Removing an add-on takes effect at the renewal; it stays until the end of the period paid for', subscription: { addOns: ['PAYROLL'], request: { plan: { code: 'GROWTH' }, addOns: [] } } });
    const runner = ctx.app.get(RenewalsRunnerService);
    await runner.tick({ orgIds: [org.orgId], now: new Date(end.getTime() - 3 * 86_400_000) });
    const [renewal] = (await ctx.http().get(`${org.base}/subscription/invoices`).set(owner.auth).expect(200)).body;
    expect(renewal).toMatchObject({ kind: 'RENEWAL', status: 'OPEN', listPrice: '1499.00', addOns: [], addOnLines: [] });
    await ctx.http().post(`/v1/admin/invoices/${renewal.id}/mark-paid`).set(admin.auth).send({ reference: 'NEFT UTR 77120' }).expect(200);
    const s = (await ctx.http().get(`${org.base}/subscription`).set(owner.auth).expect(200)).body;
    expect(s).toMatchObject({ addOns: [], features: ['AI'], price: '1499.00', request: null });
    expect((await ctx.http().get('/v1/admin/add-ons').set(admin.auth).expect(200)).body[0].subscriptions).toBe(0);
  });
});
