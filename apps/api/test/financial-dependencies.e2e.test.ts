import { addDays, fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * DASH-037 against the real API and database: revenue by customer from posted invoices, spending
 * by vendor from posted bills, cash by account and borrowing at the end of the range, with shares,
 * concentration and the dependencies worth watching; months checked; reports.read; isolation.
 */
const T = today();
const d = (k: number) => addDays(T, k);
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
const get = async (query: Record<string, string> = {}, auth = viewer.auth, status = 200) => (await ctx.http().get(`${org.base}/reports/dependencies`).query(query).set(auth).expect(status)).body;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Dependency Owner');
  viewer = await registerUser(ctx, 'Dependency Viewer');
  employee = await registerUser(ctx, 'Dependency Employee');
  outsider = await registerUser(ctx, 'Dependency Outsider');
  org = await createOrg(ctx, owner, { name: 'Dependency Traders Pvt Ltd' });
  for (const [u, role] of [[viewer, 'VIEWER'], [employee, 'EMPLOYEE']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fiscalYearForDate(d(-40), 4) });
  const a = org.acc;
  for (const name of ['Asha Traders', 'Banyan Retail', 'Cedar Foods', 'Deodar Stores']) c[name] = (await post('/contacts', { name, isCustomer: true })).id;
  for (const name of ['Granite Supplies', 'Harbour Freight']) c[name] = (await post('/contacts', { name, isVendor: true })).id;
  for (const [who, amount] of [['Asha Traders', '450000.00'], ['Banyan Retail', '300000.00'], ['Cedar Foods', '150000.00'], ['Deodar Stores', '100000.00']] as const) {
    await post('/sales/documents', { kind: 'INVOICE', contactId: c[who], issueDate: d(-20), dueDate: d(10), post: true, lines: [{ accountId: a['4100'], quantity: '1', unitPrice: amount }] });
  }
  for (const [who, amount, ref] of [['Granite Supplies', '60000.00', 'G-1'], ['Harbour Freight', '40000.00', 'H-1']] as const) {
    await post('/purchases/documents', { kind: 'BILL', contactId: c[who], issueDate: d(-15), dueDate: d(15), reference: ref, post: true, lines: [{ accountId: a['6100'], quantity: '1', unitPrice: amount }] });
  }
  // Cash: 950,000 in the bank and 50,000 in hand; 800,000 borrowed on a term loan and 30,000 on the card.
  await post('/journals', { date: d(-30), memo: 'Capital', post: true, lines: [{ accountId: a['1120'], debit: '200000.00' }, { accountId: a['3100'], credit: '200000.00' }] });
  await post('/journals', { date: d(-30), memo: 'Term loan', post: true, lines: [{ accountId: a['1120'], debit: '800000.00' }, { accountId: a['2700'], credit: '800000.00' }] });
  await post('/journals', { date: d(-29), memo: 'Petty cash', post: true, lines: [{ accountId: a['1110'], debit: '50000.00' }, { accountId: a['1120'], credit: '50000.00' }] });
  await post('/journals', { date: d(-28), memo: 'Card spend', post: true, lines: [{ accountId: a['6100'], debit: '30000.00' }, { accountId: a['2150'], credit: '30000.00' }] });
});
afterAll(async () => {
  await ctx.app.close();
});

describe('financial dependencies', () => {
  it('shows who the business depends on for revenue, spending, cash and borrowing', async () => {
    const r = await get();
    expect(r).toMatchObject({ currency: 'INR', to: T.slice(0, 7) });
    expect(r.groups.CUSTOMERS).toMatchObject({ total: '1000000.00', count: 4, hhi: 3250, concentration: 'HIGH', largestShare: 45 });
    expect(r.groups.CUSTOMERS.parties.map((p: { name: string; share: number }) => `${p.name} ${p.share}`)).toEqual(['Asha Traders 45', 'Banyan Retail 30', 'Cedar Foods 15', 'Deodar Stores 10']);
    expect(r.groups.CUSTOMERS.parties[0].id).toBe(c['Asha Traders']);
    expect(r.groups.VENDORS).toMatchObject({ total: '100000.00', count: 2, hhi: 5200, concentration: 'HIGH' });
    expect(r.groups.CASH.parties.map((p: { name: string; amount: string; share: number }) => `${p.name} ${p.amount} ${p.share}`)).toEqual(['1120 · Operating Bank Account 950000.00 95', '1110 · Cash on Hand 50000.00 5']);
    expect(r.groups.BORROWING).toMatchObject({ total: '830000.00', count: 2 });
    expect(r.dependencies.map((x: { severity: string; group: string; name: string; share: number }) => `${x.severity} ${x.group} ${x.name} ${x.share}`)).toEqual([
      'CRITICAL VENDORS Granite Supplies 60',
      'CRITICAL CUSTOMERS Asha Traders 45',
      'HIGH BORROWING 2700 · Long-Term Loans 96.4',
      'HIGH CASH 1120 · Operating Bank Account 95',
      'HIGH VENDORS Harbour Freight 40',
      'HIGH CUSTOMERS Banyan Retail 30',
      'WATCH CUSTOMERS Cedar Foods 15',
    ]);
    expect(r.dependencies[1].reason).toBe('45% of revenue comes from Asha Traders');
  });

  it('follows the months chosen, with cash and borrowing at their end', async () => {
    const before = await get({ from: '2020-01', to: '2020-12' });
    expect(before.groups.CUSTOMERS).toMatchObject({ total: '0.00', count: 0 });
    expect(before.groups.CASH).toMatchObject({ total: '0.00', count: 0 });
    expect(before.dependencies).toEqual([]);
    expect((await get({ from: T.slice(0, 7), to: '2020-01' }, owner.auth, 422)).error).toBe('INVALID_PERIOD');
    expect((await get({ from: '2020-01', to: '2022-12' }, owner.auth, 422)).error).toBe('PERIOD_TOO_LONG');
    await get({ from: '2020-13' }, owner.auth, 400);
  });

  it('needs reports access and keeps to its organisation', async () => {
    await ctx.http().get(`${org.base}/reports/dependencies`).set(employee.auth).expect(403);
    await ctx.http().get(`${org.base}/reports/dependencies`).set(outsider.auth).expect(404);
    const other = await createOrg(ctx, outsider, { name: 'Other Dependencies Ltd' });
    const r = (await ctx.http().get(`${other.base}/reports/dependencies`).set(outsider.auth).expect(200)).body;
    expect(r.groups.CUSTOMERS.count).toBe(0);
    expect(r.dependencies).toEqual([]);
  });
});
