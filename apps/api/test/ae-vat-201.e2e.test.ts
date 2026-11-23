import { fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * UAE VAT return, VAT 201 (TAX-033), against the real API and database: the TRN, the emirate the
 * business is established in, the UAE's treatments, the boxes from invoices, a credit note and a
 * bill, recording the submission, a back-dated error carried to the next return and one over
 * AED 10,000 sent to a voluntary disclosure.
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
const plus28 = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + 28 * 86_400_000).toISOString().slice(0, 10); // not money: dates

let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let ae: Awaited<ReturnType<typeof createOrg>>;
const rate: Record<string, string> = {};
const ids: Record<string, string> = {};

const doc = (side: 'sales' | 'purchases', kind: string, date: string, lines: [string, string][]) =>
  ctx
    .http()
    .post(`${ae.base}/${side}/documents`)
    .set(owner.auth)
    .send({ kind, contactId: side === 'sales' ? ids.customer : ids.vendor, issueDate: date, dueDate: date, post: true, lines: lines.map(([unitPrice, taxRateId]) => ({ accountId: side === 'sales' ? ae.acc['4100'] : ae.acc['6600'], description: 'Synthetic item', quantity: '1', unitPrice, taxRateId })) })
    .expect(201);
const ret = (end: string, auth = owner.auth) => ctx.http().get(`${ae.base}/tax/vat/return?periodEnd=${end}`).set(auth);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'UAE VAT Owner');
  viewer = await registerUser(ctx, 'UAE VAT Viewer');
  ae = await createOrg(ctx, owner, { name: 'Synthetic Creek Trading LLC', countryCode: 'AE', functionalCurrency: 'AED', fiscalYearStartMonth: 1 });
  await ctx.http().post(`${ae.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  for (const fy of new Set([`${M1}-01`, T].map((d) => fiscalYearForDate(d, 1)))) await ctx.http().post(`${ae.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fy });
  await ctx.http().post(`${ae.base}/country-module/starter-rates`).set(owner.auth).send({}).expect(201);
  await ctx.http().post(`${ae.base}/tax-rates`).set(owner.auth).send({ name: 'Exempt residential rent', rate: '0' }).expect(201);
  for (const r of (await ctx.http().get(`${ae.base}/tax-rates`).set(owner.auth).expect(200)).body as { id: string; name: string }[]) rate[r.name] = r.id;
  ids.customer = (await ctx.http().post(`${ae.base}/contacts`).set(owner.auth).send({ name: 'Synthetic Marina Retail LLC', isCustomer: true }).expect(201)).body.id;
  ids.vendor = (await ctx.http().post(`${ae.base}/contacts`).set(owner.auth).send({ name: 'Synthetic Desert Supplies LLC', isVendor: true }).expect(201)).body.id;
});
afterAll(async () => ctx?.app.close());

describe('UAE VAT registration', () => {
  it('uses the TRN, the emirate and the UAE treatments', async () => {
    const s = (await ctx.http().get(`${ae.base}/tax/vat/settings`).set(viewer.auth).expect(200)).body;
    expect(s.jurisdiction).toMatchObject({ country: 'AE', currency: 'AED', taxName: 'VAT', returnName: 'VAT return (VAT 201)', authority: 'FTA', netBox: '14', region: { name: 'Emirate' } });
    expect(s.treatments.map((t: { key: string }) => t.key)).toEqual(['STANDARD', 'ZERO', 'EXEMPT', 'OUTSIDE_SCOPE']);
    expect(s.rates.find((r: { name: string }) => r.name === 'VAT 5%').suggested).toBe('STANDARD');
    expect(s.rates.find((r: { name: string }) => r.name === 'Exempt residential rent').suggested).toBe('EXEMPT');

    const body = { vrn: '100 1234 5678 9003', registeredFrom: `${M1}-01`, stagger: 'MONTHLY', region: 'DU', untaxedTreatment: 'OUTSIDE_SCOPE', treatments: [] };
    const put = (b: object) => ctx.http().put(`${ae.base}/tax/vat/settings`).set(owner.auth).send({ ...body, ...b });
    expect((await put({ vrn: '200123456789003' }).expect(422)).body).toMatchObject({ error: 'INVALID_VRN', message: expect.stringContaining('UAE tax registration number') });
    expect((await put({ region: null }).expect(422)).body.message).toBe('Choose the emirate your business is established in');
    expect((await put({ region: 'XX' }).expect(422)).body.message).toBe('Choose the emirate your business is established in');
    expect((await put({ treatments: [{ taxRateId: rate['VAT 5%'], treatment: 'REDUCED' }] }).expect(422)).body.message).toBe('Reduced rate is not a treatment in the United Arab Emirates');
    expect((await put({}).expect(200)).body.settings).toMatchObject({ vrn: '100123456789003', stagger: 'MONTHLY', region: 'DU' });
  });
});

