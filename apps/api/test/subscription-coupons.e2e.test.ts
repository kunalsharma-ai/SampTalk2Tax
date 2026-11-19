import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPaymentsStandIn, type PaymentsStandIn } from '../../../test-support/payments-stand-in.mjs';
import { AdminService } from '../src/admin/admin.service';
import { RenewalsRunnerService } from '../src/billing/payments/renewals-runner.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Coupons on subscriptions (SUBS-024): created in Platform administration, entered at checkout,
 * taken off before GST, kept for the renewals they cover, with Razorpay played by a local stand-in.
 */
let ctx: Ctx;
let gw: PaymentsStandIn;
let admin: TestUser;
let owner: TestUser;
const RZP = { keyId: 'rzp_test_standin12', secret: 'standin-razorpay-secret', webhook: 'standin-webhook-secret' };
// Codes are platform-wide and the test database is kept between runs, so each run has its own.
const run = Date.now().toString(36).toUpperCase().slice(-6);
const LAUNCH = `LAUNCH-${run}`;
const FLAT = `FLAT-${run}`;
const PROMO = `PROMO-${run}`;
const SMALL = `SMALL-${run}`;

beforeAll(async () => {
  gw = await startPaymentsStandIn(0);
  ctx = await bootApp({ PAYMENTS_STRIPE_API_URL: gw.url, PAYMENTS_RAZORPAY_API_URL: gw.url, BILLING_RUNNER_INTERVAL_SECONDS: '0' });
  await ctx.app.listen(0, '127.0.0.1');
  const api = `http://127.0.0.1:${(ctx.app.getHttpServer().address() as AddressInfo).port}`;
  gw.webhooks.RAZORPAY = { url: `${api}/v1/billing/webhooks/razorpay`, secret: RZP.webhook };
  admin = await registerUser(ctx, 'Coupon Admin');
  owner = await registerUser(ctx, 'Coupon Owner');
  await ctx.app.get(AdminService).grant(admin.email, 'SUPER_ADMIN');
  await ctx.prisma.platformPaymentGateway.deleteMany({});
  await ctx.http().put('/v1/admin/payments/profile').set(admin.auth).send({ legalName: 'Sampledge Technologies Pvt Ltd', address: 'Pune, Maharashtra', countryCode: 'IN', gstin: '27AAPFU0939F1ZV', email: 'billing@sampledge.test', gstRate: '18', sacCode: '998314', invoicePrefix: 'T2T' }).expect(200);
  await ctx.http().put('/v1/admin/payments/gateways/razorpay').set(admin.auth).send({ enabled: true, mode: 'TEST', currencies: ['INR'], keyId: RZP.keyId, secret: RZP.secret, webhookSecret: RZP.webhook }).expect(200);
});
afterAll(async () => {
  // Promotions apply to every organisation's checkout: none is left on offer for other suites.
  await ctx.prisma.coupon.updateMany({ where: { autoApply: true, isActive: true }, data: { isActive: false } });
  await ctx.prisma.platformPaymentGateway.deleteMany({});
  await ctx.app.close();
  await gw.close();
});

