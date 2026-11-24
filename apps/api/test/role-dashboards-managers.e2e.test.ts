import { addDays, fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * DASH-049/050/051/055 against the real API and database: the receivables manager's ageing,
 * customers to chase and weekly collections; the payables manager's ageing, bills in payment
 * order, held bills and payment checks; the tax manager's payments, returns and GST check; the
 * expense manager's claims waiting, risky claims, missing receipts and department budgets;
 * expense access for the expense dashboard; isolation.
 */
const T = today();
const d = (k: number) => addDays(T, k);
const sunday = (s: string) => new Date(`${s}T00:00:00Z`).getUTCDay() === 0;
const weekday = (k: number) => (sunday(d(k)) ? d(k - 1) : d(k));
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let employee: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const c: Record<string, string> = {};

const post = async (path: string, body: object, who = owner) => {
  const r = await ctx.http().post(`${org.base}${path}`).set(who.auth).send(body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
};
const brief = async (role: string, auth = viewer.auth, status = 200) => (await ctx.http().get(`${org.base}/reports/role-dashboards/${role}`).set(auth).expect(status)).body;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Manager Owner');
  viewer = await registerUser(ctx, 'Manager Viewer');
  employee = await registerUser(ctx, 'Manager Employee');
  outsider = await registerUser(ctx, 'Manager Outsider');
  org = await createOrg(ctx, owner, { name: 'Manager Dashboards Pvt Ltd' });
  for (const [u, role] of [[viewer, 'VIEWER'], [employee, 'EMPLOYEE']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  for (const fy of new Set([fiscalYearForDate(d(-120), 4), fiscalYearForDate(T, 4)])) await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fy });
  const a = org.acc;
  for (const name of ['Asha Traders', 'Banyan Retail', 'Cedar Foods']) c[name] = (await post('/contacts', { name, isCustomer: true })).id;
  for (const name of ['Granite Supplies', 'Harbour Freight']) c[name] = (await post('/contacts', { name, isVendor: true })).id;
  // Receivables: 450,000 31-60 days late, 300,000 not yet due, 150,000 over 90 days late.
  for (const [who, amount, issue, due] of [['Asha Traders', '450000.00', -80, -50], ['Banyan Retail', '300000.00', -20, 10], ['Cedar Foods', '150000.00', -110, -95]] as const) {
    await post('/sales/documents', { kind: 'INVOICE', contactId: c[who], issueDate: d(issue), dueDate: d(due), post: true, lines: [{ accountId: a['4100'], quantity: '1', unitPrice: amount }] });
  }
  // Payables: 60,000 10 days late, 40,000 due in 15 days.
  for (const [who, amount, ref, due] of [['Granite Supplies', '60000.00', 'G-1', -10], ['Harbour Freight', '40000.00', 'H-1', 15]] as const) {
    await post('/purchases/documents', { kind: 'BILL', contactId: c[who], issueDate: d(-40), dueDate: d(due), reference: ref, post: true, lines: [{ accountId: a['6100'], quantity: '1', unitPrice: amount }] });
  }
  await post('/journals', { date: d(-100), memo: 'Capital', post: true, lines: [{ accountId: a['1120'], debit: '200000.00' }, { accountId: a['3100'], credit: '200000.00' }] });
  // One claim waiting for a decision, without a receipt.
  const claim = await post('/expense-claims', { title: 'Client visit', lines: [{ date: weekday(-3), accountId: a['6700'], merchant: 'Synthetic Cabs', amount: '2400.00' }] });
  await ctx.http().post(`${org.base}/expense-claims/${claim.id}/submit`).set(owner.auth).send({}).expect(200);
  c.claim = claim.id;
});
afterAll(async () => {
  await ctx.app.close();
});

const NAMES = ['CURRENT', 'DAYS_1_30', 'DAYS_31_60', 'DAYS_61_90', 'OVER_90'];
const aged = (a: { buckets: { bucket: string; amount: string; count: number }[] }) => a.buckets.map((b) => `${b.bucket} ${b.amount} ${b.count}`);

