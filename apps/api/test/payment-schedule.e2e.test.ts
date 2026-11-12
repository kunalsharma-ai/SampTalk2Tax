/**
 * AP-007 payment scheduling against the real API and database: open bills listed with suggested
 * dates; a plan set, checked (past date, more than is left) and changed; part payments; plans by
 * week against the bank balance (a short week flagged); auto-planning on a pay weekday; a bill paid
 * leaves the schedule and a part-paid bill pays at most what is left; permissions, isolation and
 * the database guard.
 */
import { addDays } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';
import { sqlWrite } from './sql-writes';

let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const T = today();
let vendor: string;
const bills: Record<string, { id: string; number: string }> = {};
const S = () => `${org.base}/purchases/payment-schedule`;
const raw = (sql: string, ...args: unknown[]) => sqlWrite(ctx, sql, args, { bypass: true });
const bill = async (amount: string, dueDate: string, issueDate = T) =>
  (await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: vendor, issueDate, dueDate, post: true, lines: [{ accountId: org.acc['6600'], quantity: '1', unitPrice: amount }] }).expect(201)).body as { id: string; number: string };
const find = (s: { bills: { id: string }[] }, id: string) => s.bills.find((b) => b.id === id) as any;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Schedule Owner');
  viewer = await registerUser(ctx, 'Schedule Viewer');
  outsider = await registerUser(ctx, 'Schedule Outsider');
  org = await createOrg(ctx, owner, { name: 'Schedule Traders' });
  other = await createOrg(ctx, outsider, { name: 'Other Schedules' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  vendor = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Cedar Hardware', isVendor: true }).expect(201)).body.id;
  await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: addDays(T, -30), post: true, memo: 'Capital', lines: [{ accountId: org.acc['1120'], debit: '50000.00' }, { accountId: org.acc['3100'], credit: '50000.00' }] }).expect(201);
  bills.old = await bill('10000', addDays(T, -5), addDays(T, -35));
  bills.soon = await bill('30000', addDays(T, 9));
  bills.later = await bill('25000', addDays(T, 20));
});
afterAll(async () => {
  await ctx.app.close();
});

