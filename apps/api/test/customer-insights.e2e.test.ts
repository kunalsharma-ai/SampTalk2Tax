import { addDays, fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';
import { sqlWrite } from './sql-writes';
import { tenantStorage } from '../src/common/tenant-context';

/**
 * CRM slice 4 (Customer 360) against the real API and database: revenue net of credit notes, direct
 * costs from the customer's projects, payment behaviour from receipts applied, lifetime value from
 * the organisation's own retention, credit risk with its factors and a suggested limit, credit
 * hold blocking invoices, permissions, tenant isolation and the database checks.
 */
const T = today();
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const c: Record<string, string> = {};
let projectId: string;

const raw = (sql: string, ...args: unknown[]) => sqlWrite(ctx, sql, args, { bypass: true });
const invoice = async (who: string, issueDate: string, amount: string, extra: Record<string, unknown> = {}) => {
  const r = await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: c[who], issueDate, dueDate: addDays(issueDate, 30), post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: amount }], ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; total: string };
};
const receipt = (who: string, date: string, documentId: string, amount: string) =>
  ctx.http().post(`${org.base}/sales/payments`).set(owner.auth).send({ contactId: c[who], date, bankAccountId: org.acc['1120'], amount, allocations: [{ documentId, amount }] }).expect(201);
const insights = (who: string, user = owner) => ctx.http().get(`${org.base}/customers/${c[who]}/insights`).set(user.auth);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Insight Owner');
  viewer = await registerUser(ctx, 'Insight Viewer');
  outsider = await registerUser(ctx, 'Insight Outsider');
  org = await createOrg(ctx, owner, { name: 'Insight Traders Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Insights Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  const fy = fiscalYearForDate(T, 4);
  for (const y of [fy - 1, fy - 2]) await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: y });
  for (const name of ['Asha Traders', 'Banyan Retail', 'Cedar Foods', 'Deodar Mills', 'Elm Stores', 'Fig Exports']) {
    c[name] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name, isCustomer: true, ...(name === 'Banyan Retail' ? { creditLimit: '40000.00' } : {}) }).expect(201)).body.id;
  }
  c['Teak Supplies'] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Teak Supplies', isVendor: true }).expect(201)).body.id;

  // Asha: billed 400 days ago and paid on the due date; billed 60 days ago and paid early; a credit note.
  const old = addDays(T, -400);
  const a1 = await invoice('Asha Traders', old, '100000.00');
  await receipt('Asha Traders', addDays(old, 30), a1.id, '100000.00');
  const a2 = await invoice('Asha Traders', addDays(T, -60), '200000.00');
  await receipt('Asha Traders', addDays(T, -35), a2.id, '200000.00');
  await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'CREDIT_NOTE', contactId: c['Asha Traders'], issueDate: addDays(T, -20), dueDate: addDays(T, -20), post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: '20000.00' }] }).expect(201);
  // Banyan: one invoice 70 days past due, over its limit.
  await invoice('Banyan Retail', addDays(T, -100), '50000.00', { overrideCreditLimit: true });
  // Retention: of the five billed a year before last (Asha, Cedar, Deodar, Elm, Fig), Asha, Cedar and Deodar are billed again.
  for (const name of ['Cedar Foods', 'Deodar Mills', 'Elm Stores', 'Fig Exports']) await invoice(name, addDays(T, -420), '10000.00');
  for (const name of ['Cedar Foods', 'Deodar Mills']) await invoice(name, addDays(T, -10), '5000.00');
});
afterAll(async () => {
  await ctx.app.close();
});

