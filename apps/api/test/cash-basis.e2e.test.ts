import { addDays } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Cash-basis profit and loss (GL-014) against the real API and database: invoices and bills
 * count as they are paid, credit notes as they are applied, expense claims when paid back, and
 * money moved with no invoice in full; accruals with no cash are left out.
 */
let ctx: Ctx;
let owner: TestUser;
let approver: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let customer: string;
let vendor: string;
const T = today();
const d = (n: number) => addDays(T, n);
const from = d(-30);

const doc = async (area: 'sales' | 'purchases', body: object) => (await ctx.http().post(`${org.base}/${area}/documents`).set(owner.auth).send({ post: true, ...body }).expect(201)).body;
const pay = (area: 'sales' | 'purchases', contactId: string, date: string, documentId: string, amount: string) =>
  ctx.http().post(`${org.base}/${area}/payments`).set(owner.auth).send({ contactId, date, bankAccountId: org.acc['1120'], amount, allocations: [{ documentId, amount }] }).expect(201);
const journal = (date: string, lines: object[]) => ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date, post: true, memo: 'Synthetic', lines }).expect(201);
const report = (q: string) => ctx.http().get(`${org.base}/reports/income-statement?from=${from}&to=${T}${q}`).set(owner.auth).expect(200);
const amounts = (rows: { code: string; amount: string }[]) => Object.fromEntries(rows.map((r) => [r.code, r.amount]));

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Cash Basis Owner');
  approver = await registerUser(ctx, 'Cash Basis Approver');
  org = await createOrg(ctx, owner);
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: approver.email, role: 'APPROVER' }).expect(201);
  customer = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Synthetic Customer', isCustomer: true }).expect(201)).body.id;
  vendor = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Synthetic Vendor', isVendor: true }).expect(201)).body.id;
  const tax18 = (await ctx.http().post(`${org.base}/tax-rates`).set(owner.auth).send({ name: 'Standard 18%', rate: '18', salesAccountId: org.acc['2300'], purchaseAccountId: org.acc['1450'] }).expect(201)).body.id;

  // Invoice from before the period (1000 + 18% tax), half paid inside it.
  const a = await doc('sales', { kind: 'INVOICE', contactId: customer, issueDate: d(-40), dueDate: d(-25), lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: '1000.00', taxRateId: tax18 }] });
  await pay('sales', customer, d(-10), a.id, '590.00');
  // Invoice inside the period, unpaid, with a credit note of 500 applied.
  const b = await doc('sales', { kind: 'INVOICE', contactId: customer, issueDate: d(-5), dueDate: d(10), lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: '2000.00' }] });
  const cn = await doc('sales', { kind: 'CREDIT_NOTE', contactId: customer, issueDate: d(-1), lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: '500.00' }] });
  await ctx.http().post(`${org.base}/sales/documents/${b.id}/apply-credit`).set(owner.auth).send({ creditDocumentId: cn.id, amount: '500.00' }).expect(200);
  // Bill of 3000, a third paid.
  const c = await doc('purchases', { kind: 'BILL', contactId: vendor, issueDate: d(-20), dueDate: d(10), reference: 'SYN-1', lines: [{ accountId: org.acc['6400'], quantity: '1', unitPrice: '3000.00' }] });
  await pay('purchases', vendor, d(-3), c.id, '1000.00');
  // Paid straight from the bank, and an accrual with no cash.
  await journal(d(-2), [{ accountId: org.acc['6600'], debit: '250.00' }, { accountId: org.acc['1120'], credit: '250.00' }]);
  await journal(d(-2), [{ accountId: org.acc['6200'], debit: '400.00' }, { accountId: org.acc['2200'], credit: '400.00' }]);
  // An expense claim, approved and paid back.
  const claim = (await ctx.http().post(`${org.base}/expense-claims`).set(owner.auth).send({ title: 'Taxi (synthetic)', lines: [{ date: d(-1), accountId: org.acc['6700'], amount: '300.00' }] }).expect(201)).body.id;
  await ctx.http().post(`${org.base}/expense-claims/${claim}/submit`).set(owner.auth).send({}).expect(200);
  await ctx.http().post(`${org.base}/expense-claims/${claim}/approve`).set(approver.auth).send({}).expect(200);
  await ctx.http().post(`${org.base}/expense-claims/${claim}/reimburse`).set(owner.auth).send({ bankAccountId: org.acc['1120'], date: T }).expect(200);
});
afterAll(async () => {
  await ctx.app.close();
});

