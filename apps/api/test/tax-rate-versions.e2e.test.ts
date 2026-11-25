import { addDays } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Effective-dated, version-controlled tax rates (TAX-003) against the real API and database: a
 * scheduled change, invoices on either side of it, the history, withdrawing it, versions in date
 * order, no reaching back past posted documents, expense claim lines at the rate on their date,
 * permissions and tenants.
 */
const T = today();
const F = addDays(T, 30);
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let approver: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let vat: string;
let customer: string;
const V = (id: string) => `${org.base}/tax-rates/${id}/versions`;
const invoice = async (date: string, taxRateId = vat) =>
  (await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: customer, issueDate: date, dueDate: date, post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: '1000.00', taxRateId }] }).expect(201)).body;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Rates Owner');
  viewer = await registerUser(ctx, 'Rates Viewer');
  approver = await registerUser(ctx, 'Rates Approver');
  org = await createOrg(ctx, owner, { name: 'Versioned Rates Ltd' });
  other = await createOrg(ctx, owner, { name: 'Other Rates Ltd' });
  for (const [u, role] of [[viewer, 'VIEWER'], [approver, 'APPROVER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  const fy = Number(T.slice(0, 4)) + (T.slice(5) >= '04-01' ? 1 : 0);
  for (const y of [fy - 1, fy, fy + 1]) await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: y });
  vat = (await ctx.http().post(`${org.base}/tax-rates`).set(owner.auth).send({ name: 'Service tax', rate: '10', salesAccountId: org.acc['2300'], purchaseAccountId: org.acc['1450'] }).expect(201)).body.id;
  customer = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Steady Buyer', isCustomer: true }).expect(201)).body.id;
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('tax rate versions', () => {
  it('schedules a change and charges each invoice at the rate in force on its date', async () => {
    await ctx.http().post(V(vat)).set(viewer.auth).send({ rate: '12.5', effectiveFrom: F, reason: 'Rate notified' }).expect(403);
    const h = (await ctx.http().post(V(vat)).set(owner.auth).send({ rate: '12.50', effectiveFrom: F, reason: 'Rate raised by notification 7/2026' }).expect(201)).body;
    expect(h).toMatchObject({ originalRate: '10', rateToday: '10', next: { effectiveFrom: F, rate: '12.5' }, canChange: true });
    expect(h.timeline).toEqual([
      expect.objectContaining({ version: 1, rate: '10', effectiveFrom: null, effectiveTo: addDays(F, -1), state: 'CURRENT', id: null, canWithdraw: false }),
      expect.objectContaining({ version: 2, rate: '12.5', effectiveFrom: F, effectiveTo: null, state: 'SCHEDULED', reason: 'Rate raised by notification 7/2026', recordedBy: 'Rates Owner', canWithdraw: true }),
    ]);
    const list = (await ctx.http().get(`${org.base}/tax-rates`).set(viewer.auth).expect(200)).body;
    expect(list.find((r: { id: string }) => r.id === vat)).toMatchObject({ rate: '10', originalRate: '10', nextChange: { effectiveFrom: F, rate: '12.5' } });

    const before = await invoice(addDays(F, -1));
    const after = await invoice(F);
    expect([before.taxTotal, before.total]).toEqual(['100.00', '1100.00']);
    expect([after.taxTotal, after.total]).toEqual(['125.00', '1125.00']);
  });

  it('adds versions only in date order and never behind posted documents', async () => {
    const early = await ctx.http().post(V(vat)).set(owner.auth).send({ rate: '15', effectiveFrom: addDays(F, -5), reason: 'Earlier change' }).expect(422);
    expect(early.body.error).toBe('VERSION_INVALID');
    expect(early.body.details.issues).toEqual([`Versions are added in date order: the latest takes effect on ${F}, so a new one must start after that`, `2 posted documents or claims use this rate on or after ${addDays(F, -5)}; a change cannot reach back past them`]);
    expect((await ctx.http().post(V(vat)).set(owner.auth).send({ rate: '12.5', effectiveFrom: addDays(F, 10), reason: 'Same again' }).expect(422)).body.details.issues).toEqual([`The rate is already 12.5% on ${addDays(F, 10)}`]);
    expect((await ctx.http().post(V(vat)).set(owner.auth).send({ rate: '101', effectiveFrom: addDays(F, 10), reason: 'Too high' }).expect(422)).body.details.issues).toEqual(['A tax rate is between 0% and 100%']);
    await ctx.http().post(V(vat)).set(owner.auth).send({ rate: '15', effectiveFrom: addDays(F, 10), reason: 'x' }).expect(400);

    const cess = (await ctx.http().post(`${org.base}/tax-rates`).set(owner.auth).send({ name: 'Cess', rate: '2', salesAccountId: org.acc['2300'] }).expect(201)).body.id;
    await invoice(T, cess);
    const back = await ctx.http().post(V(cess)).set(owner.auth).send({ rate: '3', effectiveFrom: addDays(T, -10), reason: 'Backdated notification' }).expect(422);
    expect(back.body.details.issues).toEqual([`1 posted document or claim uses this rate on or after ${addDays(T, -10)}; a change cannot reach back past them`]);
    await ctx.http().post(V(cess)).set(owner.auth).send({ rate: '3', effectiveFrom: addDays(T, 1), reason: 'From tomorrow' }).expect(201);
  });

  it('withdraws a scheduled version, but not one already in effect', async () => {
    const h = (await ctx.http().get(V(vat)).set(viewer.auth).expect(200)).body;
    const id = h.timeline[1].id as string;
    await ctx.http().post(`${V(vat)}/${id}/withdraw`).set(viewer.auth).send({ reason: 'Notification rescinded' }).expect(403);
    await ctx.http().post(`${V(vat)}/${id}/withdraw`).set(owner.auth).send({ reason: '' }).expect(400);
    // The invoice dated on the change keeps its tax; the version stays on record as withdrawn.
    const r = (await ctx.http().post(`${V(vat)}/${id}/withdraw`).set(owner.auth).send({ reason: 'Notification rescinded' }).expect(200)).body;
    expect(r.timeline).toHaveLength(1);
    expect(r.next).toBeNull();
    expect(r.withdrawn).toEqual([expect.objectContaining({ id, rate: '12.5', effectiveFrom: F, withdrawnReason: 'Notification rescinded', withdrawnBy: 'Rates Owner' })]);
    expect((await ctx.http().post(`${V(vat)}/${id}/withdraw`).set(owner.auth).send({ reason: 'Again' }).expect(409)).body.error).toBe('ALREADY_WITHDRAWN');
    expect((await invoice(addDays(F, 1))).taxTotal).toBe('100.00');
    const posted = await ctx.db.collection('documents').countDocuments({ orgId: org.orgId, status: 'POSTED', taxTotal: { $exists: true } });
    expect(posted).toBe(4);

    const levy = (await ctx.http().post(`${org.base}/tax-rates`).set(owner.auth).send({ name: 'Local levy', rate: '5', purchaseAccountId: org.acc['1450'] }).expect(201)).body.id;
    const lv = (await ctx.http().post(V(levy)).set(owner.auth).send({ rate: '8', effectiveFrom: addDays(T, -3), reason: 'Levy raised' }).expect(201)).body;
    expect(lv.timeline.map((e: { state: string }) => e.state)).toEqual(['PAST', 'CURRENT']);
    expect((await ctx.http().post(`${V(levy)}/${lv.timeline[1].id}/withdraw`).set(owner.auth).send({ reason: 'Too late' }).expect(409)).body.error).toBe('VERSION_IN_EFFECT');
  });

  it('works out expense claim lines at the rate on their own dates', async () => {
    const levy = (await ctx.http().get(`${org.base}/tax-rates`).set(owner.auth).expect(200)).body.find((r: { name: string }) => r.name === 'Local levy');
    expect(levy).toMatchObject({ rate: '8', originalRate: '5', nextChange: null });
    const claim = (await ctx.http().post(`${org.base}/expense-claims`).set(owner.auth).send({ title: 'Synthetic site visits', lines: [{ date: addDays(T, -10), accountId: org.acc['6700'], amount: '105.00', taxRateId: levy.id }, { date: addDays(T, -1), accountId: org.acc['6700'], amount: '108.00', taxRateId: levy.id }] }).expect(201)).body;
    expect(claim.lines.map((l: { taxRate: string; taxAmount: string }) => [l.taxRate, l.taxAmount])).toEqual([['5', '5.00'], ['8', '8.00']]);
    await ctx.http().post(`${org.base}/expense-claims/${claim.id}/submit`).set(owner.auth).send({}).expect(200);
    await ctx.http().post(`${org.base}/expense-claims/${claim.id}/approve`).set(approver.auth).send({}).expect(200);
    const issues = (await ctx.http().post(V(levy.id)).set(owner.auth).send({ rate: '9', effectiveFrom: addDays(T, -2), reason: 'Behind the claim' }).expect(422)).body.details.issues;
    expect(issues).toEqual([`1 posted document or claim uses this rate on or after ${addDays(T, -2)}; a change cannot reach back past them`]);
  });

  it('keeps every change in the audit trail and each organisation to its own rates', async () => {
    const events = await ctx.db.collection('audit_events').find({ orgId: org.orgId, action: { $regex: '^tax_rate\\.version' } }).sort({ idNumber: 1 }).toArray();
    expect(events.map((e) => e.action)).toEqual(['tax_rate.version_added', 'tax_rate.version_added', 'tax_rate.version_withdrawn', 'tax_rate.version_added']);
    expect(events[0]!.data).toMatchObject({ from: '10', to: '12.5', effectiveFrom: F, backdated: false });
    expect(events[3]!.data).toMatchObject({ from: '5', to: '8', backdated: true });
    await ctx.http().get(`${other.base}/tax-rates/${vat}/versions`).set(owner.auth).expect(404);
    const outsider = await registerUser(ctx, 'Rates Outsider');
    await ctx.http().get(V(vat)).set(outsider.auth).expect(404);
  });
});
