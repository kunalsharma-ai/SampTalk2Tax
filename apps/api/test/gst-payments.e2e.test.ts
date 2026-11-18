import { gstinCheckCharacter } from '@talk2tax/tax-engine';
import { fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * GST payments and set-off (TAX-022): last month's output tax and input credit from posted
 * documents, set off in the CGST Act's order, the rest paid by PMT-06 challan and posted; the
 * calendar shows it; months go in order and only the latest can be voided. Real API and DB.
 */
const synthetic = (state: string, pan: string) => `${state}${pan}1Z${gstinCheckCharacter(`${state}${pan}1Z`)}`;
const OWN = synthetic('29', 'ZZZGP0001Z');

let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
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
const url = (path = '') => `${org.base}/gst/payments${path}`;
const preview = async (period: string) => (await ctx.http().get(url('/preview')).query({ period }).set(owner.auth).expect(200)).body;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'GST Pay Owner');
  viewer = await registerUser(ctx, 'GST Pay Viewer');
  org = await createOrg(ctx, owner);
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  for (const m of [BEFORE, LAST]) await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fiscalYearForDate(`${m}-01`, 4) });
  await ctx.http().put(`${org.base}/gst/registration`).set(owner.auth).send({ gstin: OWN, legalName: 'Settle Test Pvt Ltd', effectiveFrom: `${BEFORE}-01` }).expect(200);
  for (const a of (await ctx.http().get(`${org.base}/accounts`).set(owner.auth).expect(200)).body as { code: string; id: string }[]) org.acc[a.code] = a.id;
  rate = (await ctx.http().post(`${org.base}/tax-rates`).set(owner.auth).send({ name: 'GST 18%', rate: '18', kind: 'GST' }).expect(201)).body.id;
  const mk = async (k: string, body: Record<string, unknown>) => (c[k] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send(body).expect(201)).body.id);
  await mk('ka', { name: 'Bengaluru Retail', isCustomer: true, gstin: synthetic('29', 'ZZZGP0002Z') });
  await mk('mh', { name: 'Pune Distributors', isCustomer: true, gstin: synthetic('27', 'ZZZGP0003Z') });
  await mk('tn', { name: 'Chennai Components', isVendor: true, gstin: synthetic('33', 'ZZZGP0004Z') });
  await mk('kav', { name: 'Mysuru Supplies', isVendor: true, gstin: synthetic('29', 'ZZZGP0005Z') });
  const doc = async (path: string, kind: string, contact: string, amount: string, account: string) =>
    ctx.http().post(`${org.base}/${path}`).set(owner.auth).send({ kind, contactId: c[contact], issueDate: `${LAST}-10`, dueDate: `${LAST}-28`, post: true, lines: [{ accountId: org.acc[account], description: 'Goods', quantity: '1', unitPrice: amount, taxRateId: rate, hsnCode: '8471' }] }).expect(201);
  await doc('sales/documents', 'INVOICE', 'ka', '100000.00', '4100'); // CGST 9,000 + SGST 9,000
  await doc('sales/documents', 'INVOICE', 'mh', '50000.00', '4100'); // IGST 9,000
  await doc('purchases/documents', 'BILL', 'tn', '40000.00', '1300'); // IGST credit 7,200
  await doc('purchases/documents', 'BILL', 'kav', '20000.00', '1300'); // CGST and SGST credit 1,800 each
});
afterAll(async () => ctx?.app.close());