describe('projects belong to customers', () => {
  it('links a project to a customer, and only a customer, and only a project', async () => {
    expect((await ctx.http().post(`${org.base}/dimensions`).set(owner.auth).send({ type: 'PROJECT', code: 'X', name: 'Vendor project', contactId: c['Teak Supplies'] }).expect(422)).body.error).toBe('CUSTOMER_NOT_FOUND');
    expect((await ctx.http().post(`${org.base}/dimensions`).set(owner.auth).send({ type: 'DEPARTMENT', code: 'X', name: 'Dept', contactId: c['Asha Traders'] }).expect(422)).body.error).toBe('DIMENSION_INVALID');
    const p = (await ctx.http().post(`${org.base}/dimensions`).set(owner.auth).send({ type: 'PROJECT', code: 'ASHA-AMC', name: 'Asha cold rooms', contactId: c['Asha Traders'] }).expect(201)).body;
    expect(p).toMatchObject({ contactId: c['Asha Traders'], contactName: 'Asha Traders', customer: 'Asha Traders' });
    projectId = p.id;
    const theirs = (await ctx.http().post(`${other.base}/contacts`).set(outsider.auth).send({ name: 'Theirs', isCustomer: true }).expect(201)).body.id;
    expect((await ctx.http().put(`${org.base}/dimensions/${projectId}`).set(owner.auth).send({ code: 'ASHA-AMC', name: 'Asha cold rooms', contactId: theirs, isActive: true }).expect(422)).body.error).toBe('CUSTOMER_NOT_FOUND');
    // Costs on the project: a bill from the vendor and a salary journal.
    await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: c['Teak Supplies'], reference: 'TS-1', issueDate: addDays(T, -40), dueDate: addDays(T, -10), post: true, lines: [{ accountId: org.acc['6400'], quantity: '1', unitPrice: '45000.00', projectId }] }).expect(201);
    await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: addDays(T, -30), memo: 'Technician time', post: true, lines: [{ accountId: org.acc['6100'], debit: '15000.00', projectId }, { accountId: org.acc['1120'], credit: '15000.00' }] }).expect(201);
  });
});

describe('a customer 360', () => {
  it('works out profit, payment behaviour, lifetime value and risk for a good customer', async () => {
    const r = (await insights('Asha Traders', viewer).expect(200)).body;
    expect(r).toMatchObject({ name: 'Asha Traders', invoices: 2, customerSince: addDays(T, -400), creditHold: false, can: { manage: false } });
    expect(r.toDate).toEqual({ revenue: '280000.00', cost: '60000.00', profit: '220000.00', margin: '0.7857' });
    expect(r.trailing).toEqual({ revenue: '180000.00', cost: '60000.00', profit: '120000.00', margin: '0.6667' });
    expect(r.months).toHaveLength(12);
    expect(r.months.at(-1).month).toBe(T.slice(0, 7));
    expect(r.months.reduce((s: number, m: { revenue: string }) => s + Number(m.revenue), 0)).toBe(180000);
    expect(r.projects).toEqual([{ id: projectId, code: 'ASHA-AMC', name: 'Asha cold rooms', isActive: true, cost: '60000.00' }]);
    expect(r.behaviour).toMatchObject({ invoices: 2, paidInvoices: 2, averageDaysToPay: 27, averageDaysLate: 0, onTimeShare: 1, open: '0.00', overdue: '0.00', oldestOverdueDays: 0 });
    expect(r.retention).toEqual({ rate: 0.6, customers: 5, retained: 3 });
    expect(r.lifetime).toMatchObject({ earnedToDate: '220000.00', annualRevenue: '180000.00', annualProfit: '120000.00', expectedYears: '1.5', assumedYears: false, value: '400000.00' });
    expect(r.risk).toMatchObject({ score: 0, rating: 'LOW', suggestedLimit: '34000.00' });
    expect(r.openInvoices).toEqual([]);
  });

  it('scores a slow payer over its limit as high risk, with the reasons', async () => {
    const r = (await insights('Banyan Retail').expect(200)).body;
    expect(r.behaviour).toMatchObject({ open: '50000.00', overdue: '50000.00', oldestOverdueDays: 70, paidInvoices: 0 });
    expect(Object.fromEntries(r.risk.factors.map((f: { key: string; points: number }) => [f.key, f.points]))).toEqual({ OVERDUE_SHARE: 30, OLDEST_OVERDUE: 18, DAYS_LATE: 0, LIMIT_USAGE: 15, SLOWING: 0 });
    expect(r.risk).toMatchObject({ score: 63, rating: 'HIGH', suggestedLimit: null });
    expect(r.risk.factors[3].detail).toBe('125% of the credit limit is used');
    expect(r.lifetime.value).toBe('125000.00'); // 50,000 earned + 50,000 a year × 1.5 years
    expect(r.openInvoices).toHaveLength(1);
  });

  it('ranks every customer by lifetime value with a summary', async () => {
    const r = (await ctx.http().get(`${org.base}/customers/insights`).set(viewer.auth).expect(200)).body;
    expect(r.customers.map((x: { name: string }) => x.name).slice(0, 2)).toEqual(['Asha Traders', 'Banyan Retail']);
    expect(r.customers).toHaveLength(6);
    expect(r.summary).toMatchObject({ customers: 6, onHold: 0 });
    expect(r.summary.ratings.HIGH + r.summary.ratings.VERY_HIGH).toBeGreaterThanOrEqual(1);
    const elm = r.customers.find((x: { name: string }) => x.name === 'Elm Stores');
    expect(elm.lifetimeValue).toBe('10000.00'); // not billed for a year: nothing more is expected
  });

  it('refuses vendors, other organisations and unknown customers', async () => {
    expect((await insights('Teak Supplies').expect(422)).body.error).toBe('NOT_A_CUSTOMER');
    await ctx.http().get(`${org.base}/customers/${c['Asha Traders']}/insights`).set(outsider.auth).expect(404);
    await ctx.http().get(`${other.base}/customers/${c['Asha Traders']}/insights`).set(outsider.auth).expect(404);
  });
});

