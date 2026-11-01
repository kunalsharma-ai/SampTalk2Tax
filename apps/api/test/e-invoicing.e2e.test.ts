import { createHash } from 'node:crypto';
import { gstinCheckCharacter } from '@talk2tax/tax-engine';
import { CompactSign, exportSPKI, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

// Synthetic, format-valid GSTINs (made-up PANs). The organisation is in Maharashtra (27), the customer in Karnataka (29).
const gstin = (state: string, pan: string) => `${state}${pan}1Z${gstinCheckCharacter(`${state}${pan}1Z`)}`;
const OWN = gstin('27', 'ZZZCE0101Z');
const BUYER = gstin('29', 'ZZZCE0102Z');
const t = today();
const FY = Number(t.slice(5, 7)) >= 4 ? Number(t.slice(0, 4)) : Number(t.slice(0, 4)) - 1;
const FY_START = `${FY}-04-01`;
const daysBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;

let ctx: Ctx;
let owner: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let customer: { id: string };
let g18: { id: string };

/** The IRP's timestamp format: "YYYY-MM-DD HH:mm:ss" in IST. */
const ist = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
/** An unsigned token with the IRP's shape (header.payload.signature, payload {"data": "<json>"}). */
const unsigned = (data: unknown) => `e30.${Buffer.from(JSON.stringify({ data: JSON.stringify(data) })).toString('base64url')}.c2ln`;
const irnFor = (s: string) => createHash('sha256').update(s).digest('hex');

interface Doc {
  id: string;
  number: string;
  issueDate: string;
  total: string;
}
function qrData(doc: Doc, irn: string, over: Record<string, unknown> = {}) {
  return { SellerGstin: OWN, BuyerGstin: BUYER, DocNo: doc.number, DocTyp: 'INV', DocDt: ddmmyyyy(doc.issueDate), TotInvVal: Number(doc.total), ItemCnt: 1, MainHsnCode: '73269099', Irn: irn, IrnDt: ist(new Date()), ...over };
}
function response(doc: Doc, opts: { irn?: string; ack?: Date; qr?: Record<string, unknown>; signedQr?: string } = {}) {
  const irn = opts.irn ?? irnFor(`${doc.id}-${Math.random()}`);
  return {
    Irn: irn,
    AckNo: '112610000012345',
    AckDt: ist(opts.ack ?? new Date()),
    SignedInvoice: unsigned({ DocDtls: { Typ: 'INV', No: doc.number, Dt: ddmmyyyy(doc.issueDate) } }),
    SignedQRCode: opts.signedQr ?? unsigned(qrData(doc, irn, opts.qr)),
    Status: 'ACT',
  };
}

async function invoice(issueDate = t, extra: Record<string, unknown> = {}): Promise<Doc> {
  const body = {
    kind: 'INVOICE',
    contactId: customer.id,
    issueDate,
    lines: [{ accountId: org.acc['4100'], description: 'Steel brackets', quantity: '4', unitPrice: '2500.00', taxRateId: g18.id, hsnCode: '73269099' }],
    post: true,
    ...extra,
  };
  return (await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send(body).expect(201)).body;
}
const state = async (id: string) => (await ctx.http().get(`${org.base}/e-invoicing/documents/${id}`).set(owner.auth).expect(200)).body;
const importIrn = (id: string, res: unknown, auth = owner.auth) => ctx.http().post(`${org.base}/e-invoicing/documents/${id}/irn`).set(auth).send({ response: res });
const settings = (over: Record<string, unknown> = {}) =>
  ctx
    .http()
    .put(`${org.base}/e-invoicing/settings`)
    .set(owner.auth)
    .send({ applicableFrom: FY_START, aatoTenCroreOrMore: false, tradeName: 'Northwind', address1: '12 MG Road', address2: 'Camp', city: 'Pune', pincode: '411001', goodsUnit: 'NOS', irpPublicKey: null, ...over });

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'E-invoice Owner');
  org = await createOrg(ctx, owner);
});
afterAll(async () => {
  await ctx.app.close();
});

