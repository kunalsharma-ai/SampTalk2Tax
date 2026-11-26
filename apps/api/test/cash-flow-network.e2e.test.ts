import { addDays, fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * DASH-024 against the real API and database: where each month's cash came from and went to,
 * per cash or bank account, from posted receipts, bill payments and journals; transfers between
 * cash accounts; months checked; reports.read; isolation.
 */
const T = today();
const month = T.slice(0, 7);
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let employee: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;

const post = async (path: string, body: object) => {
  const r = await ctx.http().post(`${org.base}${path}`).set(owner.auth).send(body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};
const get = async (query: Record<string, string> = {}, auth = viewer.auth, status = 200) => (await ctx.http().get(`${org.base}/reports/cash-flow-network`).query(query).set(auth).expect(status)).body;
const flows = (m: { flows: { from: string; to: string; amount: string }[] }, names: Record<string, string>) => m.flows.map((f) => `${names[f.from] ?? f.from} > ${names[f.to] ?? f.to} ${f.amount}`);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Cash Network Owner');
  viewer = await registerUser(ctx, 'Cash Network Viewer');
  employee = await registerUser(ctx, 'Cash Network Employee');
  outsider = await registerUser(ctx, 'Cash Network Outsider');
  org = await createOrg(ctx, owner, { name: 'Cash Network Traders Pvt Ltd' });
  for (const [u, role] of [
    [viewer, 'VIEWER'],
    [employee, 'EMPLOYEE'],
  ] as const)
    await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  await ctx
    .http()
    .post(`${org.base}/periods/fiscal-years`)
    .set(owner.auth)
    .send({ fiscalYear: fiscalYearForDate(T, 4) });
  const a = org.acc;
  // Every movement is dated today, so it falls in this month.
  const customer = (await post('/contacts', { name: 'Asha Traders', isCustomer: true })).id;
  const vendor = (await post('/contacts', { name: 'Granite Supplies', isVendor: true })).id;
  const inv = await post('/sales/documents', {
    kind: 'INVOICE',
    contactId: customer,
    issueDate: T,
    dueDate: addDays(T, 10),
    post: true,
    lines: [{ accountId: a['4100'], quantity: '1', unitPrice: '90000.00' }],
  });
  await post('/sales/payments', { contactId: customer, date: T, bankAccountId: a['1120'], amount: '60000.00', allocations: [{ documentId: inv.id, amount: '60000.00' }], post: true });
  const bill = await post('/purchases/documents', {
    kind: 'BILL',
    contactId: vendor,
    issueDate: T,
    dueDate: addDays(T, 15),
    reference: 'G-1',
    post: true,
    lines: [{ accountId: a['6100'], quantity: '1', unitPrice: '25000.00' }],
  });
  await post('/purchases/payments', { contactId: vendor, date: T, bankAccountId: a['1120'], amount: '25000.00', allocations: [{ documentId: bill.id, amount: '25000.00' }], post: true });
  await post('/journals', {
    date: T,
    memo: 'Capital',
    post: true,
    lines: [
      { accountId: a['1120'], debit: '100000.00' },
      { accountId: a['3100'], credit: '100000.00' },
    ],
  });
  await post('/journals', {
    date: T,
    memo: 'Petty cash',
    post: true,
    lines: [
      { accountId: a['1110'], debit: '5000.00' },
      { accountId: a['1120'], credit: '5000.00' },
    ],
  });
  // A draft moves nothing.
  await post('/journals', {
    date: T,
    memo: 'Draft only',
    lines: [
      { accountId: a['1120'], debit: '1.00' },
      { accountId: a['3100'], credit: '1.00' },
    ],
  });
});
afterAll(async () => {
  await ctx.app.close();
});

describe('cash-flow network', () => {
  it('shows where this month’s cash came from and went to, per account', async () => {
    const r = await get();
    expect(r).toMatchObject({ currency: 'INR', to: month, entries: 4 });
    expect(r.months).toHaveLength(12);
    const names = Object.fromEntries(r.nodes.map((n: { key: string; name: string }) => [n.key, n.name]));
    expect(r.nodes.filter((n: { kind: string }) => n.kind === 'CASH').map((n: { name: string; inflow: string; outflow: string }) => `${n.name} ${n.inflow} ${n.outflow}`)).toEqual(
      expect.arrayContaining(['1120 · Operating Bank Account 160000.00 30000.00', '1110 · Cash on Hand 5000.00 0.00']),
    );
    const now = r.months[r.months.length - 1];
    expect(flows(now, names)).toEqual([
      'OWNERS > 1120 · Operating Bank Account 100000.00',
      'CUSTOMERS > 1120 · Operating Bank Account 60000.00',
      '1120 · Operating Bank Account > VENDORS 25000.00',
      '1120 · Operating Bank Account > 1110 · Cash on Hand 5000.00',
    ]);
    expect(now).toMatchObject({ inflow: '160000.00', outflow: '25000.00', net: '135000.00' });
    expect(r.total).toMatchObject({ inflow: '160000.00', outflow: '25000.00', net: '135000.00' });
    expect(r.months[0].flows).toEqual([]);
  });

  it('follows the months chosen', async () => {
    const before = await get({ from: '2020-01', to: '2020-03' });
    expect(before.months.map((m: { month: string }) => m.month)).toEqual(['2020-01', '2020-02', '2020-03']);
    expect(before.total.flows).toEqual([]);
    expect((await get({ from: month, to: '2020-01' }, owner.auth, 422)).error).toBe('INVALID_PERIOD');
    expect((await get({ from: '2020-01', to: '2022-12' }, owner.auth, 422)).error).toBe('PERIOD_TOO_LONG');
    await get({ from: '2020-13' }, owner.auth, 400);
  });

  it('needs reports access and keeps to its organisation', async () => {
    await ctx.http().get(`${org.base}/reports/cash-flow-network`).set(employee.auth).expect(403);
    await ctx.http().get(`${org.base}/reports/cash-flow-network`).set(outsider.auth).expect(404);
    const other = await createOrg(ctx, outsider, { name: 'Other Cash Network Ltd' });
    const r = (await ctx.http().get(`${other.base}/reports/cash-flow-network`).set(outsider.auth).expect(200)).body;
    expect(r.entries).toBe(0);
    expect(r.total.flows).toEqual([]);
  });
});
