import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminService } from '../src/admin/admin.service';
import { RenewalsRunnerService } from '../src/billing/payments/renewals-runner.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Enterprise contracts (SUBS-023): recorded by a platform administrator with their own price,
 * term and limits; the organisation cannot change plan while one runs; renewals are invoiced at
 * the contract price, and at the plan's list price once the term is over.
 */
let ctx: Ctx;
let admin: TestUser;
let owner: TestUser;
const tag = randomUUID().slice(0, 6).toUpperCase();
const DAY = 86_400_000;
const istDay = (offsetDays: number) => new Date(Date.now() + 330 * 60_000 + offsetDays * DAY).toISOString().slice(0, 10);

beforeAll(async () => {
  ctx = await bootApp({ BILLING_RUNNER_INTERVAL_SECONDS: '0' });
  admin = await registerUser(ctx, 'Contracts Admin');
  owner = await registerUser(ctx, 'Contracts Owner');
  await ctx.app.get(AdminService).grant(admin.email, 'SUPER_ADMIN');
  await ctx.http().put('/v1/admin/payments/profile').set(admin.auth).send({ legalName: 'Sampledge Technologies Pvt Ltd', address: 'Pune, Maharashtra', countryCode: 'IN', gstin: '27AAPFU0939F1ZV', email: 'billing@sampledge.test', gstRate: '18', sacCode: '998314', invoicePrefix: 'T2T' }).expect(200);
});
afterAll(async () => {
  await ctx.app.close();
});

