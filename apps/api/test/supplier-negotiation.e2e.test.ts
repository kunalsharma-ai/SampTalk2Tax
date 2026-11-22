import { addDays, fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Supplier negotiation help (AP-033) against the real API and database: a vendor whose steel price
 * rose, sold cheaper by another vendor, with spend up on the year before and every bill paid on its
 * due date gets four points and a target saving; a vendor with an overdue bill gets a caution; an
 * unbilled vendor gets an empty brief; permissions and tenant isolation.
 */
const T = today();
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let employee: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const v: Record<string, string> = {};

const N = () => `${org.base}/purchases/negotiation-briefs`;
/** A posted bill `ago` days before today, due 30 days after its date. */
const bill = async (vendor: string, ago: number, quantity: string, unitPrice: string, hsnCode = '7208') =>
  (
    await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({
      kind: 'BILL',
      contactId: v[vendor],
      issueDate: addDays(T, -ago),
      dueDate: addDays(T, -ago + 30),
      post: true,
      lines: [{ accountId: org.acc['6600'], description: 'Steel sheet 2mm', hsnCode, quantity, unitPrice }],
    }).expect(201)
  ).body as { id: string; total: string; dueDate: string };
const payOn = (vendor: string, b: { id: string; total: string }, date: string) =>
  ctx.http().post(`${org.base}/purchases/payments`).set(owner.auth).send({ contactId: v[vendor], date, bankAccountId: org.acc['1120'], amount: b.total, allocations: [{ documentId: b.id, amount: b.total }] }).expect(201);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Nego Owner');
  viewer = await registerUser(ctx, 'Nego Viewer');
  employee = await registerUser(ctx, 'Nego Employee');
  outsider = await registerUser(ctx, 'Nego Outsider');
  org = await createOrg(ctx, owner, { name: 'Negotiation Works Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Negotiation Ltd' });
  for (const [u, role] of [[viewer, 'VIEWER'], [employee, 'EMPLOYEE']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  for (const name of ['Asha Steel', 'Bharat Metals', 'Chhaya Traders', 'Unused Vendor']) v[name] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name, isVendor: true }).expect(201)).body.id;
  for (const fy of new Set([400, 300, 0].map((ago) => fiscalYearForDate(addDays(T, -ago), 4)))) await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fy });
  // Asha: the year before at 40; this year 50, then 55 twice; every bill paid on its due date.
  await bill('Asha Steel', 400, '100', '40');
  for (const [ago, price] of [[300, '50'], [200, '55'], [100, '55']] as const) {
    const b = await bill('Asha Steel', ago, '100', price);
    await payOn('Asha Steel', b, addDays(T, -ago + 30));
  }
  // Bharat sells the same steel at 52, not yet due.
  await bill('Bharat Metals', 20, '10', '52');
  // Chhaya: one bill overdue now.
  await bill('Chhaya Traders', 60, '5', '100', '7210');
});
afterAll(async () => {
  await ctx.app.close();
});

type Point = { code: string; label: string; tone: string; title: string; detail: string; saving: string | null };

describe('supplier negotiation', () => {
  it('lists billed vendors with the largest possible saving first', async () => {
    const r = (await ctx.http().get(N()).set(viewer.auth).expect(200)).body;
    expect(r).toMatchObject({ asOf: T, from: addDays(T, -364), currency: 'INR', summary: { vendors: 3, withPoints: 1, targetSaving: '1000.00' } });
    expect(r.vendors.map((x: { vendor: { name: string } }) => x.vendor.name)).toEqual(['Asha Steel', 'Chhaya Traders', 'Bharat Metals']);
    expect(r.vendors[0]).toMatchObject({ spend: '16000.00', change: '300.0', share: '94.0', bills: 3, paymentRecord: 'GOOD', paymentRecordLabel: 'Pays on time', targetSaving: '1000.00' });
    expect(r.vendors[0].points.map((p: Point) => p.code)).toEqual(['PRICE_RISE', 'CHEAPER_ELSEWHERE', 'VOLUME', 'GOOD_PAYER']);
    expect(r.vendors[1]).toMatchObject({ paymentRecord: 'POOR', points: [{ code: 'PAYS_LATE', tone: 'CAUTION', label: 'Settle late bills first' }] });
    expect(r.vendors[2]).toMatchObject({ spend: '520.00', points: [], paymentRecord: 'NONE' });
  });

  it('gives one vendor a brief with prices, the cheaper vendor and the reasons', async () => {
    const b = (await ctx.http().get(`${N()}/${v['Asha Steel']}`).set(viewer.auth).expect(200)).body;
    expect(b.vendor).toEqual({ id: v['Asha Steel'], name: 'Asha Steel', paymentTermsDays: 30 });
    expect(b.spend).toEqual({ current: '16000.00', previous: '4000.00', change: '300.0', share: '94.0', bills: 3 });
    expect(b.payments).toEqual({ record: 'GOOD', paid: 3, onTime: 3, onTimePercent: 100, averageDaysLate: 0, overdue: 0 });
    expect(b.items).toHaveLength(1);
    expect(b.items[0]).toMatchObject({ key: 'hsn:7208', label: 'Steel sheet 2mm', bills: 3, quantity: '300', firstPrice: '50.00', latestPrice: '55.00', priceChange: '10.0', extraPaid: '1000.00', cheaperSaving: '900.00' });
    expect(b.items[0].bestOther).toEqual({ vendorId: v['Bharat Metals'], vendorName: 'Bharat Metals', unitPrice: '52.00', date: addDays(T, -20), gap: '5.5' });
    const byCode = Object.fromEntries((b.points as Point[]).map((p) => [p.code, p]));
    expect(byCode.PRICE_RISE).toMatchObject({ label: 'Prices went up', saving: '1000.00', title: 'Steel sheet 2mm: price up 10.0%' });
    expect(byCode.CHEAPER_ELSEWHERE.detail).toContain('Bharat Metals billed INR 52.00 a unit');
    expect(byCode.GOOD_PAYER.detail).toBe('You paid 3 of 3 bills by the due date and nothing is overdue. Ask for 45 days instead of 30, or for a discount for paying early.');
    expect(b.targetSaving).toBe('1000.00');
  });

  it('shows the overdue caution and an empty brief for an unbilled vendor', async () => {
    const c = (await ctx.http().get(`${N()}/${v['Chhaya Traders']}`).set(owner.auth).expect(200)).body;
    expect(c.payments).toMatchObject({ record: 'POOR', paid: 0, overdue: 1 });
    expect(c.points[0].detail).toBe('1 bill is overdue now. The vendor will raise this, so clear what is overdue before asking for better prices or terms.');
    const u = (await ctx.http().get(`${N()}/${v['Unused Vendor']}`).set(owner.auth).expect(200)).body;
    expect(u).toMatchObject({ spend: { current: '0.00', bills: 0 }, items: [], points: [], targetSaving: '0.00', paymentRecordLabel: 'Too few paid bills' });
  });

  it('checks permissions, ids and tenants', async () => {
    await ctx.http().get(N()).set(employee.auth).expect(403);
    await ctx.http().get(`${N()}/not-an-id`).set(owner.auth).expect(400);
    await ctx.http().get(N()).set(outsider.auth).expect(404);
    // Another organisation's vendor is not found here, and theirs see nothing of ours.
    const theirs = (await ctx.http().get(`${other.base}/purchases/negotiation-briefs`).set(outsider.auth).expect(200)).body;
    expect(theirs.vendors).toEqual([]);
    await ctx.http().get(`${other.base}/purchases/negotiation-briefs/${v['Asha Steel']}`).set(outsider.auth).expect(404);
  });
});
