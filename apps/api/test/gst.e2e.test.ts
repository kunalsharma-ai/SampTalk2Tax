import { gstinCheckCharacter } from '@talk2tax/tax-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';
import { Decimal128 } from '@talk2tax/document-db';
import { sqlWrite } from './sql-writes';

// Synthetic, format-valid GSTINs (made-up PANs, check character computed). Karnataka (29) is the organisation's state.
const synthetic = (state: string, pan: string) => `${state}${pan}1Z${gstinCheckCharacter(`${state}${pan}1Z`)}`;
const OWN = synthetic('29', 'ZZZCZ0001Z');
const MH_CUSTOMER = synthetic('27', 'ZZZFZ0002Z');
const KA_CUSTOMER = synthetic('29', 'ZZZCZ0003Z');
const TN_VENDOR = synthetic('33', 'ZZZCZ0004Z');

let ctx: Ctx;
let owner: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const rates: Record<string, { id: string }> = {};
const contacts: Record<string, { id: string; stateCode: string | null; gstin: string | null }> = {};
const kaGstin = KA_CUSTOMER;

function addDays(iso: string, n: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'GST Owner');
  org = await createOrg(ctx, owner);
});
afterAll(async () => {
  await ctx.app.close();
});

function doc(kind: string, contactId: string, lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  return { kind, contactId, issueDate: today(), lines, ...extra };
}
const line = (rate: string, unitPrice: string, extra: Record<string, unknown> = {}) => ({ accountId: org.acc['4100'], description: 'Goods', quantity: '1', unitPrice, taxRateId: rates[rate].id, hsnCode: '8471', ...extra });
const bline = (rate: string, unitPrice: string, extra: Record<string, unknown> = {}) => ({ ...line(rate, unitPrice, extra), accountId: org.acc['1300'] });

async function journalOf(entryId: string) {
  return (await ctx.http().get(`${org.base}/journals/${entryId}`).set(owner.auth).expect(200)).body as { lines: { accountId: string; debit: string; credit: string; description: string | null }[] };
}