describe('enterprise contracts', () => {
  let org: Awaited<ReturnType<typeof createOrg>>;
  let contractId: string;
  const terms = () => ({ reference: `ENT/${tag}/1`, plan: 'ENTERPRISE', interval: 'ANNUAL', price: '250000', startsOn: istDay(0), endsOn: istDay(730), limits: { members: 200, aiCreditsPerMonth: 20000 }, notes: 'Two-year agreement, 200 users', activate: true });

  it('are recorded by platform administrators with their own price, term and limits', async () => {
    org = await createOrg(ctx, owner, { name: 'Contract Holdings Ltd' });
    const url = `/v1/admin/subscriptions/${org.orgId}/contract`;
    await ctx.http().post(url).set(owner.auth).send(terms()).expect(403);
    expect((await ctx.http().post(url).set(admin.auth).send({ ...terms(), price: '0', endsOn: istDay(-1) }).expect(422)).body.message).toBe('The price must be more than zero, with at most 2 decimals; The term ends after it starts');
    expect((await ctx.http().post(url).set(admin.auth).send({ ...terms(), activate: false }).expect(409)).body.error).toBe('CONTRACT_NEEDS_ACTIVATION');
    expect((await ctx.http().post(url).set(admin.auth).send({ ...terms(), startsOn: istDay(10) }).expect(409)).body.error).toBe('CONTRACT_NOT_STARTED');

    const c = (await ctx.http().post(url).set(admin.auth).send(terms()).expect(201)).body;
    expect(c).toMatchObject({ reference: `ENT/${tag}/1`, plan: { code: 'ENTERPRISE' }, interval: 'ANNUAL', currency: 'INR', price: '250000.00', startsOn: istDay(0), lastDay: istDay(729), limits: { members: 200, aiCreditsPerMonth: 20000 }, status: 'ACTIVE', organisation: 'Contract Holdings Ltd' });
    contractId = c.id;
    const s = (await ctx.http().get(`${org.base}/subscription`).set(owner.auth).expect(200)).body;
    expect(s).toMatchObject({ status: 'ACTIVE', plan: { code: 'ENTERPRISE' }, billingInterval: 'ANNUAL', price: '250000.00', contract: { reference: `ENT/${tag}/1`, lastDay: istDay(729) } });
    // The contract's limits are the ones enforced.
    expect((await ctx.http().get(`${org.base}/usage`).set(owner.auth).expect(200)).body.ai.limit).toBe(20000);
    expect(await ctx.prisma.auditEvent.findFirst({ where: { action: 'platform.contract_recorded', entityId: c.id } })).not.toBeNull();
    // One contract at a time, and its terms never change.
    expect((await ctx.http().post(url).set(admin.auth).send({ ...terms(), reference: `ENT/${tag}/2` }).expect(409)).body.error).toBe('CONTRACT_IN_FORCE');
    await expect(ctx.prisma.enterpriseContract.update({ where: { id: c.id }, data: { price: '1' } })).rejects.toThrow('do not change');
  });

  it('keep the organisation from changing plan itself', async () => {
    const q = (await ctx.http().get(`${org.base}/subscription/quote?plan=GROWTH&interval=MONTHLY`).set(owner.auth).expect(409)).body;
    expect(q).toMatchObject({ error: 'CONTRACT_IN_FORCE', message: `Your plan is set by enterprise contract ENT/${tag}/1 until ${istDay(729)}. Talk2Tax changes it with you; write to your account manager.` });
    await ctx.http().post(`${org.base}/subscription/request`).set(owner.auth).send({ plan: 'GROWTH', interval: 'MONTHLY' }).expect(409);
  });

  it('renew at the contract price while the term runs', async () => {
    const end = new Date(Date.now() + 3 * DAY);
    await ctx.prisma.subscription.update({ where: { orgId: org.orgId }, data: { currentPeriodStart: new Date(Date.now() - 362 * DAY), currentPeriodEnd: end } });
    await ctx.app.get(RenewalsRunnerService).tick({ orgIds: [org.orgId], now: new Date() });
    const [renewal] = (await ctx.http().get(`${org.base}/subscription/invoices`).set(owner.auth).expect(200)).body;
    expect(renewal).toMatchObject({ kind: 'RENEWAL', status: 'OPEN', plan: { code: 'ENTERPRISE' }, billingInterval: 'ANNUAL', listPrice: '250000.00', subtotal: '250000.00', total: '295000.00', addOns: [] });
    await ctx.http().post(`/v1/admin/invoices/${renewal.id}/void`).set(admin.auth).send({ reason: 'Paid under the contract schedule' }).expect(200);
  });

  it('end early, after which the organisation chooses its plan again', async () => {
    await ctx.http().post(`/v1/admin/contracts/${contractId}/end`).set(admin.auth).send({ reason: 'x' }).expect(422);
    const ended = (await ctx.http().post(`/v1/admin/contracts/${contractId}/end`).set(admin.auth).send({ reason: 'Moved to a standard plan' }).expect(200)).body;
    expect(ended).toMatchObject({ status: 'ENDED', endReason: 'Moved to a standard plan' });
    await ctx.http().post(`/v1/admin/contracts/${contractId}/end`).set(admin.auth).send({ reason: 'Again' }).expect(409);
    const s = (await ctx.http().get(`${org.base}/subscription`).set(owner.auth).expect(200)).body;
    expect(s).toMatchObject({ contract: null, plan: { code: 'ENTERPRISE' }, price: '250000.00' });
    expect((await ctx.http().get(`${org.base}/usage`).set(owner.auth).expect(200)).body.ai.limit).toBe(5000);
    await ctx.http().get(`${org.base}/subscription/quote?plan=PROFESSIONAL&interval=ANNUAL`).set(owner.auth).expect(200);
  });

  it('end with their term, and the next renewal is at the list price', async () => {
    const other = await createOrg(ctx, owner, { name: 'Short Term Ltd' });
    await ctx.http().post(`/v1/admin/subscriptions/${other.orgId}/contract`).set(admin.auth).send({ ...terms(), reference: `ENT/${tag}/S`, interval: 'MONTHLY', price: '20000', startsOn: istDay(-20), endsOn: istDay(5), limits: {} }).expect(201);
    // The month paid for runs past the term, so the next period is outside it.
    const s = await ctx.prisma.subscription.findUniqueOrThrow({ where: { orgId: other.orgId } });
    await ctx.app.get(RenewalsRunnerService).tick({ orgIds: [other.orgId], now: new Date(s.currentPeriodEnd!.getTime() - 3 * DAY) });
    const [renewal] = (await ctx.http().get(`${other.base}/subscription/invoices`).set(owner.auth).expect(200)).body;
    expect(renewal).toMatchObject({ kind: 'RENEWAL', plan: { code: 'ENTERPRISE' }, billingInterval: 'MONTHLY', listPrice: '8999.00' });
    const list = (await ctx.http().get('/v1/admin/contracts').set(admin.auth).expect(200)).body;
    expect(list.find((c: { reference: string }) => c.reference === `ENT/${tag}/S`)).toMatchObject({ status: 'ENDED', endReason: 'The term ended' });
    expect((await ctx.http().get(`${other.base}/subscription`).set(owner.auth).expect(200)).body.contract).toBeNull();
  });
});
