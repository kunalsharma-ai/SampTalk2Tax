import { gstinCheckCharacter } from '@talk2tax/tax-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';
import { sqlWrite } from './sql-writes';

/**
 * Supplier tax validation (AP-019) against the real API and database: the vendor report, GST
 * portal checks recorded (and kept as recorded), bills from a cancelled or composition supplier,
 * a vendor kept twice, a GSTIN changed after billing, permissions and tenant isolation.
 */
const synthetic = (state: string, pan: string) => `${state}${pan}1Z${gstinCheckCharacter(`${state}${pan}1Z`)}`;
const OWN = synthetic('29', 'ZZZCZ0101Z');
const STEEL = synthetic('29', 'ZZZCZ0102Z');
const STEEL_NEW = synthetic('29', 'ZZZCZ0105Z');
const PAPER = synthetic('33', 'ZZZCZ0103Z');
const T = today();
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);

let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let g18: { id: string };
const v: Record<string, { id: string; name: string }> = {};
const bills: Record<string, { id: string; number: string }> = {};
const S = () => `${org.base}/purchases/supplier-tax`;
const raw = (sql: string, ...args: unknown[]) => sqlWrite(ctx, sql, args, { bypass: true });
async function bill(contactId: string, amount: string, issueDate = T) {
  return (await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId, issueDate, lines: [{ accountId: org.acc['1300'], description: 'Stock', quantity: '1', unitPrice: amount, taxRateId: g18.id, hsnCode: '7208' }], post: true }).expect(201)).body;
}
const vendorRow = async (id: string) => (await ctx.http().get(S()).set(viewer.auth).expect(200)).body.vendors.find((x: { id: string }) => x.id === id);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Tax Owner');
  viewer = await registerUser(ctx, 'Tax Viewer');
  outsider = await registerUser(ctx, 'Tax Outsider');
  org = await createOrg(ctx, owner, { name: 'Kaveri Fabrication' });
  await createOrg(ctx, outsider, { name: 'Other Org' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  await ctx.http().put(`${org.base}/gst/registration`).set(owner.auth).send({ gstin: OWN, effectiveFrom: addDays(T, -90) }).expect(200);
  g18 = (await ctx.http().post(`${org.base}/tax-rates`).set(owner.auth).send({ name: 'GST 18%', rate: '18', kind: 'GST' }).expect(201)).body;
  const mk = async (key: string, body: Record<string, unknown>) => (v[key] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ isVendor: true, ...body }).expect(201)).body);
  await mk('steel', { name: 'Tunga Steel Pvt Ltd', gstin: STEEL });
  await mk('paper', { name: 'Chola Paper Mills', gstin: PAPER });
  await mk('paperTwo', { name: 'Chola Paper Mills (Chennai)', gstin: PAPER });
  await mk('cash', { name: 'Local Hardware', stateCode: '29' });
  bills.steel1 = await bill(v.steel!.id, '10000.00', addDays(T, -20));
  bills.steel2 = await bill(v.steel!.id, '5000.00', addDays(T, -5));
  bills.paper = await bill(v.paper!.id, '2000.00', addDays(T, -10));
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('supplier tax validation', () => {
  it('reports every active vendor, worst first', async () => {
    const r = (await ctx.http().get(S()).set(viewer.auth).expect(200)).body;
    expect(r.asOf).toBe(T);
    expect(r.totals).toMatchObject({ vendors: 4, registered: 3, verified: 0 });
    const paper = r.vendors.find((x: { id: string }) => x.id === v.paper!.id);
    expect(paper.issues.map((i: { code: string }) => i.code)).toEqual(['DUPLICATE_GSTIN', 'NOT_VERIFIED']);
    expect(paper.issues[0].message).toContain('Chola Paper Mills (Chennai)');
    expect(r.vendors.find((x: { id: string }) => x.id === v.cash!.id)).toMatchObject({ issues: [], billCount: 0 });
    expect(r.vendors[0].medium + r.vendors[0].high).toBeGreaterThan(0);
    await ctx.http().get(S()).set(outsider.auth).expect(404);
  });

  it('records a GST portal check and keeps it as recorded', async () => {
    const C = `${S()}/${v.steel!.id}/checks`;
    const body = { status: 'ACTIVE', taxpayerType: 'REGULAR', legalName: 'TUNGA STEEL PRIVATE LIMITED', checkedOn: T };
    await ctx.http().post(C).set(viewer.auth).send(body).expect(403);
    await ctx.http().post(C).set(owner.auth).send({ ...body, status: 'MAYBE' }).expect(400);
    expect((await ctx.http().post(C).set(owner.auth).send({ ...body, checkedOn: addDays(T, 1) }).expect(422)).body.message).toBe('The check date cannot be in the future');
    expect((await ctx.http().post(C).set(owner.auth).send({ ...body, effectiveDate: T }).expect(422)).body.message).toMatch(/only for a cancelled or suspended/);
    expect((await ctx.http().post(`${S()}/${v.cash!.id}/checks`).set(owner.auth).send(body).expect(422)).body.message).toBe('Local Hardware has no valid GSTIN to check; add it to the vendor first');
    const r = (await ctx.http().post(C).set(owner.auth).send(body).expect(201)).body;
    expect(r.issues).toEqual([]);
    expect(r.verification).toMatchObject({ status: 'ACTIVE', taxpayerType: 'REGULAR', checkedOn: T });
    expect(r.checks).toEqual([expect.objectContaining({ gstin: STEEL, current: true, status: 'ACTIVE', recordedBy: 'Tax Owner' })]);
    await expect(raw(`UPDATE supplier_gstin_checks SET status = 'CANCELLED' WHERE contact_id = $1::uuid`, v.steel!.id)).rejects.toThrow(/kept as recorded/);
    await expect(raw(`DELETE FROM supplier_gstin_checks WHERE contact_id = $1::uuid`, v.steel!.id)).rejects.toThrow(/kept as recorded/);
  });

  it('flags GST billed after a registration was cancelled, and by a composition supplier', async () => {
    const C = `${S()}/${v.steel!.id}/checks`;
    const r = (await ctx.http().post(C).set(owner.auth).send({ status: 'CANCELLED', effectiveDate: addDays(T, -10), checkedOn: T, note: 'Cancelled suo motu' }).expect(201)).body;
    expect(r.issues[0]).toMatchObject({ code: 'REGISTRATION_CANCELLED', severity: 'HIGH', bills: [{ number: bills.steel2!.number, id: bills.steel2!.id }] });
    expect(r.checks.map((c: { status: string }) => c.status)).toEqual(['CANCELLED', 'ACTIVE']);
    expect((await vendorRow(v.steel!.id)).high).toBe(1);
    const p = (await ctx.http().post(`${S()}/${v.paper!.id}/checks`).set(owner.auth).send({ status: 'ACTIVE', taxpayerType: 'COMPOSITION', legalName: 'Chola Paper Mills', checkedOn: T }).expect(201)).body;
    expect(p.issues.map((i: { code: string }) => i.code)).toEqual(['COMPOSITION_CHARGED_GST', 'DUPLICATE_GSTIN']);
    expect(p.issues[0].bills).toEqual([{ number: bills.paper!.number, id: bills.paper!.id }]);
  });

  it('notices a GSTIN changed after billing, and that the old check no longer counts', async () => {
    await ctx.http().patch(`${org.base}/contacts/${v.steel!.id}`).set(owner.auth).send({ gstin: STEEL_NEW }).expect(200);
    const r = (await ctx.http().get(`${S()}/${v.steel!.id}`).set(viewer.auth).expect(200)).body;
    expect(r.verification).toBeNull();
    expect(r.issues.map((i: { code: string }) => i.code)).toEqual(['BILL_GSTIN_CHANGED', 'NOT_VERIFIED']);
    expect(r.issues[0].bills.map((b: { number: string }) => b.number).sort()).toEqual([bills.steel1!.number, bills.steel2!.number].sort());
    expect(r.checks.every((c: { current: boolean }) => !c.current)).toBe(true);
    await ctx.http().get(`${S()}/${v.cash!.id}`).set(viewer.auth).expect(200);
    await ctx.http().get(`${S()}/00000000-0000-4000-8000-000000000000`).set(viewer.auth).expect(404);
  });
});
