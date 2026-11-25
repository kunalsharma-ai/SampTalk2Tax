import { addDays, fiscalYearForDate } from '@talk2tax/accounting-engine';
import { financialYearOf, gstinCheckCharacter } from '@talk2tax/tax-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Reverse charge (TAX-032) against the real API and database: the month's register of bills and
 * vendor credits under reverse charge with the tax to pay in cash, a bill whose SAC is a notified
 * category but was not recorded under reverse charge, self-invoices for unregistered suppliers
 * (numbered per financial year, once per bill, audited), and permissions and tenants.
 */
const synthetic = (state: string, pan: string) => `${state}${pan}1Z${gstinCheckCharacter(`${state}${pan}1Z`)}`;
const T = today();
const OLD = addDays(T, -35);
const FY = financialYearOf(T);
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const c: Record<string, string> = {};
const d: Record<string, string> = {};
let rate: string;
const url = (path = '') => `${org.base}/gst/reverse-charge${path}`;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'RCM Owner');
  viewer = await registerUser(ctx, 'RCM Viewer');
  org = await createOrg(ctx, owner, { name: 'Reverse Traders Pvt Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  for (const day of [OLD, T]) await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fiscalYearForDate(day, 4) });
  await ctx.http().put(`${org.base}/gst/registration`).set(owner.auth).send({ gstin: synthetic('27', 'ZZZRC0001Z'), legalName: 'Reverse Traders Pvt Ltd', effectiveFrom: addDays(OLD, -30) }).expect(200);
  for (const a of (await ctx.http().get(`${org.base}/accounts`).set(owner.auth).expect(200)).body as { code: string; id: string }[]) org.acc[a.code] = a.id;
  rate = (await ctx.http().post(`${org.base}/tax-rates`).set(owner.auth).send({ name: 'GST 18%', rate: '18', kind: 'GST' }).expect(201)).body.id;
  const mk = async (k: string, body: Record<string, unknown>) => (c[k] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ isVendor: true, ...body }).expect(201)).body.id);
  await mk('advocate', { name: 'Adv. Synthetic Rao', stateCode: '27', pan: 'ZZZPR0002Z' });
  await mk('gta', { name: 'Registered Synthetic Transport', gstin: synthetic('27', 'ZZZRC0003Z') });
  await mk('guard', { name: 'Synthetic Guards Pvt Ltd', gstin: synthetic('27', 'ZZZRC0004Z') });
  await mk('foreign', { name: 'Synthetic Cloud Inc.', stateCode: '96' });
  const bill = async (k: string, contact: string, date: string, amount: string, hsnCode: string, extra: Record<string, unknown> = {}) =>
    (d[k] = (await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: c[contact], issueDate: date, dueDate: date, post: true, lines: [{ accountId: org.acc['6600'], description: 'Services', quantity: '1', unitPrice: amount, taxRateId: rate, hsnCode }], ...extra }).expect(201)).body.id);
  await bill('legal', 'advocate', T, '50000.00', '998211', { reverseCharge: true }); // CGST 4,500 + SGST 4,500
  await bill('legal2', 'advocate', T, '10000.00', '998212', { reverseCharge: true }); // CGST 900 + SGST 900
  await bill('gta', 'gta', T, '20000.00', '996511', { reverseCharge: true }); // CGST 1,800 + SGST 1,800
  await bill('cloud', 'foreign', T, '10000.00', '998315', { reverseCharge: true }); // IGST 1,800
  await bill('credit', 'advocate', T, '5000.00', '998211', { kind: 'VENDOR_CREDIT', reverseCharge: true }); // less CGST 450 + SGST 450
  await bill('guards', 'guard', T, '30000.00', '998525'); // the guards charged GST themselves
  await bill('old', 'advocate', OLD, '8000.00', '998211', { reverseCharge: true });
});
afterAll(async () => ctx?.app.close());

