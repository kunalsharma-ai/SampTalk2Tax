import { fiscalYearForDate } from '@talk2tax/accounting-engine';
import { Decimal128 } from '@talk2tax/document-db';
import { gstinCheckCharacter } from '@talk2tax/tax-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * GST reconciliation (TAX-045) and discrepancy checks (TAX-044): a month's GST accounts against
 * its documents, with a manual journal and the void of an earlier invoice explaining the
 * difference, a GST payment kept apart, and tax mistakes found in the month's documents.
 * Real API and DB.
 */
const synthetic = (state: string, pan: string) => `${state}${pan}1Z${gstinCheckCharacter(`${state}${pan}1Z`)}`;
const OWN = synthetic('29', 'ZZZGR0001Z');

let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let employee: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const c: Record<string, string> = {};
let rate: string;

const T = today();
const monthOf = (iso: string, back: number) => {
  const d = new Date(`${iso.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - back);
  return d.toISOString().slice(0, 7);
};
const LAST = monthOf(T, 1);
const BEFORE = monthOf(T, 2);
const recon = async (period: string, who = owner) => (await ctx.http().get(`${org.base}/gst/reconciliation`).query({ period }).set(who.auth).expect(200)).body;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'GST Recon Owner');
  viewer = await registerUser(ctx, 'GST Recon Viewer');
  employee = await registerUser(ctx, 'GST Recon Employee');
  org = await createOrg(ctx, owner);
  other = await createOrg(ctx, owner, { name: 'Other GST Co' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: employee.email, role: 'EMPLOYEE' }).expect(201);
  for (const m of [BEFORE, LAST]) await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fiscalYearForDate(`${m}-01`, 4) });
  await ctx.http().put(`${org.base}/gst/registration`).set(owner.auth).send({ gstin: OWN, legalName: 'Recon Test Pvt Ltd', effectiveFrom: `${BEFORE}-01` }).expect(200);
  for (const a of (await ctx.http().get(`${org.base}/accounts`).set(owner.auth).expect(200)).body as { code: string; id: string }[]) org.acc[a.code] = a.id;
  rate = (await ctx.http().post(`${org.base}/tax-rates`).set(owner.auth).send({ name: 'GST 18%', rate: '18', kind: 'GST' }).expect(201)).body.id;
  const mk = async (k: string, body: Record<string, unknown>) => (c[k] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send(body).expect(201)).body.id);
  await mk('ka', { name: 'Bengaluru Retail', isCustomer: true, gstin: synthetic('29', 'ZZZGR0002Z') });
  await mk('mh', { name: 'Pune Distributors', isCustomer: true, gstin: synthetic('27', 'ZZZGR0003Z') });
  await mk('tn', { name: 'Chennai Components', isVendor: true, gstin: synthetic('33', 'ZZZGR0004Z') });
});
afterAll(async () => ctx?.app.close());

const doc = (path: string, kind: string, contact: string, date: string, amount: string, account: string, extra: Record<string, unknown> = {}) =>
  ctx.http().post(`${org.base}/${path}`).set(owner.auth).send({ kind, contactId: c[contact], issueDate: date, dueDate: date, post: true, lines: [{ accountId: org.acc[account], description: 'Goods', quantity: '1', unitPrice: amount, taxRateId: rate, hsnCode: '8471', ...extra }] }).expect(201);

describe('GST reconciliation', () => {
  it('needs a GST registration, a valid month and reports access', async () => {
    expect((await ctx.http().get(`${other.base}/gst/reconciliation`).set(owner.auth).expect(409)).body.error).toBe('GST_NOT_REGISTERED');
    await ctx.http().get(`${org.base}/gst/reconciliation`).query({ period: '2026-13' }).set(owner.auth).expect(400);
    await ctx.http().get(`${org.base}/gst/reconciliation`).set(employee.auth).expect(403);
  });

  it('agrees when the accounts moved only by the month’s documents', async () => {
    await doc('sales/documents', 'INVOICE', 'ka', `${LAST}-10`, '100000.00', '4100'); // CGST 9,000 + SGST 9,000
    await doc('sales/documents', 'INVOICE', 'mh', `${LAST}-11`, '50000.00', '4100'); // IGST 9,000
    await doc('purchases/documents', 'BILL', 'tn', `${LAST}-12`, '40000.00', '1300'); // IGST credit 7,200
    const r = await recon(LAST, viewer);
    expect(r).toMatchObject({
      period: LAST,
      gstin: OWN,
      agrees: true,
      returns: { output: { igst: '9000.00', cgst: '9000.00', sgst: '9000.00' }, input: { igst: '7200.00', cgst: '0.00', sgst: '0.00' } },
      ledger: { output: { igst: '9000.00', cgst: '9000.00', sgst: '9000.00' }, input: { igst: '7200.00' } },
      items: [],
      documentsChecked: 3,
    });
    expect(r.discrepancies).toEqual([]);
  });

  it('explains a manual journal and the void of an earlier invoice, and keeps a GST payment apart', async () => {
    const early = (await doc('sales/documents', 'INVOICE', 'ka', `${BEFORE}-05`, '10000.00', '4100')).body; // CGST 900 + SGST 900
    await ctx.http().post(`${org.base}/sales/documents/${early.id}/void`).set(owner.auth).send({ date: `${LAST}-15`, reason: 'Wrong customer' }).expect(200);
    await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: `${LAST}-20`, post: true, memo: 'IGST correction', lines: [{ accountId: org.acc['6400'], debit: '500.00' }, { accountId: org.acc['2312'], credit: '500.00' }] }).expect(201);
    // The month before's tax (the early invoice, as it stood at that month's end) is paid during this month.
    await ctx.http().post(`${org.base}/gst/payments`).set(owner.auth).send({ period: BEFORE, paymentDate: `${LAST}-18`, bankAccountId: org.acc['1120'], cin: 'HDFC26110054321' }).expect(201);
    const r = await recon(LAST);
    expect(r.agrees).toBe(false);
    expect(r.returns.output).toEqual({ igst: '9000.00', cgst: '9000.00', sgst: '9000.00' });
    expect(r.ledger.output).toEqual({ igst: '9500.00', cgst: '8100.00', sgst: '8100.00' });
    expect(r.difference.output).toEqual({ igst: '500.00', cgst: '-900.00', sgst: '-900.00' });
    expect(r.unexplained).toEqual({ output: { igst: '0.00', cgst: '0.00', sgst: '0.00' }, input: { igst: '0.00', cgst: '0.00', sgst: '0.00' } });
    expect(r.items.map((i: { kind: string }) => i.kind)).toEqual(['VOID_OF_EARLIER_DOCUMENT', 'OTHER_ENTRY']);
    expect(r.items[0]).toMatchObject({ documentId: early.id, documentNumber: early.number, message: `Invoice ${early.number} of ${BEFORE}-05 was voided in this period; amend the return of its own period` });
    expect(r.items[1].message).toMatch(/^Journal \d+ \(manual: IGST correction\) moved a GST account with no document behind it$/);
    // The payment settles the accounts: shown apart, not as a difference.
    expect(r.settled.output).toEqual({ igst: '0.00', cgst: '-900.00', sgst: '-900.00' });
  });

  it('finds tax mistakes in the month’s documents, and a posting that no longer matches its document', async () => {
    const rate12 = (await ctx.http().post(`${org.base}/tax-rates`).set(owner.auth).send({ name: 'GST 12%', rate: '12', kind: 'GST' }).expect(201)).body.id;
    // The same HSN sold at another rate.
    const cheap = (await doc('sales/documents', 'INVOICE', 'ka', `${LAST}-22`, '1000.00', '4100', { taxRateId: rate12 })).body;
    // Two invoices changed outside the app, as imported or migrated data can be: one lost its HSN code, one has IGST on a sale within the state.
    const noHsn = (await doc('sales/documents', 'INVOICE', 'ka', `${LAST}-21`, '1000.00', '4100')).body;
    const wrong = (await doc('sales/documents', 'INVOICE', 'ka', `${LAST}-23`, '1000.00', '4100')).body;
    await ctx.db.collection('documents').updateOne({ _id: noHsn.id }, { $set: { 'lines.$[].hsnCode': null } });
    await ctx.db.collection('documents').updateOne({ _id: wrong.id }, { $set: { 'lines.$[].cgstAmount': Decimal128.fromString('0'), 'lines.$[].sgstAmount': Decimal128.fromString('0'), 'lines.$[].igstAmount': Decimal128.fromString('180') } });
    const r = await recon(LAST);
    expect(r.discrepancies.map((d: { kind: string; documentNumber: string | null }) => `${d.kind} ${d.documentNumber ?? ''}`.trim())).toEqual([`WRONG_TAX_HEADS ${wrong.number}`, `MISSING_HSN ${noHsn.number}`, 'HSN_RATE_VARIES']);
    expect(r.discrepancies[0]).toMatchObject({ severity: 'HIGH', amount: '180.00', lineNo: 1, message: `Invoice ${wrong.number} line 1: a supply within the state carries IGST; it should be CGST and SGST` });
    expect(r.discrepancies[2].message).toContain(`12% on ${cheap.number}`);
    expect(r.discrepancyCounts).toEqual({ high: 1, medium: 0, low: 2 });
    expect(r.documentsChecked).toBe(6);
    // The ledger still has the CGST and SGST that posted: the reconciliation shows the document and its posting disagree.
    expect(r.items.map((i: { kind: string }) => i.kind)).toEqual(['VOID_OF_EARLIER_DOCUMENT', 'OTHER_ENTRY', 'POSTING_DIFFERS']);
    expect(r.items[2]).toMatchObject({ documentNumber: wrong.number, effect: { output: { igst: '-180.00', cgst: '90.00', sgst: '90.00' } } });
    expect(r.unexplained.output).toEqual({ igst: '0.00', cgst: '0.00', sgst: '0.00' });
  });

  it('is kept to the organisation', async () => {
    await ctx.http().get(`${org.base}/gst/reconciliation`).set((await registerUser(ctx, 'Outsider')).auth).expect(404);
  });
});
