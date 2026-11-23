import { fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * German VAT advance return, Umsatzsteuer-Voranmeldung (TAX-031, EU VAT starting with Germany),
 * against the real API and database: the USt-IdNr. check, Germany's treatments and return cycles,
 * Kennzahlen 81, 86, 43, 48, 66 and 83 from invoices, a credit note and a bill, recording the
 * submission, and a back-dated change sent to a corrected return for its own period.
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
let de: Awaited<ReturnType<typeof createOrg>>;
const rate: Record<string, string> = {};
const ids: Record<string, string> = {};

const doc = (side: 'sales' | 'purchases', kind: string, date: string, lines: [string, string][]) =>
  ctx
    .http()
    .post(`${de.base}/${side}/documents`)
    .set(owner.auth)
    .send({ kind, contactId: side === 'sales' ? ids.customer : ids.vendor, issueDate: date, dueDate: date, post: true, lines: lines.map(([unitPrice, taxRateId]) => ({ accountId: side === 'sales' ? de.acc['4100'] : de.acc['6600'], description: 'Synthetic item', quantity: '1', unitPrice, taxRateId })) })
    .expect(201);
const ret = (end: string, auth = owner.auth) => ctx.http().get(`${de.base}/tax/vat/return?periodEnd=${end}`).set(auth);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'USt Owner');
  viewer = await registerUser(ctx, 'USt Viewer');
  de = await createOrg(ctx, owner, { name: 'Synthetic Rhein Handel GmbH', countryCode: 'DE', functionalCurrency: 'EUR', fiscalYearStartMonth: 1 });
  await ctx.http().post(`${de.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  for (const fy of new Set([`${M1}-01`, T].map((d) => fiscalYearForDate(d, 1)))) await ctx.http().post(`${de.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fy });
  await ctx.http().post(`${de.base}/country-module/starter-rates`).set(owner.auth).send({}).expect(201);
  await ctx.http().post(`${de.base}/tax-rates`).set(owner.auth).send({ name: 'Exempt rent (§ 4 Nr. 12)', rate: '0' }).expect(201);
  for (const r of (await ctx.http().get(`${de.base}/tax-rates`).set(owner.auth).expect(200)).body as { id: string; name: string }[]) rate[r.name] = r.id;
  ids.customer = (await ctx.http().post(`${de.base}/contacts`).set(owner.auth).send({ name: 'Synthetic Elbe Retail GmbH', isCustomer: true }).expect(201)).body.id;
  ids.vendor = (await ctx.http().post(`${de.base}/contacts`).set(owner.auth).send({ name: 'Synthetic Main Supplies GmbH', isVendor: true }).expect(201)).body.id;
});
afterAll(async () => ctx?.app.close());

describe('German VAT registration', () => {
  it('uses the USt-IdNr., German treatments and the monthly or quarterly cycle', async () => {
    const s = (await ctx.http().get(`${de.base}/tax/vat/settings`).set(viewer.auth).expect(200)).body;
    expect(s.jurisdiction).toMatchObject({ country: 'DE', currency: 'EUR', returnName: 'VAT advance return (UStVA)', authority: 'Finanzamt', netBox: '83', boxOrder: ['81', '81-vat', '86', '86-vat', '43', '48', '66', '83'] });
    expect(s.staggers.map((t: { key: string }) => t.key)).toEqual(['MONTHLY', 'QUARTERLY_MAR']);
    expect(s.treatments.map((t: { key: string }) => t.key)).toEqual(['STANDARD', 'REDUCED', 'ZERO', 'EXEMPT', 'OUTSIDE_SCOPE']);
    expect(s.rates.find((r: { name: string }) => r.name === 'USt 7% (reduced)').suggested).toBe('REDUCED');
    expect(s.rates.find((r: { name: string }) => r.name === 'Exempt rent (§ 4 Nr. 12)').suggested).toBe('EXEMPT');

    const body = { vrn: 'DE 136 695 976', registeredFrom: `${M1}-01`, stagger: 'MONTHLY', untaxedTreatment: 'OUTSIDE_SCOPE', treatments: [] };
    const put = (b: object) => ctx.http().put(`${de.base}/tax/vat/settings`).set(owner.auth).send({ ...body, ...b });
    expect((await put({ vrn: 'DE136695977' }).expect(422)).body).toMatchObject({ error: 'INVALID_VRN', message: expect.stringContaining('German VAT identification number') });
    expect((await put({ stagger: 'QUARTERLY_APR' }).expect(422)).body.message).toBe('Quarterly, ending April, July, October and January returns are not a return cycle the Finanzamt uses');
    expect((await put({}).expect(200)).body.settings).toMatchObject({ vrn: 'DE136695976', stagger: 'MONTHLY', region: null });
  });
});

