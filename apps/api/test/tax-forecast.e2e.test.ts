import { fiscalYearForDate } from '@talk2tax/accounting-engine';
import { gstinCheckCharacter, taxYearOf } from '@talk2tax/tax-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Tax liability forecast (TAX-048): GST owed for months already over comes from the books after
 * set-off, the month in progress from the recent average; TDS deducted and not deposited is known,
 * this month's is averaged; advance tax comes from the plan. Real API and DB.
 */
const synthetic = (state: string, pan: string) => `${state}${pan}1Z${gstinCheckCharacter(`${state}${pan}1Z`)}`;
const OWN = synthetic('29', 'ZZZTF0001Z');

let ctx: Ctx;
let owner: TestUser;
let employee: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const c: Record<string, string> = {};

const T = today();
const monthOf = (back: number) => {
  const d = new Date(`${T.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - back);
  return d.toISOString().slice(0, 7);
};
type Item = { key: string; kind: string; method: string; amount: string; low: string; high: string; basis: string; dueDate: string };
const get = async (months = 2) => (await ctx.http().get(`${org.base}/tax-forecast`).query({ months }).set(owner.auth).expect(200)).body as { items: Item[]; months: { month: string; amount: string }[]; totals: { amount: string; known: string }; horizon: number; overdue: number };

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Tax Forecast Owner');
  employee = await registerUser(ctx, 'Tax Forecast Employee');
  org = await createOrg(ctx, owner);
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: employee.email, role: 'EMPLOYEE' }).expect(201);
  for (const m of [3, 2, 1].map(monthOf)) await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fiscalYearForDate(`${m}-01`, 4) });
  await ctx.http().put(`${org.base}/gst/registration`).set(owner.auth).send({ gstin: OWN, legalName: 'Forecast Test Pvt Ltd', effectiveFrom: `${monthOf(3)}-01` }).expect(200);
  await ctx.http().put(`${org.base}/withholding/settings`).set(owner.auth).send({ tan: 'pnez12345b' }).expect(200);
  const contractor = (await ctx.http().post(`${org.base}/withholding/sections`).set(owner.auth).send({ template: '393(1)-6(i)' }).expect(201)).body.id;
  for (const a of (await ctx.http().get(`${org.base}/accounts`).set(owner.auth).expect(200)).body as { code: string; id: string }[]) org.acc[a.code] = a.id;
  const rate = (await ctx.http().post(`${org.base}/tax-rates`).set(owner.auth).send({ name: 'GST 18%', rate: '18', kind: 'GST' }).expect(201)).body.id;
  const mk = async (k: string, body: Record<string, unknown>) => (c[k] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send(body).expect(201)).body.id);
  await mk('ka', { name: 'Bengaluru Retail', isCustomer: true, gstin: synthetic('29', 'ZZZTF0002Z') });
  await mk('tn', { name: 'Chennai Components', isVendor: true, gstin: synthetic('33', 'ZZZTF0003Z') });
  await mk('works', { name: 'Mysuru Works', isVendor: true, gstin: synthetic('29', 'ZZZTF0004Z'), withholdingSectionId: contractor });
  const doc = (path: string, kind: string, contact: string, date: string, amount: string, account: string, extra: Record<string, unknown> = {}) =>
    ctx.http().post(`${org.base}/${path}`).set(owner.auth).send({ kind, contactId: c[contact], issueDate: date, dueDate: date, post: true, lines: [{ accountId: org.acc[account], description: 'Goods', quantity: '1', unitPrice: amount, taxRateId: rate, hsnCode: '8471' }], ...extra }).expect(201);
  // Three months of sales (CGST + SGST 18,000 each); the last month also has a bill with IGST credit 7,200.
  for (const back of [3, 2, 1]) await doc('sales/documents', 'INVOICE', 'ka', `${monthOf(back)}-10`, '100000.00', '4100');
  await doc('purchases/documents', 'BILL', 'tn', `${monthOf(1)}-12`, '40000.00', '1300');
  // Contractor bills with 2% TDS (1,000 each), two months back and last month, not deposited.
  for (const back of [2, 1]) await doc('purchases/documents', 'BILL', 'works', `${monthOf(back)}-15`, '50000.00', '6100', { withholdingSectionId: contractor });
});
afterAll(async () => ctx?.app.close());

describe('tax liability forecast', () => {
  it('works out GST and TDS from the books and the recent average', async () => {
    const f = await get();
    const by = (key: string) => f.items.find((i) => i.key === key)!;
    // GST for last month: everything unpaid up to its end, after set-off. Output CGST and SGST 27,000 each;
    // credit IGST 7,200 and CGST/SGST 9,000 each from the bills: 18,000 + 18,000 − 7,200 = 28,800.
    expect(by(`GSTR3B:${monthOf(1)}`)).toMatchObject({ method: 'KNOWN', amount: '28800.00' });
    expect(by(`GSTR3B:${monthOf(1)}`).basis).toMatch(/includes anything unpaid from earlier months/);
    // The earlier unpaid months are in that balance, not counted again.
    expect(f.items.filter((i) => i.kind === 'GSTR3B').map((i) => i.key)).toEqual([`GSTR3B:${monthOf(1)}`, `GSTR3B:${monthOf(0)}`]);
    expect(by(`GSTR3B:${monthOf(1)}`).basis).toMatch(/Includes .+, not paid yet\.$/);
    // This month's GST: the average of each month's cash after set-off: 18,000, 9,000 and 1,800.
    const now = by(`GSTR3B:${monthOf(0)}`);
    expect(now).toMatchObject({ method: 'AVERAGE', amount: '9600.00', low: '2972.78', high: '16227.22' });
    expect(now.basis).toBe(`Average of the last 3 periods (₹18,000.00, ₹9,000.00, ₹1,800.00); ${now.basis.split('; ')[1]!.split(' has')[0]} has not ended yet. Net of input tax credit, per month.`);
    // TDS deducted and not deposited is known; this month's is the average.
    expect(by(`TDS_DEPOSIT:${monthOf(2)}`)).toMatchObject({ method: 'KNOWN', amount: '1000.00' });
    expect(by(`TDS_DEPOSIT:${monthOf(1)}`)).toMatchObject({ method: 'KNOWN', amount: '1000.00' });
    expect(by(`TDS_DEPOSIT:${monthOf(0)}`)).toMatchObject({ method: 'AVERAGE', amount: '1000.00' });
    expect(f.horizon).toBe(2);
    expect(f.items.map((i) => i.dueDate)).toEqual([...f.items.map((i) => i.dueDate)].sort());
    const sum = f.items.reduce((s, i) => s + Number(i.amount) * 100, 0) / 100; // not money
    expect(f.totals.amount).toBe(sum.toFixed(2));
    expect(f.totals.known).toBe('30800.00');
    expect(f.overdue).toBe(f.items.filter((i) => i.dueDate < T).length);
  });

  it('adds advance tax from the plan once it is tracked', async () => {
    const ty = taxYearOf(T);
    await ctx.http().put(`${org.base}/compliance/settings`).set(owner.auth).send({ gstReturnFrequency: 'MONTHLY', advanceTaxFrom: ty.from }).expect(200);
    const plan = (await ctx.http().get(`${org.base}/tax/advance-tax`).set(owner.auth).expect(200)).body as { instalments: { dueDate: string; toPay: string }[] };
    const f = await get(6);
    const adv = f.items.filter((i) => i.kind === 'ADVANCE_TAX');
    expect(adv.length).toBeGreaterThan(0);
    for (const a of adv) {
      expect(a.method).toBe('PLAN');
      const inst = plan.instalments.find((i) => i.dueDate === a.dueDate);
      if (inst) expect(a.amount).toBe(inst.toPay);
    }
  });

  it('can be read with reports access only, and limits the window', async () => {
    await ctx.http().get(`${org.base}/tax-forecast`).set(employee.auth).expect(403);
    await ctx.http().get(`${org.base}/tax-forecast`).query({ months: 7 }).set(owner.auth).expect(400);
    await ctx.http().get(`${org.base}/tax-forecast`).set((await registerUser(ctx, 'Outsider')).auth).expect(404);
  });
});
