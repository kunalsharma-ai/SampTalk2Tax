import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Department performance (DASH-035) against the real API and database: journals booked to
 * departments become each department's revenue, spending, profit and margin, ranked, with what
 * is not assigned shown apart and spending compared with the fiscal year's budget; periods,
 * permissions and tenants.
 */
const T = today();
const M = T.slice(0, 7);
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let employee: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const dep: Record<string, string> = {};
const url = (q = '') => `${org.base}/reports/department-performance${q}`;
const journal = (lines: Record<string, unknown>[]) => ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: T, memo: 'Department test', post: true, lines }).expect(201);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Dept Owner');
  viewer = await registerUser(ctx, 'Dept Viewer');
  employee = await registerUser(ctx, 'Dept Employee');
  org = await createOrg(ctx, owner, { name: 'Department Traders Pvt Ltd' });
  for (const [u, role] of [[viewer, 'VIEWER'], [employee, 'EMPLOYEE']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  for (const [code, name] of [['D01', 'Sales'], ['D02', 'Operations'], ['D03', 'Quiet']]) dep[name] = (await ctx.http().post(`${org.base}/dimensions`).set(owner.auth).send({ type: 'DEPARTMENT', code, name }).expect(201)).body.id;
});
afterAll(async () => ctx?.app.close());

describe('department performance', () => {
  it('says when nothing is booked', async () => {
    const r = (await ctx.http().get(url()).set(viewer.auth).expect(200)).body;
    expect(r).toMatchObject({ to: M, hasDepartments: true, rows: [], totals: { revenue: '0.00', expenses: '0.00', profit: '0.00' } });
    expect(r.months).toHaveLength(6);
  });

  it('ranks departments by profit, with what is not assigned and the budget', async () => {
    const a = org.acc;
    await journal([{ accountId: a['1120'], debit: '150000.00' }, { accountId: a['4100'], credit: '120000.00', departmentId: dep.Sales }, { accountId: a['4200'], credit: '30000.00', departmentId: dep.Operations }]);
    await journal([
      { accountId: a['6100'], debit: '40000.00', departmentId: dep.Sales },
      { accountId: a['6500'], debit: '10000.00', departmentId: dep.Sales },
      { accountId: a['6200'], debit: '45000.00', departmentId: dep.Operations },
      { accountId: a['6900'], debit: '5000.00' },
      { accountId: a['1120'], credit: '100000.00' },
    ]);
    const fiscalYear = (await ctx.http().get(url(`?from=${M}&to=${M}`)).set(owner.auth).expect(200)).body.fiscalYear;
    await ctx.http().put(`${org.base}/department-budgets`).set(owner.auth).send({ departmentId: dep.Operations, fiscalYear, amount: '40000.00' }).expect(200);
    const r = (await ctx.http().get(url(`?from=${M}&to=${M}`)).set(viewer.auth).expect(200)).body;
    expect(r.rows.map((x: { name: string; revenue: string; expenses: string; profit: string; margin: number | null }) => `${x.name} ${x.revenue} ${x.expenses} ${x.profit} ${x.margin}`)).toEqual([
      'Sales 120000.00 50000.00 70000.00 58.3',
      'Operations 30000.00 45000.00 -15000.00 -50',
      'Not assigned 0.00 5000.00 -5000.00 null',
    ]);
    expect(r.totals).toEqual({ revenue: '150000.00', expenses: '100000.00', profit: '50000.00', margin: 33.3, unassignedExpenseShare: 5 });
    expect(r.rows[1].budget).toEqual({ amount: '40000.00', spent: '45000.00', remaining: '0.00', usedPercent: 112.5, status: 'OVER' });
    expect(r.rows[0].budget).toBeNull();
    expect(r.rows[0].months).toEqual([{ month: M, revenue: '120000.00', expenses: '50000.00', profit: '70000.00' }]);
    expect(r.rows[0].expenseShare).toBe(50);
  });

  it('checks the period and permissions, and keeps tenants apart', async () => {
    expect((await ctx.http().get(url(`?from=${M}&to=2020-01`)).set(owner.auth).expect(422)).body.error).toBe('INVALID_PERIOD');
    expect((await ctx.http().get(url('?from=2020-01&to=2023-01')).set(owner.auth).expect(422)).body.error).toBe('PERIOD_TOO_LONG');
    await ctx.http().get(url('?to=bad')).set(owner.auth).expect(400);
    await ctx.http().get(url()).set(employee.auth).expect(403);
    const stranger = await registerUser(ctx, 'Dept Stranger');
    const other = await createOrg(ctx, stranger, { name: 'Other Dept Org' });
    await ctx.http().get(url()).set(stranger.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/reports/department-performance`).set(stranger.auth).expect(200)).body).toMatchObject({ hasDepartments: false, rows: [] });
  });
});
