import { addDays, fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Vendor contract compliance (AP-032) against the real API and database: a steel contract with a
 * price list, contract items only, 30-day terms and a spend cap; bills above the contract price,
 * with an item not on it, due too soon, over the cap and after the contract ended; a second
 * contract kept to and then terminated early; validation, permissions and tenant isolation.
 */
const T = today();
const d = (n: number) => addDays(T, -n);
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const v: Record<string, string> = {};
const k: Record<string, { id: string; reference: string }> = {};
const bills: Record<string, string> = {};

const V = () => `${org.base}/purchases/vendor-contracts`;
type Line = { description: string; hsnCode?: string; quantity: string; unitPrice: string };
const steel = (quantity: string, unitPrice: string): Line => ({ description: 'Steel sheet 2mm', hsnCode: '7208', quantity, unitPrice });
const bill = async (key: string, vendor: string, ago: number, dueIn: number, lines: Line[]) => {
  const b = (await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: v[vendor], issueDate: d(ago), dueDate: addDays(d(ago), dueIn), post: true, lines: lines.map((l) => ({ accountId: org.acc['6600'], ...l })) }).expect(201)).body;
  bills[key] = b.number;
};
const contract = (body: Record<string, unknown>, user = owner) => ctx.http().post(V()).set(user.auth).send(body);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Contract Owner');
  viewer = await registerUser(ctx, 'Contract Viewer');
  outsider = await registerUser(ctx, 'Contract Outsider');
  org = await createOrg(ctx, owner, { name: 'Contracted Supplies Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Contracts Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  for (const fy of new Set([300, 0].map((ago) => fiscalYearForDate(d(ago), 4)))) await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fy });
  for (const name of ['Asha Steel', 'Bharat Metals']) v[name] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name, isVendor: true }).expect(201)).body.id;
  v.customer = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Only A Customer', isCustomer: true }).expect(201)).body.id;
  k.asha = (
    await contract({
      contactId: v['Asha Steel'], title: 'Steel supply 2026', vendorReference: 'AS/RC/26', startDate: d(300), endDate: d(60), paymentTermsDays: 30, spendCap: '12000', itemsOnly: true,
      prices: [{ hsnCode: '7208', description: 'Steel sheet 2mm', unitPrice: '50' }, { description: 'Delivery charge', unitPrice: '200' }],
    }).expect(201)
  ).body;
  k.bharat = (await contract({ contactId: v['Bharat Metals'], title: 'Steel rate card', startDate: d(100), endDate: addDays(T, 200), paymentTermsDays: 30, prices: [{ hsnCode: '7208', unitPrice: '50' }] }).expect(201)).body;
  await bill('ok', 'Asha Steel', 250, 30, [steel('100', '50'), { description: 'Delivery charge', quantity: '1', unitPrice: '200' }]);
  await bill('bad', 'Asha Steel', 150, 15, [steel('100', '52'), { description: 'Packing', quantity: '1', unitPrice: '100' }]);
  await bill('cap', 'Asha Steel', 100, 30, [steel('50', '50')]);
  await bill('late', 'Asha Steel', 30, 30, [steel('10', '50')]);
  await bill('bharat', 'Bharat Metals', 50, 45, [steel('10', '48')]);
});
afterAll(async () => {
  await ctx?.app.close();
});

type Issue = { billNumber: string; code: string; severity: string; amount: string | null; detail: string; label: string };