describe('the VAT 201', () => {
  it('fills the boxes, with supplies in the business emirate', async () => {
    await doc('sales', 'INVOICE', `${M1}-05`, [['10000.00', rate['VAT 5%']!], ['3000.00', rate['VAT 0% (zero-rated)']!]]);
    await doc('sales', 'INVOICE', `${M1}-06`, [['2000.00', rate['Exempt residential rent']!]]);
    await doc('sales', 'CREDIT_NOTE', `${M1}-07`, [['1000.00', rate['VAT 5%']!]]);
    await doc('purchases', 'BILL', `${M1}-08`, [['4000.00', rate['VAT 5%']!]]);
    const r = (await ret(E1, viewer.auth).expect(200)).body;
    expect(r.period).toEqual({ start: `${M1}-01`, end: E1, due: plus28(E1) });
    expect(r.boxes).toMatchObject({ '1a': '0.00', '1b': '9000.00', '1b-vat': '450.00', '4': '3000.00', '5': '2000.00', '8': '14000.00', '8-vat': '450.00', '9': '4000.00', '9-vat': '200.00', '12': '450.00', '13': '200.00', '14': '250.00' });
    expect(r.labels['1b']).toBe('Standard rated supplies in Dubai: amount');
    expect(r).toMatchObject({ net: '250.00', direction: 'PAY', issues: [] });
  });

  it('records the submission against the payable tax shown', async () => {
    expect((await ctx.http().post(`${ae.base}/tax/vat/returns`).set(owner.auth).send({ periodEnd: E1, submittedOn: T, net: '249.00' }).expect(409)).body.message).toBe('The return has changed since it was opened: the net VAT is now AED 250.00. Check it again');
    const r = (await ctx.http().post(`${ae.base}/tax/vat/returns`).set(owner.auth).send({ periodEnd: E1, submittedOn: T, reference: 'SYN-FTA-1', net: '250.00' }).expect(201)).body;
    expect(r.submitted).toMatchObject({ reference: 'SYN-FTA-1', changedSince: null });
    const p = (await ctx.http().get(`${ae.base}/tax/vat/periods`).set(viewer.auth).expect(200)).body;
    expect(p.periods.find((x: { end: string }) => x.end === E1)).toMatchObject({ status: 'SUBMITTED', net: '250.00', direction: 'PAY' });
  });

  it('carries an error of up to AED 10,000 to the next return and sends a larger one to a voluntary disclosure', async () => {
    await doc('sales', 'INVOICE', `${M1}-20`, [['1000.00', rate['VAT 5%']!]]);
    const next = (await ret(E2).expect(200)).body;
    expect(next.corrections).toMatchObject({ included: true, pending: [{ periodEnd: E1, output: '50.00', input: '0.00' }], allowance: { limit: '10000.00', allowed: true } });
    expect(next.boxes).toMatchObject({ '1b': '0.00', '8-vat': '50.00', '12': '50.00', '14': '50.00' });
    await ctx.http().post(`${ae.base}/tax/vat/returns`).set(owner.auth).send({ periodEnd: E2, submittedOn: T, net: '50.00' }).expect(201);

    await doc('sales', 'INVOICE', `${M1}-21`, [['250000.00', rate['VAT 5%']!]]);
    const open = (await ret(E3).expect(200)).body;
    expect(open.corrections).toMatchObject({ included: false, pending: [{ periodEnd: E1, output: '12500.00', net: '12500.00' }], allowance: { allowed: false } });
    expect(open.boxes['12']).toBe('0.00');
    expect(open.warnings).toContain('The corrections of earlier returns come to AED 12500.00, over the AED 10000.00 that may go on this return: submit a voluntary disclosure to the FTA instead (Form 211)');
  });

  it('exports the VAT 201 as CSV', async () => {
    const x = (await ctx.http().get(`${ae.base}/tax/vat/return/export?periodEnd=${E1}`).set(viewer.auth).expect(200)).body;
    expect(x.fileName).toBe(`vat-return-${M1}-01-to-${E1}.csv`);
    expect(x.csv.split('\n')[0]).toBe(`VAT return (VAT 201),${M1}-01 to ${E1}`);
    expect(x.csv).toContain('1b,Standard rated supplies in Dubai: amount,9000.00');
    expect(x.csv).toContain('14,Payable tax for the period (12 less 13),250.00');
  });
});
