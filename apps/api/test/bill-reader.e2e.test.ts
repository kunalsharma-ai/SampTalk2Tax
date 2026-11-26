import PDFDocument from 'pdfkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * The bill reader (AP-025) against the real API and database: a supplier's PDF bill (made with
 * pdfkit, as billing software makes them) is read into its supplier, number, dates, items,
 * taxes and total; the person saves the bill and the reading is linked with the PDF attached and
 * what they changed audited; pasted text; a second copy flagged as a duplicate; photos, scans
 * and other files refused in words; permissions and tenant isolation.
 */
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let vendorId: string;
const R = () => `${org.base}/purchases/bill-reader`;

function billPdf(rows: [string, string, string, string, string][], opts: { total?: string; text?: boolean } = {}): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const parts: Buffer[] = [];
    doc.on('data', (b: Buffer) => parts.push(b));
    doc.on('end', () => resolve(Buffer.concat(parts)));
    if (opts.text !== false) {
      doc.fontSize(16).text('Granite Parts Pvt Ltd', 40, 40);
      doc.fontSize(9).text('GSTIN: 27AAACG1234F1Z4', 40, 62);
      doc.fontSize(14).text('TAX INVOICE', 400, 40);
      doc.fontSize(10).text('Invoice No: GP/2026/118', 400, 70).text('Invoice Date: 05/10/2026', 400, 84).text('Due Date: 04/11/2026', 400, 98);
      let y = 150;
      doc.text('Description', 40, y).text('HSN', 250, y).text('Qty', 320, y).text('Rate', 380, y).text('Amount', 470, y);
      y += 18;
      for (const [d, h, q, r, a] of rows) {
        doc.text(d, 40, y).text(h, 250, y).text(q, 320, y).text(r, 380, y).text(a, 470, y);
        y += 16;
      }
      y += 10;
      doc.text('Sub Total', 380, y).text('7,000.00', 470, y);
      doc.text('CGST @ 9%', 380, (y += 16)).text('630.00', 470, y);
      doc.text('SGST @ 9%', 380, (y += 16)).text('630.00', 470, y);
      doc.text('Grand Total', 380, (y += 16)).text(`Rs. ${opts.total ?? '8,260.00'}`, 470, y);
    } else doc.rect(40, 40, 300, 400).fill('#888');
    doc.end();
  });
}
const ROWS: [string, string, string, string, string][] = [
  ['Steel brackets', '7326', '10', '450.00', '4,500.00'],
  ['Fitting service', '9987', '2', '1,250.00', '2,500.00'],
];
const sendFile = (user: TestUser, body: Buffer, fileName = 'granite-118.pdf', type = 'application/pdf') => ctx.http().post(`${R()}/file?fileName=${encodeURIComponent(fileName)}`).set(user.auth).set('Content-Type', type).send(body);
/** Uploads a PDF, which is read in the background (PERF-013), and waits until it is read or failed. */
async function readPdf(body: Buffer, fileName?: string) {
  const queued = (await sendFile(owner, body, fileName).expect(202)).body;
  expect(queued).toMatchObject({ status: 'QUEUED', reading: null, failure: null });
  for (let i = 0; i < 200; i++) {
    const r = (await ctx.http().get(`${R()}/${queued.id}`).set(owner.auth).expect(200)).body;
    if (r.status !== 'QUEUED' && r.status !== 'READING') return r;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error('The bill was not read in time');
}

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Reader Owner');
  viewer = await registerUser(ctx, 'Reader Viewer');
  outsider = await registerUser(ctx, 'Reader Outsider');
  org = await createOrg(ctx, owner, { name: 'Bill Reader Traders' });
  other = await createOrg(ctx, outsider, { name: 'Other Reader Co' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  vendorId = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Granite Parts Private Limited', isVendor: true }).expect(201)).body.id;
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('the bill reader (AP-025)', () => {
  let readingId: string;

  it('reads a PDF bill into its fields, with suggestions, checks and an audit event', async () => {
    const r = await readPdf(await billPdf(ROWS));
    readingId = r.id;
    expect(r).toMatchObject({ number: 'BR-0001', source: 'PDF', fileName: 'granite-118.pdf', pages: 1, status: 'READ', bill: null });
    expect(r.text).toContain('Steel brackets   7326   10   450.00   4,500.00');
    const b = r.reading;
    expect(b.supplier).toEqual({ name: 'Granite Parts Private Limited', taxId: '27AAACG1234F1Z4', contactId: vendorId, matchedBy: 'NAME', source: 'FOUND' });
    expect(b.invoiceNumber).toEqual({ value: 'GP/2026/118', source: 'FOUND' });
    expect(b.issueDate.value).toBe('2026-10-05');
    expect(b.dueDate.value).toBe('2026-11-04');
    expect(b.currency.value).toBe('INR');
    expect(b.lines.map((l: { description: string; quantity: string; unitPrice: string; amount: string; hsnCode: string }) => [l.description, l.hsnCode, l.quantity, l.unitPrice, l.amount])).toEqual([
      ['Steel brackets', '7326', '10', '450.00', '4500.00'],
      ['Fitting service', '9987', '2', '1250.00', '2500.00'],
    ]);
    expect(b).toMatchObject({ subtotal: '7000.00', taxTotal: '1260.00', total: '8260.00', taxPercent: { value: '18', source: 'FOUND' }, duplicateOf: null });
    expect(b.checks).toEqual(['Granite Parts Private Limited has no GSTIN recorded; the bill shows 27AAACG1234F1Z4', "No active tax rate of 18% is set up, so the bill's lines would carry no tax; add one in Settings → Tax rates, or choose the tax on each line"]);
    expect(b.suggestions.map((x: { taxRateId: string | null }) => x.taxRateId)).toEqual([null, null]);
    expect(b.suggestions).toHaveLength(2);
    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, entityType: 'bill_reading' }, select: { action: true, data: true } });
    expect(audit.map((a) => a.action)).toEqual(['bill_reading.queued', 'bill_reading.read']);
    expect(audit[1]).toMatchObject({ action: 'bill_reading.read', data: { number: 'BR-0001', source: 'PDF', invoiceNumber: 'GP/2026/118', total: '8260.00', lines: 2 } });
    // the PDF is kept encrypted, not as plain bytes
    const raw = await ctx.db.collection('bill_readings').findOne({ _id: readingId as never });
    expect(raw!.contentKeyId).toBeTruthy();
    expect(Buffer.from(raw!.content.buffer).subarray(0, 5).toString('latin1')).not.toBe('%PDF-');
  });

  it('links the saved bill, attaches the PDF and records what the person changed', async () => {
    const r = (await ctx.http().get(`${R()}/${readingId}`).set(viewer.auth).expect(200)).body;
    const lines = r.reading.lines.map((l: { description: string; quantity: string; unitPrice: string; hsnCode: string }) => ({ accountId: org.acc['5000'], description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, hsnCode: l.hsnCode }));
    // the person corrects the bill number's spacing as they save it
    const bill = (await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: vendorId, issueDate: '2026-10-05', dueDate: '2026-11-04', reference: 'GP/2026/118-A', lines }).expect(201)).body;
    const invoice = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'A Customer', isCustomer: true }).expect(201)).body.id;
    const inv = (await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: invoice, issueDate: '2026-10-05', dueDate: '2026-10-05', lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: '10.00' }] }).expect(201)).body;
    expect((await ctx.http().post(`${R()}/${readingId}/link`).set(owner.auth).send({ documentId: inv.id }).expect(422)).body.error).toBe('NOT_A_BILL');
    await ctx.http().post(`${R()}/${readingId}/link`).set(viewer.auth).send({ documentId: bill.id }).expect(403);
    const linked = (await ctx.http().post(`${R()}/${readingId}/link`).set(owner.auth).send({ documentId: bill.id }).expect(200)).body;
    expect(linked).toMatchObject({ status: 'SAVED', bill: { id: bill.id, status: 'DRAFT' }, decidedBy: 'Reader Owner' });
    const files = (await ctx.http().get(`${org.base}/attachments?entityType=DOCUMENT&entityId=${bill.id}`).set(viewer.auth).expect(200)).body;
    expect(files.map((f: { fileName: string; contentType: string }) => [f.fileName, f.contentType])).toEqual([['granite-118.pdf', 'application/pdf']]);
    expect(files[0].id).toBe(linked.attachmentId);
    const audit = await ctx.prisma.auditEvent.findFirst({ where: { orgId: org.orgId, action: 'bill_reading.saved' }, select: { data: true } });
    expect((audit!.data as { changed: string[] }).changed).toEqual(['bill number', 'total']);
    expect((await ctx.http().post(`${R()}/${readingId}/link`).set(owner.auth).send({ documentId: bill.id }).expect(409)).body.error).toBe('READING_DECIDED');
    expect((await ctx.http().post(`${R()}/${readingId}/discard`).set(owner.auth).send({}).expect(409)).body.error).toBe('READING_DECIDED');
  });

  it('flags a second copy of a bill already in the books, and reads pasted text', async () => {
    await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: vendorId, issueDate: '2026-10-05', reference: 'GP/2026/118', lines: [{ accountId: org.acc['5000'], quantity: '1', unitPrice: '7000.00' }] }).expect(201);
    const rate = (await ctx.http().post(`${org.base}/tax-rates`).set(owner.auth).send({ name: 'Purchase tax 18%', rate: '18', salesAccountId: org.acc['2300'], purchaseAccountId: org.acc['1450'] }).expect(201)).body.id;
    const again = await readPdf(await billPdf(ROWS));
    expect(again.number).toBe('BR-0002');
    expect(again.reading.duplicateOf).toMatchObject({ number: null });
    // the organisation's 18% rate is suggested for every line
    expect(again.reading.suggestions.map((x: { taxRateId: string | null }) => x.taxRateId)).toEqual([rate, rate]);
    expect(again.reading.checks.some((c: string) => c.startsWith('No active tax rate'))).toBe(false);
    expect(again.reading.checks[0]).toBe('Bill GP/2026/118 from Granite Parts Private Limited is already in the books (a draft); check before saving it again');
    const t = (await ctx.http().post(`${R()}/text`).set(owner.auth).send({ text: 'Acme Software Inc\nInvoice #INV-77\nInvoice date: Oct 12, 2026\nAmount due   $ 500.00' }).expect(201)).body;
    expect(t).toMatchObject({ number: 'BR-0003', source: 'TEXT', pages: 0 });
    expect(t.reading).toMatchObject({ linesFrom: 'TOTAL_ONLY', total: '500.00', currency: { value: 'USD' }, supplier: { name: 'Acme Software Inc', contactId: null } });
    const gone = (await ctx.http().post(`${R()}/${t.id}/discard`).set(owner.auth).send({ reason: 'Not our bill' }).expect(200)).body;
    expect(gone.status).toBe('DISCARDED');
    const list = (await ctx.http().get(R()).set(viewer.auth).expect(200)).body;
    expect(list.map((x: { number: string; status: string }) => [x.number, x.status])).toEqual([
      ['BR-0003', 'DISCARDED'],
      ['BR-0002', 'READ'],
      ['BR-0001', 'SAVED'],
    ]);
    expect(list[2]).toMatchObject({ supplier: 'Granite Parts Private Limited', invoiceNumber: 'GP/2026/118', total: '8260.00', bill: { number: null } });
  });

  it('says in words when a file cannot be read', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic')]);
    expect((await sendFile(owner, png, 'photo.png', 'image/png').expect(422)).body.error).toBe('PHOTO_NOT_READABLE');
    expect((await sendFile(owner, Buffer.from('just some bytes'), 'x.bin', 'application/octet-stream').expect(415)).body.error).toBe('UNSUPPORTED_FILE');
    expect((await ctx.http().post(`${R()}/text`).set(owner.auth).send({ text: '   ' }).expect(422)).body.error).toBe('EMPTY_TEXT');
    // nothing is recorded for a refused file
    expect(await ctx.db.collection('bill_readings').countDocuments({ orgId: org.orgId })).toBe(3);
    // A PDF is read after the upload answers, so a scan with no text is a reading that failed, with the reason.
    const scan = await readPdf(await billPdf([], { text: false }), 'scan.pdf');
    expect(scan).toMatchObject({ number: 'BR-0004', status: 'FAILED', reading: null, failure: 'This PDF has no text to read; it is probably a scan or a photo. Paste the text of the bill, or enter the bill by hand' });
    expect((await ctx.http().post(`${R()}/${scan.id}/discard`).set(owner.auth).send({}).expect(409)).body.error).toBe('READING_FAILED');
    const listed = (await ctx.http().get(R()).set(viewer.auth).expect(200)).body[0];
    expect(listed).toMatchObject({ number: 'BR-0004', status: 'FAILED', supplier: null, total: null, checks: 0, failure: scan.failure });
  });

  it('needs purchases.manage to read bills and keeps organisations apart', async () => {
    await sendFile(viewer, await billPdf(ROWS)).expect(403);
    expect(await ctx.db.collection('bill_readings').countDocuments({ orgId: org.orgId })).toBe(4);
    await ctx.http().post(`${R()}/text`).set(viewer.auth).send({ text: 'x' }).expect(403);
    await ctx.http().get(`${R()}/${readingId}`).set(outsider.auth).expect(404);
    await ctx.http().get(`${other.base}/purchases/bill-reader/${readingId}`).set(outsider.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/purchases/bill-reader`).set(outsider.auth).expect(200)).body).toEqual([]);
  });
});
