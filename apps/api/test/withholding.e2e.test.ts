import { gstinCheckCharacter } from '@talk2tax/tax-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';
import { sqlWrite } from './sql-writes';

// Synthetic, format-valid identifiers (made-up PANs). Maharashtra (27) is the organisation's state.
const gstin = (state: string, pan: string) => `${state}${pan}1Z${gstinCheckCharacter(`${state}${pan}1Z`)}`;
const OWN = gstin('27', 'ZZZCW0001Z');
const CONSULTANT = gstin('27', 'ZZZCW0002Z');
const CUSTOMER = gstin('29', 'ZZZCW0003Z');

let ctx: Ctx;
let owner: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const rates: Record<string, { id: string }> = {};
const sections: Record<string, { id: string; code: string }> = {};
const contacts: Record<string, { id: string; pan: string | null }> = {};
const docs: Record<string, { id: string; journalEntryId: string; total: string; withholding: { amount: string } | null }> = {};

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'TDS Owner');
  org = await createOrg(ctx, owner);
  await ctx.http().put(`${org.base}/gst/registration`).set(owner.auth).send({ gstin: OWN, effectiveFrom: today() }).expect(200);
  for (const [k, body] of Object.entries({ g18: { name: 'GST 18%', rate: '18', kind: 'GST' }, exempt: { name: 'Exempt', rate: '0', kind: 'GST', gstCategory: 'EXEMPT' } })) {
    rates[k] = (await ctx.http().post(`${org.base}/tax-rates`).set(owner.auth).send(body).expect(201)).body;
  }
});
afterAll(async () => {
  await ctx.app.close();
});

