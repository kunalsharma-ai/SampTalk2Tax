import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminService } from '../src/admin/admin.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/** Plans and subscriptions, against the real API and database. */
let ctx: Ctx;
let admin: TestUser;
let owner: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const plain = { 'content-type': 'application/json' };

beforeAll(async () => {
  ctx = await bootApp();
  admin = await registerUser(ctx, 'Billing Admin');
  owner = await registerUser(ctx, 'Billing Owner');
  await ctx.app.get(AdminService).grant(admin.email, 'SUPER_ADMIN');
  org = await createOrg(ctx, owner, { name: 'Plan Traders Pvt Ltd' });
});
afterAll(async () => {
  await ctx.app.close();
});

const sub = async () => (await ctx.http().get(`${org.base}/subscription`).set(owner.auth).expect(200)).body;
/** Moves the subscription's dates, as time passing would. */
const setDates = (data: Record<string, unknown>) => ctx.prisma.subscription.update({ where: { orgId: org.orgId }, data });

describe('a new organisation', () => {
  it('starts a 14-day trial of every module, billed in its country currency', async () => {
    const s = await sub();
    expect(s).toMatchObject({ status: 'TRIALING', currency: 'INR', plan: { code: 'ENTERPRISE' }, access: { level: 'FULL', state: 'TRIAL', daysLeft: 14 }, usage: { members: 1, openInvitations: 0 }, request: null });
    expect(s.plans.map((p: { code: string; price: { monthly: string } }) => [p.code, p.price.monthly])).toEqual([['STARTER', '499.00'], ['GROWTH', '1499.00'], ['PROFESSIONAL', '3499.00'], ['ENTERPRISE', '8999.00']]);
    expect(s.history.map((h: { kind: string }) => h.kind)).toEqual(['TRIAL_STARTED']);
    const uk = await createOrg(ctx, owner, { name: 'Plan UK Ltd', countryCode: 'GB', functionalCurrency: 'GBP', fiscalYearStartMonth: 4 });
    const ukSub = (await ctx.http().get(`${uk.base}/subscription`).set(owner.auth).expect(200)).body;
    expect(ukSub.currency).toBe('USD');
    expect(ukSub.plans[0].price).toEqual({ currency: 'USD', monthly: '9.00', annual: '90.00' });
    const listed = (await ctx.http().get('/v1/orgs').set(owner.auth).expect(200)).body.find((o: { id: string }) => o.id === org.orgId);
    expect(listed.subscription).toMatchObject({ plan: { code: 'ENTERPRISE', features: ['AI', 'PAYROLL', 'MULTI_CURRENCY', 'CONSOLIDATION'] }, status: 'TRIALING', access: { level: 'FULL' } });
  });
});

