import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPaymentsStandIn, type PaymentsStandIn } from '../../../test-support/payments-stand-in.mjs';
import { AdminService } from '../src/admin/admin.service';
import type { CopilotModel, CopilotResponse } from '../src/copilot/copilot.model';
import { CopilotService } from '../src/copilot/copilot.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Extra AI requests (SUBS-018): packs offered in Platform administration, bought and paid for
 * through the Razorpay stand-in, and used once the plan's monthly requests run out. The AI model
 * is a local stand-in that always answers.
 */
class AnsweringModel implements CopilotModel {
  readonly provider = 'Test stand-in';
  calls = 0;
  async send(): Promise<CopilotResponse> {
    this.calls += 1;
    return { id: `msg_${this.calls}`, type: 'message', role: 'assistant', model: 'stand-in', content: [{ type: 'text', text: 'Cash is 0.00.', citations: null }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } } as unknown as CopilotResponse;
  }
}

const model = new AnsweringModel();
let ctx: Ctx;
let gw: PaymentsStandIn;
let admin: TestUser;
let owner: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let planId: string;
const RZP = { keyId: 'rzp_test_standin12', secret: 'standin-razorpay-secret', webhook: 'standin-webhook-secret' };

const ask = async (q: string) => {
  const r = await ctx.http().post(`${org.base}/copilot/conversations`).set(owner.auth).send({ question: q });
  await Promise.all([...ctx.app.get(CopilotService).inflight.values()]);
  return r;
};
const usage = async () => (await ctx.http().get(`${org.base}/usage`).set(owner.auth).expect(200)).body;

beforeAll(async () => {
  gw = await startPaymentsStandIn(0);
  ctx = await bootApp({ PAYMENTS_STRIPE_API_URL: gw.url, PAYMENTS_RAZORPAY_API_URL: gw.url, BILLING_RUNNER_INTERVAL_SECONDS: '0' }, { copilotModel: model });
  await ctx.app.listen(0, '127.0.0.1');
  const api = `http://127.0.0.1:${(ctx.app.getHttpServer().address() as AddressInfo).port}`;
  gw.webhooks.RAZORPAY = { url: `${api}/v1/billing/webhooks/razorpay`, secret: RZP.webhook };
  admin = await registerUser(ctx, 'Credits Admin');
  owner = await registerUser(ctx, 'Credits Owner');
  await ctx.app.get(AdminService).grant(admin.email, 'SUPER_ADMIN');
  await ctx.prisma.platformPaymentGateway.deleteMany({});
  // Packs are platform-wide and kept between runs (they cannot be deleted): start with none on offer.
  await ctx.prisma.aiCreditPack.updateMany({ where: { isActive: true }, data: { isActive: false } });
  await ctx.http().put('/v1/admin/payments/profile').set(admin.auth).send({ legalName: 'Sampledge Technologies Pvt Ltd', address: 'Pune, Maharashtra', countryCode: 'IN', gstin: '27AAPFU0939F1ZV', email: 'billing@sampledge.test', gstRate: '18', sacCode: '998314', invoicePrefix: 'T2T' }).expect(200);
  await ctx.http().put('/v1/admin/payments/gateways/razorpay').set(admin.auth).send({ enabled: true, mode: 'TEST', currencies: ['INR'], keyId: RZP.keyId, secret: RZP.secret, webhookSecret: RZP.webhook }).expect(200);
  org = await createOrg(ctx, owner, { name: 'Credit Buying Pvt Ltd' });
  // A plan with two AI requests a month, so it runs out in a few questions. Its invoices keep it,
  // so it stays (not offered, listed after the standard plans).
  planId = randomUUID();
  await ctx.prisma.plan.create({ data: { id: planId, code: `TWO_${planId.slice(0, 6).toUpperCase()}`, name: 'Two', prices: { INR: { monthly: '1', annual: '10' }, USD: { monthly: '1', annual: '10' } }, limits: { members: null, aiCreditsPerMonth: 2, documentUploadsPerMonth: null }, features: ['AI'], isActive: false, sortOrder: 900 } });
  await ctx.prisma.subscription.update({ where: { orgId: org.orgId }, data: { planId } });
  await ctx.http().put(`${org.base}/copilot/settings`).set(owner.auth).send({ enabled: true }).expect(200);
});
afterAll(async () => {
  await ctx.prisma.aiCreditPack.updateMany({ where: { isActive: true }, data: { isActive: false } });
  await ctx.prisma.platformPaymentGateway.deleteMany({});
  const growth = await ctx.prisma.plan.findUnique({ where: { code: 'GROWTH' } });
  if (growth && planId) {
    await ctx.prisma.subscription.updateMany({ where: { planId }, data: { planId: growth.id } });
  }
  await ctx.app.close();
  await gw.close();
});