const bline = (unitPrice: string, extra: Record<string, unknown> = {}) => ({ accountId: org.acc['6600'], description: 'Services', quantity: '1', unitPrice, taxRateId: rates.g18.id, hsnCode: '998221', ...extra });
const bill = (contact: string, lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({ kind: 'BILL', contactId: contacts[contact].id, issueDate: today(), lines, post: true, ...extra });
const postBill = async (key: string, body: Record<string, unknown>) => (docs[key] = (await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send(body).expect(201)).body);
async function journal(entryId: string) {
  const j = (await ctx.http().get(`${org.base}/journals/${entryId}`).set(owner.auth).expect(200)).body as { lines: { accountId: string; debit: string; credit: string }[] };
  const by = (code: string) => j.lines.filter((l) => l.accountId === org.acc[code]).map((l) => (l.debit !== '0.00' ? `Dr ${l.debit}` : `Cr ${l.credit}`));
  return by;
}

describe('setup', () => {
  it('needs TDS/TCS settings before sections, and checks the TAN', async () => {
    expect((await ctx.http().get(`${org.base}/withholding/settings`).set(owner.auth).expect(200)).body).toEqual({ configured: false });
    expect((await ctx.http().post(`${org.base}/withholding/sections`).set(owner.auth).send({ template: '393(1)-6(i)' }).expect(409)).body.error).toBe('WITHHOLDING_NOT_CONFIGURED');
    expect((await ctx.http().put(`${org.base}/withholding/settings`).set(owner.auth).send({ tan: 'PNE123456B' }).expect(422)).body.error).toBe('INVALID_TAN');
  });

  it('saves the TAN and creates the TDS and TCS payable accounts', async () => {
    const r = await ctx.http().put(`${org.base}/withholding/settings`).set(owner.auth).send({ tan: 'pnez12345b' }).expect(200);
    expect(r.body).toMatchObject({ configured: true, tan: 'PNEZ12345B', accounts: { tdsPayable: { code: '2320', name: 'TDS payable' }, tcsPayable: { code: '2321', name: 'TCS payable' } } });
    const accounts = (await ctx.http().get(`${org.base}/accounts`).set(owner.auth).expect(200)).body as { code: string; id: string }[];
    for (const a of accounts) org.acc[a.code] = a.id;
  });

  it('creates sections from templates and by hand, and keeps their rules fixed', async () => {
    const templates = (await ctx.http().get(`${org.base}/withholding/templates`).set(owner.auth).expect(200)).body as { code: string }[];
    expect(templates.map((t) => t.code)).toContain('393(1)-6(iii)(b)');
    for (const [k, code] of [['contractor', '393(1)-6(i)'], ['professional', '393(1)-6(iii)(b)']]) {
      sections[k] = (await ctx.http().post(`${org.base}/withholding/sections`).set(owner.auth).send({ template: code }).expect(201)).body;
    }
    expect(sections.contractor).toMatchObject({ kind: 'TDS', rate: '2', rateIndividualHuf: '1', singleThreshold: '30000.00', aggregateThreshold: '100000.00', thresholdWindow: 'TAX_YEAR', validFrom: '2026-04-01' });
    sections.tcs = (
      await ctx
        .http()
        .post(`${org.base}/withholding/sections`)
        .set(owner.auth)
        .send({ kind: 'TCS', code: 'TCS-SCRAP', name: 'Sale of scrap', rate: '1', rateNoPan: '5', thresholdWindow: 'TAX_YEAR', thresholdBasis: 'WHOLE', validFrom: '2026-04-01' })
        .expect(201)
    ).body;
    await ctx.http().post(`${org.base}/withholding/sections`).set(owner.auth).send({ template: '393(1)-6(i)' }).expect(409);
    const bad = await ctx.http().post(`${org.base}/withholding/sections`).set(owner.auth).send({ kind: 'TDS', code: 'X', name: 'X', rate: '0', rateNoPan: '20', thresholdWindow: 'TAX_YEAR', thresholdBasis: 'EXCESS', validFrom: '2026-04-01' }).expect(422);
    expect(bad.body.details.issues.join(' ')).toMatch(/Rate must be above 0.*excess needs an aggregate/);
    await expect(sqlWrite(ctx, `UPDATE withholding_sections SET rate = 5 WHERE id = '${sections.professional.id}'`)).rejects.toThrow(/cannot change/);
    await ctx.http().patch(`${org.base}/withholding/sections/${sections.professional.id}`).set(owner.auth).send({ name: 'Professional fees' }).expect(200);
  });

  it('stores PANs, taking them from the GSTIN', async () => {
    const mk = async (k: string, body: Record<string, unknown>) => (contacts[k] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send(body).expect(201)).body);
    expect(await mk('consultant', { name: 'Deccan Consulting LLP', isVendor: true, gstin: CONSULTANT, withholdingSectionId: sections.professional.id })).toMatchObject({ pan: 'ZZZCW0002Z', withholdingSectionId: sections.professional.id });
    expect(await mk('contractor', { name: 'R. Patil (contractor)', isVendor: true, stateCode: '27', pan: 'zzzpw0004z' })).toMatchObject({ pan: 'ZZZPW0004Z', stateCode: '27' });
    expect(await mk('nopan', { name: 'Unknown Designer', isVendor: true, stateCode: '27' })).toMatchObject({ pan: null });
    await mk('advocate', { name: 'Adv. S. Kulkarni', isVendor: true, stateCode: '27', pan: 'ZZZPW0005Z' });
    await mk('foreign', { name: 'CloudSuite Inc.', isVendor: true, stateCode: '96' });
    await mk('customer', { name: 'Karnataka Metals', isCustomer: true, gstin: CUSTOMER });
    const mismatch = await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Mismatch', isVendor: true, gstin: CONSULTANT, pan: 'ZZZCW0009Z' }).expect(422);
    expect(mismatch.body.error).toBe('INVALID_PAN');
    await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Bad PAN', isVendor: true, pan: 'ZZZXW0001Z' }).expect(422);
  });
});

