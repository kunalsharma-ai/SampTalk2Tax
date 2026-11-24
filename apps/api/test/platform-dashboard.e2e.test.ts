import { D } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminService } from '../src/admin/admin.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * DASH-042, the global super admin's dashboard, against the real API and database: growth,
 * subscriptions and their run-rate, usage, support, operations and what to look at first. The
 * test database is shared with earlier suites, so figures are checked as changes from a first read.
 */
let ctx: Ctx;
let admin: TestUser;
let support: TestUser;
let owner: TestUser;
type Dash = {
  organisations: { total: number; countries: { countryCode: string; organisations: number }[] };
  people: { total: number };
  growth: { month: string; organisations: number; people: number }[];
  subscriptions: {
    paying: number;
    runRate: { currency: string; monthly: string; annual: string; subscriptions: number }[];
    requests: { orgId: string; plan: string; interval: string }[];
    byState: { state: string; organisations: number }[];
  };
  support: { open: number; pending: number; overdue: number; queue: { subject: string; organisation: string; reference: string }[] };
  operations: { errorGroupsOpen: number; securityAlertsOpen: number; backups: { problems: string[] } };
  attention: { title: string; level: string; href: string }[];
};
const dash = async (auth = admin.auth): Promise<Dash> => (await ctx.http().get('/v1/admin/dashboard').set(auth).expect(200)).body;
const inr = (d: Dash) => new D(d.subscriptions.runRate.find((r) => r.currency === 'INR')?.monthly ?? '0');

beforeAll(async () => {
  ctx = await bootApp();
  admin = await registerUser(ctx, 'Dashboard Super Admin');
  support = await registerUser(ctx, 'Dashboard Support');
  owner = await registerUser(ctx, 'Dashboard Tenant Owner');
  await ctx.db.collection('users').updateMany({ platformRole: { $ne: null } }, { $set: { platformRole: null } });
  const svc = ctx.app.get(AdminService);
  await svc.grant(admin.email, 'SUPER_ADMIN');
  await svc.grant(support.email, 'SUPPORT');
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('global super admin dashboard', () => {
  it('is for platform staff only', async () => {
    await ctx.http().get('/v1/admin/dashboard').expect(401);
    await ctx.http().get('/v1/admin/dashboard').set(owner.auth).expect(403);
    const d = await dash(support.auth);
    expect(Object.keys(d).sort()).toEqual(['administrators', 'asOf', 'attention', 'growth', 'operations', 'organisations', 'people', 'subscriptions', 'support', 'usage']);
  });

  it('follows new organisations, a plan request, its activation and a support ticket', async () => {
    const before = await dash();
    expect(before.growth).toHaveLength(6);
    const paid = await createOrg(ctx, owner, { name: 'Dashboard Paying Traders' });
    const other = await createOrg(ctx, owner, { name: 'Dashboard Helpdesk Traders' });

    await ctx.http().post(`${paid.base}/subscription/request`).set(owner.auth).send({ plan: 'GROWTH', interval: 'ANNUAL' }).expect(201);
    const asked = await dash();
    expect(asked.organisations.total).toBe(before.organisations.total + 2);
    expect(asked.growth.at(-1)!.organisations).toBe(before.growth.at(-1)!.organisations + 2);
    expect(asked.organisations.countries.find((c) => c.countryCode === 'IN')!.organisations).toBe(before.organisations.countries.find((c) => c.countryCode === 'IN')!.organisations + 2);
    expect(asked.subscriptions.requests.find((r) => r.orgId === paid.orgId)).toMatchObject({ plan: 'Growth', interval: 'ANNUAL' });
    expect(asked.attention.find((a) => a.title === 'Plan requests waiting')).toMatchObject({ level: 'MEDIUM', href: '/admin/subscriptions' });

    await ctx.http().post(`/v1/admin/subscriptions/${paid.orgId}/activate`).set(admin.auth).send({ paymentReference: 'NEFT UTR 9910' }).expect(201);
    await ctx
      .http()
      .post(`${other.base}/support/tickets`)
      .set(owner.auth)
      .send({ subject: 'Dashboard ticket about GST', category: 'TAX', priority: 'HIGH', body: 'A synthetic question.' })
      .expect(201);
    const after = await dash();
    expect(after.subscriptions.paying).toBe(before.subscriptions.paying + 1);
    // 14,990 a year counts as 1,249.17 a month; sums are rounded once, so allow a paisa either way.
    const added = inr(after).minus(inr(before));
    expect(added.minus('1249.17').abs().lessThanOrEqualTo('0.01')).toBe(true);
    expect(after.subscriptions.requests.find((r) => r.orgId === paid.orgId)).toBeUndefined();
    expect(after.support.open).toBe(before.support.open + 1);
    // Earlier suites leave tickets behind, so the five most urgent may be older ones.
    expect(after.support.queue.length).toBeLessThanOrEqual(5);
    expect(after.support.queue.every((t) => /^T-\d+$/.test(t.reference))).toBe(true);
    expect(after.attention.some((a) => a.href === '/admin/support')).toBe(true);
  });

  it('carries no organisation books', async () => {
    const text = JSON.stringify(await dash());
    expect(text).not.toMatch(/"(accountId|journal|balance|debit|credit)"/);
  });
});
