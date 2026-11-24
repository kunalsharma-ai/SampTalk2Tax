import { addDays, fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * DASH-047/048/054/056 against the real API and database: the accountant's work queue (draft
 * journals and documents, journal approvals, bank reconciliation, the close), the financial
 * controller's closes, approvals, separation of duties, controls and findings, the internal
 * auditor's audits, findings, evidence and failed controls, and the procurement manager's orders,
 * contracts and vendor risk; which dashboards each role may open; isolation.
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

const post = async (path: string, body: object, status = 201) => {
  const r = await ctx.http().post(`${org.base}${path}`).set(owner.auth).send(body);
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const brief = async (role: string, auth = owner.auth, status = 200) => (await ctx.http().get(`${org.base}/reports/role-dashboards/${role}`).set(auth).expect(status)).body;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Books Owner');
  viewer = await registerUser(ctx, 'Books Viewer');
  employee = await registerUser(ctx, 'Books Employee');
  outsider = await registerUser(ctx, 'Books Outsider');
  org = await createOrg(ctx, owner, { name: 'Books Dashboards Pvt Ltd' });
  for (const [u, role] of [[viewer, 'VIEWER'], [employee, 'EMPLOYEE']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  for (const fy of new Set([fiscalYearForDate(d(-40), 4), fiscalYearForDate(T, 4)])) await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fy });
  const a = org.acc;
  c.customer = (await post('/contacts', { name: 'Asha Traders', isCustomer: true })).id;
  c.vendor = (await post('/contacts', { name: 'Granite Supplies', isVendor: true })).id;
  // Work waiting: a draft journal and a draft invoice.
  c.journal = (await post('/journals', { date: d(-1), memo: 'Accrue November rent', lines: [{ accountId: a['6100'], debit: '25000.00' }, { accountId: a['3100'], credit: '25000.00' }] })).id;
  await post('/sales/documents', { kind: 'INVOICE', contactId: c.customer, issueDate: d(-1), dueDate: d(20), lines: [{ accountId: a['4100'], quantity: '1', unitPrice: '10000.00' }] });
  // An issued purchase order, nothing received, expected two days ago.
  const po = await post('/purchases/orders', { contactId: c.vendor, orderDate: d(-10), expectedDate: d(-2), lines: [{ accountId: a['6600'], description: 'Packing cartons', quantity: '100', unitPrice: '40' }] });
  c.po = (await ctx.http().post(`${org.base}/purchases/orders/${po.id}/issue`).set(owner.auth).expect(200)).body.id;
  // A control and an audit finding.
  await post('/controls', { templateId: 'BANK_RECONCILIATION', ownerId: owner.id });
  c.finding = (await post('/audit-findings', { title: 'Payments approved after release', description: 'Two payments were approved after the bank sent them.', severity: 'HIGH', ownerId: owner.id, plan: 'Approve payment batches before release' })).id;
});
afterAll(async () => {
  await ctx.app.close();
});

describe('books and audit dashboards', () => {
  it('says which dashboards each role may open', async () => {
    const forOwner = (await ctx.http().get(`${org.base}/reports/role-dashboards`).set(owner.auth).expect(200)).body.roles;
    expect(forOwner.filter((r: { available: boolean }) => !r.available)).toEqual([]);
    const forViewer = (await ctx.http().get(`${org.base}/reports/role-dashboards`).set(viewer.auth).expect(200)).body.roles;
    expect(forViewer.filter((r: { available: boolean }) => !r.available).map((r: { role: string }) => r.role)).toEqual(['CONTROLLER', 'INTERNAL_AUDITOR']);
  });

  it("gives the accountant the work queue and the month's close", async () => {
    const r = await brief('ACCOUNTANT');
    expect(r).toMatchObject({ role: 'ACCOUNTANT', name: 'Accountant' });
    const v = r.accountant;
    expect(v.queue).toMatchObject({ draftJournals: 1, draftDocuments: 1, approvals: 0, reconciliation: 0 });
    expect(v.draftJournals).toEqual([{ id: c.journal, date: d(-1), memo: 'Accrue November rent' }]);
    expect(v.draftDocuments).toEqual([{ kind: 'INVOICE', count: 1 }]);
    expect(v.close.length).toBeGreaterThanOrEqual(1);
    expect(v.close[0]).toMatchObject({ current: true, closeStatus: 'NOT_STARTED' });
  });

  it('gives the controller closes, approvals, separation of duties, controls and findings', async () => {
    const v = (await brief('CONTROLLER')).controller;
    expect(v.closes[0].current).toBe(true);
    expect(v.approvals).toMatchObject({ count: 0 });
    expect(v.separation).toEqual(expect.objectContaining({ open: expect.any(Number), rules: expect.any(Array) }));
    expect(v.controls.total).toBe(1);
    expect(v.findings).toMatchObject({ open: 1, high: 1 });
  });

  it('gives the internal auditor findings, evidence and controls', async () => {
    const v = (await brief('INTERNAL_AUDITOR')).audit;
    expect(v.findings.summary).toMatchObject({ open: 1, high: 1 });
    expect(v.findings.open).toEqual([expect.objectContaining({ id: c.finding, reference: 'F-001', title: 'Payments approved after release', severity: 'HIGH', status: 'OPEN', overdue: false })]);
    expect(v.engagements).toEqual([]);
    expect(v.evidence.summary).toMatchObject({ requested: 0, overdue: 0 });
    expect(v.controls).toMatchObject({ total: 1, failed: [] });
  });

  it('gives the procurement manager orders, contracts and vendor risk', async () => {
    const v = (await brief('PROCUREMENT', viewer.auth)).procurement;
    expect(v.orders.totals).toMatchObject({ open: 1, late: 1, toReceive: '4000.00' });
    expect(v.orders.late).toEqual([expect.objectContaining({ id: c.po, vendor: 'Granite Supplies', expectedDate: d(-2), toReceive: '4000.00' })]);
    expect(v.contracts.summary).toMatchObject({ contracts: 0 });
    expect(v.vendors.totals).toEqual(expect.objectContaining({ vendors: expect.any(Number) }));
    expect(v.heldBills).toEqual({ bills: 0, atStake: '0.00' });
  });

  it('keeps audit dashboards to audit roles, reports to members, and data to its organisation', async () => {
    expect((await brief('CONTROLLER', viewer.auth, 403)).message).toMatch(/audit and controls/);
    await brief('INTERNAL_AUDITOR', viewer.auth, 403);
    await brief('ACCOUNTANT', employee.auth, 403);
    await ctx.http().get(`${org.base}/reports/role-dashboards/ACCOUNTANT`).set(outsider.auth).expect(404);
    const other = await createOrg(ctx, outsider, { name: 'Other Books Ltd' });
    const a = (await ctx.http().get(`${other.base}/reports/role-dashboards/ACCOUNTANT`).set(outsider.auth).expect(200)).body.accountant;
    expect(a.queue).toMatchObject({ draftJournals: 0, draftDocuments: 0 });
    const p = (await ctx.http().get(`${other.base}/reports/role-dashboards/INTERNAL_AUDITOR`).set(outsider.auth).expect(200)).body.audit;
    expect(p.findings.open).toEqual([]);
  });
});