describe('TDS on bills', () => {
  it('counts a bill below the threshold, then catches it up when the year crosses it', async () => {
    await postBill('fee1', bill('consultant', [bline('40000.00')], { withholdingSectionId: sections.professional.id }));
    expect(docs.fee1).toMatchObject({ total: '47200.00', withholding: { kind: 'TDS', subject: '40000.00', base: '0.00', amount: '0.00', pan: 'ZZZCW0002Z' } });
    const preview = (await ctx.http().post(`${org.base}/withholding/preview`).set(owner.auth).send({ documentKind: 'BILL', contactId: contacts.consultant.id, sectionId: sections.professional.id, issueDate: today(), amount: '20000.00' }).expect(201)).body;
    expect(preview).toMatchObject({ kind: 'TDS', base: '60000.00', rate: '10', amount: '6000.00' });
    expect(preview.reason).toMatch(/earlier amounts of 40000.00 are included/);
    await postBill('fee2', bill('consultant', [bline('20000.00')], { withholdingSectionId: sections.professional.id }));
    // 20,000 + 3,600 GST, less TDS of 10% on 60,000.
    expect(docs.fee2).toMatchObject({ subtotal: '20000.00', taxTotal: '3600.00', total: '17600.00', amountDue: '17600.00', withholding: { base: '60000.00', rate: '10', amount: '6000.00' } });
    const j = await journal(docs.fee2.journalEntryId);
    expect(j('2100')).toEqual(['Cr 17600.00']);
    expect(j('2320')).toEqual(['Cr 6000.00']);
    expect(j('6600')).toEqual(['Dr 20000.00']);
  });

  it('uses the individual rate for a contractor and the higher rate when there is no PAN', async () => {
    await postBill('contract', bill('contractor', [bline('35000.00', { accountId: org.acc['6200'], taxRateId: rates.exempt.id, hsnCode: '995411' })], { withholdingSectionId: sections.contractor.id }));
    expect(docs.contract).toMatchObject({ total: '34650.00', withholding: { rate: '1', amount: '350.00' } });
    await postBill('nopan', bill('nopan', [bline('60000.00', { taxRateId: rates.exempt.id })], { withholdingSectionId: sections.professional.id }));
    expect(docs.nopan).toMatchObject({ total: '48000.00', withholding: { rate: '20', amount: '12000.00', pan: null } });
  });

  it('re-checks the TDS when a draft posts', async () => {
    const draft = (await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send(bill('nopan', [bline('10000.00', { taxRateId: rates.exempt.id })], { withholdingSectionId: sections.professional.id, post: false })).expect(201)).body;
    expect(draft.withholding).toMatchObject({ rate: '20', amount: '2000.00' });
    await ctx.http().patch(`${org.base}/contacts/${contacts.nopan.id}`).set(owner.auth).send({ pan: 'ZZZPW0006Z' }).expect(200);
    const r = await ctx.http().post(`${org.base}/purchases/documents/${draft.id}/post`).set(owner.auth).send({}).expect(409);
    expect(r.body.error).toBe('TOTAL_CHANGED');
    expect(r.body.message).toMatch(/now 1000.00/);
    await ctx.http().delete(`${org.base}/purchases/documents/${draft.id}`).set(owner.auth).expect(204);
  });

  it('refuses TDS on invoices and TCS on bills', async () => {
    const r = await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send(bill('consultant', [bline('100.00')], { withholdingSectionId: sections.tcs.id })).expect(422);
    expect(r.body.message).toMatch(/TCS section; bills take TDS/);
  });
});

describe('reverse charge', () => {
  it('suggests reverse charge for GST from an unregistered or foreign supplier', async () => {
    const a = await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send(bill('advocate', [bline('50000.00', { hsnCode: '998211' })])).expect(422);
    expect(a.body.details.issues.join(' ')).toMatch(/Tick Reverse charge/);
    const f = await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send(bill('foreign', [bline('10000.00', { hsnCode: '997331' })])).expect(422);
    expect(f.body.details.issues.join(' ')).toMatch(/outside India/);
  });

  it('self-assesses CGST and SGST on legal services, with TDS on the net', async () => {
    await postBill('legal', bill('advocate', [bline('60000.00', { hsnCode: '998211' })], { reverseCharge: true, withholdingSectionId: sections.professional.id }));
    expect(docs.legal).toMatchObject({ reverseCharge: true, reverseChargeTax: '10800.00', subtotal: '60000.00', taxTotal: '0.00', total: '54000.00', withholding: { base: '60000.00', amount: '6000.00' } });
    expect((docs.legal as unknown as { gst: object }).gst).toMatchObject({ supplyNature: 'INTRA', cgst: '5400.00', sgst: '5400.00' });
    const j = await journal(docs.legal.journalEntryId);
    expect([j('2100'), j('1451'), j('1452'), j('2310'), j('2311'), j('2320')]).toEqual([['Cr 54000.00'], ['Dr 5400.00'], ['Dr 5400.00'], ['Cr 5400.00'], ['Cr 5400.00'], ['Cr 6000.00']]);
  });

  it('treats services from abroad as an import, with IGST under reverse charge', async () => {
    await postBill('cloud', bill('foreign', [bline('10000.00', { accountId: org.acc['6400'], hsnCode: '997331' })], { reverseCharge: true }));
    expect(docs.cloud).toMatchObject({ total: '10000.00', reverseChargeTax: '1800.00' });
    const j = await journal(docs.cloud.journalEntryId);
    expect([j('1453'), j('2312')]).toEqual([['Dr 1800.00'], ['Cr 1800.00']]);
  });

  it('is only for GST purchases with tax', async () => {
    const inv = { kind: 'INVOICE', contactId: contacts.customer.id, issueDate: today(), reverseCharge: true, lines: [{ ...bline('100.00'), accountId: org.acc['4100'] }] };
    expect((await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send(inv).expect(422)).body.details.issues).toContain('Reverse charge applies to bills and vendor credits');
    const nil = await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send(bill('advocate', [bline('100.00', { taxRateId: rates.exempt.id })], { reverseCharge: true })).expect(422);
    expect(nil.body.details.issues.join(' ')).toMatch(/at least one line with a GST rate above 0%/);
  });
});

