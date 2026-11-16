/**
 * AR-017 debit notes against the real API and database: a debit note raises the value of a posted
 * invoice to the same customer (same currency and place of supply), takes its own DN- series, is
 * owed and paid like an invoice, is reported in GSTR-1 table 9B with type D and as its own series
 * in table 13, and blocks voiding the invoice while it stands.
 */
import { gstinCheckCharacter } from '@talk2tax/tax-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';
import { sqlWrite } from './sql-writes';

const synthetic = (state: string, pan: string) => `${state}${pan}1Z${gstinCheckCharacter(`${state}${pan}1Z`)}`;
const OWN = synthetic('29', 'ZZZCZ0101Z');
const MH_CUSTOMER = synthetic('27', 'ZZZFZ0102Z');

let ctx: Ctx;
let owner: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let g18: string;
let mh: string;
let other: string;
let inv: { id: string; number: string; total: string };

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Debit Note Owner');
  org = await createOrg(ctx, owner);
  await ctx.http().put(`${org.base}/gst/registration`).set(owner.auth).send({ gstin: OWN, legalName: 'Debit Test Pvt Ltd', effectiveFrom: '2026-04-01' }).expect(200);
  for (const a of (await ctx.http().get(`${org.base}/accounts`).set(owner.auth).expect(200)).body as { code: string; id: string }[]) org.acc[a.code] = a.id;
  g18 = (await ctx.http().post(`${org.base}/tax-rates`).set(owner.auth).send({ name: 'GST 18%', rate: '18', kind: 'GST' }).expect(201)).body.id;
  mh = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Pune Distributors', isCustomer: true, gstin: MH_CUSTOMER }).expect(201)).body.id;
  other = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Other Customer', isCustomer: true, stateCode: '29' }).expect(201)).body.id;
  inv = (await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: mh, issueDate: today(), post: true, lines: [{ accountId: org.acc['4100'], description: 'Steel', quantity: '10', unitPrice: '1000', taxRateId: g18, hsnCode: '7326' }] }).expect(201)).body;
});
afterAll(async () => {
  await ctx.app.close();
});

const line = (unitPrice: string) => ({ accountId: org.acc['4100'], description: 'Price revision', quantity: '1', unitPrice, taxRateId: g18, hsnCode: '7326' });
const S = () => `${org.base}/sales/documents`;

describe('debit notes', () => {
  let dn: { id: string; number: string; journalEntryId: string };

  it('refuses a debit note that does not fit its invoice', async () => {
    const draft = (await ctx.http().post(S()).set(owner.auth).send({ kind: 'INVOICE', contactId: mh, issueDate: today(), lines: [line('100')] }).expect(201)).body;
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ contactId: other, debitNoteFor: inv.id }, /same customer/],
      [{ debitNoteFor: draft.id }, /Post the invoice/],
      [{ debitNoteFor: inv.id, placeOfSupply: '29' }, /place of supply/],
      [{ debitNoteFor: inv.id, currency: 'USD', exchangeRate: '84' }, /in INR, like the invoice/],
      [{ debitNoteFor: inv.id, issueDate: '2026-04-01' }, /cannot be dated before/],
      [{ kind: 'CREDIT_NOTE', debitNoteFor: inv.id }, /Only an invoice/],
    ];
    for (const [extra, msg] of cases) {
      const r = await ctx.http().post(S()).set(owner.auth).send({ kind: 'INVOICE', contactId: mh, issueDate: today(), lines: [line('100')], ...extra }).expect(422);
      expect(r.body.error).toBe('DEBIT_NOTE_INVALID');
      expect(r.body.message).toMatch(msg);
    }
    await ctx.http().delete(`${S()}/${draft.id}`).set(owner.auth).expect(204);
  });

  it('posts a debit note in its own series at the invoice place of supply', async () => {
    const r = await ctx.http().post(S()).set(owner.auth).send({ kind: 'INVOICE', contactId: mh, issueDate: today(), debitNoteFor: inv.id, reference: 'Steel price revision', lines: [line('500')] }).expect(201);
    expect(r.body).toMatchObject({ status: 'DRAFT', debitNoteFor: { id: inv.id, number: inv.number }, gst: { placeOfSupply: '27', igst: '90.00' }, total: '590.00' });
    dn = (await ctx.http().post(`${S()}/${r.body.id}/post`).set(owner.auth).send({}).expect(200)).body;
    expect(dn.number).toBe('DN-000001');
    expect(dn).toMatchObject({ kind: 'INVOICE', amountDue: '590.00', paymentStatus: 'UNPAID' });
    // Ordinary invoices keep their own numbers.
    const next = (await ctx.http().post(S()).set(owner.auth).send({ kind: 'INVOICE', contactId: other, issueDate: today(), post: true, lines: [{ ...line('100'), hsnCode: '7326' }] }).expect(201)).body;
    expect(next.number).toBe('INV-000002');
    const j = (await ctx.http().get(`${org.base}/journals/${dn.journalEntryId}`).set(owner.auth).expect(200)).body;
    expect(j.memo).toMatch(/DN-000001 · Pune Distributors · debit note on INV-000001/);
    const orig = (await ctx.http().get(`${S()}/${inv.id}`).set(owner.auth).expect(200)).body;
    expect(orig.debitNotes).toEqual([expect.objectContaining({ id: dn.id, number: 'DN-000001', status: 'POSTED', total: '590.00' })]);
  });

  it('is owed and received like an invoice', async () => {
    const pay = await ctx.http().post(`${org.base}/sales/payments`).set(owner.auth).send({ contactId: mh, date: today(), bankAccountId: org.acc['1120'], amount: '590.00', allocations: [{ documentId: dn.id, amount: '590.00' }] }).expect(201);
    expect(pay.body.allocations[0].target.number).toBe('DN-000001');
    expect((await ctx.http().get(`${S()}/${dn.id}`).set(owner.auth).expect(200)).body.amountDue).toBe('0.00');
  });

  it('reports it in GSTR-1 table 9B as a debit note and as its own series', async () => {
    const r = (await ctx.http().get(`${org.base}/gst/returns/gstr-1?from=2026-04-01&to=${today()}`).set(owner.auth).expect(200)).body;
    expect(r.b2b.map((x: { number: string }) => x.number)).toEqual([inv.number]);
    expect(r.cdnr).toEqual([expect.objectContaining({ number: 'DN-000001', noteType: 'D', originalNumber: inv.number, value: '590.00' })]);
    expect(r.documents).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'DEBIT_NOTE', from: 'DN-000001', to: 'DN-000001', issued: 1 })]));
    const b = (await ctx.http().get(`${org.base}/gst/returns/gstr-3b?from=2026-04-01&to=${today()}`).set(owner.auth).expect(200)).body;
    expect(b.outwardTaxable.igst).toBe('1890.00');
  });

  it('keeps the invoice from being voided while the debit note stands, and the link fixed', async () => {
    const r = await ctx.http().post(`${S()}/${inv.id}/void`).set(owner.auth).send({ reason: 'Wrong customer' }).expect(409);
    expect(r.body.error).toBe('HAS_DEBIT_NOTES');
    await expect(sqlWrite(ctx, `UPDATE documents SET debit_note_for_id = NULL WHERE id = '${dn.id}'`)).rejects.toThrow(/cannot change/);
    // A debit note cannot adjust another debit note.
    const chained = await ctx.http().post(S()).set(owner.auth).send({ kind: 'INVOICE', contactId: mh, issueDate: today(), debitNoteFor: dn.id, lines: [line('10')] }).expect(422);
    expect(chained.body.message).toMatch(/itself a debit note/);
  });
});