describe('credit hold', () => {
  it('needs a reason and permission, blocks posting invoices, and is lifted again', async () => {
    const url = `${org.base}/customers/${c['Banyan Retail']}/credit-hold`;
    await ctx.http().put(url).set(viewer.auth).send({ hold: true, reason: 'Overdue' }).expect(403);
    expect((await ctx.http().put(url).set(owner.auth).send({ hold: true }).expect(422)).body.error).toBe('REASON_REQUIRED');
    expect((await ctx.http().put(url).set(owner.auth).send({ hold: false }).expect(409)).body.error).toBe('NOT_ON_HOLD');
    expect((await ctx.http().put(url).set(owner.auth).send({ hold: true, reason: '70 days overdue on INV-0006' }).expect(200)).body).toMatchObject({ creditHold: true });
    expect((await ctx.http().put(url).set(owner.auth).send({ hold: true, reason: 'Again' }).expect(409)).body.error).toBe('ALREADY_ON_HOLD');

    const contact = (await ctx.http().get(`${org.base}/contacts/${c['Banyan Retail']}`).set(owner.auth).expect(200)).body;
    expect(contact).toMatchObject({ creditHold: true, creditHoldReason: '70 days overdue on INV-0006' });
    const r = (await insights('Banyan Retail').expect(200)).body;
    expect(r).toMatchObject({ creditHold: true, creditHoldBy: 'Insight Owner' });

    const draft = (await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: c['Banyan Retail'], issueDate: T, dueDate: addDays(T, 30), lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: '1000.00' }] }).expect(201)).body;
    const blocked = await ctx.http().post(`${org.base}/sales/documents/${draft.id}/post`).set(owner.auth).send({ overrideCreditLimit: true }).expect(409);
    expect(blocked.body.error).toBe('CREDIT_HOLD');
    expect(blocked.body.message).toContain('70 days overdue on INV-0006');
    // A credit note still posts while on hold.
    await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'CREDIT_NOTE', contactId: c['Banyan Retail'], issueDate: T, dueDate: T, post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: '500.00' }] }).expect(201);
    expect((await ctx.http().get(`${org.base}/customers/insights`).set(owner.auth).expect(200)).body.summary.onHold).toBe(1);

    await ctx.http().put(url).set(owner.auth).send({ hold: false, reason: 'Paid in part, plan agreed' }).expect(200);
    await ctx.http().post(`${org.base}/sales/documents/${draft.id}/post`).set(owner.auth).send({ overrideCreditLimit: true }).expect(200);
    const audit = await tenantStorage.run({ bypass: true }, async () => await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, entityId: c['Banyan Retail'], action: { startsWith: 'contact.credit_hold' } }, orderBy: { createdAt: 'asc' } }));
    expect(audit.map((a) => a.action)).toEqual(['contact.credit_hold_set', 'contact.credit_hold_lifted']);
  });

  it('cannot be on hold without a reason in the database, and projects of departments have no customer', async () => {
    await expect(raw(`UPDATE contacts SET credit_hold = true WHERE id = '${c['Cedar Foods']}'`)).rejects.toThrow(/contacts_credit_hold_check/);
    const dept = (await ctx.http().post(`${org.base}/dimensions`).set(owner.auth).send({ type: 'DEPARTMENT', code: 'OPS', name: 'Operations' }).expect(201)).body.id;
    await expect(raw(`UPDATE dimension_values SET contact_id = '${c['Cedar Foods']}' WHERE id = '${dept}'`)).rejects.toThrow(/dimension_values_contact_project_check/);
  });
});
