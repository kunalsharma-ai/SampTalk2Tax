import PDFDocument from 'pdfkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BillReaderService } from '../src/bill-reader/bill-reader.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * PDF bills read in the background (PERF-013): the upload answers at once with the reading
 * QUEUED, a worker reads it; a worker that stopped mid-way loses its lease and the reading is
 * taken again; after three tries it fails with a reason; two servers never read the same bill
 * twice; nothing can be saved from a reading that is not read yet.
 */
let a: Ctx;
let b: Ctx;
let owner: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const R = () => `${org.base}/purchases/bill-reader`;

function billPdf(invoiceNo: string): Promise<Buffer> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const parts: Buffer[] = [];
    doc.on('data', (x: Buffer) => parts.push(x));
    doc.on('end', () => resolve(Buffer.concat(parts)));
    doc.fontSize(16).text('Basalt Supplies Pvt Ltd', 40, 40);
    doc.fontSize(10).text(`Invoice No: ${invoiceNo}`, 400, 70).text('Invoice Date: 05/10/2026', 400, 84);
    doc.text('Description', 40, 150).text('Qty', 320, 150).text('Rate', 380, 150).text('Amount', 470, 150);
    doc.text('Packing boxes', 40, 168).text('4', 320, 168).text('250.00', 380, 168).text('1,000.00', 470, 168);
    doc.text('Grand Total', 380, 200).text('Rs. 1,000.00', 470, 200);
    doc.end();
  });
}
const upload = async (invoiceNo: string) =>
  (
    await a
      .http()
      .post(`${R()}/file?fileName=${invoiceNo}.pdf`)
      .set(owner.auth)
      .set('Content-Type', 'application/pdf')
      .send(await billPdf(invoiceNo))
      .expect(202)
  ).body as { id: string; status: string };
const get = async (id: string) => (await a.http().get(`${R()}/${id}`).set(owner.auth).expect(200)).body;
async function settled(id: string) {
  for (let i = 0; i < 200; i++) {
    const r = await get(id);
    if (r.status !== 'QUEUED' && r.status !== 'READING') return r;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error('not read in time');
}
/** Puts a reading back as a worker would leave it mid-way: READING, nothing read yet, with this lease. */
const stuck = (id: string, set: Record<string, unknown>) =>
  a.db.collection('bill_readings').updateOne({ _id: id as never }, { $set: { status: 'READING', text: '', pages: 0, result: {}, readAt: null, ...set } });
const reads = async (id: string) => a.db.collection('audit_events').countDocuments({ orgId: org.orgId, action: 'bill_reading.read', entityId: id });

beforeAll(async () => {
  a = await bootApp();
  b = await bootApp();
  owner = await registerUser(a, 'Background Owner');
  org = await createOrg(a, owner, { name: 'Background Reading Traders' });
}, 60_000);
afterAll(async () => {
  await a?.app.close();
  await b?.app.close();
});

describe('reading PDF bills in the background', () => {
  it('answers the upload at once, then reads the bill', async () => {
    const q = await upload('BS-1');
    expect(q.status).toBe('QUEUED');
    const r = await settled(q.id);
    expect(r).toMatchObject({ status: 'READ', pages: 1, failure: null, reading: { invoiceNumber: { value: 'BS-1' }, total: '1000.00' } });
    expect(r.readAt).toBeTruthy();
    expect(await reads(q.id)).toBe(1);
  });

  it('takes a reading again when the worker holding it stopped, but not while its lease runs', async () => {
    const { id } = await upload('BS-2');
    await settled(id);
    const svc = a.app.get(BillReaderService);
    await stuck(id, { attempts: 1, leaseUntil: new Date(Date.now() + 60_000) });
    await svc.readWaiting();
    expect((await get(id)).status).toBe('READING'); // another worker still holds it
    await stuck(id, { attempts: 1, leaseUntil: new Date(Date.now() - 1_000) });
    await svc.readWaiting();
    const r = await get(id);
    expect(r).toMatchObject({ status: 'READ', reading: { invoiceNumber: { value: 'BS-2' } } });
    expect((await a.db.collection('bill_readings').findOne({ _id: id as never }))!.attempts).toBe(2);
  });

  it('fails with a reason after three tries', async () => {
    const { id } = await upload('BS-3');
    await settled(id);
    await stuck(id, { attempts: 3, leaseUntil: new Date(Date.now() - 1_000) });
    await a.app.get(BillReaderService).readWaiting();
    const r = await get(id);
    expect(r).toMatchObject({ status: 'FAILED', reading: null, failure: 'The bill could not be read after 3 tries. Upload it again, paste its text, or enter the bill by hand' });
    expect((await a.http().post(`${R()}/${id}/link`).set(owner.auth).send({ documentId: crypto.randomUUID() }).expect(409)).body.error).toBe('READING_FAILED');
  });

  it('two servers reading at the same moment read each bill once', async () => {
    const ids: string[] = [];
    for (const n of ['BS-4', 'BS-5', 'BS-6']) ids.push((await upload(n)).id);
    for (const id of ids) await settled(id);
    for (const id of ids) await stuck(id, { attempts: 0, leaseUntil: null, status: 'QUEUED' });
    await Promise.all([a.app.get(BillReaderService).readWaiting(), b.app.get(BillReaderService).readWaiting(), a.app.get(BillReaderService).readWaiting()]);
    for (const id of ids) {
      expect((await get(id)).status).toBe('READ');
      expect(await reads(id)).toBe(2); // once when uploaded, once now: never twice for one take
    }
  });

  it('nothing is saved or discarded from a bill still being read', async () => {
    const { id } = await upload('BS-7');
    await settled(id);
    await stuck(id, { attempts: 1, leaseUntil: new Date(Date.now() + 60_000) });
    expect((await a.http().post(`${R()}/${id}/discard`).set(owner.auth).send({}).expect(409)).body).toMatchObject({
      error: 'NOT_READ_YET',
      message: 'The bill is still being read; try again in a moment',
    });
    expect((await get(id)).reading).toBeNull();
    const list = (await a.http().get(R()).set(owner.auth).expect(200)).body as { id: string; status: string; supplier: string | null }[];
    expect(list.find((x) => x.id === id)).toMatchObject({ status: 'READING', supplier: null });
  });
});