describe('GST payments', () => {
  let paymentId: string;
  let journalId: string;

  it('works out the month: credit set off in the Act’s order, the rest in cash', async () => {
    const p = await preview(LAST);
    expect(p).toMatchObject({
      period: LAST,
      liability: { igst: '9000.00', cgst: '9000.00', sgst: '9000.00' },
      credit: { igst: '7200.00', cgst: '1800.00', sgst: '1800.00' },
      creditUsed: { igst: '7200.00', cgst: '1800.00', sgst: '1800.00' },
      cash: { igst: '1800.00', cgst: '7200.00', sgst: '7200.00' },
      creditLeft: { igst: '0.00', cgst: '0.00', sgst: '0.00' },
      totalCash: '16200.00',
      nothingToPay: false,
      blocked: null,
    });
    expect(p.uses.map((u: { label: string; amount: string }) => `${u.label} ${u.amount}`)).toEqual(['IGST credit against IGST 7200.00', 'CGST credit against CGST 1800.00', 'SGST credit against SGST 1800.00']);
    expect(p).not.toHaveProperty('_setOff');
  });

  it('checks the challan, the date and the accounts', async () => {
    const bad = await ctx.http().post(url()).set(owner.auth).send({ period: LAST, paymentDate: `${LAST}-15`, interest: '12.345' }).expect(422);
    expect(bad.body.details.issues).toEqual([
      expect.stringMatching(/^The payment date must be after the month/),
      'Interest: enter an amount in rupees and paise',
      'Choose the bank account the challan was paid from',
      'Enter the CIN the bank gave for the challan',
    ]);
    const charges = await ctx.http().post(url()).set(owner.auth).send({ period: LAST, paymentDate: T, bankAccountId: org.acc['1120'], cin: 'HDFC26110012345', interest: '50', chargesAccountId: org.acc['1120'] }).expect(422);
    expect(charges.body.details.issues).toEqual(['Choose an active expense account for the interest and late fee']);
    await ctx.http().post(url()).set(viewer.auth).send({ period: LAST, paymentDate: T, bankAccountId: org.acc['1120'], cin: 'HDFC26110012345' }).expect(403);
  });

  it('records the payment as one journal, and the month has nothing left to pay', async () => {
    const r = await ctx.http().post(url()).set(owner.auth).send({ period: LAST, paymentDate: T, bankAccountId: org.acc['1120'], cpin: '26292900012345', cin: 'hdfc26110012345', interest: '50.00', chargesAccountId: org.acc['6400'], memo: 'Paid with GSTR-3B' }).expect(201);
    paymentId = r.body.id;
    journalId = r.body.journalEntryId;
    expect(r.body).toMatchObject({ number: 'GSTP-000001', period: LAST, status: 'POSTED', totalCash: '16200.00', interest: '50.00', totalPaid: '16250.00', cin: 'HDFC26110012345', cpin: '26292900012345', createdBy: 'GST Pay Owner', canVoid: true });
    const je = (await ctx.http().get(`${org.base}/journals/${journalId}`).set(owner.auth).expect(200)).body as { lines: { accountId: string; debit: string; credit: string }[] };
    const code = (id: string) => Object.entries(org.acc).find(([, v]) => v === id)![0];
    const lines = je.lines.map((l) => `${code(l.accountId)} ${l.debit !== '0' && l.debit !== '0.00' ? `Dr ${l.debit}` : `Cr ${l.credit}`}`).sort();
    // Output IGST/CGST/SGST 2312/2310/2311 debited with all of it; input 1453/1451/1452 credited with the credit used.
    expect(lines).toEqual(['1120 Cr 16250.00', '1451 Cr 1800.00', '1452 Cr 1800.00', '1453 Cr 7200.00', '2310 Dr 9000.00', '2311 Dr 9000.00', '2312 Dr 9000.00', '6400 Dr 50.00'].sort());
    const after = await preview(LAST);
    expect(after).toMatchObject({ nothingToPay: true, totalCash: '0.00', liability: { igst: '0.00', cgst: '0.00', sgst: '0.00' } });
    const again = await ctx.http().post(url()).set(owner.auth).send({ period: LAST, paymentDate: T, bankAccountId: org.acc['1120'], cin: 'HDFC26110099999' }).expect(422);
    expect(again.body.error).toBe('NOTHING_TO_PAY');
  });

  it('settles months in order', async () => {
    expect((await preview(BEFORE)).blocked).toBe(`A payment for ${LAST} is already recorded; months are settled in order`);
    const r = await ctx.http().post(url()).set(owner.auth).send({ period: BEFORE, paymentDate: T }).expect(409);
    expect(r.body.error).toBe('OUT_OF_ORDER');
  });

  it('shows on the compliance calendar against the month’s GSTR-3B', async () => {
    const cal = (await ctx.http().get(`${org.base}/compliance/calendar`).query({ from: `${LAST}-01`, to: `${T.slice(0, 7)}-28` }).set(owner.auth).expect(200)).body as { items: { key: string; paid: string | null; evidence: { type: string; id: string; label: string }[] }[] };
    const item = cal.items.find((i) => i.key === `GSTR3B:${LAST}`);
    expect(item).toMatchObject({ paid: '16200.00', evidence: [{ type: 'GST_PAYMENT', id: paymentId, label: 'GSTP-000001 · HDFC26110012345' }] });
  });

  it('voids the latest payment by reversing its journal, which brings the tax back', async () => {
    await ctx.http().post(url(`/${paymentId}/void`)).set(owner.auth).send({ date: T, reason: 'x' }).expect(422);
    const v = await ctx.http().post(url(`/${paymentId}/void`)).set(owner.auth).send({ date: T, reason: 'Challan entered twice' }).expect(201);
    expect(v.body).toMatchObject({ status: 'VOID', voidReason: 'Challan entered twice', voidedBy: 'GST Pay Owner', canVoid: false });
    expect(v.body.reversalEntryId).toBeTruthy();
    expect((await preview(LAST)).totalCash).toBe('16200.00');
    await ctx.http().post(url(`/${paymentId}/void`)).set(owner.auth).send({ date: T, reason: 'Again' }).expect(409);
    const list = (await ctx.http().get(url()).set(viewer.auth).expect(200)).body;
    expect(list.map((p: { number: string; status: string }) => `${p.number} ${p.status}`)).toEqual(['GSTP-000001 VOID']);
    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, entityType: 'gst_payment' }, orderBy: { id: 'asc' }, select: { action: true } });
    expect(audit.map((a) => a.action)).toEqual(['gst_payment.recorded', 'gst_payment.voided']);
  });

  it('a month covered by credit alone needs no challan', async () => {
    // A large bill brings more credit than the month's tax; a new payment needs no bank or CIN.
    await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: c.tn, issueDate: `${LAST}-20`, post: true, lines: [{ accountId: org.acc['1300'], description: 'Machine', quantity: '1', unitPrice: '200000.00', taxRateId: rate, hsnCode: '8471' }] }).expect(201);
    const p = await preview(LAST);
    expect(p).toMatchObject({ totalCash: '0.00', credit: { igst: '43200.00' }, creditLeft: { igst: '16200.00', cgst: '1800.00', sgst: '1800.00' } });
    const r = await ctx.http().post(url()).set(owner.auth).send({ period: LAST, paymentDate: T }).expect(201);
    expect(r.body).toMatchObject({ number: 'GSTP-000002', totalCash: '0.00', bankAccount: null, cin: null });
  });
});