describe('vendor contracts', () => {
  it('checks every bill against the contract covering its date', async () => {
    const a = (await ctx.http().get(`${V()}/${k.asha!.id}`).set(viewer.auth).expect(200)).body;
    expect(a).toMatchObject({ reference: 'VC-001', title: 'Steel supply 2026', vendor: { name: 'Asha Steel' }, vendorReference: 'AS/RC/26', state: 'ENDED', spend: '13000.00', capUsed: '108.3', billsChecked: 3, billsWithIssues: 3, overcharge: '200.00' });
    expect(a.prices.map((p: { key: string; unitPrice: string }) => [p.key, p.unitPrice])).toEqual([['hsn:7208', '50'], ['desc:delivery charge', '200']]);
    expect((a.issues as Issue[]).map((i) => [i.billNumber, i.code, i.severity, i.amount])).toEqual([
      [bills.bad, 'PRICE_ABOVE', 'HIGH', '200.00'],
      [bills.bad, 'NOT_IN_CONTRACT', 'LOW', null],
      [bills.bad, 'SHORT_TERMS', 'MEDIUM', null],
      [bills.cap, 'OVER_CAP', 'HIGH', '1000.00'],
      [bills.late, 'OUTSIDE_TERM', 'MEDIUM', null],
    ]);
    expect(a.issues[0].detail).toBe('Steel sheet 2mm: billed 52.00 a unit, the contract price is 50.00 (100 units)');
    expect(a.issues[4]).toMatchObject({ label: 'Outside the contract term', detail: `Billed on ${d(30)}, after contract VC-001 ended on ${d(60)}` });
    const b = (await ctx.http().get(`${V()}/${k.bharat!.id}`).set(viewer.auth).expect(200)).body;
    expect(b).toMatchObject({ state: 'IN_FORCE', spend: '480.00', capUsed: null, billsChecked: 1, issues: [] });
  });

  it('lists contracts with the findings, most serious first', async () => {
    const r = (await ctx.http().get(V()).set(viewer.auth).expect(200)).body;
    expect(r.summary).toEqual({ contracts: 2, inForce: 1, withIssues: 1, issues: 5, high: 2, overcharge: '200.00' });
    expect(r.contracts.map((c: { reference: string; issues: number }) => [c.reference, c.issues])).toEqual([['VC-002', 0], ['VC-001', 5]]);
    expect((r.issues as Issue[]).map((i) => i.code)).toEqual(['OVER_CAP', 'PRICE_ABOVE', 'OUTSIDE_TERM', 'SHORT_TERMS', 'NOT_IN_CONTRACT']);
    expect(r.issues[0]).toMatchObject({ contract: { reference: 'VC-001' }, vendor: { name: 'Asha Steel' } });
  });

  it('refuses overlapping, inconsistent or unknown contracts', async () => {
    expect((await contract({ contactId: v['Asha Steel'], title: 'Overlap', startDate: d(100), endDate: T }).expect(409)).body.error).toBe('OVERLAPS');
    expect((await contract({ contactId: v['Asha Steel'], title: 'Backwards', startDate: d(10), endDate: d(20) }).expect(422)).body.message).toBe('The contract ends before it starts');
    expect((await contract({ contactId: v['Asha Steel'], title: 'Twice', startDate: d(50), endDate: T, prices: [{ hsnCode: '7208', unitPrice: '50' }, { hsnCode: '72 08', unitPrice: '49' }] }).expect(422)).body.message).toBe('An item is priced twice; keep one price per item');
    expect((await contract({ contactId: v['Asha Steel'], title: 'No items', startDate: d(50), endDate: T, itemsOnly: true }).expect(422)).body.message).toBe('List the contract items to check bills against them');
    expect((await contract({ contactId: v.customer, title: 'Customer', startDate: d(50), endDate: T }).expect(422)).body.error).toBe('VENDOR_NOT_FOUND');
    await contract({ contactId: v['Asha Steel'], title: 'No key', startDate: d(50), endDate: T, prices: [{ unitPrice: '5' }] }).expect(422);
    await contract({ contactId: v['Asha Steel'], title: 'Viewer', startDate: d(50), endDate: T }, viewer).expect(403);
  });

  it('terminates a contract early; later bills fall outside its term', async () => {
    await ctx.http().post(`${V()}/${k.bharat!.id}/terminate`).set(owner.auth).send({ reason: 'Prices renegotiated', date: addDays(T, 300) }).expect(422);
    await ctx.http().post(`${V()}/${k.bharat!.id}/terminate`).set(viewer.auth).send({ reason: 'x' }).expect(403);
    const t = (await ctx.http().post(`${V()}/${k.bharat!.id}/terminate`).set(owner.auth).send({ reason: 'Prices renegotiated', date: d(10) }).expect(200)).body;
    expect(t).toMatchObject({ status: 'TERMINATED', state: 'TERMINATED', terminatedOn: d(10), terminateReason: 'Prices renegotiated' });
    await ctx.http().post(`${V()}/${k.bharat!.id}/terminate`).set(owner.auth).send({ reason: 'Again' }).expect(409);
    await bill('afterEnd', 'Bharat Metals', 2, 30, [steel('1', '50')]);
    const b = (await ctx.http().get(`${V()}/${k.bharat!.id}`).set(owner.auth).expect(200)).body;
    expect((b.issues as Issue[]).map((i) => [i.billNumber, i.code])).toEqual([[bills.afterEnd, 'OUTSIDE_TERM']]);
    // The vendor can have a new contract from the day after.
    await contract({ contactId: v['Bharat Metals'], title: 'Steel rate card 2', startDate: d(9), endDate: addDays(T, 300) }).expect(201);
  });

  it('keeps contracts to their organisation', async () => {
    await ctx.http().get(V()).set(outsider.auth).expect(404);
    await ctx.http().get(`${other.base}/purchases/vendor-contracts/${k.asha!.id}`).set(outsider.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/purchases/vendor-contracts`).set(outsider.auth).expect(200)).body.contracts).toEqual([]);
    expect((await ctx.http().post(`${other.base}/purchases/vendor-contracts`).set(outsider.auth).send({ contactId: v['Asha Steel'], title: 'Theirs', startDate: d(5), endDate: T }).expect(422)).body.error).toBe('VENDOR_NOT_FOUND');
  });
});