describe('set-up', () => {
  it('needs the GST registration first, then stores the seller details', async () => {
    expect((await ctx.http().get(`${org.base}/e-invoicing/settings`).set(owner.auth).expect(200)).body).toEqual({ configured: false, gstRegistered: false });
    expect((await settings().expect(409)).body.error).toBe('GST_NOT_REGISTERED');
    await ctx.http().put(`${org.base}/gst/registration`).set(owner.auth).send({ gstin: OWN, legalName: 'Northwind Traders Private Limited', effectiveFrom: FY_START }).expect(200);
    const accounts = (await ctx.http().get(`${org.base}/accounts`).set(owner.auth).expect(200)).body as { code: string; id: string }[];
    for (const a of accounts) org.acc[a.code] = a.id;
    g18 = (await ctx.http().post(`${org.base}/tax-rates`).set(owner.auth).send({ name: 'GST 18%', rate: '18', kind: 'GST' }).expect(201)).body;

    await settings({ pincode: '011001' }).expect(400);
    await settings({ goodsUnit: 'PIECES' }).expect(400);
    expect((await settings({ irpPublicKey: 'not a key' }).expect(422)).body.error).toBe('INVALID_KEY');
    const s = (await settings().expect(200)).body;
    expect(s).toMatchObject({ configured: true, applicableFrom: FY_START, city: 'Pune', pincode: '411001', goodsUnit: 'NOS', irpPublicKeySet: false });
  });

  it('stores the city and PIN code on contacts', async () => {
    customer = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Karnataka Metals LLP', isCustomer: true, gstin: BUYER, address: '4 Residency Road\nAshok Nagar', city: 'Bengaluru' }).expect(201)).body;
    expect(customer).toMatchObject({ city: 'Bengaluru', pincode: null });
    await ctx.http().patch(`${org.base}/contacts/${customer.id}`).set(owner.auth).send({ pincode: '56002' }).expect(400);
  });
});

describe('the INV-01 JSON', () => {
  let doc: Doc;

  it('asks for the missing data before it can be generated', async () => {
    doc = await invoice();
    const s = await state(doc.id);
    expect(s).toMatchObject({ configured: true, state: 'NEEDS_DATA' });
    expect(s.reason).toMatch(/PIN/);
    const r = await ctx.http().get(`${org.base}/e-invoicing/documents/${doc.id}/json`).set(owner.auth).expect(422);
    expect(r.body.error).toBe('EINVOICE_DATA_MISSING');
  });

  it('builds the schema 1.1 JSON once the customer has a PIN code', async () => {
    await ctx.http().patch(`${org.base}/contacts/${customer.id}`).set(owner.auth).send({ pincode: '560025' }).expect(200);
    expect((await state(doc.id)).state).toBe('READY');
    const p = (await ctx.http().get(`${org.base}/e-invoicing/documents/${doc.id}/json`).set(owner.auth).expect(200)).body;
    expect(p).toMatchObject({
      Version: '1.1',
      TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N' },
      DocDtls: { Typ: 'INV', No: doc.number, Dt: ddmmyyyy(doc.issueDate) },
      SellerDtls: { Gstin: OWN, LglNm: 'Northwind Traders Private Limited', TrdNm: 'Northwind', Addr1: '12 MG Road', Addr2: 'Camp', Loc: 'Pune', Pin: 411001, Stcd: '27' },
      BuyerDtls: { Gstin: BUYER, LglNm: 'Karnataka Metals LLP', Addr1: '4 Residency Road', Addr2: 'Ashok Nagar', Loc: 'Bengaluru', Pin: 560025, Stcd: '29', Pos: '29' },
      ValDtls: { AssVal: 10000, IgstVal: 1800, CgstVal: 0, SgstVal: 0, TotInvVal: 11800 },
    });
    expect(p.ItemList).toEqual([expect.objectContaining({ SlNo: '1', IsServc: 'N', HsnCd: '73269099', Qty: 4, Unit: 'NOS', UnitPrice: 2500, TotAmt: 10000, GstRt: 18, IgstAmt: 1800, TotItemVal: 11800 })]);
  });

  it('lists the documents with their state, and downloads several at once', async () => {
    const b2c = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Walk-in', isCustomer: true, stateCode: '27' }).expect(201)).body;
    const retail = await invoice(t, { contactId: b2c.id });
    const reg = (await ctx.http().get(`${org.base}/e-invoicing/documents`).query({ from: FY_START, to: t }).set(owner.auth).expect(200)).body;
    expect(reg.rows.map((r: { number: string; state: string }) => [r.number, r.state])).toEqual([
      [doc.number, 'READY'],
      [retail.number, 'NOT_REQUIRED'],
    ]);
    expect(reg.summary).toMatchObject({ ready: 1, notRequired: 1, generated: 0 });
    const bulk = (await ctx.http().post(`${org.base}/e-invoicing/bulk-json`).set(owner.auth).send({ documentIds: [doc.id, retail.id] }).expect(200)).body;
    expect(bulk.payloads.map((x: { DocDtls: { No: string } }) => x.DocDtls.No)).toEqual([doc.number]);
    expect(bulk.skipped).toEqual([expect.objectContaining({ number: retail.number, state: 'NOT_REQUIRED' })]);
    await ctx.http().get(`${org.base}/e-invoicing/documents`).query({ from: t, to: FY_START }).set(owner.auth).expect(422);
  });

  it.skipIf(daysBetween(FY_START, t) < 31)('refuses documents older than 30 days when the 30-day limit applies', async () => {
    const old = await invoice(FY_START);
    expect((await state(old.id)).state).toBe('READY');
    await settings({ aatoTenCroreOrMore: true }).expect(200);
    const s = await state(old.id);
    expect(s).toMatchObject({ state: 'TOO_LATE', deadline: `${FY}-04-30` });
    expect((await ctx.http().get(`${org.base}/e-invoicing/documents/${old.id}/json`).set(owner.auth).expect(422)).body.error).toBe('REPORTING_WINDOW_CLOSED');
    expect((await state(doc.id)).state).toBe('READY');
    await settings().expect(200);
  });
});

