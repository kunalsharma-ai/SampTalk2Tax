import { fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Singapore GST F5 return (TAX-036) against the real API and database: the registration with its
 * number format and Singapore's treatments, boxes 1 to 8 from invoices, a credit note and a bill
 * with box 13 from the ledger's revenue, recording the submission, a small back-dated error
 * carried to the next return and a large one sent to IRAS separately (GST F7).
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
let sg: Awaited<ReturnType<typeof createOrg>>;
const rate: Record<string, string> = {};
const ids: Record<string, string> = {};

const doc = (side: 'sales' | 'purchases', kind: string, date: string, lines: [string, string][]) =>
  ctx
    .http()
    .post(`${sg.base}/${side}/documents`)
    .set(owner.auth)
    .send({ kind, contactId: side === 'sales' ? ids.customer : ids.vendor, issueDate: date, dueDate: date, post: true, lines: lines.map(([unitPrice, taxRateId]) => ({ accountId: side === 'sales' ? sg.acc['4100'] : sg.acc['6600'], description: 'Synthetic item', quantity: '1', unitPrice, taxRateId })) })
    .expect(201);
const gst = (end: string, auth = owner.auth) => ctx.http().get(`${sg.base}/tax/vat/return?periodEnd=${end}`).set(auth);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'GST Owner');
  viewer = await registerUser(ctx, 'GST Viewer');
  sg = await createOrg(ctx, owner, { name: 'Synthetic Lion Trading Pte Ltd', countryCode: 'SG', functionalCurrency: 'SGD', fiscalYearStartMonth: 1 });
  await ctx.http().post(`${sg.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  for (const fy of new Set([`${M1}-01`, T].map((d) => fiscalYearForDate(d, 1)))) await ctx.http().post(`${sg.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fy });
  await ctx.http().post(`${sg.base}/country-module/starter-rates`).set(owner.auth).send({}).expect(201);
  await ctx.http().post(`${sg.base}/tax-rates`).set(owner.auth).send({ name: 'Exempt financial services', rate: '0' }).expect(201);
  for (const r of (await ctx.http().get(`${sg.base}/tax-rates`).set(owner.auth).expect(200)).body as { id: string; name: string }[]) rate[r.name] = r.id;
  ids.customer = (await ctx.http().post(`${sg.base}/contacts`).set(owner.auth).send({ name: 'Synthetic Merlion Retail Pte Ltd', isCustomer: true }).expect(201)).body.id;
  ids.vendor = (await ctx.http().post(`${sg.base}/contacts`).set(owner.auth).send({ name: 'Synthetic Harbour Supplies Pte Ltd', isVendor: true }).expect(201)).body.id;
});
afterAll(async () => ctx?.app.close());

describe('GST registration', () => {
  it('uses Singapore numbers and treatments', async () => {
    const s = (await ctx.http().get(`${sg.base}/tax/vat/settings`).set(viewer.auth).expect(200)).body;
    expect(s.jurisdiction).toMatchObject({ country: 'SG', currency: 'SGD', taxName: 'GST', returnName: 'GST return (F5)', authority: 'IRAS', netBox: 'box8' });
    expect(s.treatments.map((t: { key: string }) => t.key)).toEqual(['STANDARD', 'ZERO', 'EXEMPT', 'OUTSIDE_SCOPE']);
    expect(s.rates.find((r: { name: string }) => r.name === 'GST 9% (standard)').suggested).toBe('STANDARD');
    expect(s.rates.find((r: { name: string }) => r.name === 'Exempt financial services').suggested).toBe('EXEMPT');

    const body = { vrn: '2019-12345k', registeredFrom: `${M1}-01`, stagger: 'MONTHLY', untaxedTreatment: 'OUTSIDE_SCOPE', treatments: [] };
    const bad = (await ctx.http().put(`${sg.base}/tax/vat/settings`).set(owner.auth).send({ ...body, vrn: 'GB123456782' }).expect(422)).body;
    expect(bad).toMatchObject({ error: 'INVALID_VRN', message: expect.stringContaining('Singapore GST registration number') });
    expect((await ctx.http().put(`${sg.base}/tax/vat/settings`).set(owner.auth).send({ ...body, treatments: [{ taxRateId: rate['GST 9% (standard)'], treatment: 'REDUCED' }] }).expect(422)).body.message).toBe('Reduced rate is not a treatment in Singapore');
    expect((await ctx.http().put(`${sg.base}/tax/vat/settings`).set(owner.auth).send(body).expect(200)).body.settings).toMatchObject({ vrn: '201912345K', stagger: 'MONTHLY' });
  });
});

