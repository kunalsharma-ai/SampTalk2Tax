import { gstinCheckCharacter, taxYearOf } from '@talk2tax/tax-engine';
import PDFDocument from 'pdfkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Tax document interpretation (TAX-043) against the real API and database: an Indian company
 * uploads a customer's TDS certificate as a PDF and pastes its annual tax statement and a GST
 * challan. Each is recognised, explained and checked against the company's PAN and GSTIN, and
 * the statement's TDS is compared with the TDS receivable account. A US company reads a 1099 it
 * received. Readings are kept, marked reviewed once, audited and refused to viewers for writing.
 */
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const ty = taxYearOf(T);
const AY = `${Number(ty.label.slice(0, 4)) + 1}-${String((Number(ty.label.slice(0, 4)) + 2) % 100).padStart(2, '0')}`;
const PAN = 'ZZZTD0001Z';
const GSTIN = `27${PAN}1Z${gstinCheckCharacter(`27${PAN}1Z`)}`;
const R = () => `${org.base}/tax/document-readings`;

function certificatePdf(): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const parts: Buffer[] = [];
    doc.on('data', (b: Buffer) => parts.push(b));
    doc.on('end', () => resolve(Buffer.concat(parts)));
    doc.fontSize(14).text('FORM NO. 16A', 40, 40);
    doc.fontSize(10);
    let y = 70;
    for (const line of [
      'Certificate under section 203 of the Income-tax Act, 1961 for tax deducted at source',
      'Certificate No. QWERTYU',
      'Name of the Deductor: Synthetic Buyer Private Limited',
      'TAN of the Deductor: MUMS12345A',
      `PAN of the Deductee: ${PAN}`,
      `Assessment Year ${AY}`,
      'Quarter Q2',
      'Section 194J',
      'Amount paid/credited 2,00,000.00',
      'Amount of tax deducted 20,000.00',
      'Amount of tax deposited 20,000.00',
    ]) {
      doc.text(line, 40, y);
      y += 16;
    }
    doc.end();
  });
}

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Tax Docs Owner');
  viewer = await registerUser(ctx, 'Tax Docs Viewer');
  org = await createOrg(ctx, owner);
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  await ctx.http().put(`${org.base}/gst/registration`).set(owner.auth).send({ gstin: GSTIN, legalName: 'Tax Docs Pvt Ltd', effectiveFrom: ty.from }).expect(200);
  const tds = (await ctx.http().post(`${org.base}/accounts`).set(owner.auth).send({ code: '1470', name: 'TDS Receivable', type: 'ASSET', subtype: 'OTHER_CURRENT_ASSET' }).expect(201)).body.id;
  await ctx
    .http()
    .post(`${org.base}/journals`)
    .set(owner.auth)
    .send({
      date: ty.from,
      post: true,
      memo: 'TDS deducted by customers',
      lines: [
        { accountId: tds, debit: '10000.00' },
        { accountId: org.acc['1120'], credit: '10000.00' },
      ],
    })
    .expect(201);
  await ctx
    .http()
    .put(`${org.base}/tax/advance-tax`)
    .set(owner.auth)
    .send({ taxYear: ty.label, regime: 'COMPANY_22', method: 'ANNUALISE', estimatedIncome: null, adjustments: [], paidAccountId: null, tdsAccountId: tds, otherCredits: '0' })
    .expect(200);
});
afterAll(async () => ctx?.app.close());