describe('GST registration', () => {
  it('refuses GST rates before the organisation is registered', async () => {
    const r = await ctx.http().post(`${org.base}/tax-rates`).set(owner.auth).send({ name: 'GST 18%', rate: '18', kind: 'GST' }).expect(409);
    expect(r.body.error).toBe('GST_NOT_REGISTERED');
    expect((await ctx.http().get(`${org.base}/gst/registration`).set(owner.auth).expect(200)).body).toEqual({ registered: false });
  });

  it('checks the GSTIN and refuses organisations outside India', async () => {
    const bad = await ctx.http().put(`${org.base}/gst/registration`).set(owner.auth).send({ gstin: OWN.slice(0, 14) + (OWN[14] === 'A' ? 'B' : 'A'), effectiveFrom: today() }).expect(422);
    expect(bad.body.message).toMatch(/check character/);
    const uk = await createOrg(ctx, owner, { countryCode: 'GB', functionalCurrency: 'GBP' });
    const r = await ctx.http().put(`${uk.base}/gst/registration`).set(owner.auth).send({ gstin: OWN, effectiveFrom: today() }).expect(422);
    expect(r.body.error).toBe('NOT_INDIA');
  });

  it('registers and creates the six GST accounts', async () => {
    const r = await ctx.http().put(`${org.base}/gst/registration`).set(owner.auth).send({ gstin: OWN.toLowerCase(), legalName: 'Acme Test Pvt Ltd', effectiveFrom: today() }).expect(200);
    expect(r.body).toMatchObject({ registered: true, gstin: OWN, stateCode: '29', stateName: 'Karnataka', effectiveFrom: today() });
    expect(Object.values(r.body.accounts).map((a) => (a as { code: string }).code).sort()).toEqual(['1451', '1452', '1453', '2310', '2311', '2312']);
    const accounts = (await ctx.http().get(`${org.base}/accounts`).set(owner.auth).expect(200)).body as { code: string; id: string }[];
    for (const a of accounts) org.acc[a.code] = a.id;
    // Saving again reuses the same accounts.
    await ctx.http().put(`${org.base}/gst/registration`).set(owner.auth).send({ gstin: OWN, effectiveFrom: today() }).expect(200);
    expect(((await ctx.http().get(`${org.base}/accounts`).set(owner.auth).expect(200)).body as unknown[]).length).toBe(accounts.length);
  });

  it('creates GST rates with categories', async () => {
    for (const [key, body] of Object.entries({
      g18: { name: 'GST 18%', rate: '18', kind: 'GST' },
      g5: { name: 'GST 5%', rate: '5', kind: 'GST', gstCategory: 'TAXABLE' },
      nil: { name: 'Nil rated', rate: '0', kind: 'GST', gstCategory: 'NIL_RATED' },
      exempt: { name: 'Exempt', rate: '0', kind: 'GST', gstCategory: 'EXEMPT' },
    })) {
      const r = await ctx.http().post(`${org.base}/tax-rates`).set(owner.auth).send(body).expect(201);
      expect(r.body).toMatchObject({ kind: 'GST', salesAccountId: null, purchaseAccountId: null });
      rates[key] = r.body;
    }
    expect(rates.g18).toMatchObject({ gstCategory: 'TAXABLE' });
    await ctx.http().post(`${org.base}/tax-rates`).set(owner.auth).send({ name: 'Bad nil', rate: '5', kind: 'GST', gstCategory: 'NIL_RATED' }).expect(422);
    await ctx.http().post(`${org.base}/tax-rates`).set(owner.auth).send({ name: 'Bad acc', rate: '5', kind: 'GST', salesAccountId: org.acc['2300'] }).expect(422);
    rates.simple = (await ctx.http().post(`${org.base}/tax-rates`).set(owner.auth).send({ name: 'Old 10%', rate: '10', salesAccountId: org.acc['2300'], purchaseAccountId: org.acc['1450'] }).expect(201)).body;
  });

  it('keeps a GST rate from changing kind in the database', async () => {
    await expect(sqlWrite(ctx, `UPDATE tax_rates SET kind = 'SIMPLE', gst_category = NULL WHERE id = '${rates.g18.id}'`)).rejects.toThrow(/cannot change/);
  });
});

describe('contacts', () => {
  it('stores GSTIN and takes the state from it', async () => {
    const mk = async (key: string, body: Record<string, unknown>) => (contacts[key] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send(body).expect(201)).body);
    expect(await mk('ka', { name: 'Bengaluru Retail', isCustomer: true, gstin: kaGstin })).toMatchObject({ gstin: kaGstin, stateCode: '29' });
    expect(await mk('mh', { name: 'Pune Distributors', isCustomer: true, gstin: MH_CUSTOMER })).toMatchObject({ stateCode: '27' });
    expect(await mk('dl', { name: 'Walk-in Delhi', isCustomer: true, stateCode: '07' })).toMatchObject({ gstin: null, stateCode: '07' });
    await mk('nostate', { name: 'No State Ltd', isCustomer: true });
    await mk('tn', { name: 'Chennai Components', isVendor: true, gstin: TN_VENDOR });
    await mk('unreg', { name: 'Local Unregistered Supplier', isVendor: true, stateCode: '29' });
    const bad = await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Typo', isCustomer: true, gstin: MH_CUSTOMER.slice(0, 14) + (MH_CUSTOMER[14] === 'A' ? 'B' : 'A') }).expect(422);
    expect(bad.body.error).toBe('INVALID_GSTIN');
    await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Mismatch', isCustomer: true, gstin: MH_CUSTOMER, stateCode: '29' }).expect(422);
    await ctx.http().patch(`${org.base}/contacts/${contacts.mh.id}`).set(owner.auth).send({ stateCode: '29' }).expect(422);
    const check = (await ctx.http().post(`${org.base}/gst/check-gstin`).set(owner.auth).send({ gstin: ` ${MH_CUSTOMER.toLowerCase()}` }).expect(201)).body;
    expect(check).toMatchObject({ valid: true, gstin: MH_CUSTOMER, stateCode: '27', pan: 'ZZZFZ0002Z' });
  });
});

