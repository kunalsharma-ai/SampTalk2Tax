import { fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Australian GST on the BAS (TAX-035) against the real API and database: the ABN with the ATO
 * check digits, Australia's treatments and return cycles, G1, 1A and 1B in whole dollars from
 * invoices, a credit note and a bill, recording the lodgment, a back-dated error carried to the
 * next BAS and one over A$10,000 sent back to revise the earlier BAS.
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
let au: Awaited<ReturnType<typeof createOrg>>;
const rate: Record<string, string> = {};
const ids: Record<string, string> = {};

const doc = (side: 'sales' | 'purchases', kind: string, date: string, lines: [string, string][]) =>
  ctx
    .http()
    .post(`${au.base}/${side}/documents`)
    .set(owner.auth)
    .send({ kind, contactId: side === 'sales' ? ids.customer : ids.vendor, issueDate: date, dueDate: date, post: true, lines: lines.map(([unitPrice, taxRateId]) => ({ accountId: side === 'sales' ? au.acc['4100'] : au.acc['6600'], description: 'Synthetic item', quantity: '1', unitPrice, taxRateId })) })
    .expect(201);
const bas = (end: string, auth = owner.auth) => ctx.http().get(`${au.base}/tax/vat/return?periodEnd=${end}`).set(auth);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'BAS Owner');
  viewer = await registerUser(ctx, 'BAS Viewer');
  au = await createOrg(ctx, owner, { name: 'Synthetic Wattle Trading Pty Ltd', countryCode: 'AU', functionalCurrency: 'AUD', fiscalYearStartMonth: 7 });
  await ctx.http().post(`${au.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  for (const fy of new Set([`${M1}-01`, T].map((d) => fiscalYearForDate(d, 7)))) await ctx.http().post(`${au.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fy });
  await ctx.http().post(`${au.base}/country-module/starter-rates`).set(owner.auth).send({}).expect(201);
  await ctx.http().post(`${au.base}/tax-rates`).set(owner.auth).send({ name: 'Input taxed rent', rate: '0' }).expect(201);
  for (const r of (await ctx.http().get(`${au.base}/tax-rates`).set(owner.auth).expect(200)).body as { id: string; name: string }[]) rate[r.name] = r.id;
  ids.customer = (await ctx.http().post(`${au.base}/contacts`).set(owner.auth).send({ name: 'Synthetic Banksia Retail Pty Ltd', isCustomer: true }).expect(201)).body.id;
  ids.vendor = (await ctx.http().post(`${au.base}/contacts`).set(owner.auth).send({ name: 'Synthetic Harbour Supplies Pty Ltd', isVendor: true }).expect(201)).body.id;
});
afterAll(async () => ctx?.app.close());

describe('ABN and BAS cycle', () => {
  it('uses the ABN, Australian treatments and the ATO return cycles', async () => {
    const s = (await ctx.http().get(`${au.base}/tax/vat/settings`).set(viewer.auth).expect(200)).body;
    expect(s.jurisdiction).toMatchObject({ country: 'AU', currency: 'AUD', taxName: 'GST', returnName: 'Business activity statement (GST)', authority: 'ATO', numberName: 'ABN', netBox: 'net', wholeBoxes: ['G1', '1A', '1B', 'net'] });
    expect(s.jurisdiction.cardTitles.boxes).toBe('BAS GST items');
    expect(s.staggers.map((t: { key: string }) => t.key)).toEqual(['MONTHLY', 'QUARTERLY_MAR']);
    expect(s.treatments.map((t: { key: string }) => t.key)).toEqual(['STANDARD', 'ZERO', 'EXEMPT', 'OUTSIDE_SCOPE']);
    expect(s.rates.find((r: { name: string }) => r.name === 'GST 10%').suggested).toBe('STANDARD');
    expect(s.rates.find((r: { name: string }) => r.name === 'GST-free 0%').suggested).toBe('ZERO');
    expect(s.rates.find((r: { name: string }) => r.name === 'Input taxed rent').suggested).toBe('EXEMPT');

    const body = { vrn: '51 824 753 556', registeredFrom: `${M1}-01`, stagger: 'MONTHLY', untaxedTreatment: 'OUTSIDE_SCOPE', treatments: [] };
    const put = (b: object) => ctx.http().put(`${au.base}/tax/vat/settings`).set(owner.auth).send({ ...body, ...b });
    expect((await put({ vrn: '51 824 753 557' }).expect(422)).body).toMatchObject({ error: 'INVALID_VRN', message: expect.stringContaining('Australian Business Number') });
    expect((await put({ treatments: [{ taxRateId: rate['GST 10%'], treatment: 'REDUCED' }] }).expect(422)).body.message).toBe('Reduced rate is not a treatment in Australia');
    expect((await put({ stagger: 'QUARTERLY_APR' }).expect(422)).body.message).toBe('Quarterly, ending April, July, October and January returns are not a return cycle ATO uses');
    await ctx.http().put(`${au.base}/tax/vat/settings`).set(viewer.auth).send(body).expect(403);
    expect((await put({}).expect(200)).body.settings).toMatchObject({ vrn: '51824753556', stagger: 'MONTHLY' });
  });
});

