import { fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Canadian GST/HST return (TAX-034) against the real API and database: the business number with
 * its check digit, Canada's treatments, lines 101 to 109 from GST and HST invoices, a credit note
 * and a bill with line 101 from the ledger's revenue, recording the filing, a missed input tax
 * credit claimed on the next return and under-reported GST/HST sent back to the earlier return.
 */
const T = today();
function lastDay(ym: string) {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
}
const shiftMonth = (ym: string, by: number) => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const t = y * 12 + m - 1 + by;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const M1 = shiftMonth(T.slice(0, 7), -2);
const M2 = shiftMonth(T.slice(0, 7), -1);
const E1 = lastDay(M1);
const E2 = lastDay(M2);
const E3 = lastDay(T.slice(0, 7));

let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let ca: Awaited<ReturnType<typeof createOrg>>;
const rate: Record<string, string> = {};
const ids: Record<string, string> = {};

const doc = (side: 'sales' | 'purchases', kind: string, date: string, lines: [string, string][]) =>
  ctx
    .http()
    .post(`${ca.base}/${side}/documents`)
    .set(owner.auth)
    .send({ kind, contactId: side === 'sales' ? ids.customer : ids.vendor, issueDate: date, dueDate: date, post: true, lines: lines.map(([unitPrice, taxRateId]) => ({ accountId: side === 'sales' ? ca.acc['4100'] : ca.acc['6600'], description: 'Synthetic item', quantity: '1', unitPrice, taxRateId })) })
    .expect(201);
const ret = (end: string, auth = owner.auth) => ctx.http().get(`${ca.base}/tax/vat/return?periodEnd=${end}`).set(auth);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'GST/HST Owner');
  viewer = await registerUser(ctx, 'GST/HST Viewer');
  ca = await createOrg(ctx, owner, { name: 'Synthetic Maple Trading Inc.', countryCode: 'CA', functionalCurrency: 'CAD', fiscalYearStartMonth: 1 });
  await ctx.http().post(`${ca.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  for (const fy of new Set([`${M1}-01`, T].map((d) => fiscalYearForDate(d, 1)))) await ctx.http().post(`${ca.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fy });
  await ctx.http().post(`${ca.base}/country-module/starter-rates`).set(owner.auth).send({}).expect(201);
  await ctx.http().post(`${ca.base}/tax-rates`).set(owner.auth).send({ name: 'Exempt residential rent', rate: '0' }).expect(201);
  for (const r of (await ctx.http().get(`${ca.base}/tax-rates`).set(owner.auth).expect(200)).body as { id: string; name: string }[]) rate[r.name] = r.id;
  ids.customer = (await ctx.http().post(`${ca.base}/contacts`).set(owner.auth).send({ name: 'Synthetic Lakeshore Retail Ltd', isCustomer: true }).expect(201)).body.id;
  ids.vendor = (await ctx.http().post(`${ca.base}/contacts`).set(owner.auth).send({ name: 'Synthetic Prairie Supplies Ltd', isVendor: true }).expect(201)).body.id;
});
afterAll(async () => ctx?.app.close());

describe('GST/HST registration', () => {
  it('uses the business number, Canadian treatments and HST rates', async () => {
    const s = (await ctx.http().get(`${ca.base}/tax/vat/settings`).set(viewer.auth).expect(200)).body;
    expect(s.jurisdiction).toMatchObject({ country: 'CA', currency: 'CAD', taxName: 'GST/HST', returnName: 'GST/HST return', authority: 'CRA', netBox: '109', wholeBoxes: ['101'] });
    expect(s.jurisdiction.correctionRule).toContain('input tax credits missed');
    expect(s.treatments.map((t: { key: string }) => t.key)).toEqual(['STANDARD', 'ZERO', 'EXEMPT', 'OUTSIDE_SCOPE']);
    for (const n of ['GST 5% (federal)', 'HST 13% (Ontario)', 'HST 14% (Nova Scotia)', 'HST 15% (Atlantic)']) expect(s.rates.find((r: { name: string }) => r.name === n).suggested).toBe('STANDARD');
    expect(s.rates.find((r: { name: string }) => r.name === 'Exempt residential rent').suggested).toBe('EXEMPT');

    const body = { vrn: '123456782 RT0001', registeredFrom: `${M1}-01`, stagger: 'MONTHLY', untaxedTreatment: 'OUTSIDE_SCOPE', treatments: [] };
    const put = (b: object) => ctx.http().put(`${ca.base}/tax/vat/settings`).set(owner.auth).send({ ...body, ...b });
    expect((await put({ vrn: '123456783RT0001' }).expect(422)).body).toMatchObject({ error: 'INVALID_VRN', message: expect.stringContaining('business number') });
    expect((await put({ treatments: [{ taxRateId: rate['GST 5% (federal)'], treatment: 'REDUCED' }] }).expect(422)).body.message).toBe('Reduced rate is not a treatment in Canada');
    expect((await put({}).expect(200)).body.settings).toMatchObject({ vrn: '123456782RT0001', stagger: 'MONTHLY' });
  });
});