describe('recording the IRP response', () => {
  let doc: Doc;
  let irn: string;

  it('refuses a response for another document', async () => {
    doc = await invoice();
    expect((await importIrn(doc.id, { hello: 'world' }).expect(422)).body.error).toBe('INVALID_IRP_RESPONSE');
    const wrong = await importIrn(doc.id, response(doc, { qr: { DocNo: 'INV-999999', TotInvVal: 100 } })).expect(422);
    expect(wrong.body.error).toBe('IRP_RESPONSE_MISMATCH');
    expect(wrong.body.details.issues.join(' ')).toMatch(/INV-999999.*does not match/);
    expect((await importIrn(doc.id, response(doc, { qr: { BuyerGstin: OWN } })).expect(422)).body.error).toBe('IRP_RESPONSE_MISMATCH');
  });

  it('records the IRN, acknowledgement and signed QR code', async () => {
    const res = response(doc);
    irn = res.Irn;
    const e = (await importIrn(doc.id, { data: res }).expect(201)).body;
    expect(e).toMatchObject({ irn, ackNo: '112610000012345', status: 'ACTIVE', signatureVerified: false, qr: { docNo: doc.number, buyerGstin: BUYER, total: '11800' } });
    const s = await state(doc.id);
    expect(s).toMatchObject({ state: 'GENERATED', eInvoice: { irn } });
    expect((await importIrn(doc.id, response(doc)).expect(409)).body.error).toBe('IRN_EXISTS');
    const audit = await ctx.prisma.auditEvent.findFirst({ where: { orgId: org.orgId, action: 'einvoice.irn_recorded' } });
    expect(audit).not.toBeNull();
  });

  it('keeps the same IRN off another document', async () => {
    const other = await invoice();
    // Same IRN, other details right: the database refuses the duplicate.
    const r = await importIrn(other.id, response(other, { irn })).expect(409);
    expect(r.body.error).toBeDefined();
  });

  it('blocks voiding a document with a live IRN', async () => {
    const r = await ctx.http().post(`${org.base}/sales/documents/${doc.id}/void`).set(owner.auth).send({ reason: 'Wrong buyer' }).expect(409);
    expect(r.body.error).toBe('HAS_IRN');
    await expect(ctx.prisma.$executeRawUnsafe(`UPDATE documents SET status = 'VOID' WHERE id = '${doc.id}'`)).rejects.toThrow(/has an IRN/);
  });

  it('keeps e-invoice records immutable in the database', async () => {
    await expect(ctx.prisma.$executeRawUnsafe(`UPDATE e_invoices SET ack_no = '1' WHERE org_id = '${org.orgId}'`)).rejects.toThrow(/immutable/);
    await expect(ctx.prisma.$executeRawUnsafe(`DELETE FROM e_invoices WHERE org_id = '${org.orgId}'`)).rejects.toThrow(/cannot be deleted/);
  });

  it('records a cancellation within 24 hours, after which the document can be voided', async () => {
    const cancel = (id: string, body: Record<string, unknown>) => ctx.http().post(`${org.base}/e-invoicing/documents/${id}/irn/cancel`).set(owner.auth).send(body);
    await cancel(doc.id, { reason: '5', remark: 'Wrong buyer' }).expect(400);
    const c = (await cancel(doc.id, { reason: '2', remark: 'Wrong buyer' }).expect(200)).body;
    expect(c).toMatchObject({ status: 'CANCELLED', cancelReason: 'Data entry mistake', cancelRemark: 'Wrong buyer' });
    expect((await cancel(doc.id, { reason: '2', remark: 'Again' }).expect(409)).body.error).toBe('NO_IRN');
    expect((await state(doc.id)).state).toBe('READY');
    await ctx.http().post(`${org.base}/sales/documents/${doc.id}/void`).set(owner.auth).send({ reason: 'Wrong buyer' }).expect(200);
    const s = await state(doc.id);
    expect(s).toMatchObject({ state: 'CANCELLED' });
    expect(s.history).toHaveLength(1);
  });

  it('refuses a cancellation after 24 hours', async () => {
    const late = await invoice();
    await importIrn(late.id, response(late, { ack: new Date(Date.now() - 25 * 3_600_000) })).expect(201);
    const r = await ctx.http().post(`${org.base}/e-invoicing/documents/${late.id}/irn/cancel`).set(owner.auth).send({ reason: '3', remark: 'Order cancelled' }).expect(409);
    expect(r.body.error).toBe('CANCEL_WINDOW_CLOSED');
    // Backdating the cancellation does not get round the database check either.
    await expect(ctx.prisma.$executeRawUnsafe(`UPDATE e_invoices SET status = 'CANCELLED', cancelled_at = now(), cancel_reason = '3', cancel_remark = 'x', cancelled_by_id = created_by_id WHERE document_id = '${late.id}'`)).rejects.toThrow();
  });
});

