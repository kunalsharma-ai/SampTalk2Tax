import { gstinCheckCharacter } from '@talk2tax/tax-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

// Synthetic, format-valid GSTINs (made-up PANs). The organisation is in Maharashtra (27).
const gstin = (state: string, pan: string) => `${state}${pan}1Z${gstinCheckCharacter(`${state}${pan}1Z`)}`;
const OWN = gstin('27', 'ZZZCW0101Z');
const BUYER = gstin('29', 'ZZZCW0102Z');
const TRANSPORTER = gstin('27', 'ZZZCW0103Z');
// Two hours ago, in India: an e-way bill generated an hour ago is then never dated before its invoice, even just after midnight IST.
const t = new Date(Date.now() + 5.5 * 3_600_000 - 2 * 3_600_000).toISOString().slice(0, 10);
const FY = Number(t.slice(5, 7)) >= 4 ? Number(t.slice(0, 4)) : Number(t.slice(0, 4)) - 1;
const FY_START = `${FY}-04-01`;
const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

let ctx: Ctx;
let owner: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let customer: { id: string };
let local: { id: string };
const rates: Record<string, { id: string }> = {};
let ewbSeq = 100000000000;
const ewbNo = () => String(ewbSeq++);

interface Doc {
  id: string;
  number: string;
  issueDate: string;
  total: string;
}
const ROAD = { mode: 'ROAD', distanceKm: 842, vehicleNo: 'MH12AB1234', vehicleType: 'R' };

async function invoice(contactId: string, lines: Record<string, unknown>[], issueDate = t): Promise<Doc> {
  return (await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId, issueDate, lines, post: true }).expect(201)).body;
}
const goods = (unitPrice: string, extra: Record<string, unknown> = {}) => ({ accountId: org.acc['4100'], description: 'Steel brackets', quantity: '100', unitPrice, taxRateId: rates.g18.id, hsnCode: '73269099', ...extra });
const state = async (id: string) => (await ctx.http().get(`${org.base}/e-way-bills/documents/${id}`).set(owner.auth).expect(200)).body;
const record = (id: string, body: Record<string, unknown>, auth = owner.auth) => ctx.http().post(`${org.base}/e-way-bills/documents/${id}/e-way-bill`).set(auth).send({ number: ewbNo(), generatedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 5 * 86_400_000).toISOString(), transport: ROAD, ...body });
const settings = (over: Record<string, unknown> = {}) =>
  ctx.http().put(`${org.base}/e-way-bills/settings`).set(owner.auth).send({ threshold: '50000', intraStateThreshold: null, address1: 'Plot 7, MIDC Bhosari', address2: null, city: 'Pune', pincode: '411026', goodsUnit: 'NOS', ...over });

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'E-way Bill Owner');
  org = await createOrg(ctx, owner);
});
afterAll(async () => {
  await ctx.app.close();
});

describe('set-up', () => {
  it('needs the GST registration, then stores the threshold and dispatch address', async () => {
    expect((await ctx.http().get(`${org.base}/e-way-bills/settings`).set(owner.auth).expect(200)).body).toMatchObject({ configured: false, gstRegistered: false });
    expect((await settings().expect(409)).body.error).toBe('GST_NOT_REGISTERED');
    await ctx.http().put(`${org.base}/gst/registration`).set(owner.auth).send({ gstin: OWN, legalName: 'Deccan Fabricators Private Limited', effectiveFrom: FY_START }).expect(200);
    const accounts = (await ctx.http().get(`${org.base}/accounts`).set(owner.auth).expect(200)).body as { code: string; id: string }[];
    for (const a of accounts) org.acc[a.code] = a.id;
    rates.g18 = (await ctx.http().post(`${org.base}/tax-rates`).set(owner.auth).send({ name: 'GST 18%', rate: '18', kind: 'GST' }).expect(201)).body;
    rates.exempt = (await ctx.http().post(`${org.base}/tax-rates`).set(owner.auth).send({ name: 'Exempt', rate: '0', kind: 'GST', gstCategory: 'EXEMPT' }).expect(201)).body;
    await settings({ threshold: 'fifty' }).expect(400);
    expect((await settings().expect(200)).body).toMatchObject({ configured: true, stateCode: '27', threshold: '50000.00', intraStateThreshold: null, city: 'Pune' });
    customer = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Karnataka Metals LLP', isCustomer: true, gstin: BUYER, address: '4 Residency Road\nAshok Nagar', city: 'Bengaluru', pincode: '560025' }).expect(201)).body;
    local = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Walk-in Pune buyer', isCustomer: true, stateCode: '27', address: 'Shop 4, Camp', city: 'Pune' }).expect(201)).body;
  });
});