describe('the BAS GST items', () => {
  it('fills G1, 1A and 1B in whole dollars', async () => {
    await doc('sales', 'INVOICE', `${M1}-05`, [['1000.40', rate['GST 10%']!], ['500.00', rate['GST-free 0%']!]]);
    await doc('sales', 'INVOICE', `${M1}-06`, [['300.00', rate['Input taxed rent']!]]);
    await doc('sales', 'CREDIT_NOTE', `${M1}-07`, [['100.00', rate['GST 10%']!]]);
    await doc('purchases', 'BILL', `${M1}-08`, [['400.00', rate['GST 10%']!], ['200.00', rate['GST-free 0%']!]]);
    const r = (await bas(E1, viewer.auth).expect(200)).body;
    expect(r.period).toEqual({ start: `${M1}-01`, end: E1, due: `${M2}-21` });
    // G1 = 1100.44 + 500 + 300 − 110 = 1790.44; 1A = 100.04 − 10 = 90.04; 1B = 40.
    expect(r.boxes).toEqual({ G1: '1790', '1A': '90', '1B': '40', net: '50' });
    expect(r.labels.G1).toBe('Total sales (including any GST)');
    expect(r).toMatchObject({ net: '50', direction: 'PAY', issues: [] });
    expect(r.own).toEqual({ output: '90.04', input: '40.00', supplies: '1790.44', purchases: '640.00' });
  });

  it('records the lodgment against the net GST shown', async () => {
    expect((await ctx.http().post(`${au.base}/tax/vat/returns`).set(owner.auth).send({ periodEnd: E1, submittedOn: T, net: '49' }).expect(409)).body.message).toBe('The return has changed since it was opened: the net GST is now AUD 50. Check it again');
    const r = (await ctx.http().post(`${au.base}/tax/vat/returns`).set(owner.auth).send({ periodEnd: E1, submittedOn: T, reference: 'SYN-ATO-1', net: '50' }).expect(201)).body;
    expect(r.submitted).toMatchObject({ reference: 'SYN-ATO-1', boxes: { G1: '1790', '1A': '90', '1B': '40', net: '50' }, changedSince: null });
    const p = (await ctx.http().get(`${au.base}/tax/vat/periods`).set(viewer.auth).expect(200)).body;
    expect(p.periods.find((x: { end: string }) => x.end === E1)).toMatchObject({ status: 'SUBMITTED', net: '50', direction: 'PAY', due: `${M2}-21` });
  });

  it('carries an error of up to A$10,000 to the next BAS and sends a larger one back to revise', async () => {
    await doc('purchases', 'BILL', `${M1}-20`, [['250.00', rate['GST 10%']!]]);
    const next = (await bas(E2).expect(200)).body;
    expect(next.corrections).toMatchObject({ included: true, pending: [{ periodEnd: E1, output: '0.00', input: '25.00' }], allowance: { limit: '10000.00', allowed: true } });
    expect(next.boxes).toEqual({ G1: '0', '1A': '0', '1B': '25', net: '25' });
    expect(next.direction).toBe('RECLAIM');
    await ctx.http().post(`${au.base}/tax/vat/returns`).set(owner.auth).send({ periodEnd: E2, submittedOn: T, net: '25' }).expect(201);

    await doc('sales', 'INVOICE', `${M1}-21`, [['150000.00', rate['GST 10%']!]]);
    const open = (await bas(E3).expect(200)).body;
    expect(open.corrections).toMatchObject({ included: false, pending: [{ periodEnd: E1, output: '15000.00', net: '15000.00' }], allowance: { allowed: false } });
    expect(open.boxes['1A']).toBe('0');
    expect(open.warnings).toContain('The corrections of earlier returns come to AUD 15000.00, over the AUD 10000.00 that may go on this return: revise the earlier BAS with the ATO instead');
  });

  it('exports the BAS GST items as CSV', async () => {
    const x = (await ctx.http().get(`${au.base}/tax/vat/return/export?periodEnd=${E1}`).set(viewer.auth).expect(200)).body;
    expect(x.fileName).toBe(`gst-return-${M1}-01-to-${E1}.csv`);
    expect(x.csv.split('\n')[0]).toBe(`Business activity statement (GST),${M1}-01 to ${E1}`);
    expect(x.csv).toContain('G1,Total sales (including any GST),1790');
    expect(x.csv).toContain('net,Net GST for the period (1A less 1B),50');
    expect(x.csv).toContain('Treatment,Rate,Net,GST');
  });
});
