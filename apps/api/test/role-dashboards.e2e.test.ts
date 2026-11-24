import { addDays, fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * DASH-044/045/053/063/064/066 against the real API and database: one dashboard per role, each
 * with its own figures (CEO headline and cash, CFO margins and working capital, treasury cash
 * forecast and what to pay or collect, risk officer scores and dependencies, compliance deadlines
 * and tax, board quarters without names); reports.read; isolation.
 */
const T = today();
const d = (k: number) => addDays(T, k);
const lastMonth = (() => {
  const [y, m] = T.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
})();
const P = `${lastMonth}-15`;
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let employee: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const c: Record<string, string> = {};

const post = async (path: string, body: object) => {
  const r = await ctx.http().post(`${org.base}${path}`).set(owner.auth).send(body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};
const brief = async (role: string, auth = viewer.auth, status = 200) => (await ctx.http().get(`${org.base}/reports/role-dashboards/${role}`).set(auth).expect(status)).body;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Role Owner');
  viewer = await registerUser(ctx, 'Role Viewer');
  employee = await registerUser(ctx, 'Role Employee');
  outsider = await registerUser(ctx, 'Role Outsider');
  org = await createOrg(ctx, owner, { name: 'Role Dashboards Pvt Ltd' });
  for (const [u, role] of [[viewer, 'VIEWER'], [employee, 'EMPLOYEE']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  for (const fy of new Set([fiscalYearForDate(P, 4), fiscalYearForDate(T, 4)])) await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fy });
  const a = org.acc;
  for (const name of ['Asha Traders', 'Banyan Retail', 'Cedar Foods', 'Deodar Stores']) c[name] = (await post('/contacts', { name, isCustomer: true })).id;
  for (const name of ['Granite Supplies', 'Harbour Freight']) c[name] = (await post('/contacts', { name, isVendor: true })).id;
  for (const [who, amount] of [['Asha Traders', '450000.00'], ['Banyan Retail', '300000.00'], ['Cedar Foods', '150000.00'], ['Deodar Stores', '100000.00']] as const) {
    await post('/sales/documents', { kind: 'INVOICE', contactId: c[who], issueDate: P, dueDate: d(10), post: true, lines: [{ accountId: a['4100'], quantity: '1', unitPrice: amount }] });
  }
  for (const [who, amount, ref] of [['Granite Supplies', '60000.00', 'G-1'], ['Harbour Freight', '40000.00', 'H-1']] as const) {
    await post('/purchases/documents', { kind: 'BILL', contactId: c[who], issueDate: P, dueDate: d(15), reference: ref, post: true, lines: [{ accountId: a['6100'], quantity: '1', unitPrice: amount }] });
  }
  await post('/journals', { date: P, memo: 'Capital', post: true, lines: [{ accountId: a['1120'], debit: '200000.00' }, { accountId: a['3100'], credit: '200000.00' }] });
  await post('/journals', { date: P, memo: 'Term loan', post: true, lines: [{ accountId: a['1120'], debit: '800000.00' }, { accountId: a['2700'], credit: '800000.00' }] });
  await post('/journals', { date: P, memo: 'Petty cash', post: true, lines: [{ accountId: a['1110'], debit: '50000.00' }, { accountId: a['1120'], credit: '50000.00' }] });
  await post('/journals', { date: P, memo: 'Card spend', post: true, lines: [{ accountId: a['6100'], debit: '30000.00' }, { accountId: a['2150'], credit: '30000.00' }] });
});
afterAll(async () => {
  await ctx.app.close();
});

const NAMES = ['Asha Traders', 'Banyan Retail', 'Cedar Foods', 'Deodar Stores', 'Granite Supplies', 'Harbour Freight'];