describe('manager dashboards', () => {
  it('gives the receivables manager ageing, customers to chase and weekly collections', async () => {
    const r = await brief('AR_MANAGER');
    expect(r).toMatchObject({ role: 'AR_MANAGER', name: 'Accounts receivable manager' });
    const v = r.receivables;
    expect(v.aging).toMatchObject({ total: '900000.00', overdue: '600000.00' });
    expect(aged(v.aging)).toEqual([`${NAMES[0]} 300000.00 1`, `${NAMES[1]} 0.00 0`, `${NAMES[2]} 450000.00 1`, `${NAMES[3]} 0.00 0`, `${NAMES[4]} 150000.00 1`]);
    expect(v.overdueCustomers.map((x: { name: string; overdue: string; invoices: number; oldestDaysLate: number }) => `${x.name} ${x.overdue} ${x.invoices} ${x.oldestDaysLate}`)).toEqual(['Asha Traders 450000.00 1 50', 'Cedar Foods 150000.00 1 95']);
    // Without paid invoices to learn from there is nothing to score yet; the priorities fill in as customers pay.
    expect(v.collections.summary).toEqual(expect.objectContaining({ customers: expect.any(Number), toChase: expect.any(String) }));
    expect(v.forecast.weeks).toHaveLength(8);
    expect(v.forecast.total).toEqual(expect.any(String));
    expect(v.dso.key).toBe('dso');
  });

  it('gives the payables manager ageing, bills in payment order, held bills and payment checks', async () => {
    const v = (await brief('AP_MANAGER')).payables;
    expect(v.aging).toMatchObject({ total: '100000.00', overdue: '60000.00' });
    expect(aged(v.aging)).toEqual([`${NAMES[0]} 40000.00 1`, `${NAMES[1]} 60000.00 1`, `${NAMES[2]} 0.00 0`, `${NAMES[3]} 0.00 0`, `${NAMES[4]} 0.00 0`]);
    expect(v.payments.bills.map((b: { vendor: string }) => b.vendor).sort()).toEqual(['Granite Supplies', 'Harbour Freight']);
    expect(v.exceptions.summary).toMatchObject({ bills: 0, atStake: '0.00' });
    expect(v.fraud.summary).toEqual(expect.objectContaining({ checked: expect.any(Number), flagged: expect.any(Number) }));
    expect(v.dpo.key).toBe('dpo');
  });

  it('gives the tax manager payments, returns and the GST check', async () => {
    const v = (await brief('TAX_MANAGER')).tax;
    expect(v.payments.totals).toHaveProperty('amount');
    expect(Array.isArray(v.returns)).toBe(true);
    expect(Array.isArray(v.byArea)).toBe(true);
    // No GST registration in this organisation: nothing to reconcile, not an error.
    expect(v.gst).toEqual({ registered: false, period: expect.stringMatching(/^\d{4}-\d{2}$/) });
  });

  it('gives the expense manager claims waiting, risky claims, missing receipts and budgets', async () => {
    const v = (await brief('EXPENSE_MANAGER')).expenses;
    expect(v.approvals).toMatchObject({ count: 1, totals: [{ currency: 'INR', amount: '2400.00' }] });
    expect(v.approvals.claims[0]).toMatchObject({ id: c.claim, title: 'Client visit', claimant: 'Manager Owner', total: '2400.00', submittedOn: T });
    expect(v.receipts).toMatchObject({ days: 30, lines: 0, withReceipt: 0, missing: 0 });
    expect(v.risk.summary.claims).toBe(1);
    expect(v.budgets.rows).toEqual([]);
  });

  it('needs expense access for the expense dashboard, reports access for all, and keeps to its organisation', async () => {
    await ctx.http().get(`${org.base}/reports/role-dashboards/AR_MANAGER`).set(employee.auth).expect(403);
    await ctx.http().get(`${org.base}/reports/role-dashboards/EXPENSE_MANAGER`).set(employee.auth).expect(403);
    await ctx.http().get(`${org.base}/reports/role-dashboards/AP_MANAGER`).set(outsider.auth).expect(404);
    const other = await createOrg(ctx, outsider, { name: 'Other Managers Ltd' });
    const r = (await ctx.http().get(`${other.base}/reports/role-dashboards/AR_MANAGER`).set(outsider.auth).expect(200)).body;
    expect(r.receivables.aging.total).toBe('0.00');
    expect(r.receivables.collections.customers).toEqual([]);
    const e = (await ctx.http().get(`${other.base}/reports/role-dashboards/EXPENSE_MANAGER`).set(outsider.auth).expect(200)).body;
    expect(e.expenses.approvals.count).toBe(0);
  });
});