describe('payment schedule', () => {
  it('lists open bills with suggested dates and the cash on hand', async () => {
    const s = (await ctx.http().get(S()).set(viewer.auth).expect(200)).body;
    expect(s).toMatchObject({ today: T, currency: 'INR', totals: { open: '65000.00', planned: '0.00', unplanned: 3, overdueUnplanned: 1, late: 0 }, can: { plan: false } });
    expect(s.cash.total).toBe('50000.00');
    expect(find(s, bills.old.id)).toMatchObject({ overdue: true, suggested: T, plan: null, due: '10000.00' });
    expect(find(s, bills.soon.id).suggested).toBe(addDays(T, 9));
    expect(s.weeks).toHaveLength(8);
    expect(s.weeks.every((w: { amount: string; balanceAfter: string }) => w.amount === '0.00' && w.balanceAfter === '50000.00')).toBe(true);
  });

  it('plans a bill, checks the plan, and shows a short week', async () => {
    await ctx.http().put(`${S()}/bills/${bills.soon.id}`).set(viewer.auth).send({ payDate: T }).expect(403);
    expect((await ctx.http().put(`${S()}/bills/${bills.soon.id}`).set(owner.auth).send({ payDate: addDays(T, -1) }).expect(422)).body.error).toBe('PLAN_INVALID');
    expect((await ctx.http().put(`${S()}/bills/${bills.soon.id}`).set(owner.auth).send({ payDate: T, amount: '30000.01' }).expect(422)).body.message).toMatch(/more than the 30000.00 left/);
    let s = (await ctx.http().put(`${S()}/bills/${bills.soon.id}`).set(owner.auth).send({ payDate: T, note: 'Before the Diwali break' }).expect(200)).body;
    expect(find(s, bills.soon.id).plan).toMatchObject({ payDate: T, amount: '30000.00', partial: false, timing: 'ON_TIME', late: false, by: 'Schedule Owner', note: 'Before the Diwali break' });
    // The later bill planned after its due date is late; together they exceed the cash.
    s = (await ctx.http().put(`${S()}/bills/${bills.later.id}`).set(owner.auth).send({ payDate: addDays(T, 21) }).expect(200)).body;
    expect(find(s, bills.later.id).plan).toMatchObject({ timing: 'LATE', late: true });
    expect(s.totals).toMatchObject({ planned: '55000.00', unplanned: 1, late: 1 });
    expect(s.weeks[0]).toMatchObject({ payments: 1, amount: '30000.00', balanceAfter: '20000.00', short: false });
    const short = s.weeks.find((w: { short: boolean }) => w.short);
    expect(short).toMatchObject({ payments: 1, amount: '25000.00', balanceAfter: '-5000.00' });
    // Re-planned for part of the bill: the week totals follow.
    s = (await ctx.http().put(`${S()}/bills/${bills.later.id}`).set(owner.auth).send({ payDate: addDays(T, 14), amount: '15000' }).expect(200)).body;
    expect(find(s, bills.later.id).plan).toMatchObject({ amount: '15000.00', partial: true, timing: 'ON_TIME' });
    expect(s.weeks.some((w: { short: boolean }) => w.short)).toBe(false);
    // Plans are listed first, by date.
    expect(s.bills.map((b: { id: string }) => b.id)).toEqual([bills.soon.id, bills.later.id, bills.old.id]);
  });

  it('plans the rest automatically on a pay weekday', async () => {
    await ctx.http().post(`${S()}/auto`).set(viewer.auth).send({}).expect(403);
    const r = (await ctx.http().post(`${S()}/auto`).set(owner.auth).send({ payWeekday: 5 }).expect(200)).body;
    expect(r.planned).toBe(1);
    const p = find(r.schedule, bills.old.id).plan;
    // Overdue: the next Friday on or after today.
    expect(new Date(`${p.payDate}T00:00:00Z`).getUTCDay()).toBe(5);
    expect(p.payDate >= T && p.payDate <= addDays(T, 6)).toBe(true);
    expect(p.timing).toBe('OVERDUE');
    // Already planned bills are left as they are.
    expect((await ctx.http().post(`${S()}/auto`).set(owner.auth).send({ payWeekday: 5 }).expect(200)).body.planned).toBe(0);
    expect(find(r.schedule, bills.soon.id).plan.payDate).toBe(T);
  });

  it('follows payments: a part-paid bill pays what is left, a paid bill leaves the schedule', async () => {
    await ctx.http().post(`${org.base}/purchases/payments`).set(owner.auth).send({ contactId: vendor, date: T, bankAccountId: org.acc['1120'], amount: '20000', allocations: [{ documentId: bills.later.id, amount: '20000' }] }).expect(201);
    let s = (await ctx.http().get(S()).set(owner.auth).expect(200)).body;
    expect(find(s, bills.later.id)).toMatchObject({ due: '5000.00', plan: { amount: '5000.00', partial: false } });
    expect(s.cash.total).toBe('30000.00');
    await ctx.http().post(`${org.base}/purchases/payments`).set(owner.auth).send({ contactId: vendor, date: T, bankAccountId: org.acc['1120'], amount: '5000', allocations: [{ documentId: bills.later.id, amount: '5000' }] }).expect(201);
    s = (await ctx.http().get(S()).set(owner.auth).expect(200)).body;
    expect(find(s, bills.later.id)).toBeUndefined();
    expect((await ctx.http().put(`${S()}/bills/${bills.later.id}`).set(owner.auth).send({ payDate: T }).expect(409)).body.message).toMatch(/nothing left to pay/);
  });

  it('removes a plan, refuses drafts, and keeps each organisation to its own bills', async () => {
    const s = (await ctx.http().delete(`${S()}/bills/${bills.soon.id}`).set(owner.auth).expect(200)).body;
    expect(find(s, bills.soon.id).plan).toBeNull();
    await ctx.http().delete(`${S()}/bills/${bills.soon.id}`).set(owner.auth).expect(404);
    const draft = (await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: vendor, issueDate: T, lines: [{ accountId: org.acc['6600'], quantity: '1', unitPrice: '5' }] }).expect(201)).body;
    expect((await ctx.http().put(`${S()}/bills/${draft.id}`).set(owner.auth).send({ payDate: T }).expect(409)).body.message).toMatch(/posted bill/);
    await ctx.http().put(`${other.base}/purchases/payment-schedule/bills/${bills.soon.id}`).set(outsider.auth).send({ payDate: T }).expect(404);
    await ctx.http().get(S()).set(outsider.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/purchases/payment-schedule`).set(outsider.auth).expect(200)).body.bills).toEqual([]);
    // The database only takes plans for bills.
    const customer = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'A Customer', isCustomer: true }).expect(201)).body.id;
    const inv = (await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: customer, issueDate: T, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: '5' }] }).expect(201)).body;
    await expect(raw(`INSERT INTO bill_payment_plans (id, org_id, document_id, pay_date, updated_by_id, updated_at) SELECT gen_random_uuid(), org_id, id, CURRENT_DATE, created_by_id, now() FROM documents WHERE id = '${inv.id}'`)).rejects.toThrow(/for a vendor bill/);
  });
});