describe('coupons on subscriptions', () => {
  let first: Awaited<ReturnType<typeof createOrg>>;
  let launchId: string;

  it('are created by platform administrators, with terms that are checked', async () => {
    const terms = { code: LAUNCH.toLowerCase(), description: 'Launch offer', kind: 'PERCENT', percentOff: '20', planCodes: ['GROWTH'], cycles: 2, maxRedemptions: 1 };
    await ctx.http().post('/v1/admin/coupons').set(owner.auth).send(terms).expect(403);
    expect((await ctx.http().post('/v1/admin/coupons').set(admin.auth).send({ ...terms, percentOff: '100' }).expect(422)).body.message).toMatch(/complimentary/);
    expect((await ctx.http().post('/v1/admin/coupons').set(admin.auth).send({ ...terms, planCodes: ['NO_SUCH'] }).expect(422)).body.error).toBe('PLAN_NOT_FOUND');
    const c = (await ctx.http().post('/v1/admin/coupons').set(admin.auth).send(terms).expect(201)).body;
    expect(c).toMatchObject({ code: LAUNCH, kind: 'PERCENT', percentOff: '20.00', amountOff: null, planCodes: ['GROWTH'], cycles: 2, maxRedemptions: 1, isActive: true, terms: '20% off the first 2 payments' });
    launchId = c.id;
    expect((await ctx.http().post('/v1/admin/coupons').set(admin.auth).send(terms).expect(409)).body.error).toBe('COUPON_EXISTS');
    await ctx.http().post('/v1/admin/coupons').set(admin.auth).send({ code: FLAT, kind: 'AMOUNT', amountOff: '2000', currency: 'INR' }).expect(201);
    const audit = await ctx.prisma.auditEvent.findFirst({ where: { action: 'platform.coupon_created', entityId: c.id } });
    expect(audit).not.toBeNull();
  });

  it('take money off before GST at checkout, and only where the coupon fits', async () => {
    first = await createOrg(ctx, owner, { name: 'Coupon Using Traders Pvt Ltd' });
    const q = (await ctx.http().get(`${first.base}/subscription/quote?plan=GROWTH&interval=MONTHLY&coupon=${LAUNCH.toLowerCase()}`).set(owner.auth).expect(200)).body;
    // 1,499.00 less 20% = 1,199.20; CGST and SGST at 9% each on that.
    expect(q).toMatchObject({ kind: 'NEW', amount: '1499.00', discount: '299.80', subtotal: '1199.20', lines: [{ code: 'CGST', amount: '107.93' }, { code: 'SGST', amount: '107.93' }], total: '1415.06', coupon: { code: LAUNCH, terms: '20% off the first 2 payments', continuing: false } });
    expect((await ctx.http().get(`${first.base}/subscription/quote?plan=PROFESSIONAL&interval=MONTHLY&coupon=${LAUNCH}`).set(owner.auth).expect(422)).body).toMatchObject({ error: 'COUPON_NOT_VALID', message: 'This coupon is for the GROWTH plan' });
    expect((await ctx.http().get(`${first.base}/subscription/quote?plan=GROWTH&interval=MONTHLY&coupon=NOPE-123`).set(owner.auth).expect(422)).body.error).toBe('COUPON_NOT_FOUND');
    expect((await ctx.http().get(`${first.base}/subscription/quote?plan=STARTER&interval=MONTHLY&coupon=${FLAT}`).set(owner.auth).expect(422)).body).toMatchObject({ error: 'COUPON_TOO_LARGE', message: expect.stringMatching(/nothing to pay/) });
    const plain = (await ctx.http().get(`${first.base}/subscription/quote?plan=GROWTH&interval=MONTHLY`).set(owner.auth).expect(200)).body;
    expect(plain).toMatchObject({ amount: '1499.00', discount: '0.00', subtotal: '1499.00', coupon: null });

    const c = (await ctx.http().post(`${first.base}/subscription/checkout`).set(owner.auth).send({ plan: 'GROWTH', interval: 'MONTHLY', coupon: LAUNCH }).expect(201)).body;
    expect(c.invoice).toMatchObject({ listPrice: '1499.00', discount: '299.80', couponCode: LAUNCH, subtotal: '1199.20', total: '1415.06' });
    const link = [...gw.links.values()].at(-1)!;
    expect(link.amount).toBe(141506);
    await gw.pay(link.id);
    const s = (await ctx.http().get(`${first.base}/subscription`).set(owner.auth).expect(200)).body;
    expect(s).toMatchObject({ status: 'ACTIVE', price: '1499.00', coupon: { code: LAUNCH, paymentsUsed: 1, paymentsLeft: 1 } });
    await expect(ctx.prisma.subscriptionInvoice.update({ where: { id: c.invoice.id }, data: { discount: '0' } })).rejects.toThrow(/cannot be changed/);
  });

  it('are used by no more organisations than allowed, and once by each', async () => {
    const second = await createOrg(ctx, owner, { name: 'Late Coupon Traders Pvt Ltd' });
    expect((await ctx.http().get(`${second.base}/subscription/quote?plan=GROWTH&interval=MONTHLY&coupon=${LAUNCH}`).set(owner.auth).expect(422)).body.message).toBe('This coupon has been used by as many organisations as it allows');
  });

  it('go on taking money off renewals until their payments are used up', async () => {
    const runner = ctx.app.get(RenewalsRunnerService);
    const s0 = await ctx.prisma.subscription.findUniqueOrThrow({ where: { orgId: first.orgId } });
    expect(s0.couponUses).toBe(1);
    // Three days before the paid period ends, the renewal is issued.
    await runner.tick({ orgIds: [first.orgId], now: new Date(s0.currentPeriodEnd!.getTime() - 3 * 86_400_000) });
    const [renewal] = (await ctx.http().get(`${first.base}/subscription/invoices`).set(owner.auth).expect(200)).body;
    expect(renewal).toMatchObject({ kind: 'RENEWAL', status: 'OPEN', listPrice: '1499.00', discount: '299.80', couponCode: LAUNCH, subtotal: '1199.20', total: '1415.06' });
    await ctx.http().post(`/v1/admin/invoices/${renewal.id}/mark-paid`).set(admin.auth).send({ reference: 'NEFT UTR 55101' }).expect(200);
    let s = (await ctx.http().get(`${first.base}/subscription`).set(owner.auth).expect(200)).body;
    expect(s.coupon).toMatchObject({ paymentsUsed: 2, paymentsLeft: 0 });

    // The next renewal is at the full price: both payments the coupon was for are used.
    const sub = await ctx.prisma.subscription.findUniqueOrThrow({ where: { orgId: first.orgId } });
    await runner.tick({ orgIds: [first.orgId], now: new Date(sub.currentPeriodEnd!.getTime() - 3 * 86_400_000) });
    const [next] = (await ctx.http().get(`${first.base}/subscription/invoices`).set(owner.auth).expect(200)).body;
    expect(next).toMatchObject({ kind: 'RENEWAL', status: 'OPEN', discount: '0.00', couponCode: null, subtotal: '1499.00' });
    const q = (await ctx.http().get(`${first.base}/subscription/quote?plan=GROWTH&interval=MONTHLY&coupon=${LAUNCH}`).set(owner.auth).expect(422)).body;
    expect(q.message).toBe('This coupon has taken money off all 2 payments it was for');
    s = (await ctx.http().get(`${first.base}/subscription`).set(owner.auth).expect(200)).body;
    expect(s.coupon.paymentsLeft).toBe(0);
  });

  it('show administrators who used them and what they gave, and can be switched off', async () => {
    const list = (await ctx.http().get('/v1/admin/coupons').set(admin.auth).expect(200)).body;
    const launch = list.find((c: { code: string }) => c.code === LAUNCH);
    expect(launch).toMatchObject({ organisations: [{ name: 'Coupon Using Traders Pvt Ltd', payments: 2, discount: '599.60', stillUsing: true, paymentsLeft: 0 }], discountGiven: [{ currency: 'INR', amount: '599.60' }] });
    await ctx.http().get('/v1/admin/coupons').set(owner.auth).expect(403);
    const flat = list.find((c: { code: string }) => c.code === FLAT);
    expect((await ctx.http().post(`/v1/admin/coupons/${flat.id}/active`).set(admin.auth).send({ active: false }).expect(200)).body.isActive).toBe(false);
    const third = await createOrg(ctx, owner, { name: 'Switched Off Coupon Pvt Ltd' });
    expect((await ctx.http().get(`${third.base}/subscription/quote?plan=PROFESSIONAL&interval=ANNUAL&coupon=${FLAT}`).set(owner.auth).expect(422)).body.message).toBe('This coupon is no longer offered');
    expect(await ctx.prisma.auditEvent.findFirst({ where: { action: 'platform.coupon_switched_off', entityId: flat.id } })).not.toBeNull();
    expect(launchId).toBe(launch.id);
  });
});