describe('GST documents', () => {
  let intra: { id: string; journalEntryId: string };

  it('charges CGST and SGST inside the state and posts them to their accounts', async () => {
    const r = await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ ...doc('INVOICE', contacts.ka.id, [line('g18', '10000.00'), line('nil', '500.00', { hsnCode: '0401' })]), post: true }).expect(201);
    intra = r.body;
    expect(r.body).toMatchObject({ subtotal: '10500.00', taxTotal: '1800.00', total: '12300.00' });
    expect(r.body.gst).toEqual({ placeOfSupply: '29', supplierState: '29', supplyNature: 'INTRA', counterpartyGstin: kaGstin, cgst: '900.00', sgst: '900.00', igst: '0.00' });
    expect(r.body.lines[0]).toMatchObject({ hsnCode: '8471', cgstAmount: '900.00', sgstAmount: '900.00', igstAmount: '0.00', taxKind: 'GST', gstCategory: 'TAXABLE' });
    const j = await journalOf(r.body.journalEntryId);
    const credit = (code: string) => j.lines.filter((l) => l.accountId === org.acc[code]).map((l) => [l.credit, l.description]);
    expect(credit('2310')).toEqual([['900.00', 'CGST']]);
    expect(credit('2311')).toEqual([['900.00', 'SGST']]);
    expect(credit('2312')).toEqual([]);
  });

  it('charges IGST across states, and to an unregistered buyer at the chosen place of supply', async () => {
    const mh = await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ ...doc('INVOICE', contacts.mh.id, [line('g18', '2000.00')]), post: true }).expect(201);
    expect(mh.body.gst).toMatchObject({ placeOfSupply: '27', supplyNature: 'INTER', igst: '360.00', cgst: '0.00' });
    const missing = await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send(doc('INVOICE', contacts.nostate.id, [line('g5', '100.00')])).expect(422);
    expect(missing.body.error).toBe('PLACE_OF_SUPPLY_REQUIRED');
    const b2c = await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ ...doc('INVOICE', contacts.nostate.id, [line('g5', '333.33', { hsnCode: '998314' })], { placeOfSupply: '07' }), post: true }).expect(201);
    expect(b2c.body.gst).toMatchObject({ placeOfSupply: '07', supplyNature: 'INTER', counterpartyGstin: null, igst: '16.67' });
    const big = await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ ...doc('INVOICE', contacts.dl.id, [line('g18', '150000.00')]), post: true }).expect(201);
    expect(big.body.gst).toMatchObject({ placeOfSupply: '07', igst: '27000.00' });
    const exportInv = await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ ...doc('INVOICE', contacts.nostate.id, [line('g18', '1000.00')], { placeOfSupply: '96' }), post: true }).expect(201);
    expect(exportInv.body.gst).toMatchObject({ placeOfSupply: '96', supplyNature: 'INTER', igst: '180.00' });
  });

  it('requires a GST rate and an HSN code on every line once registered', async () => {
    const noTax = await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send(doc('INVOICE', contacts.ka.id, [{ accountId: org.acc['4100'], quantity: '1', unitPrice: '10' }])).expect(422);
    expect(noTax.body.details.issues[0]).toMatch(/choose a GST rate/);
    const simple = await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send(doc('INVOICE', contacts.ka.id, [line('simple', '10')])).expect(422);
    expect(simple.body.details.issues[0]).toMatch(/choose a GST rate/);
    const noHsn = await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send(doc('INVOICE', contacts.ka.id, [line('g18', '10', { hsnCode: '' })])).expect(422);
    expect(noHsn.body.details.issues[0]).toMatch(/HSN or SAC/);
    const shortHsn = await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send(doc('INVOICE', contacts.ka.id, [line('g18', '10', { hsnCode: '84713' })])).expect(422);
    expect(shortHsn.body.details.issues[0]).toMatch(/4, 6 or 8/);
  });

  it('refuses GST rates before the effective date, and allows plain documents then', async () => {
    const before = addDays(today(), -1);
    const r = await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send(doc('INVOICE', contacts.ka.id, [line('g18', '10')], { issueDate: before })).expect(422);
    expect(r.body.details.issues[0]).toMatch(/apply from/);
    const plain = await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send(doc('INVOICE', contacts.ka.id, [line('simple', '10', { hsnCode: null })], { issueDate: before })).expect(201);
    expect(plain.body.gst).toBeNull();
    await ctx.http().delete(`${org.base}/sales/documents/${plain.body.id}`).set(owner.auth).expect(204);
  });

  it('takes input tax on bills, and refuses GST from an unregistered supplier', async () => {
    const bill = await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ ...doc('BILL', contacts.tn.id, [bline('g18', '5000.00', { hsnCode: '85423100' })], { reference: 'TN/77' }), post: true }).expect(201);
    expect(bill.body.gst).toMatchObject({ placeOfSupply: '29', supplierState: '33', supplyNature: 'INTER', counterpartyGstin: TN_VENDOR, igst: '900.00' });
    const j = await journalOf(bill.body.journalEntryId);
    expect(j.lines.filter((l) => l.accountId === org.acc['1453']).map((l) => l.debit)).toEqual(['900.00']);
    const unreg = await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send(doc('BILL', contacts.unreg.id, [bline('g18', '100.00')])).expect(422);
    expect(unreg.body.details.issues[0]).toMatch(/no GSTIN/);
    await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ ...doc('BILL', contacts.unreg.id, [bline('exempt', '800.00', { hsnCode: '0701' })]), post: true }).expect(201);
  });

  it('nets a credit note and keeps posted GST facts immutable', async () => {
    const cn = await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ ...doc('CREDIT_NOTE', contacts.ka.id, [line('g18', '1000.00')]), post: true }).expect(201);
    expect(cn.body.gst).toMatchObject({ cgst: '90.00', sgst: '90.00' });
    await expect(sqlWrite(ctx, `UPDATE documents SET place_of_supply = '27', supply_nature = 'INTER' WHERE id = '${intra.id}'`)).rejects.toThrow(/immutable/);
  });

  it('re-checks a draft when it posts', async () => {
    const draft = await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send(doc('INVOICE', contacts.ka.id, [line('g18', '100.00')])).expect(201);
    expect(draft.body.gst).toMatchObject({ supplyNature: 'INTRA', cgst: '9.00' });
    // The stored draft is tampered with so it no longer matches what GST says now.
    await sqlWrite(ctx, `UPDATE document_lines SET cgst_amount = 0, sgst_amount = 0, igst_amount = 18 WHERE document_id = '${draft.body.id}'`);
    // MongoDB holds the record, so the tampering is done there too.
    await ctx.db.collection('documents').updateOne({ _id: draft.body.id }, { $set: { 'lines.$[].cgstAmount': Decimal128.fromString('0'), 'lines.$[].sgstAmount': Decimal128.fromString('0'), 'lines.$[].igstAmount': Decimal128.fromString('18') } });
    const r = await ctx.http().post(`${org.base}/sales/documents/${draft.body.id}/post`).set(owner.auth).send({}).expect(409);
    expect(r.body.error).toBe('TOTAL_CHANGED');
    await ctx.http().delete(`${org.base}/sales/documents/${draft.body.id}`).set(owner.auth).expect(204);
  });

  it('keeps GST rates off expense claims', async () => {
    const r = await ctx.http().post(`${org.base}/expense-claims`).set(owner.auth).send({ title: 'Trip', lines: [{ date: today(), accountId: org.acc['6700'], merchant: 'Cab', amount: '118.00', taxRateId: rates.g18.id }] });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toMatch(/GST rates cannot be used on expense claims/);
  });
});