describe('reverse charge', () => {
  it("registers the month's reverse-charge bills and vendor credits, and the tax to pay in cash", async () => {
    const r = (await ctx.http().get(url()).query({ period: T.slice(0, 7) }).set(viewer.auth).expect(200)).body;
    expect(r.rows.map((x: { id: string }) => x.id).sort()).toEqual([d.legal, d.legal2, d.gta, d.cloud, d.credit].sort());
    expect(r.totals).toEqual({ taxable: '85000.00', igst: '1800.00', cgst: '6750.00', sgst: '6750.00', tax: '15300.00' });
    const row = (id: string) => r.rows.find((x: { id: string }) => x.id === id);
    expect(row(d.legal)).toMatchObject({ kind: 'BILL', categories: [{ key: 'LEGAL' }], selfInvoice: { required: true, number: null, dueBy: addDays(T, 30), overdue: false } });
    expect(row(d.gta)).toMatchObject({ categories: [{ key: 'GTA' }], selfInvoice: { required: false } });
    expect(row(d.cloud)).toMatchObject({ importOfServices: true, igst: '1800.00', selfInvoice: { required: true } });
    expect(row(d.credit)).toMatchObject({ kind: 'VENDOR_CREDIT', selfInvoice: { required: false } });
    expect(r.selfInvoices).toEqual({ required: 3, issued: 0, overdue: 0 });
    expect(r.possiblyMissed).toEqual([expect.objectContaining({ id: d.guards, hsnCode: '998525', taxCharged: '5400.00', category: expect.objectContaining({ key: 'SECURITY' }) })]);
    expect(r.payment).toBeNull();
    expect(r.categories.length).toBeGreaterThan(10);
  });

  it('issues self-invoices once per bill, numbered per financial year, for those who keep the books', async () => {
    await ctx.http().post(url(`/${d.legal}/self-invoice`)).set(viewer.auth).send({}).expect(403);
    const before = (await ctx.http().get(url(`/${d.legal}/self-invoice`)).set(viewer.auth).expect(200)).body;
    expect(before).toMatchObject({ required: true, issued: null, billDate: T, recipient: { name: 'Reverse Traders Pvt Ltd', state: 'Maharashtra' }, supplier: { name: 'Adv. Synthetic Rao', gstin: null }, totals: { taxable: '50000.00', cgst: '4500.00', sgst: '4500.00', tax: '9000.00' } });
    expect(before.lines[0]).toMatchObject({ hsnCode: '998211', category: 'Legal services by an advocate' });

    const a = (await ctx.http().post(url(`/${d.legal}/self-invoice`)).set(owner.auth).send({}).expect(201)).body;
    expect(a.issued).toMatchObject({ number: `RCM/${FY}/0001`, issuedOn: T, issuedBy: 'RCM Owner' });
    const b = (await ctx.http().post(url(`/${d.cloud}/self-invoice`)).set(owner.auth).send({ issuedOn: T }).expect(201)).body;
    expect(b.issued.number).toBe(`RCM/${FY}/0002`);

    const again = await ctx.http().post(url(`/${d.legal}/self-invoice`)).set(owner.auth).send({}).expect(422);
    expect(again.body.details.issues).toEqual([`Self-invoice RCM/${FY}/0001 was already issued on ${T}`]);
    expect((await ctx.http().post(url(`/${d.gta}/self-invoice`)).set(owner.auth).send({}).expect(422)).body.details.issues).toEqual(['The supplier is registered, so their own tax invoice is the document; no self-invoice is needed']);
    expect((await ctx.http().post(url(`/${d.credit}/self-invoice`)).set(owner.auth).send({}).expect(422)).body.details.issues).toEqual(['Self-invoices are issued for bills, not vendor credits']);
    expect((await ctx.http().post(url(`/${d.legal2}/self-invoice`)).set(owner.auth).send({ issuedOn: addDays(T, -1) }).expect(422)).body.details.issues).toEqual([`A self-invoice cannot be dated before the bill (${T})`]);
    await ctx.http().post(url(`/${d.legal2}/self-invoice`)).set(owner.auth).send({ issuedOn: 'soon' }).expect(400);

    const r = (await ctx.http().get(url()).query({ period: T.slice(0, 7) }).set(viewer.auth).expect(200)).body;
    expect(r.selfInvoices).toEqual({ required: 3, issued: 2, overdue: 0 });
  });

  it('marks a self-invoice overdue 30 days after the bill', async () => {
    const r = (await ctx.http().get(url()).query({ period: OLD.slice(0, 7) }).set(viewer.auth).expect(200)).body;
    const old = r.rows.find((x: { id: string }) => x.id === d.old);
    expect(old.selfInvoice).toMatchObject({ required: true, dueBy: addDays(OLD, 30), overdue: true });
    expect(r.selfInvoices.overdue).toBeGreaterThanOrEqual(1);
    const late = (await ctx.http().post(url(`/${d.old}/self-invoice`)).set(owner.auth).send({}).expect(201)).body;
    expect(late.issued.number).toBe(`RCM/${FY}/${financialYearOf(OLD) === FY ? '0003' : '0001'}`);
  });

  it('is audited, needs a GST registration and is kept to its organisation', async () => {
    const events = await ctx.db.collection('audit_events').find({ orgId: org.orgId, action: 'gst.rcm_self_invoice_issued' }).sort({ idNumber: 1 }).toArray();
    expect(events.map((e) => [e.data.supplier, e.data.tax, e.data.late])).toEqual([['Adv. Synthetic Rao', '9000.00', false], ['Synthetic Cloud Inc.', '1800.00', false], ['Adv. Synthetic Rao', '1440.00', true]]);
    await ctx.http().get(url()).query({ period: '2026-13' }).set(owner.auth).expect(400);
    await ctx.http().get(url('/00000000-0000-4000-8000-000000000000/self-invoice')).set(owner.auth).expect(404);
    const other = await createOrg(ctx, owner, { name: 'Unregistered Ltd' });
    expect((await ctx.http().get(`${other.base}/gst/reverse-charge`).set(owner.auth).expect(409)).body.error).toBe('GST_NOT_REGISTERED');
    const outsider = await registerUser(ctx, 'RCM Outsider');
    await ctx.http().get(url(`/${d.legal}/self-invoice`)).set(outsider.auth).expect(404);
  });
});
