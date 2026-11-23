import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Financial visuals (DASH-028/029/030/031/034) against the real API and database: posted
 * journals become a profit and loss waterfall, a balanced Sankey, a spending heatmap and a
 * treemap, each naming its accounts; draft journals are left out; periods are checked;
 * permissions and tenants.
 */
const T = today();
const M = T.slice(0, 7);
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let employee: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const url = (q = '') => `${org.base}/reports/visuals${q}`;
const journal = (lines: Record<string, unknown>[], post = true) => ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: T, memo: 'Visuals test', post, lines }).expect(201);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Visual Owner');
  viewer = await registerUser(ctx, 'Visual Viewer');
  employee = await registerUser(ctx, 'Visual Employee');
  org = await createOrg(ctx, owner, { name: 'Visual Traders Pvt Ltd' });
  for (const [u, role] of [[viewer, 'VIEWER'], [employee, 'EMPLOYEE']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
});
afterAll(async () => ctx?.app.close());

describe('financial visuals', () => {
  it('shows an empty period as empty', async () => {
    const v = (await ctx.http().get(url()).set(viewer.auth).expect(200)).body;
    expect(v).toMatchObject({ to: M, empty: true, currency: 'INR', treemap: { total: '0.00', groups: [] } });
    expect(v.months).toHaveLength(12);
    expect(v.waterfall.at(-1)).toMatchObject({ key: 'NET_PROFIT', amount: '0.00' });
  });

  it('draws posted journals four ways', async () => {
    const a = org.acc;
    await journal([{ accountId: a['1120'], debit: '100000.00' }, { accountId: a['4100'], credit: '80000.00' }, { accountId: a['4200'], credit: '20000.00' }]);
    await journal([{ accountId: a['5000'], debit: '30000.00' }, { accountId: a['6100'], debit: '25000.00' }, { accountId: a['6200'], debit: '9000.00' }, { accountId: a['6400'], debit: '1000.00' }, { accountId: a['1120'], credit: '65000.00' }]);
    await journal([{ accountId: a['6700'], debit: '99999.00' }, { accountId: a['1120'], credit: '99999.00' }], false);
    const v = (await ctx.http().get(url(`?from=${M}&to=${M}`)).set(viewer.auth).expect(200)).body;
    expect(v).toMatchObject({ from: M, to: M, months: [M], empty: false, fromDate: `${M}-01` });
    expect(v.waterfall.map((s: { key: string; amount: string }) => `${s.key} ${s.amount}`)).toEqual([
      'REVENUE 100000.00',
      'COST_OF_SALES -30000.00',
      'GROSS_PROFIT 70000.00',
      'PAYROLL -25000.00',
      'OPERATING -10000.00',
      'OPERATING_PROFIT 35000.00',
      'PROFIT_BEFORE_TAX 35000.00',
      'NET_PROFIT 35000.00',
    ]);
    expect(v.waterfall[1].accountIds).toEqual([a['5000']]);
    const { nodes, links } = v.sankey;
    const hub = nodes.findIndex((n: { kind: string }) => n.kind === 'INCOME');
    const total = (pred: (l: { source: number; target: number }) => boolean) => links.filter(pred).reduce((s: number, l: { amount: string }) => s + Number(l.amount), 0); // not money: test arithmetic
    expect(total((l) => l.target === hub)).toBe(100000);
    expect(total((l) => l.source === hub)).toBe(100000);
    expect(v.sankey.profit).toBe('35000.00');
    expect(nodes.find((n: { accountId: string | null }) => n.accountId === a['4100']).label).toBe('Sales Revenue');
    expect(v.heatmap.rows.map((r: { code: string; total: string }) => `${r.code} ${r.total}`)).toEqual(['5000 30000.00', '6100 25000.00', '6200 9000.00', '6400 1000.00']);
    expect(v.heatmap.rows[0].cells).toEqual([{ month: M, amount: '30000.00', intensity: 1 }]);
    expect(v.treemap.total).toBe('65000.00');
    expect(v.treemap.groups.map((g: { label: string; share: number }) => `${g.label} ${g.share}`)).toEqual(['Cost of sales 46.2', 'People 38.5', 'Operating costs 15.4']);
    expect(v.accounts.map((x: { code: string; total: string }) => `${x.code} ${x.total}`)).toEqual(['4100 80000.00', '4200 20000.00', '5000 30000.00', '6100 25000.00', '6200 9000.00', '6400 1000.00']);
  });

  it('checks the period and permissions, and keeps tenants apart', async () => {
    expect((await ctx.http().get(url(`?from=${M}&to=2020-01`)).set(owner.auth).expect(422)).body.error).toBe('INVALID_PERIOD');
    expect((await ctx.http().get(url('?from=2020-01&to=2023-01')).set(owner.auth).expect(422)).body.error).toBe('PERIOD_TOO_LONG');
    await ctx.http().get(url('?from=2026-13')).set(owner.auth).expect(400);
    await ctx.http().get(url()).set(employee.auth).expect(403);
    const stranger = await registerUser(ctx, 'Visual Stranger');
    const other = await createOrg(ctx, stranger, { name: 'Other Visual Org' });
    await ctx.http().get(url()).set(stranger.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/reports/visuals`).set(stranger.auth).expect(200)).body.empty).toBe(true);
  });
});