describe('role dashboards', () => {
  it('lists one dashboard per role with the question it answers', async () => {
    const r = (await ctx.http().get(`${org.base}/reports/role-dashboards`).set(viewer.auth).expect(200)).body;
    expect(r.roles.map((x: { role: string }) => x.role)).toEqual(['CEO', 'CFO', 'TREASURY', 'RISK', 'COMPLIANCE', 'BOARD']);
    expect(r.roles[0].question).toMatch(/growing/);
  });

  it('gives the CEO the headline, the cash and the biggest customers', async () => {
    const r = await brief('CEO');
    expect(r).toMatchObject({ role: 'CEO', name: 'Chief executive', currency: 'INR', asOf: T });
    expect(r.ceo.month).toBe(lastMonth);
    expect(r.ceo.headline.map((k: { key: string }) => k.key)).toEqual(['revenue', 'netMargin', 'netCashFlow', 'runway']);
    expect(r.ceo.headline[0].value).toBe('1000000.00');
    expect(r.ceo.revenue.at(-1)).toMatchObject({ month: lastMonth, value: '1000000.00' });
    expect(r.ceo.cash.now).toBe('1000000.00');
    expect(r.ceo.customers.top.map((x: { name: string; share: string }) => `${x.name} ${x.share}`)).toEqual(['Asha Traders 45.0', 'Banyan Retail 30.0', 'Cedar Foods 15.0', 'Deodar Stores 10.0']);
    expect(typeof r.ceo.risk.score).toBe('number');
    expect(Array.isArray(r.ceo.attention)).toBe(true);
    expect(r.cfo).toBeUndefined();
  });

  it('gives the CFO margins, liquidity and working capital both ways', async () => {
    const r = await brief('CFO');
    expect(r.cfo.profitability.map((k: { key: string }) => k.key)).toEqual(['grossMargin', 'operatingMargin', 'netMargin', 'opexRatio']);
    expect(r.cfo.profitability[0].series.length).toBeGreaterThan(0);
    expect(r.cfo.liquidity.map((k: { key: string }) => k.key)).toEqual(['currentRatio', 'quickRatio', 'workingCapital', 'debtToEquity']);
    expect(r.cfo.efficiency.map((k: { key: string }) => k.key)).toEqual(['dso', 'dpo']);
    expect(r.cfo.workingCapital.receivables).toMatchObject({ open: '1000000.00', overdue: '0.00', invoices: 4 });
    expect(r.cfo.workingCapital.payables).toMatchObject({ open: '100000.00', overdue: '0.00', bills: 2 });
    expect(r.cfo.tax.totals).toHaveProperty('amount');
  });

  it('gives treasury the cash by account, the 90-day forecast and what to pay and collect', async () => {
    const r = await brief('TREASURY');
    const t = r.treasury;
    expect(t.accounts.map((x: { code: string; balance: string }) => `${x.code} ${x.balance}`)).toEqual(['1110 50000.00', '1120 950000.00']);
    expect(t.forecast).toMatchObject({ horizonDays: 90, opening: '1000000.00', minimumBalance: '0.00' });
    // Customers are expected to pay in 10 days and vendors to be paid in 15: 1,000,000 in, 100,000 out.
    expect(t.forecast.closing.base).toBe('1900000.00');
    expect(t.forecast.lowest.base.amount).toBe('1000000.00');
    expect(t.forecast.headroom).toMatchObject({ headroom: '1000000.00', breaks: false });
    expect(t.forecast.buckets.length).toBeGreaterThanOrEqual(13);
    expect(t.collections).toMatchObject({ days: 30, expected: '1000000.00', count: 4 });
    expect(t.collections.invoices[0]).toMatchObject({ expectedOn: d(10) });
    expect(t.payments.bills.map((b: { vendor: string }) => b.vendor).sort()).toEqual(['Granite Supplies', 'Harbour Freight']);
  });

  it('gives the risk officer the scores by area and the dependencies', async () => {
    const r = await brief('RISK');
    expect(r.risk.areas.map((a: { area: string }) => a.area)).toEqual(['ALERTS', 'PAYMENTS', 'EXPENSES', 'BANK', 'COMPLIANCE', 'VENDORS']);
    expect(r.risk.groups.map((g: { group: string; concentration: string | null }) => `${g.group} ${g.concentration}`)).toEqual(['CUSTOMERS HIGH', 'VENDORS HIGH', 'CASH HIGH', 'BORROWING HIGH']);
    expect(r.risk.dependencies.slice(0, 2).map((x: { severity: string; name: string }) => `${x.severity} ${x.name}`)).toEqual(['CRITICAL Granite Supplies', 'CRITICAL Asha Traders']);
    expect(r.risk.history.length).toBeGreaterThanOrEqual(1);
  });

  it('gives the compliance officer deadlines and the tax to pay', async () => {
    const r = await brief('COMPLIANCE');
    expect(r.compliance).toMatchObject({ days: 60 });
    expect(typeof r.compliance.configured).toBe('boolean');
    expect(r.compliance.summary).toEqual(expect.objectContaining({ high: expect.any(Number), overdue: expect.any(Number), dueThisWeek: expect.any(Number) }));
    expect(Array.isArray(r.compliance.deadlines)).toBe(true);
    expect(r.compliance.tax.totals).toHaveProperty('amount');
  });

  it('gives the board quarters and position without naming anyone', async () => {
    const r = await brief('BOARD');
    const b = r.board;
    const last = b.quarters.at(-1);
    expect(last).toMatchObject({ revenue: '1000000.00', grossProfit: '1000000.00', netIncome: '870000.00', closingCash: '1000000.00' });
    expect(b.quarters.reduce((t: number, q: { months: number }) => t + q.months, 0)).toBe(12);
    expect(b.position.map((k: { key: string }) => k.key)).toEqual(['grossMargin', 'netMargin', 'currentRatio', 'debtToEquity', 'runway']);
    expect(b.concentration).toMatchObject({ band: 'HIGH', largestShare: '45.0', topFiveShare: '100.0', customers: 4 });
    const text = JSON.stringify(r);
    for (const n of NAMES) expect(text).not.toContain(n);
  });

  it('checks the role, needs reports access and keeps to its organisation', async () => {
    await brief('JANITOR', viewer.auth, 400);
    await ctx.http().get(`${org.base}/reports/role-dashboards/CEO`).set(employee.auth).expect(403);
    await ctx.http().get(`${org.base}/reports/role-dashboards/CEO`).set(outsider.auth).expect(404);
    const other = await createOrg(ctx, outsider, { name: 'Other Roles Ltd' });
    const r = (await ctx.http().get(`${other.base}/reports/role-dashboards/TREASURY`).set(outsider.auth).expect(200)).body;
    expect(r.treasury.collections.count).toBe(0);
    expect(r.treasury.forecast.opening).toBe('0.00');
  });
});