describe('choosing a plan', () => {
  it('is requested by an owner and activated when payment is received', async () => {
    await ctx.http().post(`${org.base}/subscription/request`).set(owner.auth).send({ plan: 'NOPE', interval: 'MONTHLY' }).expect(422);
    const r = (await ctx.http().post(`${org.base}/subscription/request`).set(owner.auth).send({ plan: 'GROWTH', interval: 'ANNUAL' }).expect(201)).body;
    expect(r.request).toMatchObject({ plan: { code: 'GROWTH', price: { annual: '14990.00' } }, interval: 'ANNUAL' });
    expect(r.status).toBe('TRIALING');
    const waiting = (await ctx.http().get('/v1/admin/subscriptions?filter=requested').set(admin.auth).expect(200)).body;
    expect(waiting.find((w: { orgId: string }) => w.orgId === org.orgId)?.request).toMatchObject({ plan: { code: 'GROWTH' }, interval: 'ANNUAL' });
    await ctx.http().post(`/v1/admin/subscriptions/${org.orgId}/activate`).set(admin.auth).send({ paymentReference: '' }).expect(422);
    await ctx.http().post(`/v1/admin/subscriptions/${org.orgId}/activate`).set(owner.auth).send({ paymentReference: 'NEFT 123' }).expect(403);
    const a = (await ctx.http().post(`/v1/admin/subscriptions/${org.orgId}/activate`).set(admin.auth).send({ paymentReference: 'NEFT UTR 4471' }).expect(201)).body;
    expect(a).toMatchObject({ status: 'ACTIVE', plan: { code: 'GROWTH' }, billingInterval: 'ANNUAL', price: '14990.00', paymentReference: 'NEFT UTR 4471', request: null, access: { level: 'FULL', state: 'ACTIVE' } });
    const days = Math.round((new Date(a.currentPeriodEnd).getTime() - Date.now()) / 86_400_000);
    expect(days).toBeGreaterThanOrEqual(364);
    const s = await sub();
    expect(s.history.map((h: { kind: string }) => h.kind)).toEqual(['ACTIVATED', 'PLAN_REQUESTED', 'TRIAL_STARTED']);
  });

  it('enforces the plan: modules it does not include cannot be used, but past records stay readable', async () => {
    // Growth has AI but not payroll, foreign currencies or consolidation.
    const fx = await ctx.http().put(`${org.base}/fx/rates`).set(owner.auth).send({ currency: 'USD', date: '2026-11-01', rate: '84' }).expect(403);
    expect(fx.body).toMatchObject({ error: 'FEATURE_NOT_IN_PLAN', feature: 'MULTI_CURRENCY' });
    expect(fx.body.message).toMatch(/Growth plan does not include this module/);
    await ctx.http().get(`${org.base}/fx/rates`).set(owner.auth).expect(200);
    await ctx.http().post(`${org.base}/consolidation/groups`).set(owner.auth).send({ name: 'Group' }).expect(403);
    await ctx.http().get(`${org.base}/payroll/settings`).set(owner.auth).expect(200);
  });

  it('limits members, counting open invitations', async () => {
    // Growth allows 5 members.
    for (let i = 0; i < 4; i++) {
      const u = await registerUser(ctx, `Plan Member ${i}`);
      await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role: 'VIEWER' }).expect(201);
    }
    const sixth = await registerUser(ctx, 'One Too Many');
    const refused = await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: sixth.email, role: 'VIEWER' }).expect(409);
    expect(refused.body).toMatchObject({ error: 'PLAN_LIMIT' });
    expect(refused.body.message).toMatch(/Growth plan allows 5 members/);
    await ctx.http().post(`${org.base}/invitations`).set(owner.auth).send({ email: 'later@example.test', role: 'VIEWER' }).expect(409);
    // A smaller plan cannot be asked for while the organisation has more members than it allows.
    const down = await ctx.http().post(`${org.base}/subscription/request`).set(owner.auth).send({ plan: 'STARTER', interval: 'MONTHLY' }).expect(409);
    expect(down.body.message).toMatch(/Starter allows 2 members and the organisation has 5/);
  });
});