describe('returns', () => {
  const from = () => `${today().slice(0, 8)}01`;

  it('summarises outward supplies for GSTR-1', async () => {
    const r = (await ctx.http().get(`${org.base}/gst/returns/gstr-1?from=${from()}&to=${today()}`).set(owner.auth).expect(200)).body;
    expect(r.gstin).toBe(OWN);
    expect(r.b2b.map((x: { gstin: string; value: string }) => [x.gstin, x.value])).toEqual([
      [kaGstin, '12300.00'],
      [MH_CUSTOMER, '2360.00'],
    ]);
    expect(r.b2cl.map((x: { placeOfSupply: string; value: string }) => [x.placeOfSupply, x.value])).toEqual([['07', '177000.00']]);
    expect(r.b2cs).toEqual(
      expect.arrayContaining([
        { placeOfSupply: '07', nature: 'INTER', rate: '5', taxable: '333.33', igst: '16.67', cgst: '0.00', sgst: '0.00' },
      ]),
    );
    expect(r.b2cs.some((x: { placeOfSupply: string }) => x.placeOfSupply === '96')).toBe(false);
    expect(r.exp.map((x: { value: string }) => x.value)).toEqual(['1180.00']);
    expect(r.cdnr).toHaveLength(1);
    expect(r.nil).toEqual([{ nature: 'INTRA', registered: true, nilRated: '500.00', exempt: '0.00', nonGst: '0.00' }]);
    expect(r.documents.find((d: { kind: string }) => d.kind === 'INVOICE').issued).toBe(5);
  });

  it('summarises GSTR-3B, sets off input tax, and agrees with the ledger', async () => {
    const r = (await ctx.http().get(`${org.base}/gst/returns/gstr-3b?from=${from()}&to=${today()}`).set(owner.auth).expect(200)).body;
    // Outward: CGST/SGST 900 - 90 each; IGST 360 + 16.67 + 27000, plus 180 on the export (3.1(b)).
    expect(r.outwardTaxable).toEqual({ taxable: '161333.33', igst: '27376.67', cgst: '810.00', sgst: '810.00' });
    expect(r.outwardZeroRated).toEqual({ taxable: '1000.00', igst: '180.00' });
    expect(r.outwardNilExempt).toBe('500.00');
    expect(r.itc).toEqual({ igst: '900.00', cgst: '0.00', sgst: '0.00' });
    expect(r.inwardExempt).toEqual({ inter: '0.00', intra: '800.00' });
    expect(r.setOff.used.igst.igst).toBe('900.00');
    expect(r.setOff.cash).toEqual({ igst: '26656.67', cgst: '810.00', sgst: '810.00' });
    expect(r.ledger).toEqual({ output: { igst: '27556.67', cgst: '810.00', sgst: '810.00' }, input: { igst: '900.00', cgst: '0.00', sgst: '0.00' }, agrees: true });
  });

  it('flags a manual journal on a GST account as a ledger difference', async () => {
    await ctx
      .http()
      .post(`${org.base}/journals`)
      .set(owner.auth)
      .send({ date: today(), type: 'STANDARD', memo: 'Manual GST adjustment', post: true, lines: [{ accountId: org.acc['2310'], credit: '10.00' }, { accountId: org.acc['6700'], debit: '10.00' }] })
      .expect(201);
    const r = (await ctx.http().get(`${org.base}/gst/returns/gstr-3b?from=${from()}&to=${today()}`).set(owner.auth).expect(200)).body;
    expect(r.ledger.output.cgst).toBe('820.00');
    expect(r.ledger.agrees).toBe(false);
  });

  it('refuses to change the GSTIN once documents carry it', async () => {
    const r = await ctx.http().put(`${org.base}/gst/registration`).set(owner.auth).send({ gstin: MH_CUSTOMER, effectiveFrom: today() }).expect(409);
    expect(r.body.error).toBe('GST_IN_USE');
  });

  it('needs reports access and a valid period', async () => {
    await ctx.http().get(`${org.base}/gst/returns/gstr-3b?from=${today()}&to=${from()}`).set(owner.auth).expect(today() === from() ? 200 : 400);
    const other = await registerUser(ctx, 'Outsider');
    await ctx.http().get(`${org.base}/gst/returns/gstr-1?from=${from()}&to=${today()}`).set(other.auth).expect(404);
  });
});