describe('income statement on a cash basis', () => {
  it('stays accrual unless asked', async () => {
    const r = (await report('')).body;
    expect(r).toMatchObject({ basis: 'ACCRUAL', totalRevenue: '1500.00', totalExpenses: '3950.00', netIncome: '-2450.00', accrualNetIncome: null, notInCash: null });
  });

  it('counts what was paid or applied, net of tax, and leaves out accruals with no cash', async () => {
    const r = (await report('&basis=CASH')).body;
    expect(r).toMatchObject({ basis: 'CASH', totalRevenue: '500.00', totalExpenses: '1550.00', netIncome: '-1050.00', accrualNetIncome: '-2450.00', notInCash: '-1400.00' });
    // 590 of 1180 → 500 of revenue; the credit note settles 500 of invoice B and reverses itself.
    expect(amounts(r.revenue)).toEqual({ '4100': '500.00' });
    expect(amounts(r.expenses)).toEqual({ '6400': '1000.00', '6600': '250.00', '6700': '300.00' });
  });

  it('moves the payment to the period it was made in', async () => {
    const before = (await ctx.http().get(`${org.base}/reports/income-statement?from=${d(-60)}&to=${d(-31)}&basis=CASH`).set(owner.auth).expect(200)).body;
    expect(before).toMatchObject({ totalRevenue: '0.00', totalExpenses: '0.00', accrualNetIncome: '1000.00' });
  });

  it('exports the cash view with a note of the accrual result', async () => {
    const csv = (await ctx.http().get(`${org.base}/reports/export/income-statement?from=${from}&to=${T}&basis=CASH&format=csv`).set(owner.auth).buffer(true).parse((r, cb) => {
      const parts: Buffer[] = [];
      r.on('data', (c: Buffer) => parts.push(c));
      r.on('end', () => cb(null, Buffer.concat(parts)));
    }).expect(200)).body.toString('utf8');
    expect(csv).toContain('Profit and loss (cash basis)');
    expect(csv).toContain('The accrual result for the period is -2,450.00.');
    expect(csv).toContain(',Net loss,-1050.00');
  });

  it('refuses an unknown basis', async () => {
    await ctx.http().get(`${org.base}/reports/income-statement?from=${from}&to=${T}&basis=MODIFIED`).set(owner.auth).expect(400);
  });
});

describe('payroll on a cash basis', () => {
  it('counts a pay run as its salaries and dues are paid, and in full once all are paid', async () => {
    const o = await createOrg(ctx, owner);
    const lastMonth = addDays(`${T.slice(0, 7)}-01`, -1).slice(0, 7);
    const start = `${lastMonth}-01`;
    await ctx.http().put(`${o.base}/payroll/settings`).set(owner.auth).send({ pfEstablishmentCode: 'MHBAN0012345000', esiEmployerCode: '31000123450001001' }).expect(200);
    await ctx.http().post(`${o.base}/payroll/employees`).set(owner.auth).send({
      code: 'E001', name: 'Synthetic Employee', dateOfJoining: start, workStateCode: '27',
      structure: { effectiveFrom: start, components: [{ code: 'BASIC', name: 'Basic', kind: 'WAGES', monthlyAmount: '20000' }, { code: 'HRA', name: 'House rent allowance', kind: 'EXCLUDED', monthlyAmount: '8000' }] },
    }).expect(201);
    const run = (await ctx.http().post(`${o.base}/payroll/runs`).set(owner.auth).send({ period: lastMonth, payDate: addDays(`${T.slice(0, 7)}-01`, -1) }).expect(201)).body;
    const posted = (await ctx.http().post(`${o.base}/payroll/runs/${run.id}/post`).set(owner.auth).expect(200)).body;
    const cash = async () => (await ctx.http().get(`${o.base}/reports/income-statement?from=${start}&to=${T}&basis=CASH`).set(owner.auth).expect(200)).body;
    const accrual = (await ctx.http().get(`${o.base}/reports/income-statement?from=${start}&to=${T}`).set(owner.auth).expect(200)).body;
    expect(Number(accrual.totalExpenses)).toBeGreaterThan(20000);
    expect((await cash()).totalExpenses).toBe('0.00');

    const dues = posted.liabilities.filter((l: { amount: string }) => Number(l.amount) > 0) as { liability: string; amount: string }[];
    const total = dues.reduce((s, l) => s + Number(l.amount), 0);
    const net = dues.find((l) => l.liability === 'NET_PAY')!;
    const pay = (liability: string) => ctx.http().post(`${o.base}/payroll/runs/${run.id}/payments`).set(owner.auth).send({ liability, date: T, bankAccountId: o.acc['1120'], reference: `SYN-${liability}` }).expect(201);
    await pay('NET_PAY');
    // The share paid: net pay out of everything the run owes.
    const share = (Number(accrual.totalExpenses) * Number(net.amount)) / total;
    expect(Math.abs(Number((await cash()).totalExpenses) - share)).toBeLessThan(0.01);
    for (const l of dues) if (l.liability !== 'NET_PAY') await pay(l.liability);
    expect((await cash()).totalExpenses).toBe(accrual.totalExpenses);
  });
});