describe('when a trial or plan runs out', () => {
  it('keeps the books readable, refuses changes, and still lets the owner choose a plan', async () => {
    const other = await createOrg(ctx, owner, { name: 'Trial Ends Pvt Ltd' });
    await ctx.prisma.subscription.update({ where: { orgId: other.orgId }, data: { trialEndsAt: new Date(Date.now() - 1000) } });
    const s = (await ctx.http().get(`${other.base}/subscription`).set(owner.auth).expect(200)).body;
    expect(s.access).toMatchObject({ level: 'READ_ONLY', state: 'TRIAL_ENDED' });
    await ctx.http().get(`${other.base}/accounts`).set(owner.auth).expect(200);
    const refused = await ctx.http().post(`${other.base}/accounts`).set(owner.auth).send({ code: '9996', name: 'Blocked', type: 'EXPENSE' }).expect(402);
    expect(refused.body).toMatchObject({ error: 'PLAN_REQUIRED', state: 'TRIAL_ENDED' });
    await ctx.http().post(`${other.base}/subscription/request`).set(owner.auth).send({ plan: 'STARTER', interval: 'MONTHLY' }).expect(201);
    await ctx.http().delete(`${other.base}/subscription/request`).set(owner.auth).expect(200);

    // An administrator can extend the trial.
    const ext = (await ctx.http().post(`/v1/admin/subscriptions/${other.orgId}/extend-trial`).set(admin.auth).send({ days: 7 }).expect(201)).body;
    expect(ext.access).toMatchObject({ level: 'FULL', state: 'TRIAL', daysLeft: 7 });
    await ctx.http().post(`${other.base}/accounts`).set(owner.auth).send({ code: '9996', name: 'Allowed', type: 'EXPENSE' }).expect(201);
  });

  it('gives a paid plan a grace week, and a cancelled one runs to its period end', async () => {
    const day = 86_400_000;
    await setDates({ currentPeriodStart: new Date(Date.now() - 370 * day), currentPeriodEnd: new Date(Date.now() - 3 * day) });
    expect((await sub()).access).toMatchObject({ level: 'FULL', state: 'GRACE', daysLeft: 4 });
    await setDates({ currentPeriodEnd: new Date(Date.now() - 8 * day) });
    expect((await sub()).access).toMatchObject({ level: 'READ_ONLY', state: 'LAPSED' });
    await setDates({ currentPeriodEnd: new Date(Date.now() + 10 * day) });
    await ctx.http().post(`/v1/admin/subscriptions/${org.orgId}/cancel`).set(admin.auth).send({ reason: 'Customer asked' }).expect(201);
    expect((await sub()).access).toMatchObject({ level: 'FULL', state: 'CANCELLING', daysLeft: 10 });
    await ctx.http().post(`/v1/admin/subscriptions/${org.orgId}/cancel`).set(admin.auth).send({ reason: 'Again' }).expect(409);
    const c = (await ctx.http().post(`/v1/admin/subscriptions/${org.orgId}/complimentary`).set(admin.auth).send({ reason: 'Partner firm' }).expect(201)).body;
    expect(c.access).toMatchObject({ level: 'FULL', state: 'COMPLIMENTARY' });
  });

  it('keeps the subscription history unchangeable', async () => {
    const e = await ctx.prisma.subscriptionEvent.findFirstOrThrow({ where: { orgId: org.orgId } });
    await expect(ctx.prisma.subscriptionEvent.delete({ where: { id: e.id } })).rejects.toThrow(/cannot be changed or deleted/);
  });
});

describe('plans in platform administration', () => {
  it('are edited by super admins and checked', async () => {
    const plans = (await ctx.http().get('/v1/admin/plans').set(admin.auth).expect(200)).body;
    expect(plans.map((p: { code: string }) => p.code).slice(0, 4)).toEqual(['STARTER', 'GROWTH', 'PROFESSIONAL', 'ENTERPRISE']);
    const growth = plans.find((p: { code: string }) => p.code === 'GROWTH');
    const bad = await ctx.http().put('/v1/admin/plans/GROWTH').set(admin.auth).set(plain).send({ ...pick(growth), prices: { ...growth.prices, INR: { monthly: '-1', annual: '14990' } } }).expect(422);
    expect(bad.body.issues ?? bad.body.details?.issues).toContain('INR monthly price must be more than zero, with at most 2 decimals');
    const code = `TEST_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    const created = (await ctx.http().put(`/v1/admin/plans/${code}`).set(admin.auth).send({ ...pick(growth), name: 'Test plan', isActive: false, sortOrder: 99 }).expect(200)).body;
    expect(created).toMatchObject({ code, name: 'Test plan', isActive: false });
    // An inactive plan is not offered to organisations.
    expect((await sub()).plans.map((p: { code: string }) => p.code)).not.toContain(code);
    await ctx.http().post(`${org.base}/subscription/request`).set(owner.auth).send({ plan: code, interval: 'MONTHLY' }).expect(422);
  });
});

function pick(p: Record<string, unknown>) {
  return { name: p.name, description: p.description, prices: p.prices, limits: p.limits, features: p.features, isActive: p.isActive, sortOrder: p.sortOrder };
}