describe('which invoices need one', () => {
  let big: Doc;
  let small: Doc;
  let services: Doc;
  let localSale: Doc;

  it('goes by the value of goods with GST, leaving out services and exempt goods', async () => {
    big = await invoice(customer.id, [goods('600.00'), { ...goods('5000.00'), description: 'Installation', quantity: '1', hsnCode: '995461' }]);
    small = await invoice(customer.id, [goods('300.00'), { ...goods('400.00'), description: 'Exempt goods', taxRateId: rates.exempt.id, hsnCode: '0401' }]);
    services = await invoice(customer.id, [{ ...goods('90000.00'), description: 'Consulting', quantity: '1', hsnCode: '998311' }]);
    localSale = await invoice(local.id, [goods('600.00', { hsnCode: '7326' })]);
    expect(await state(big.id)).toMatchObject({ state: 'NEEDED', required: true, consignmentValue: '70800.00' });
    // 100 × 300 + 18% = 35,400 of taxable goods; the exempt goods are left out.
    expect(await state(small.id)).toMatchObject({ state: 'OPTIONAL', required: false, consignmentValue: '35400.00' });
    expect(await state(services.id)).toMatchObject({ state: 'NOT_APPLICABLE', reason: 'Services only: no goods move' });
    // Unregistered buyer without a PIN code: still needed, but details are missing.
    const l = await state(localSale.id);
    expect(l).toMatchObject({ state: 'NEEDS_DATA', required: true });
    expect(l.reason).toMatch(/Delivery PIN code is missing/);
  });

  it('uses the state’s own threshold for movement within it', async () => {
    await ctx.http().patch(`${org.base}/contacts/${local.id}`).set(owner.auth).send({ pincode: '411001' }).expect(200);
    expect((await state(localSale.id)).state).toBe('NEEDED');
    await settings({ intraStateThreshold: '100000' }).expect(200);
    expect((await state(localSale.id)).state).toBe('OPTIONAL');
    expect((await state(big.id)).state).toBe('NEEDED');
    await settings().expect(200);
  });

  it('builds the portal JSON with the transport details, and lists invoices in the register', async () => {
    const r = (await ctx.http().post(`${org.base}/e-way-bills/documents/${big.id}/json`).set(owner.auth).send({ transport: { ...ROAD, vehicleNo: 'mh-12-ab-1234', transporterId: TRANSPORTER, transporterName: 'Sahyadri Roadways' } }).expect(200)).body;
    expect(r.version).toBe('1.0.0621');
    expect(r.billLists).toHaveLength(1);
    expect(r.billLists[0]).toMatchObject({
      supplyType: 'O',
      docType: 'INV',
      docNo: big.number,
      docDate: ddmmyyyy(big.issueDate),
      fromGstin: OWN,
      fromTrdName: 'Deccan Fabricators Private Limited',
      fromPincode: 411026,
      toGstin: BUYER,
      toPincode: 560025,
      toStateCode: 29,
      totalValue: 65000,
      igstValue: 11700,
      totInvValue: 76700,
      transMode: '1',
      transDistance: '842',
      vehicleNo: 'MH12AB1234',
      transporterId: TRANSPORTER,
    });
    const bad = await ctx.http().post(`${org.base}/e-way-bills/documents/${big.id}/json`).set(owner.auth).send({ transport: { mode: 'ROAD', distanceKm: 842, vehicleType: 'R' } }).expect(422);
    expect(bad.body).toMatchObject({ error: 'EWAY_BILL_DATA_MISSING', details: { issues: ['A vehicle number is needed for transport by road'] } });
    expect((await ctx.http().post(`${org.base}/e-way-bills/documents/${services.id}/json`).set(owner.auth).send({ transport: ROAD }).expect(422)).body.error).toBe('EWAY_BILL_NOT_APPLICABLE');

    const reg = (await ctx.http().get(`${org.base}/e-way-bills/documents`).query({ from: FY_START, to: t }).set(owner.auth).expect(200)).body;
    expect(reg.rows.map((x: { number: string; state: string }) => [x.number, x.state])).toEqual([
      [big.number, 'NEEDED'],
      [small.number, 'OPTIONAL'],
      [services.number, 'NOT_APPLICABLE'],
      [localSale.number, 'NEEDED'],
    ]);
    expect(reg.summary).toMatchObject({ needed: 2, optional: 1, notApplicable: 1, generated: 0 });
  });
});