describe('TCS on invoices and GST returns', () => {
  it('adds TCS on the invoice value including GST, outside the GST invoice value', async () => {
    const r = await ctx
      .http()
      .post(`${org.base}/sales/documents`)
      .set(owner.auth)
      .send({ kind: 'INVOICE', contactId: contacts.customer.id, issueDate: today(), withholdingSectionId: sections.tcs.id, post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: '100000.00', taxRateId: rates.g18.id, hsnCode: '7204' }] })
      .expect(201);
    expect(r.body).toMatchObject({ subtotal: '100000.00', taxTotal: '18000.00', total: '119180.00', withholding: { kind: 'TCS', base: '118000.00', rate: '1', amount: '1180.00' } });
    const j = await journal(r.body.journalEntryId);
    expect([j('1200'), j('2321')]).toEqual([['Dr 119180.00'], ['Cr 1180.00']]);
    const g1 = (await ctx.http().get(`${org.base}/gst/returns/gstr-1?from=${today()}&to=${today()}`).set(owner.auth).expect(200)).body;
    expect(g1.b2b[0]).toMatchObject({ number: r.body.number, value: '118000.00' });
  });

  it('reports reverse-charge purchases in GSTR-3B and still agrees with the ledger', async () => {
    const r = (await ctx.http().get(`${org.base}/gst/returns/gstr-3b?from=${today()}&to=${today()}`).set(owner.auth).expect(200)).body;
    expect(r.inwardReverseCharge).toEqual({ taxable: '70000.00', igst: '1800.00', cgst: '5400.00', sgst: '5400.00' });
    expect(r.itcImportServices).toEqual({ igst: '1800.00', cgst: '0.00', sgst: '0.00' });
    expect(r.itcReverseCharge).toEqual({ igst: '0.00', cgst: '5400.00', sgst: '5400.00' });
    expect(r.itc).toEqual({ igst: '0.00', cgst: '5400.00', sgst: '5400.00' });
    expect(r.reverseChargeCash).toEqual({ igst: '1800.00', cgst: '5400.00', sgst: '5400.00' });
    expect(r.ledger.agrees).toBe(true);
  });
});

