import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * The financial digital twin against the real API and database: the baseline read from posted
 * journals, simulations without saving, saved scenarios with validation in words, comparison,
 * permissions and tenant isolation, and proof that nothing is ever posted to the books.
 */
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let accountant: TestUser;
type Org = Awaited<ReturnType<typeof createOrg>>;
let org: Org;
let other: Org;
let T: string;
let lastMonth: string;
let hireId: string;
let downturnId: string;

const shift = (ym: string, n: number) => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const t = y * 12 + m - 1 + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const journal = (debit: string, credit: string, amount: string, memo: string) =>
  ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: `${lastMonth}-15`, post: true, memo, lines: [{ accountId: org.acc[debit], debit: amount }, { accountId: org.acc[credit], credit: amount }] }).expect(201);
const hire = { kind: 'HIRING', count: 2, monthlyCostPerHead: '50000', oneOffCostPerHead: '10000', fromMonth: 2 };

beforeAll(async () => {
  ctx = await bootApp();
  T = today();
  lastMonth = shift(T.slice(0, 7), -1);
  owner = await registerUser(ctx, 'Twin Owner');
  viewer = await registerUser(ctx, 'Twin Viewer');
  accountant = await registerUser(ctx, 'Twin Accountant');
  org = await createOrg(ctx, owner, { name: 'Twin Co' });
  other = await createOrg(ctx, viewer, { name: 'Other Co' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: accountant.email, role: 'ACCOUNTANT' }).expect(201);
  await journal('1120', '3100', '1000000.00', 'Capital');
  await journal('1120', '4100', '300000.00', 'Sales');
  await journal('5000', '1120', '120000.00', 'Stock sold');
  await journal('6100', '1120', '90000.00', 'Salaries');
  await journal('6200', '1120', '30000.00', 'Rent');
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('digital twin', () => {
  it('builds the baseline from the posted books', async () => {
    const r = (await ctx.http().get(`${org.base}/twin/baseline?baselineMonths=3&horizonMonths=6`).set(viewer.auth).expect(200)).body;
    expect(r.actualMonths.map((m: { month: string }) => m.month)).toEqual([shift(lastMonth, -2), shift(lastMonth, -1), lastMonth]);
    expect(r.actualMonths[2]).toMatchObject({ revenue: '300000', costOfSales: '120000', payroll: '90000', otherOperating: '30000', cash: '1060000' });
    // Averaged over three months.
    expect(r.baseline).toMatchObject({ monthsUsed: 3, revenue: '100000.00', costOfSales: '40000.00', payroll: '30000.00', otherOperating: '10000.00', cash: '1060000.00', taxRateSource: 'NONE' });
    expect(r.projection.months).toHaveLength(6);
    expect(r.projection.months[0]).toMatchObject({ month: shift(lastMonth, 1), netProfit: '20000.00', closingCash: '1080000.00' });
    expect(r.missing.map((m: { field: string }) => m.field)).toContain('TAX_RATE');
  });

  it('tries changes without saving them', async () => {
    const r = (await ctx.http().post(`${org.base}/twin/simulate`).set(viewer.auth).send({ baselineMonths: 3, horizonMonths: 6, drivers: [hire, { kind: 'TAX_RATE', percent: '25' }] }).expect(200)).body;
    expect(r.projection.months[0]).toMatchObject({ payroll: '30000.00', tax: '5000.00', netProfit: '15000.00' });
    expect(r.projection.months[1]).toMatchObject({ payroll: '130000.00', headcountAdded: 2, netProfit: '-100000.00', tax: '0.00' });
    expect(r.assumptions.some((a: string) => a.startsWith('2 people join in'))).toBe(true);
    const bad = (await ctx.http().post(`${org.base}/twin/simulate`).set(viewer.auth).send({ baselineMonths: 3, horizonMonths: 6, drivers: [{ ...hire, count: 0, fromMonth: 9 }] }).expect(422)).body;
    expect(bad.details.issues).toEqual(['Change 1: People hired must be a whole number from 1 to 10000', 'Change 1: Starting month must be a whole number from 1 to 6']);
    await ctx.http().post(`${org.base}/twin/simulate`).set(viewer.auth).send({ baselineMonths: 4, horizonMonths: 6, drivers: [] }).expect(400);
    await ctx.http().post(`${org.base}/twin/simulate`).set(viewer.auth).send({ baselineMonths: 3, horizonMonths: 6, drivers: [{ kind: 'MAGIC' }] }).expect(400);
  });

  it('saves scenarios, which only people who manage scenarios can change', async () => {
    const body = { name: 'Hire two engineers', description: 'Product team', baselineMonths: 3, horizonMonths: 12, drivers: [hire] };
    await ctx.http().post(`${org.base}/twin/scenarios`).set(viewer.auth).send(body).expect(403);
    hireId = (await ctx.http().post(`${org.base}/twin/scenarios`).set(accountant.auth).send(body).expect(201)).body.id;
    await ctx.http().post(`${org.base}/twin/scenarios`).set(owner.auth).send(body).expect(409);
    await ctx.http().post(`${org.base}/twin/scenarios`).set(owner.auth).send({ ...body, name: 'Bad', drivers: [{ kind: 'CHURN', percentPerMonth: '120' }] }).expect(422);
    downturnId = (
      await ctx
        .http()
        .post(`${org.base}/twin/scenarios`)
        .set(owner.auth)
        .send({ name: 'Downturn', baselineMonths: 3, horizonMonths: 6, drivers: [{ kind: 'DOWNTURN', revenuePercent: '80', extraCollectionDays: 0, fromMonth: 1 }] })
        .expect(201)
    ).body.id;
    const d = (await ctx.http().get(`${org.base}/twin/scenarios/${hireId}`).set(viewer.auth).expect(200)).body;
    expect(d.scenario).toMatchObject({ name: 'Hire two engineers', horizonMonths: 12, drivers: [hire] });
    expect(d.result.projection.months).toHaveLength(12);
    expect(d.baseline.projection.months[1].payroll).toBe('30000.00');
    expect(d.result.projection.months[1].payroll).toBe('130000.00');
    const u = (await ctx.http().put(`${org.base}/twin/scenarios/${hireId}`).set(owner.auth).send({ ...body, drivers: [{ ...hire, count: 3 }] }).expect(200)).body;
    expect(u.drivers[0].count).toBe(3);
    expect((await ctx.http().get(`${org.base}/twin/scenarios`).set(viewer.auth).expect(200)).body.items.map((s: { name: string }) => s.name)).toEqual(['Hire two engineers', 'Downturn']);
  });

  it('compares scenarios with the baseline', async () => {
    const c = (await ctx.http().get(`${org.base}/twin/compare?ids=${hireId},${downturnId}`).set(viewer.auth).expect(200)).body;
    expect(c).toMatchObject({ horizonMonths: 12, baselineMonths: 3 });
    expect(c.rows.map((r: { name: string }) => r.name)).toEqual(['No change (baseline)', 'Hire two engineers', 'Downturn']);
    expect(c.rows[0]).toMatchObject({ netProfit: '240000.00', cashNegativeFrom: null });
    // Revenue down 80% to 20,000; cost of sales follows volume (8,000), payroll and rent stay (40,000): 28,000 lost a month.
    expect(c.rows[2]).toMatchObject({ netProfit: '-336000.00' });
    expect(c.rows[2].cash).toHaveLength(12);
    await ctx.http().get(`${org.base}/twin/compare?ids=nope`).set(viewer.auth).expect(400);
  });

  it('never posts anything, and keeps scenarios to their organisation', async () => {
    const before = (await ctx.http().get(`${org.base}/journals?limit=100`).set(owner.auth).expect(200)).body;
    const count = (Array.isArray(before) ? before : before.items).length;
    await ctx.http().get(`${org.base}/twin/scenarios/${hireId}`).set(owner.auth).expect(200);
    const after = (await ctx.http().get(`${org.base}/journals?limit=100`).set(owner.auth).expect(200)).body;
    expect((Array.isArray(after) ? after : after.items).length).toBe(count);
    await ctx.http().get(`${other.base}/twin/scenarios/${hireId}`).set(viewer.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/twin/scenarios`).set(viewer.auth).expect(200)).body.items).toEqual([]);
    await ctx.http().delete(`${org.base}/twin/scenarios/${downturnId}`).set(viewer.auth).expect(403);
    await ctx.http().delete(`${org.base}/twin/scenarios/${downturnId}`).set(owner.auth).expect(200);
    await ctx.http().get(`${org.base}/twin/scenarios/${downturnId}`).set(owner.auth).expect(404);
    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=twin_scenario&limit=50`).set(owner.auth).expect(200)).body;
    const actions = (Array.isArray(audit) ? audit : audit.items).map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['twin_scenario.created', 'twin_scenario.updated', 'twin_scenario.deleted']));
    expect((await ctx.http().get(`${org.base}/twin/templates`).set(viewer.auth).expect(200)).body.length).toBe(9);
  });
});
