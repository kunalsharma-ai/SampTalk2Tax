import { addDays, fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Predictive payment scheduling (AP-034) against the real API and database: open bills given a
 * payment date from the cash in the bank and the receipt expected from a customer who pays on
 * time, keeping a buffer; an overdue bill paid today, one on its due date, one waiting for the
 * receipt, one the cash cannot cover, one blocked and one due after the period; applying the dates
 * as payment plans; permissions, validation and tenant isolation.
 */
const T = today();
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const v: Record<string, string> = {};
const b: Record<string, string> = {};
let invoiceId: string;

type Bill = { id: string; number: string; vendor: string; status: string; statusLabel: string; payOn: string | null; daysLate: number; reason: string; plannedOn: string | null };
type Res = { asOf: string; days: number; currency: string; summary: Record<string, unknown> & { applicable: number }; weeks: { from: string; receipts: string; payments: string; closing: string }[]; bills: Bill[] };
const get = (q = '?buffer=10000', user = owner) => ctx.http().get(`${org.base}/purchases/payment-schedule/predicted${q}`).set(user.auth);
const bill = async (vendor: string, issueAgo: number, dueIn: number, amount: string) =>
  (await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: v[vendor], issueDate: addDays(T, -issueAgo), dueDate: addDays(T, dueIn), post: true, lines: [{ accountId: org.acc['6600'], quantity: '1', unitPrice: amount }] }).expect(201)).body.id as string;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Schedule Owner');
  viewer = await registerUser(ctx, 'Schedule Viewer');
  outsider = await registerUser(ctx, 'Schedule Outsider');
  org = await createOrg(ctx, owner, { name: 'Forward Pay Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Forward Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fiscalYearForDate(T, 4) - 1 });
  await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: addDays(T, -150), post: true, memo: 'Capital', lines: [{ accountId: org.acc['1120'], debit: '50000.00' }, { accountId: org.acc['3100'], credit: '50000.00' }] }).expect(201);
  // A customer who has paid three invoices on their due dates: 30,000 in the bank.
  const asha = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Asha Traders', isCustomer: true }).expect(201)).body.id as string;
  const invoice = async (issueDate: string, amount: string) => (await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: asha, issueDate, dueDate: addDays(issueDate, 15), post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: amount }] }).expect(201)).body.id as string;
  for (let k = 0; k < 3; k++) {
    const issued = addDays(T, -60 - k * 30);
    const id = await invoice(issued, '10000.00');
    await ctx.http().post(`${org.base}/sales/payments`).set(owner.auth).send({ contactId: asha, date: addDays(issued, 15), bankAccountId: org.acc['1120'], amount: '10000.00', allocations: [{ documentId: id, amount: '10000.00' }] }).expect(201);
  }
  invoiceId = await invoice(T, '50000.00');
  for (const name of ['Oak Metals', 'Pine Paper', 'Elm Freight', 'Teak Works', 'Fir Logistics', 'Ash Unverified']) {
    v[name] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name, isVendor: true }).expect(201)).body.id;
    await ctx.http().put(`/v1/orgs/${org.orgId}/contacts/${v[name]}/bank-details`).set(owner.auth).send({ accountName: name, accountNumber: `5010001${Object.keys(v).length}2345`, ifsc: 'HDFC0001234' }).expect(200);
    if (name !== 'Ash Unverified') await ctx.http().post(`/v1/orgs/${org.orgId}/contacts/${v[name]}/bank-details/verify`).set(owner.auth).send({ note: 'Checked against a cancelled cheque' }).expect(200);
  }
  b.oak = await bill('Oak Metals', 50, -20, '30000');
  b.pine = await bill('Pine Paper', 10, 5, '40000');
  b.elm = await bill('Elm Freight', 10, 10, '25000');
  b.teak = await bill('Teak Works', 10, 12, '60000');
  b.fir = await bill('Fir Logistics', 10, 80, '7000');
  b.ash = await bill('Ash Unverified', 10, 3, '5000');
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('predictive payment dates', () => {
  it('dates each bill from the cash and the receipts expected, keeping the buffer', async () => {
    const pred = (await ctx.http().get(`${org.base}/payment-predictions`).set(owner.auth).expect(200)).body as { invoices: { invoiceId: string; predictedPayDate: string }[] };
    const P = pred.invoices.find((i) => i.invoiceId === invoiceId)!.predictedPayDate;
    expect(P).toBe(addDays(T, 15));
    const r = (await get('?buffer=10000', viewer).expect(200)).body as Res;
    expect(r).toMatchObject({ asOf: T, days: 60, currency: 'INR' });
    expect(r.bills.map((x) => [x.id, x.status, x.payOn, x.daysLate])).toEqual([
      [b.oak, 'OVERDUE_NOW', T, 20],
      [b.pine, 'ON_DUE', addDays(T, 5), 0],
      [b.elm, 'DELAYED', P, 5],
      [b.teak, 'NOT_COVERED', null, 0],
      [b.ash, 'BLOCKED', null, 0],
      [b.fir, 'AFTER_PERIOD', null, 0],
    ]);
    const elm = r.bills.find((x) => x.id === b.elm)!;
    expect(elm.statusLabel).toBe('Pay later, when cash comes in');
    expect(elm.reason).toMatch(/^Waits 5 days past its due date for 1 expected receipt, the largest ₹50,000\.00 from Asha Traders \(INV-\d+\) by /);
    expect(r.summary).toMatchObject({ cash: '80000.00', buffer: '10000.00', receipts: '50000.00', onTime: { count: 2, amount: '70000.00' }, delayed: { count: 1, amount: '25000.00', averageDaysLate: 5 }, notCovered: { count: 1, amount: '60000.00' }, endBalance: '35000.00', lowest: { balance: '10000.00', date: addDays(T, 5) }, applicable: 3 });
    expect(r.weeks).toHaveLength(9);
    expect(r.weeks[0]).toMatchObject({ from: T, receipts: '0.00', payments: '-70000.00', closing: '10000.00' });
  });

  it('plans the dates as payment plans, once', async () => {
    await ctx.http().post(`${org.base}/purchases/payment-schedule/predicted/apply?buffer=10000`).set(viewer.auth).send({}).expect(403);
    const one = (await ctx.http().post(`${org.base}/purchases/payment-schedule/predicted/apply?buffer=10000`).set(owner.auth).send({ documentIds: [b.pine] }).expect(200)).body as { planned: number; result: Res };
    expect(one.planned).toBe(1);
    expect(one.result.bills.find((x) => x.id === b.pine)!.plannedOn).toBe(addDays(T, 5));
    const rest = (await ctx.http().post(`${org.base}/purchases/payment-schedule/predicted/apply?buffer=10000`).set(owner.auth).send({}).expect(200)).body as { planned: number; result: Res };
    expect(rest.planned).toBe(2);
    expect(rest.result.summary.applicable).toBe(0);
    const schedule = (await ctx.http().get(`${org.base}/purchases/payment-schedule`).set(owner.auth).expect(200)).body as { bills: { id: string; plan: { payDate: string; note: string | null } | null }[] };
    const plan = (id: string) => schedule.bills.find((x) => x.id === id)?.plan;
    expect(plan(b.elm)).toMatchObject({ payDate: addDays(T, 15), note: 'Predicted date (AP-034)' });
    expect(plan(b.oak)).toMatchObject({ payDate: T });
    expect(plan(b.teak) ?? null).toBeNull();
    expect((await ctx.http().post(`${org.base}/purchases/payment-schedule/predicted/apply?buffer=10000`).set(owner.auth).send({}).expect(200)).body.planned).toBe(0);
  });

  it('checks the query', async () => {
    await get('?days=45').expect(400);
    await get('?buffer=abc').expect(400);
    await ctx.http().post(`${org.base}/purchases/payment-schedule/predicted/apply`).set(owner.auth).send({ documentIds: ['nope'] }).expect(400);
  });

  it('keeps organisations apart', async () => {
    await ctx.http().get(`${org.base}/purchases/payment-schedule/predicted`).set(outsider.auth).expect(404);
    const mine = (await ctx.http().get(`${other.base}/purchases/payment-schedule/predicted`).set(outsider.auth).expect(200)).body as Res;
    expect(mine.bills).toEqual([]);
  });
});
