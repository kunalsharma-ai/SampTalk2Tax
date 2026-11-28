import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * DASH-023 against the real API and database: spending and income by account and month from
 * posted journals (drafts and other months left out), largest first; months checked;
 * reports.read; isolation.
 */
const T = today();
const month = T.slice(0, 7);
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let employee: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;

const journal = (date: string, debit: string, credit: string, amount: string, memo: string, post = true) =>
  ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date, post, memo, lines: [{ accountId: org.acc[debit], debit: amount }, { accountId: org.acc[credit], credit: amount }] }).expect(201);
const get = async (query: Record<string, string> = {}, auth = viewer.auth, status = 200) => (await ctx.http().get(`${org.base}/reports/landscape`).query(query).set(auth).expect(status)).body;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Landscape Owner');
  viewer = await registerUser(ctx, 'Landscape Viewer');
  employee = await registerUser(ctx, 'Landscape Employee');
  outsider = await registerUser(ctx, 'Landscape Outsider');
  org = await createOrg(ctx, owner, { name: 'Landscape Co' });
  for (const [u, role] of [[viewer, 'VIEWER'], [employee, 'EMPLOYEE']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  await journal(T, '1120', '4100', '300000.00', 'Sales');
  await journal(T, '6100', '1120', '90000.00', 'Salaries');
  await journal(T, '6200', '1120', '30000.00', 'Rent');
  await journal(T, '6200', '1120', '5000.00', 'Rent draft', false);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('financial landscape', () => {
  it('lays out this month’s spending by account, largest first', async () => {
    const r = await get();
    expect(r).toMatchObject({ currency: 'INR', to: month, view: 'EXPENSES', total: '120000.00', busiestMonth: month });
    expect(r.months).toHaveLength(12);
    expect(r.rows.map((x: { label: string; total: string }) => `${x.label} ${x.total}`)).toEqual(['6100 Salaries and Wages 90000.00', '6200 Rent 30000.00']);
    expect(r.rows[0].values[11]).toBe('90000.00');
    expect(r.peak).toEqual({ row: '6100 Salaries and Wages', month, amount: '90000.00' });
    const rev = await get({ view: 'REVENUE' });
    expect(rev.rows.map((x: { label: string; total: string }) => `${x.label} ${x.total}`)).toEqual(['4100 Sales Revenue 300000.00']);
  });

  it('follows the months chosen', async () => {
    const before = await get({ from: '2020-01', to: '2020-03' });
    expect(before).toMatchObject({ months: ['2020-01', '2020-02', '2020-03'], rows: [], total: '0.00', peak: null });
    expect((await get({ from: month, to: '2020-01' }, owner.auth, 422)).error).toBe('INVALID_PERIOD');
    expect((await get({ from: '2020-01', to: '2022-12' }, owner.auth, 422)).error).toBe('PERIOD_TOO_LONG');
    await get({ view: 'ASSETS' }, owner.auth, 400);
  });

  it('needs reports access and keeps to its organisation', async () => {
    await ctx.http().get(`${org.base}/reports/landscape`).set(employee.auth).expect(403);
    await ctx.http().get(`${org.base}/reports/landscape`).set(outsider.auth).expect(404);
    const other = await createOrg(ctx, outsider, { name: 'Other Landscape Co' });
    expect((await ctx.http().get(`${other.base}/reports/landscape`).set(outsider.auth).expect(200)).body.rows).toEqual([]);
  });
});