describe('the GST/HST return', () => {
  it('fills lines 101 to 109 from the documents and the ledger', async () => {
    await doc('sales', 'INVOICE', `${M1}-05`, [['1000.00', rate['GST 5% (federal)']!], ['500.00', rate['GST 0% (zero-rated)']!]]);
    await doc('sales', 'INVOICE', `${M1}-06`, [['2000.00', rate['HST 13% (Ontario)']!]]);
    await doc('sales', 'CREDIT_NOTE', `${M1}-07`, [['100.00', rate['GST 5% (federal)']!]]);
    await doc('purchases', 'BILL', `${M1}-08`, [['400.00', rate['HST 13% (Ontario)']!]]);
    const r = (await ret(E1, viewer.auth).expect(200)).body;
    expect(r.period).toEqual({ start: `${M1}-01`, end: E1, due: E2 });
    expect(r.boxes).toEqual({ '101': '3400', '103': '305.00', '104': '0.00', '105': '305.00', '106': '52.00', '107': '0.00', '108': '52.00', '109': '253.00' });
    expect(r.labels['109']).toBe('Net tax (105 minus 108)');
    expect(r).toMatchObject({ net: '253.00', direction: 'PAY', issues: [] });
  });

  it('records the filing against the net tax shown', async () => {
    expect((await ctx.http().post(`${ca.base}/tax/vat/returns`).set(owner.auth).send({ periodEnd: E1, submittedOn: T, net: '250.00' }).expect(409)).body.message).toBe('The return has changed since it was opened: the net GST/HST is now CAD 253.00. Check it again');
    const r = (await ctx.http().post(`${ca.base}/tax/vat/returns`).set(owner.auth).send({ periodEnd: E1, submittedOn: T, reference: 'SYN-CRA-1', net: '253.00' }).expect(201)).body;
    expect(r.submitted).toMatchObject({ reference: 'SYN-CRA-1', changedSince: null });
    const p = (await ctx.http().get(`${ca.base}/tax/vat/periods`).set(viewer.auth).expect(200)).body;
    expect(p.periods.find((x: { end: string }) => x.end === E1)).toMatchObject({ status: 'SUBMITTED', net: '253.00', direction: 'PAY', due: E2 });
  });

  it('claims a missed input tax credit on the next return and sends under-reported GST/HST back', async () => {
    await doc('purchases', 'BILL', `${M1}-20`, [['100.00', rate['GST 5% (federal)']!]]);
    const next = (await ret(E2).expect(200)).body;
    expect(next.corrections).toMatchObject({ included: true, pending: [{ periodEnd: E1, output: '0.00', input: '5.00' }], allowance: { allowed: true } });
    expect(next.boxes).toMatchObject({ '101': '0', '103': '0.00', '106': '5.00', '109': '5.00' });
    expect(next.direction).toBe('RECLAIM');
    await ctx.http().post(`${ca.base}/tax/vat/returns`).set(owner.auth).send({ periodEnd: E2, submittedOn: T, net: '5.00' }).expect(201);

    await doc('sales', 'INVOICE', `${M1}-21`, [['100.00', rate['GST 5% (federal)']!]]);
    const open = (await ret(E3).expect(200)).body;
    expect(open.corrections).toMatchObject({ included: false, pending: [{ periodEnd: E1, output: '5.00', input: '0.00' }], allowance: { allowed: false } });
    expect(open.boxes['103']).toBe('0.00');
    expect(open.warnings).toContain('The changes to earlier returns cannot go on this return (only input tax credits missed on an earlier return may be claimed on a later one (within four years); GST/HST reported wrongly, or ITCs over-claimed, are corrected on the earlier return): ask the CRA to adjust the earlier returns instead');
  });

  it('exports the return as CSV', async () => {
    const x = (await ctx.http().get(`${ca.base}/tax/vat/return/export?periodEnd=${E1}`).set(viewer.auth).expect(200)).body;
    expect(x.fileName).toBe(`gst-hst-return-${M1}-01-to-${E1}.csv`);
    expect(x.csv.split('\n')[0]).toBe(`GST/HST return,${M1}-01 to ${E1}`);
    expect(x.csv).toContain('101,Sales and other revenue,3400');
    expect(x.csv).toContain('109,Net tax (105 minus 108),253.00');
  });
});