describe('signature verification with the IRP public key', () => {
  it('verifies the signed QR code, and refuses one signed with another key', async () => {
    const irp = await generateKeyPair('RS256', { extractable: true });
    const other = await generateKeyPair('RS256', { extractable: true });
    await settings({ irpPublicKey: await exportSPKI(irp.publicKey) }).expect(200);
    expect((await ctx.http().get(`${org.base}/e-invoicing/settings`).set(owner.auth).expect(200)).body.irpPublicKeySet).toBe(true);
    const sign = async (doc: Doc, irn: string, key: Parameters<CompactSign['sign']>[0]) =>
      new CompactSign(new TextEncoder().encode(JSON.stringify({ data: JSON.stringify(qrData(doc, irn)), iss: 'NIC' }))).setProtectedHeader({ alg: 'RS256', typ: 'JWT' }).sign(key);

    const a = await invoice();
    const irnA = irnFor(`signed-a-${a.id}`);
    expect((await importIrn(a.id, response(a, { irn: irnA, signedQr: await sign(a, irnA, other.privateKey) })).expect(422)).body.error).toBe('SIGNATURE_INVALID');
    expect((await importIrn(a.id, response(a)).expect(422)).body.error).toBe('SIGNATURE_INVALID');
    const ok = (await importIrn(a.id, response(a, { irn: irnA, signedQr: await sign(a, irnA, irp.privateKey) })).expect(201)).body;
    expect(ok).toMatchObject({ signatureVerified: true, qr: { docNo: a.number } });
    await settings().expect(200);
  });
});

describe('access', () => {
  it('lets viewers read but not record, and keeps organisations apart', async () => {
    const viewer = await registerUser(ctx, 'Viewer');
    await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
    const reg = (await ctx.http().get(`${org.base}/e-invoicing/documents`).query({ from: FY_START, to: t }).set(viewer.auth).expect(200)).body;
    const ready = reg.rows.find((r: { state: string }) => r.state === 'READY');
    await importIrn(ready.documentId, response(ready), viewer.auth).expect(403);
    await ctx.http().put(`${org.base}/e-invoicing/settings`).set(viewer.auth).send({}).expect(403);

    const outsider = await registerUser(ctx, 'Outsider');
    const theirs = await createOrg(ctx, outsider);
    await ctx.http().get(`${theirs.base}/e-invoicing/documents/${ready.documentId}`).set(outsider.auth).expect(404);
    await ctx.http().get(`${org.base}/e-invoicing/documents/${ready.documentId}`).set(outsider.auth).expect(404);
  });
});
