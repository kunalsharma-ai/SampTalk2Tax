import { gstinCheckCharacter } from '@talk2tax/tax-engine';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import PDFDocument from 'pdfkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Receipt reading (EXP-004) against the real API and database: an employee sends a photo of a café
 * bill and the OCR engine inside the API reads it (no receipt leaves the server), and a PDF receipt
 * is read from its own text. What was read comes back with how sure each value is, for the member
 * to check before saving; the file is scanned and the reading audited, and nothing else is stored.
 */
let ctx: Ctx;
let owner: TestUser;
let employee: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const GSTIN = `29ABCDE1234F1Z${gstinCheckCharacter('29ABCDE1234F1Z')}`;
const PHOTO = readFileSync(join(__dirname, 'fixtures', 'receipt-cafe.jpg'));
const R = () => `${org.base}/receipt-reading`;
/** Warnings that depend on today's date (a receipt over a year old) are left out. */
const lasting = (w: string[]) => w.filter((x) => x !== 'The receipt is more than a year old');

function receiptPdf(): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A6', margin: 20 });
    const parts: Buffer[] = [];
    doc.on('data', (b: Buffer) => parts.push(b));
    doc.on('end', () => resolve(Buffer.concat(parts)));
    doc.fontSize(9);
    let y = 20;
    for (const line of [
      'Hotel Saffron Inn',
      'Tax Invoice',
      'Invoice Date: 03-Nov-2026',
      'Room, 2 nights 4,000.00',
      'Taxable Value 4,000.00',
      'CGST 6% 240.00',
      'SGST 6% 240.00',
      'Grand Total 4,480.00',
    ]) {
      doc.text(line, 20, y);
      y += 14;
    }
    doc.end();
  });
}

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Receipt Reading Owner');
  employee = await registerUser(ctx, 'Receipt Reading Employee');
  viewer = await registerUser(ctx, 'Receipt Reading Viewer');
  org = await createOrg(ctx, owner);
  for (const [u, role] of [
    [employee, 'EMPLOYEE'],
    [viewer, 'VIEWER'],
  ] as const)
    await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
}, 60_000);
afterAll(async () => {
  await ctx?.app.close();
});

describe('reading receipts (EXP-004)', () => {
  it('reads a photo of a café bill with OCR inside Talk2Tax', async () => {
    const r = (await ctx.http().post(`${R()}?fileName=chai.jpg`).set(employee.auth).set('content-type', 'image/jpeg').send(PHOTO).expect(201)).body;
    expect(r).toMatchObject({ source: 'PHOTO', fileName: 'chai.jpg' });
    expect(r.ocrConfidence).toBeGreaterThan(70);
    expect(r.text).toContain('CHAI POINT CAFE');
    expect(r.reading).toMatchObject({
      merchant: { value: 'CHAI POINT CAFE' },
      date: { value: '2026-11-14', confidence: 'HIGH' },
      subtotal: { value: '400.00' },
      total: { value: '420.00', confidence: 'HIGH' },
      taxTotal: '20.00',
      gstin: { value: GSTIN, confidence: 'HIGH' },
      currency: 'INR',
      addsUp: true,
    });
    expect(r.reading.taxes.map((t: { label: string; rate: string; amount: string }) => [t.label, t.rate, t.amount])).toEqual([
      ['CGST', '2.5', '10.00'],
      ['SGST', '2.5', '10.00'],
    ]);
    expect(lasting(r.reading.warnings)).toEqual([]);

    // The file was scanned, and the reading audited; no receipt or claim was created.
    const scan = await ctx.prisma.fileScan.findFirst({ where: { orgId: org.orgId, fileName: 'chai.jpg' } });
    expect(scan).toMatchObject({ contentType: 'image/jpeg', sizeBytes: PHOTO.length });
    const audit = await ctx.prisma.auditEvent.findFirst({ where: { orgId: org.orgId, action: 'receipt.read' }, orderBy: { createdAt: 'desc' } });
    expect(audit).toMatchObject({ entityId: r.id, actorId: employee.id });
    expect(audit?.data).toMatchObject({ source: 'PHOTO', merchant: 'CHAI POINT CAFE', date: '2026-11-14', total: '420.00' });
    expect((await ctx.http().get(`${org.base}/expense-receipts`).set(employee.auth).expect(200)).body.items).toEqual([]);
  }, 90_000);

  it('reads a PDF receipt from its own text', async () => {
    const r = (
      await ctx
        .http()
        .post(`${R()}?fileName=hotel.pdf`)
        .set(owner.auth)
        .set('content-type', 'application/pdf')
        .send(await receiptPdf())
        .expect(201)
    ).body;
    expect(r).toMatchObject({ source: 'PDF', ocrConfidence: null });
    expect(r.reading).toMatchObject({
      merchant: { value: 'Hotel Saffron Inn' },
      date: { value: '2026-11-03' },
      subtotal: { value: '4000.00' },
      total: { value: '4480.00', confidence: 'HIGH' },
      taxTotal: '480.00',
      addsUp: true,
      gstin: null,
    });
  });

  it('refuses what it cannot read, and members who cannot submit expenses', async () => {
    await ctx.http().post(R()).set(viewer.auth).set('content-type', 'image/jpeg').send(PHOTO).expect(403);
    expect((await ctx.http().post(R()).set(owner.auth).set('content-type', 'application/octet-stream').send(Buffer.alloc(0)).expect(422)).body.error).toBe('EMPTY_FILE');
    expect((await ctx.http().post(R()).set(owner.auth).set('content-type', 'application/json').send({ a: 1 }).expect(422)).body.error).toBe('EMPTY_FILE');
    expect((await ctx.http().post(R()).set(owner.auth).set('content-type', 'application/octet-stream').send(Buffer.from('just some text')).expect(415)).body.error).toBe('UNSUPPORTED_FILE');
    const big = Buffer.concat([Buffer.from('\xff\xd8\xff\xe0', 'latin1'), Buffer.alloc(5 * 1024 * 1024)]);
    expect((await ctx.http().post(R()).set(owner.auth).set('content-type', 'image/jpeg').send(big).expect(413)).body.error).toBe('FILE_TOO_LARGE');
    // A JPEG header with nothing behind it.
    const broken = Buffer.from('\xff\xd8\xff\xe0 not really a photo', 'latin1');
    expect(['PHOTO_NOT_READABLE', 'NO_TEXT']).toContain((await ctx.http().post(R()).set(owner.auth).set('content-type', 'image/jpeg').send(broken).expect(422)).body.error);
    // The engine still reads the next photo after a failure.
    const again = (await ctx.http().post(R()).set(employee.auth).set('content-type', 'image/jpeg').send(PHOTO).expect(201)).body;
    expect(again.reading.total.value).toBe('420.00');
  }, 90_000);
});