describe('the F5', () => {
  it('fills boxes 1 to 8 from the documents and box 13 from revenue', async () => {
    await doc('sales', 'INVOICE', `${M1}-05`, [['1000.00', rate['GST 9% (standard)']!], ['500.00', rate['GST 0% (zero-rated)']!]]);
    await doc('sales', 'INVOICE', `${M1}-06`, [['200.00', rate['Exempt financial services']!]]);
    await doc('sales', 'CREDIT_NOTE', `${M1}-07`, [['100.00', rate['GST 9% (standard)']!]]);
    await doc('purchases', 'BILL', `${M1}-08`, [['400.00', rate['GST 9% (standard)']!]]);
    const r = (await gst(E1, viewer.auth).expect(200)).body;
    expect(r.period).toEqual({ start: `${M1}-01`, end: E1, due: E2 });
    expect(r.boxes).toEqual({ box1: '900.00', box2: '500.00', box3: '200.00', box4: '1600.00', box5: '400.00', box6: '81.00', box7: '36.00', box8: '45.00', box13: '1600.00' });
    expect(r.labels.box8).toBe('Net GST to be paid to or claimed from IRAS');
    expect(r).toMatchObject({ net: '45.00', direction: 'PAY', issues: [] });
  });

  it('records the submission against the net GST shown', async () => {
    expect((await ctx.http().post(`${sg.base}/tax/vat/returns`).set(owner.auth).send({ periodEnd: E1, submittedOn: T, net: '44.00' }).expect(409)).body.message).toBe('The return has changed since it was opened: the net GST is now SGD 45.00. Check it again');
    const r = (await ctx.http().post(`${sg.base}/tax/vat/returns`).set(owner.auth).send({ periodEnd: E1, submittedOn: T, reference: 'SYN-IRAS-1', net: '45.00' }).expect(201)).body;
    expect(r.submitted).toMatchObject({ reference: 'SYN-IRAS-1', changedSince: null });
    const p = (await ctx.http().get(`${sg.base}/tax/vat/periods`).set(viewer.auth).expect(200)).body;
    expect(p.periods.find((x: { end: string }) => x.end === E1)).toMatchObject({ status: 'SUBMITTED', net: '45.00', direction: 'PAY', due: E2 });
  });

  it('carries an error of up to S$1,500 to the next return and sends a larger one to IRAS', async () => {
    await doc('sales', 'INVOICE', `${M1}-20`, [['100.00', rate['GST 9% (standard)']!]]);
    const next = (await gst(E2).expect(200)).body;
    expect(next.corrections).toMatchObject({ included: true, pending: [{ periodEnd: E1, output: '9.00', input: '0.00' }], allowance: { limit: '1500.00', allowed: true } });
    expect(next.boxes).toMatchObject({ box6: '9.00', box8: '9.00', box13: '0.00' });
    await ctx.http().post(`${sg.base}/tax/vat/returns`).set(owner.auth).send({ periodEnd: E2, submittedOn: T, net: '9.00' }).expect(201);

    await doc('sales', 'INVOICE', `${M1}-21`, [['20000.00', rate['GST 9% (standard)']!]]);
    const open = (await gst(E3).expect(200)).body;
    expect(open.corrections).toMatchObject({ included: false, pending: [{ periodEnd: E1, output: '1800.00', net: '1800.00' }], allowance: { allowed: false } });
    expect(open.boxes.box6).toBe('0.00');
    expect(open.warnings).toContain('The corrections of earlier returns come to SGD 1800.00, over the SGD 1500.00 that may go on this return: correct the earlier returns with IRAS instead (GST F7)');
  });

  it('exports the F5 as CSV', async () => {
    const x = (await ctx.http().get(`${sg.base}/tax/vat/return/export?periodEnd=${E1}`).set(viewer.auth).expect(200)).body;
    expect(x.fileName).toBe(`gst-return-${M1}-01-to-${E1}.csv`);
    expect(x.csv.split('\n')[0]).toBe(`GST return (F5),${M1}-01 to ${E1}`);
    expect(x.csv).toContain('8,Net GST to be paid to or claimed from IRAS,45.00');
    expect(x.csv).toContain('13,Revenue for the accounting period,1600.00');
  });
});