describe('recording e-way bills', () => {
  let doc: Doc;
  let number: string;

  it('records the number, validity and transport, once', async () => {
    doc = await invoice(customer.id, [goods('600.00')]);
    await record(doc.id, { number: '1234' }).expect(400);
    expect((await record(doc.id, { validUntil: null }).expect(422)).body.error).toBe('VALIDITY_REQUIRED');
    expect((await record(doc.id, { generatedAt: new Date(Date.now() + 86_400_000).toISOString() }).expect(422)).body.error).toBe('INVALID_DATE');
    expect((await record(doc.id, { transport: { ...ROAD, vehicleNo: 'NOT A TRUCK' } }).expect(422)).body.error).toBe('EWAY_BILL_DATA_MISSING');
    const generatedAt = new Date(Date.now() - 3_600_000).toISOString();
    const r = await record(doc.id, { number: '271000000001', generatedAt, transport: { ...ROAD, vehicleNo: 'mh12 ab 1234' } }).expect(201);
    number = r.body.number;
    expect(r.body).toMatchObject({ number: '271000000001', status: 'ACTIVE', distanceKm: 842, partB: { mode: 'ROAD', vehicleNo: 'MH12AB1234' }, expired: false, updates: [] });
    expect(r.body.expectedValidUntil).toMatch(/T18:29:59.000Z$/);
    expect(await state(doc.id)).toMatchObject({ state: 'GENERATED', eWayBill: { number } });
    expect((await record(doc.id, {}).expect(409)).body.error).toBe('EWAY_BILL_EXISTS');
    // The same number on another invoice is refused by the database.
    const other = await invoice(customer.id, [goods('600.00')]);
    await record(other.id, { number }).expect(409);
    expect(await ctx.prisma.auditEvent.findFirst({ where: { orgId: org.orgId, action: 'ewaybill.recorded' } })).toBeTruthy();
  });

  it('records a change of vehicle while valid, and refuses a first-time reason', async () => {
    const vehicle = (body: Record<string, unknown>) => ctx.http().post(`${org.base}/e-way-bills/documents/${doc.id}/e-way-bill/vehicle`).set(owner.auth).send({ mode: 'ROAD', vehicleNo: 'KA01AB4321', fromPlace: 'Belagavi', fromStateCode: '29', reason: '1', remark: 'Breakdown near Belagavi', ...body });
    expect((await vehicle({ reason: '4' }).expect(422)).body.error).toBe('INVALID_REASON');
    expect((await vehicle({ validUntil: new Date(Date.now() + 9 * 86_400_000).toISOString() }).expect(422)).body.error).toBe('INVALID_DATE');
    expect((await vehicle({ vehicleNo: null }).expect(422)).body).toMatchObject({ error: 'INVALID_TRANSPORT' });
    const r = (await vehicle({}).expect(201)).body;
    expect(r).toMatchObject({ partB: { mode: 'ROAD', vehicleNo: 'KA01AB4321' }, updates: [{ vehicleNo: 'KA01AB4321', reason: 'Breakdown', fromPlace: 'Belagavi' }] });
  });

  it('starts validity with the first Part B on a Part A only bill', async () => {
    const partA = await invoice(customer.id, [goods('600.00')]);
    const r = (await record(partA.id, { validUntil: null, transport: { mode: null, distanceKm: 842, vehicleType: 'R', transporterId: TRANSPORTER } }).expect(201)).body;
    expect(r).toMatchObject({ partB: null, validUntil: null, expectedValidUntil: null });
    expect((await state(partA.id)).reason).toMatch(/Part A only/);
    const vehicle = (body: Record<string, unknown>) => ctx.http().post(`${org.base}/e-way-bills/documents/${partA.id}/e-way-bill/vehicle`).set(owner.auth).send({ mode: 'ROAD', vehicleNo: 'MH14XY9876', fromPlace: 'Pune', fromStateCode: '27', reason: '4', remark: 'First vehicle', ...body });
    expect((await vehicle({ reason: '1' }).expect(422)).body.error).toBe('INVALID_REASON');
    expect((await vehicle({}).expect(422)).body.error).toBe('VALIDITY_REQUIRED');
    const validUntil = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const u = (await vehicle({ validUntil }).expect(201)).body;
    expect(u).toMatchObject({ partB: { vehicleNo: 'MH14XY9876' }, validUntil });
    expect(u.expectedValidUntil).toMatch(/T18:29:59.000Z$/);
  });

  const fourDaysAgo = new Date(Date.now() - 4 * 86_400_000).toISOString().slice(0, 10);
  it.skipIf(fourDaysAgo < FY_START)('refuses Part B changes after expiry', async () => {
    const old = await invoice(customer.id, [goods('600.00')], fourDaysAgo);
    const generatedAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
    await record(old.id, { generatedAt, validUntil: new Date(Date.now() - 86_400_000).toISOString() }).expect(201);
    expect((await state(old.id)).eWayBill).toMatchObject({ expired: true });
    const r = await ctx.http().post(`${org.base}/e-way-bills/documents/${old.id}/e-way-bill/vehicle`).set(owner.auth).send({ mode: 'ROAD', vehicleNo: 'KA01AB4321', fromPlace: 'Hubballi', fromStateCode: '29', reason: '2', remark: 'Transhipment' }).expect(409);
    expect(r.body.error).toBe('EWAY_BILL_EXPIRED');
    // Cancelling is also too late after 24 hours.
    expect((await ctx.http().post(`${org.base}/e-way-bills/documents/${old.id}/e-way-bill/cancel`).set(owner.auth).send({ reason: '2', remark: 'Order cancelled' }).expect(409)).body.error).toBe('CANCEL_WINDOW_CLOSED');
  });

  it('blocks voiding the invoice until the cancellation is recorded, within 24 hours', async () => {
    const v = await ctx.http().post(`${org.base}/sales/documents/${doc.id}/void`).set(owner.auth).send({ reason: 'Wrong buyer' }).expect(409);
    expect(v.body.error).toBe('HAS_EWAY_BILL');
    await expect(ctx.prisma.$executeRawUnsafe(`UPDATE documents SET status = 'VOID' WHERE id = '${doc.id}'`)).rejects.toThrow(/live e-way bill/);
    const c = (await ctx.http().post(`${org.base}/e-way-bills/documents/${doc.id}/e-way-bill/cancel`).set(owner.auth).send({ reason: '3', remark: 'Wrong buyer' }).expect(200)).body;
    expect(c).toMatchObject({ status: 'CANCELLED', cancelReason: 'Data entry mistake' });
    expect((await state(doc.id)).state).toBe('NEEDED');
    await ctx.http().post(`${org.base}/sales/documents/${doc.id}/void`).set(owner.auth).send({ reason: 'Wrong buyer' }).expect(200);
    expect(await state(doc.id)).toMatchObject({ state: 'CANCELLED', history: [expect.objectContaining({ status: 'CANCELLED', updates: [expect.objectContaining({ reason: 'Breakdown' })] })] });
  });

  it('keeps the records immutable in the database', async () => {
    await expect(ctx.prisma.$executeRawUnsafe(`UPDATE e_way_bills SET vehicle_no = 'X' WHERE org_id = '${org.orgId}'`)).rejects.toThrow(/immutable/);
    await expect(ctx.prisma.$executeRawUnsafe(`DELETE FROM e_way_bills WHERE org_id = '${org.orgId}'`)).rejects.toThrow(/cannot be deleted/);
    await expect(ctx.prisma.$executeRawUnsafe(`UPDATE e_way_bill_vehicle_updates SET remark = 'X' WHERE org_id = '${org.orgId}'`)).rejects.toThrow(/cannot be changed/);
  });
});

describe('access', () => {
  it('lets viewers read but not record, and keeps organisations apart', async () => {
    const viewer = await registerUser(ctx, 'Viewer');
    await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
    const reg = (await ctx.http().get(`${org.base}/e-way-bills/documents`).query({ from: FY_START, to: t }).set(viewer.auth).expect(200)).body;
    const needed = reg.rows.find((r: { state: string }) => r.state === 'NEEDED');
    await record(needed.documentId, {}, viewer.auth).expect(403);
    await ctx.http().put(`${org.base}/e-way-bills/settings`).set(viewer.auth).send({}).expect(403);
    const outsider = await registerUser(ctx, 'Outsider');
    const theirs = await createOrg(ctx, outsider);
    await ctx.http().get(`${theirs.base}/e-way-bills/documents/${needed.documentId}`).set(outsider.auth).expect(404);
  });
});