describe('tax document interpretation', () => {
  it('reads a TDS certificate PDF, explains it and checks it against the PAN', async () => {
    const pdf = await certificatePdf();
    await ctx.http().post(`${R()}/file?fileName=16A.pdf`).set(viewer.auth).set('content-type', 'application/pdf').send(pdf).expect(403);
    const r = (await ctx.http().post(`${R()}/file?fileName=16A.pdf`).set(owner.auth).set('content-type', 'application/pdf').send(pdf).expect(201)).body;
    expect(r).toMatchObject({ number: 'TD-0001', source: 'PDF', kind: 'TDS_CERTIFICATE', status: 'READ', createdBy: 'Tax Docs Owner' });
    expect(r.reading.title).toBe('TDS certificate (Form 16A)');
    expect(r.reading.year).toBe(ty.label);
    const v = Object.fromEntries(r.reading.fields.map((f: { key: string; value: string }) => [f.key, f.value]));
    expect(v).toMatchObject({ deductorName: 'Synthetic Buyer Private Limited', deductorTan: 'MUMS12345A', deducteePan: PAN, section: '194J', amountPaid: '200000.00', taxDeducted: '20000.00' });
    expect(r.reading.checks).toEqual([
      { level: 'OK', message: 'The certificate is for your PAN.' },
      { level: 'OK', message: expect.stringContaining('10% of the amount paid') },
    ]);
    const raw = await ctx.db.collection('tax_document_readings').findOne({ _id: r.id as never });
    expect(Buffer.from(raw!.content.buffer).subarray(0, 5).toString('latin1')).not.toBe('%PDF-');
  });

  it('compares the annual statement with the TDS receivable account', async () => {
    const text = [
      'Annual Tax Statement (Form 26AS)',
      `Permanent Account Number (PAN) ${PAN}`,
      `Assessment Year ${AY}`,
      'Sr. No. | Name of Deductor | TAN of Deductor | Total Amount Paid / Credited | Total Tax Deducted | Total TDS Deposited',
      '1 | SYNTHETIC BUYER PRIVATE LIMITED | MUMS12345A | 80000.00 | 8000.00 | 8000.00',
      '2 | SYNTHETIC RETAIL LLP | DELS54321B | 1,50,000.00 | 3,000.00 | 3,000.00',
    ].join('\n');
    const r = (await ctx.http().post(`${R()}/text`).set(owner.auth).send({ text, fileName: '26AS.txt' }).expect(201)).body;
    expect(r.kind).toBe('ANNUAL_TAX_STATEMENT');
    expect(r.reading.booksTds).toBe('10000.00');
    expect(r.reading.totals).toMatchObject({ amountPaid: '230000.00', taxDeducted: '11000.00' });
    expect(r.reading.deductors).toHaveLength(2);
    expect(r.reading.checks).toEqual([{ level: 'WARNING', message: expect.stringContaining('1000.00 more TDS than your TDS receivable account') }]);
  });

  it('flags a GST challan for another GSTIN', async () => {
    const other = `29ZZZXX0002Z1Z${gstinCheckCharacter('29ZZZXX0002Z1Z')}`;
    const text = ['Form GST PMT-06', 'CPIN: 26112900054321', `GSTIN: ${other}`, 'CGST Tax 0.00 4,500.00', 'SGST Tax 0.00 4,500.00', 'Total Challan Amount: 9,000.00'].join('\n');
    const r = (await ctx.http().post(`${R()}/text`).set(owner.auth).send({ text }).expect(201)).body;
    expect(r.reading.checks[0]).toEqual({ level: 'ERROR', message: `The challan is for GSTIN ${other}, not yours (${GSTIN}). The payment would go to another ledger.` });
    expect(r.reading.checks.map((c: { level: string }) => c.level)).toEqual(['ERROR', 'OK', 'WARNING']);
  });

  it('lists readings, marks one reviewed once and audits it', async () => {
    const list = (await ctx.http().get(R()).set(viewer.auth).expect(200)).body;
    expect(list.map((x: { number: string; kind: string; problems: number }) => `${x.number} ${x.kind} ${x.problems}`)).toEqual([
      'TD-0003 GST_CHALLAN 2',
      'TD-0002 ANNUAL_TAX_STATEMENT 1',
      'TD-0001 TDS_CERTIFICATE 0',
    ]);
    const id = list[1].id;
    await ctx.http().post(`${R()}/${id}/review`).set(viewer.auth).send({ note: 'x' }).expect(403);
    const r = (await ctx.http().post(`${R()}/${id}/review`).set(owner.auth).send({ note: 'Asked Synthetic Buyer to correct its TDS return' }).expect(200)).body;
    expect(r).toMatchObject({ status: 'REVIEWED', reviewNote: 'Asked Synthetic Buyer to correct its TDS return', reviewedBy: 'Tax Docs Owner' });
    await ctx.http().post(`${R()}/${id}/review`).set(owner.auth).send({}).expect(409);
    const events = await ctx.db.collection('audit_events').find({ orgId: org.orgId, entityType: 'tax_document_reading' }).sort({ idNumber: 1 }).toArray();
    expect(events.map((e) => e.action).sort()).toEqual(['tax_document.read', 'tax_document.read', 'tax_document.read', 'tax_document.reviewed']);
    await ctx.http().get(`${R()}/00000000-0000-4000-8000-000000000000`).set(owner.auth).expect(404);
  });

  it('refuses photos and empty text, reads a 1099 for a US company and keeps tenants apart', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    expect((await ctx.http().post(`${R()}/file`).set(owner.auth).set('content-type', 'image/png').send(png).expect(422)).body.error).toBe('PHOTO_NOT_READABLE');
    await ctx.http().post(`${R()}/text`).set(owner.auth).send({ text: '   ' }).expect(422);
    const us = await createOrg(ctx, owner, { name: 'Synthetic Docs Inc', countryCode: 'US', functionalCurrency: 'USD', fiscalYearStartMonth: 1 });
    const text = [
      'Form 1099-NEC',
      'For calendar year 2026',
      "PAYER'S name: Synthetic Payer Inc",
      "RECIPIENT'S TIN ***-**-6789",
      '1 Nonemployee compensation $ 12,000.00',
      '4 Federal income tax withheld $ 2,880.00',
    ].join('\n');
    const r = (await ctx.http().post(`${us.base}/tax/document-readings/text`).set(owner.auth).send({ text }).expect(201)).body;
    expect(r).toMatchObject({ number: 'TD-0001', kind: 'FORM_1099' });
    expect(r.reading.totals.total).toBe('12000.00');
    expect(r.reading.checks).toEqual([{ level: 'WARNING', message: expect.stringContaining('backup withholding') }]);
    expect((await ctx.http().get(`${us.base}/tax/document-readings`).set(owner.auth).expect(200)).body).toHaveLength(1);
    await ctx.http().get(`${us.base}/tax/document-readings/${r.id}`).set(owner.auth).expect(200);
    await ctx.http().get(`${org.base}/tax/document-readings/${r.id}`).set(owner.auth).expect(404);
  });
});
