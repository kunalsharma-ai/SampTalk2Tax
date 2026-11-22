import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * EXP-014: department budgets against the real API and database. Expense claim lines carry a
 * department into the books; each department's budget is compared with what it spent (claims and
 * bills) and what is waiting for approval; a claim waiting for approval shows whether it would
 * take a department over.
 */
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

let ctx: Ctx;
let owner: TestUser;
let employee: TestUser;
let approver: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const dep: Record<string, string> = {};
let waitingId: string;
let fiscalYear: number;

const claim = async (lines: object[]) => (await ctx.http().post(`${org.base}/expense-claims`).set(employee.auth).send({ title: 'Synthetic client visit', lines }));
const line = (department: string | null, amount: string, code = '6700') => ({ date: T, accountId: org.acc[code], merchant: 'Synthetic Cabs', amount, ...(department ? { departmentId: dep[department] } : {}) });
const report = async (auth = owner.auth) => (await ctx.http().get(`${org.base}/department-budgets`).set(auth).expect(200)).body;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Budget Owner');
  employee = await registerUser(ctx, 'Budget Employee');
  approver = await registerUser(ctx, 'Budget Approver');
  org = await createOrg(ctx, owner, { name: 'Department Budgets Pvt Ltd' });
  for (const [u, role] of [[employee, 'EMPLOYEE'], [approver, 'APPROVER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  for (const [code, name] of [['D01', 'Sales'], ['D02', 'Field service'], ['D03', 'Old projects']]) dep[name] = (await ctx.http().post(`${org.base}/dimensions`).set(owner.auth).send({ type: 'DEPARTMENT', code, name }).expect(201)).body.id;
  await ctx.http().put(`${org.base}/dimensions/${dep['Old projects']}`).set(owner.auth).send({ code: 'D03', name: 'Old projects', isActive: false }).expect(200);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('departments on expense claims', () => {
  it('lists active departments for the person claiming', async () => {
    const d = (await ctx.http().get(`${org.base}/expense-departments`).set(employee.auth).expect(200)).body;
    expect(d.departments.map((x: { name: string }) => x.name)).toEqual(['Sales', 'Field service']);
  });

  it('refuses a department that is not an active department', async () => {
    const bad = await claim([{ ...line(null, '100.00'), departmentId: '00000000-0000-4000-8000-000000000000' }]);
    expect(bad.status).toBe(422);
    expect(bad.body.details.issues).toEqual(['Line 1: department not found']);
    const inactive = await claim([line('Old projects', '100.00')]);
    expect(inactive.body.details.issues).toEqual(['Line 1: Old projects is no longer an active department']);
  });

  it('carries the department into the books when the claim is approved', async () => {
    const c = (await claim([line('Sales', '6000.00'), line('Field service', '3000.00'), line(null, '450.00')])).body;
    expect(c.lines.map((l: { departmentId: string | null }) => l.departmentId)).toEqual([dep.Sales, dep['Field service'], null]);
    await ctx.http().post(`${org.base}/expense-claims/${c.id}/submit`).set(employee.auth).send({}).expect(200);
    const approved = (await ctx.http().post(`${org.base}/expense-claims/${c.id}/approve`).set(approver.auth).send({}).expect(200)).body;
    const entry = (await ctx.http().get(`${org.base}/journals/${approved.journalEntryId}`).set(owner.auth).expect(200)).body;
    const debits = entry.lines.filter((l: { debit: string }) => Number(l.debit) > 0).map((l: { debit: string; departmentId: string | null }) => [l.debit, l.departmentId]);
    expect(debits).toEqual(expect.arrayContaining([['6000.00', dep.Sales], ['3000.00', dep['Field service']], ['450.00', null]]));
  });
});

describe('department budgets', () => {
  it('lets only budget managers set a budget, and audits each change', async () => {
    fiscalYear = (await report()).fiscalYear;
    await ctx.http().put(`${org.base}/department-budgets`).set(approver.auth).send({ departmentId: dep.Sales, fiscalYear, amount: '10000.00' }).expect(403);
    await ctx.http().get(`${org.base}/department-budgets`).set(employee.auth).expect(403);
    await ctx.http().put(`${org.base}/department-budgets`).set(owner.auth).send({ departmentId: dep.Sales, fiscalYear, amount: 'lots' }).expect(400);
    await ctx.http().put(`${org.base}/department-budgets`).set(owner.auth).send({ departmentId: '00000000-0000-4000-8000-000000000000', fiscalYear, amount: '1.00' }).expect(404);
    await ctx.http().put(`${org.base}/department-budgets`).set(owner.auth).send({ departmentId: dep.Sales, fiscalYear, amount: '8000' }).expect(200);
    await ctx.http().put(`${org.base}/department-budgets`).set(owner.auth).send({ departmentId: dep.Sales, fiscalYear, amount: '10000', note: 'Raised for the trade fair' }).expect(200);
    await ctx.http().put(`${org.base}/department-budgets`).set(owner.auth).send({ departmentId: dep['Field service'], fiscalYear, amount: '1000000.00' }).expect(200);
    const audits = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, action: 'department_budget.set' }, orderBy: { createdAt: 'asc' } });
    expect(audits.map((a) => (a.data as { amount: unknown }).amount)).toEqual([{ from: null, to: '8000.00' }, { from: '8000.00', to: '10000.00' }, { from: null, to: '1000000.00' }]);
  });

  it('compares each budget with what was spent and what is waiting', async () => {
    // A bill for the field team counts too.
    const vendor = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Synthetic Tools Co', isVendor: true }).expect(201)).body;
    await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: vendor.id, issueDate: T, post: true, lines: [{ accountId: org.acc['6700'], quantity: '1', unitPrice: '2000.00', departmentId: dep['Field service'] }] }).expect(201);
    const waiting = (await claim([line('Sales', '5000.00')])).body;
    waitingId = waiting.id;
    await ctx.http().post(`${org.base}/expense-claims/${waiting.id}/submit`).set(employee.auth).send({}).expect(200);

    const r = await report(approver.auth);
    expect(r).toMatchObject({ fiscalYear, currency: 'INR', canManage: false, totals: { budget: '1010000.00', actual: '11000.00', committed: '5000.00' } });
    const sales = r.rows.find((x: { name: string }) => x.name === 'Sales');
    expect(sales).toMatchObject({ status: 'AT_RISK', budget: '10000.00', actual: '6000.00', committed: '5000.00', remaining: '-1000.00', usedPercent: '60.0', note: 'Raised for the trade fair' });
    expect(sales.reason).toBe('Claims waiting for approval would take it ₹1,000.00 over');
    expect(r.rows.find((x: { name: string }) => x.name === 'Field service')).toMatchObject({ status: 'ON_TRACK', actual: '5000.00', committed: '0.00' });
    // Inactive departments with nothing on them are left out.
    expect(r.rows.map((x: { name: string }) => x.name)).not.toContain('Old projects');
    expect(r.rows[0].name).toBe('Sales');
  });

  it('shows the approver what a waiting claim would do to the budget', async () => {
    const i = (await ctx.http().get(`${org.base}/expense-claims/${waitingId}/budget-impact`).set(approver.auth).expect(200)).body;
    expect(i.departments).toEqual([{ departmentId: dep.Sales, name: 'Sales', amount: '5000.00', budget: '10000.00', remainingBefore: '4000.00', remainingAfter: '-1000.00', takesOver: true }]);
    await ctx.http().get(`${org.base}/expense-claims/00000000-0000-4000-8000-000000000000/budget-impact`).set(approver.auth).expect(404);
    // Once approved it is spending, and there is nothing left to weigh.
    await ctx.http().post(`${org.base}/expense-claims/${waitingId}/approve`).set(approver.auth).send({}).expect(200);
    expect((await ctx.http().get(`${org.base}/expense-claims/${waitingId}/budget-impact`).set(approver.auth).expect(200)).body.departments).toEqual([]);
    const sales = (await report()).rows.find((x: { name: string }) => x.name === 'Sales');
    expect(sales).toMatchObject({ status: 'OVER', actual: '11000.00', committed: '0.00', reason: 'Spent ₹1,000.00 more than the budget' });
  });

  it('keeps budgets to their own year and organisation', async () => {
    const next = await report();
    const other = (await ctx.http().get(`${org.base}/department-budgets?fiscalYear=${fiscalYear + 1}`).set(owner.auth).expect(200)).body;
    expect(other.rows.every((x: { budget: string | null }) => x.budget === null)).toBe(true);
    expect(next.rows.some((x: { budget: string | null }) => x.budget !== null)).toBe(true);
    const elsewhere = await createOrg(ctx, owner, { name: 'Other Budgets Ltd' });
    await ctx.http().put(`${elsewhere.base}/department-budgets`).set(owner.auth).send({ departmentId: dep.Sales, fiscalYear, amount: '1.00' }).expect(404);
  });
});