describe('extra AI requests', () => {
  let small: string;
  let large: string;

  it('are offered in packs by platform administrators', async () => {
    await ctx.http().post('/v1/admin/ai-credit-packs').set(owner.auth).send({ name: 'Ten', requests: 10, prices: { INR: '99', USD: '2' } }).expect(403);
    expect((await ctx.http().post('/v1/admin/ai-credit-packs').set(admin.auth).send({ name: 'Five', requests: 5, prices: { INR: '99' } }).expect(422)).body.message).toBe('A pack holds a whole number of requests, from 10 to 1,000,000; A USD price is needed');
    await ctx.http().post('/v1/admin/ai-credit-packs').set(admin.auth).send({ name: '10 requests', requests: 10, prices: { INR: '99', USD: '2' } }).expect(201);
    const list = (await ctx.http().post('/v1/admin/ai-credit-packs').set(admin.auth).send({ name: '50 requests', requests: 50, prices: { INR: '399', USD: '6.5' } }).expect(201)).body;
    const mine = list.filter((p: { isActive: boolean }) => p.isActive);
    expect(mine).toMatchObject([
      { name: '10 requests', requests: 10, prices: { INR: '99.00', USD: '2.00' }, isActive: true, sold: 0 },
      { name: '50 requests', requests: 50, prices: { INR: '399.00', USD: '6.50' }, isActive: true, sold: 0 },
    ]);
    [small, large] = mine.map((p: { id: string }) => p.id);
    // Withdrawn, the larger pack is no longer offered.
    await ctx.http().post(`/v1/admin/ai-credit-packs/${large}/active`).set(admin.auth).send({ active: false }).expect(200);
    expect(await ctx.prisma.auditEvent.findFirst({ where: { action: 'platform.ai_credit_pack_created', entityId: small } })).not.toBeNull();
    // What a pack holds and costs does not change once offered.
    await expect(ctx.prisma.aiCreditPack.update({ where: { id: small }, data: { requests: 20 } })).rejects.toThrow('keeps its requests and prices');
  });

  it('are bought once the plan runs out, without touching an unpaid plan invoice', async () => {
    await ask('What is our cash?');
    await ask('And now?');
    const before = model.calls;
    const r = await ask('Third?');
    expect(model.calls).toBe(before);
    if (r.status === 429) expect(r.body.message).toContain('buy more AI requests under Governance → Usage');
    let u = await usage();
    expect(u.ai).toMatchObject({ used: 2, limit: 2, state: 'REACHED', extra: 0 });
    expect(u.credits).toMatchObject({ balance: 0, bought: [], packs: [{ id: small, name: '10 requests', requests: 10, price: '99.00', currency: 'INR', perRequest: '9.90' }] });

    expect((await ctx.http().get(`${org.base}/subscription/credits/quote?pack=${large}`).set(owner.auth).expect(422)).body.error).toBe('CREDIT_PACK_NOT_FOUND');
    const q = (await ctx.http().get(`${org.base}/subscription/credits/quote?pack=${small}`).set(owner.auth).expect(200)).body;
    expect(q).toMatchObject({ pack: { name: '10 requests', requests: 10 }, subtotal: '99.00', total: '116.82', payOnline: true });

    // An unpaid invoice for a plan stays as it is when requests are bought, and the other way round.
    const plan = (await ctx.http().post(`${org.base}/subscription/checkout`).set(owner.auth).send({ plan: 'GROWTH', interval: 'MONTHLY' }).expect(201)).body.invoice;
    const cr = await ctx.http().post(`${org.base}/subscription/credits/checkout`).set(owner.auth).send({ pack: small });
    expect(cr.status, JSON.stringify(cr.body)).toBe(201);
    const c = cr.body;
    expect(c.invoice).toMatchObject({ kind: 'CREDITS', status: 'OPEN', creditPack: { id: small, name: '10 requests', requests: 10 }, subtotal: '99.00', total: '116.82', addOns: [] });
    expect(c.url).toBeTruthy();
    const invoices = (await ctx.http().get(`${org.base}/subscription/invoices`).set(owner.auth).expect(200)).body;
    expect(invoices.find((i: { id: string }) => i.id === plan.id).status).toBe('OPEN');
    await gw.pay([...gw.links.values()].at(-1)!.id);

    const paid = (await ctx.http().get(`${org.base}/subscription/invoices/${c.invoice.id}`).set(owner.auth).expect(200)).body;
    expect(paid.status).toBe('PAID');
    expect(paid.number).toMatch(/^T2T\//);
    u = await usage();
    expect(u.credits).toMatchObject({ balance: 10, bought: [{ name: '10 requests', requests: 10, used: 0, left: 10, invoiceId: c.invoice.id, expired: false }] });
    // Valid for a year from the payment.
    const days = (Date.parse(u.credits.bought[0].expiresAt) - Date.parse(u.credits.bought[0].grantedAt)) / 86_400_000;
    expect(days).toBe(365);
    // The subscription itself is unchanged: still the same plan, still in its trial.
    expect((await ctx.http().get(`${org.base}/subscription`).set(owner.auth).expect(200)).body).toMatchObject({ status: 'TRIALING', plan: { name: 'Two' } });
    // The plan invoice is still waiting to be paid.
    expect((await ctx.http().get(`${org.base}/subscription/invoices/${plan.id}`).set(owner.auth).expect(200)).body.status).toBe('OPEN');
  });

  it('are used after the plan, one per answered request, and shown as extra', async () => {
    const before = model.calls;
    expect((await ask('Now with bought requests?')).status).toBe(201);
    await ask('Once more?');
    expect(model.calls).toBe(before + 2);
    const u = await usage();
    expect(u.ai).toMatchObject({ used: 2, limit: 2, extra: 2 });
    expect(u.credits).toMatchObject({ balance: 8, bought: [{ used: 2, left: 8 }] });
    expect(u.history[0].ai).toBe(4);
    const packs = (await ctx.http().get('/v1/admin/ai-credit-packs').set(admin.auth).expect(200)).body;
    expect(packs.find((p: { id: string }) => p.id === small).sold).toBe(1);
    // A grant is kept as recorded.
    await expect(ctx.prisma.aiCreditGrant.updateMany({ where: { orgId: org.orgId }, data: { requests: 1000 } })).rejects.toThrow('kept as granted');
  });

  it('are refused for a plan without a limit on AI requests', async () => {
    const unlimited = randomUUID();
    await ctx.prisma.plan.create({ data: { id: unlimited, code: `UNL_${unlimited.slice(0, 6).toUpperCase()}`, name: 'Unlimited', prices: { INR: { monthly: '1', annual: '10' }, USD: { monthly: '1', annual: '10' } }, limits: { members: null, aiCreditsPerMonth: null, documentUploadsPerMonth: null }, features: ['AI'], isActive: false, sortOrder: 901 } });
    await ctx.prisma.subscription.update({ where: { orgId: org.orgId }, data: { planId: unlimited } });
    expect((await ctx.http().get(`${org.base}/subscription/credits/quote?pack=${small}`).set(owner.auth).expect(409)).body.message).toBe('The Unlimited plan has no limit on AI requests');
    await ctx.prisma.subscription.update({ where: { orgId: org.orgId }, data: { planId } });
    await ctx.prisma.plan.delete({ where: { id: unlimited } });
  });
});