describe('register and deposits', () => {
  let deposit: { id: string; number: string; journalEntryId: string };

  it('lists every TDS document with what is still to deposit, and ties to the ledger', async () => {
    const r = (await ctx.http().get(`${org.base}/withholding/register?kind=TDS&from=${today()}&to=${today()}`).set(owner.auth).expect(200)).body;
    expect(r.tan).toBe('PNEZ12345B');
    expect(r.rows).toHaveLength(5);
    expect(r.totals).toMatchObject({ withheld: '24350.00', deposited: '0.00', pending: '24350.00' });
    expect(r.sections.map((s: { section: { code: string }; amount: string }) => [s.section.code, s.amount])).toEqual([
      ['393(1)-6(i)', '350.00'],
      ['393(1)-6(iii)(b)', '24000.00'],
    ]);
    expect(r.ledger).toMatchObject({ balance: '24350.00', expected: '24350.00', agrees: true, account: { code: '2320' } });
  });

  it('records a challan for the deducted tax, with interest, and refuses a second one for the same bill', async () => {
    const ids = [docs.fee2.id, docs.contract.id, docs.nopan.id, docs.legal.id];
    const bad = await ctx.http().post(`${org.base}/withholding/deposits`).set(owner.auth).send({ kind: 'TDS', depositDate: today(), bankAccountId: org.acc['1120'], challanReference: 'CIN 0510001-01112026-00042', documentIds: [...ids, docs.fee1.id] }).expect(422);
    expect(bad.body.details.issues.join(' ')).toMatch(/below the threshold/);
    const r = await ctx
      .http()
      .post(`${org.base}/withholding/deposits`)
      .set(owner.auth)
      .send({ kind: 'TDS', depositDate: today(), bankAccountId: org.acc['1120'], challanReference: 'CIN 0510001-01112026-00042', documentIds: ids, interestAmount: '150.00', interestAccountId: org.acc['7100'] })
      .expect(201);
    deposit = r.body;
    expect(r.body).toMatchObject({ kind: 'TDS', number: 'TDSD-000001', taxAmount: '24350.00', interestAmount: '150.00', status: 'POSTED' });
    expect(r.body.items).toHaveLength(4);
    const j = await journal(r.body.journalEntryId);
    expect([j('2320'), j('7100'), j('1120')]).toEqual([['Dr 24350.00'], ['Dr 150.00'], ['Cr 24500.00']]);
    const again = await ctx.http().post(`${org.base}/withholding/deposits`).set(owner.auth).send({ kind: 'TDS', depositDate: today(), bankAccountId: org.acc['1120'], challanReference: 'X', documentIds: [docs.legal.id] }).expect(422);
    expect(again.body.details.issues.join(' ')).toMatch(/already in a deposit/);
    const reg = (await ctx.http().get(`${org.base}/withholding/register?kind=TDS&from=${today()}&to=${today()}`).set(owner.auth).expect(200)).body;
    expect(reg.totals).toMatchObject({ deposited: '24350.00', pending: '0.00' });
    expect(reg.ledger).toMatchObject({ balance: '0.00', agrees: true });
    const legal = (await ctx.http().get(`${org.base}/purchases/documents/${docs.legal.id}`).set(owner.auth).expect(200)).body;
    expect(legal.withholding.deposit).toMatchObject({ number: 'TDSD-000001', challanReference: 'CIN 0510001-01112026-00042' });
  });

  it('will not void a bill whose TDS is deposited until the deposit is voided', async () => {
    const r = await ctx.http().post(`${org.base}/purchases/documents/${docs.legal.id}/void`).set(owner.auth).send({ reason: 'Entered twice' }).expect(409);
    expect(r.body.error).toBe('TAX_DEPOSITED');
    await expect(sqlWrite(ctx, `UPDATE withholding_deposit_items SET active = false WHERE document_id = '${docs.legal.id}'`)).rejects.toThrow(/only change when their deposit is voided/);
    const v = await ctx.http().post(`${org.base}/withholding/deposits/${deposit.id}/void`).set(owner.auth).send({ reason: 'Wrong challan' }).expect(200);
    expect(v.body).toMatchObject({ status: 'VOID', voidReason: 'Wrong challan' });
    await ctx.http().post(`${org.base}/purchases/documents/${docs.legal.id}/void`).set(owner.auth).send({ reason: 'Entered twice' }).expect(200);
    const reg = (await ctx.http().get(`${org.base}/withholding/register?kind=TDS&from=${today()}&to=${today()}`).set(owner.auth).expect(200)).body;
    expect(reg.totals).toMatchObject({ withheld: '18350.00', deposited: '0.00' });
    expect(reg.ledger).toMatchObject({ balance: '18350.00', agrees: true });
    expect(reg.rows.find((x: { documentId: string }) => x.documentId === docs.legal.id)).toMatchObject({ status: 'VOID', deposit: null });
  });

  it('keeps posted withholding facts immutable and tenants apart', async () => {
    await expect(sqlWrite(ctx, `UPDATE documents SET withholding_amount = 0, total = total + 6000 WHERE id = '${docs.fee2.id}'`)).rejects.toThrow(/immutable/);
    const other = await registerUser(ctx, 'Other');
    const otherOrg = await createOrg(ctx, other);
    await ctx.http().get(`${org.base}/withholding/register?kind=TDS&from=${today()}&to=${today()}`).set(other.auth).expect(404);
    expect((await ctx.http().get(`${otherOrg.base}/withholding/sections`).set(other.auth).expect(200)).body).toEqual([]);
    await ctx.http().post(`${otherOrg.base}/withholding/deposits/${deposit.id}/void`).set(other.auth).send({ reason: 'Not mine' }).expect(404);
  });
});