describe('promotions (coupons applied without a code)', () => {
  it('are shown beside the plans and the best one is taken off at checkout', async () => {
    await ctx.http().post('/v1/admin/coupons').set(admin.auth).send({ code: PROMO, description: 'Annual sale', kind: 'PERCENT', percentOff: '10', planCodes: ['PROFESSIONAL'], intervals: ['ANNUAL'], cycles: 1, autoApply: true }).expect(201);
    const small = (await ctx.http().post('/v1/admin/coupons').set(admin.auth).send({ code: SMALL, kind: 'AMOUNT', amountOff: '1', currency: 'INR', cycles: 1, autoApply: true }).expect(201)).body;
    expect(small).toMatchObject({ autoApply: true });
    const o = await createOrg(ctx, owner, { name: 'Promotion Buying Pvt Ltd' });
    const s = (await ctx.http().get(`${o.base}/subscription`).set(owner.auth).expect(200)).body;
    expect(s.promotions.map((p: { code: string }) => p.code)).toEqual(expect.arrayContaining([PROMO, SMALL]));

    // 10% off Professional annual beats 1.00 off; Growth monthly only has the 1.00.
    const annual = (await ctx.http().get(`${o.base}/subscription/quote?plan=PROFESSIONAL&interval=ANNUAL`).set(owner.auth).expect(200)).body;
    expect(annual.coupon).toMatchObject({ code: PROMO, promotion: true, terms: '10% off the first payment' });
    expect(annual.discount).toBe((Math.round(Number(annual.amount) * 10) / 100).toFixed(2));
    const monthly = (await ctx.http().get(`${o.base}/subscription/quote?plan=GROWTH&interval=MONTHLY`).set(owner.auth).expect(200)).body;
    expect(monthly).toMatchObject({ amount: '1499.00', discount: '1.00', subtotal: '1498.00', coupon: { code: SMALL, promotion: true } });

    // Paid with the promotion: it is used once, so the next payment is at the full price.
    const c = (await ctx.http().post(`${o.base}/subscription/checkout`).set(owner.auth).send({ plan: 'GROWTH', interval: 'MONTHLY' }).expect(201)).body;
    expect(c.invoice).toMatchObject({ couponCode: SMALL, discount: '1.00' });
    await gw.pay([...gw.links.values()].at(-1)!.id);
    const after = (await ctx.http().get(`${o.base}/subscription/quote?plan=GROWTH&interval=MONTHLY`).set(owner.auth).expect(200)).body;
    expect(after).toMatchObject({ discount: '0.00', coupon: null, couponNote: 'This coupon has taken money off all 1 payment it was for' });

    // Switched off, a promotion is neither shown nor taken off.
    await ctx.http().post(`/v1/admin/coupons/${small.id}/active`).set(admin.auth).send({ active: false }).expect(200);
    const o2 = await createOrg(ctx, owner, { name: 'After The Sale Pvt Ltd' });
    const s2 = (await ctx.http().get(`${o2.base}/subscription`).set(owner.auth).expect(200)).body;
    expect(s2.promotions.map((p: { code: string }) => p.code)).not.toContain(SMALL);
    expect((await ctx.http().get(`${o2.base}/subscription/quote?plan=GROWTH&interval=MONTHLY`).set(owner.auth).expect(200)).body.coupon).toBeNull();
  });
});