describe('the advance return', () => {
  it('fills the Kennzahlen, with the tax worked out from whole-euro bases', async () => {
    await doc('sales', 'INVOICE', `${M1}-05`, [['1000.80', rate['USt 19% (standard)']!], ['500.00', rate['USt 7% (reduced)']!]]);
    await doc('sales', 'INVOICE', `${M1}-06`, [['300.50', rate['USt 0%']!], ['200.00', rate['Exempt rent (§ 4 Nr. 12)']!]]);
    await doc('sales', 'CREDIT_NOTE', `${M1}-07`, [['100.00', rate['USt 19% (standard)']!]]);
    await doc('purchases', 'BILL', `${M1}-08`, [['400.00', rate['USt 19% (standard)']!]]);
    const r = (await ret(E1, viewer.auth).expect(200)).body;
    expect(r.period).toEqual({ start: `${M1}-01`, end: E1, due: `${M2}-10` });
    expect(r.boxes).toEqual({ '81': '900', '81-vat': '171.00', '86': '500', '86-vat': '35.00', '43': '300', '48': '200', '66': '76.00', '83': '130.00', output: '206.00' });
    expect(r.labels['83']).toBe('Advance payment due or surplus (Vorauszahlung / Überschuss)');
    expect(r).toMatchObject({ net: '130.00', direction: 'PAY', issues: [], warnings: [] });
  });

  it('records the submission against the advance payment shown', async () => {
    expect((await ctx.http().post(`${de.base}/tax/vat/returns`).set(owner.auth).send({ periodEnd: E1, submittedOn: T, net: '129.00' }).expect(409)).body.message).toBe('The return has changed since it was opened: the net VAT is now EUR 130.00. Check it again');
    const r = (await ctx.http().post(`${de.base}/tax/vat/returns`).set(owner.auth).send({ periodEnd: E1, submittedOn: T, reference: 'SYN-ELSTER-1', net: '130.00' }).expect(201)).body;
    expect(r.submitted).toMatchObject({ reference: 'SYN-ELSTER-1', changedSince: null });
    const p = (await ctx.http().get(`${de.base}/tax/vat/periods`).set(viewer.auth).expect(200)).body;
    expect(p.periods.find((x: { end: string }) => x.end === E1)).toMatchObject({ status: 'SUBMITTED', net: '130.00', direction: 'PAY', due: `${M2}-10` });
  });

  it('sends a back-dated change to a corrected return for its own period', async () => {
    await doc('purchases', 'BILL', `${M1}-20`, [['100.00', rate['USt 19% (standard)']!]]);
    const next = (await ret(E2).expect(200)).body;
    expect(next.corrections).toMatchObject({ included: false, pending: [{ periodEnd: E1, output: '0.00', input: '19.00' }], allowance: { allowed: false } });
    expect(next.boxes['66']).toBe('0.00');
    expect(next.warnings).toContain('The changes to earlier returns cannot go on this return (a change to an advance return already filed goes on a corrected return for that period (berichtigte Voranmeldung), not on a later one): file corrected advance returns for those periods with the Finanzamt');
    const filed = (await ret(E1).expect(200)).body;
    expect(filed.submitted.changedSince).toMatchObject({ output: '0.00', input: '19.00' });
  });

  it('exports the Kennzahlen as CSV', async () => {
    const x = (await ctx.http().get(`${de.base}/tax/vat/return/export?periodEnd=${E1}`).set(viewer.auth).expect(200)).body;
    expect(x.fileName).toBe(`vat-return-${M1}-01-to-${E1}.csv`);
    expect(x.csv.split('\n')[0]).toBe(`VAT advance return (UStVA),${M1}-01 to ${E1}`);
    expect(x.csv).toContain('81,Taxable supplies at 19% (Umsätze zu 19 %): base,900');
    expect(x.csv).toContain('83,Advance payment due or surplus (Vorauszahlung / Überschuss),130.00');
    expect(x.csv).not.toContain('output,');
  });
});
