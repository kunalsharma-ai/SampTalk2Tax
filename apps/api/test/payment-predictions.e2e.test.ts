import { addDays, fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Predictive payment-delay scoring (AR-033) against the real API and database: open invoices are
 * scored from the receipts applied to earlier invoices (a punctual customer, a slow one, a new
 * one with no history), a past-due invoice is late for certain and raises the chance on the same
 * customer's other invoices, the summary totals in decimals, the method is checked against paid
 * invoices, and the endpoint keeps to the reports permission and the organisation.
 */
const T = today();
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const c: Record<string, string> = {};
const inv: Record<string, string> = {};

const invoice = async (who: string, issueDate: string, amount: string, dueIn = 30) => {
  const r = await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: c[who], issueDate, dueDate: addDays(issueDate, dueIn), post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: amount }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; total: string; number: string };
};
const receipt = (who: string, date: string, documentId: string, amount: string) =>
  ctx.http().post(`${org.base}/sales/payments`).set(owner.auth).send({ contactId: c[who], date, bankAccountId: org.acc['1120'], amount, allocations: [{ documentId, amount }] }).expect(201);
type Row = { invoiceId: string; number: string; customer: string; dueDate: string; outstanding: string; expectedDaysLate: number; predictedPayDate: string; lateChance: number; band: string; confidence: string; basedOn: number; daysPastDue: number; reasons: string[] };
type Res = { asOf: string; currency: string; summary: { invoices: number; outstanding: string; byBand: Record<string, { invoices: number; outstanding: string }>; expectedIn30Days: string; atRisk: string; unscored: number; paidHistory: number }; accuracy: { tested: number; meanErrorDays: number | null; withinWeekShare: number | null; rightBandShare: number | null }; invoices: Row[] };
const get = (q = '', user = owner) => ctx.http().get(`${org.base}/payment-predictions${q}`).set(user.auth);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Predict Owner');
  viewer = await registerUser(ctx, 'Predict Viewer');
  outsider = await registerUser(ctx, 'Predict Outsider');
  org = await createOrg(ctx, owner, { name: 'Predict Traders Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Predict Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  const fy = fiscalYearForDate(T, 4);
  await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fy - 1 });
  for (const name of ['Asha Traders', 'Banyan Retail', 'Cedar Foods']) c[name] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name, isCustomer: true }).expect(201)).body.id;

  // Asha pays on the due date, six times; Banyan forty days after it, three times.
  for (let k = 0; k < 6; k++) {
    const issued = addDays(T, -60 - k * 30);
    const i = await invoice('Asha Traders', issued, '10000.00');
    await receipt('Asha Traders', addDays(issued, 30), i.id, '10000.00');
  }
  for (let k = 0; k < 3; k++) {
    const issued = addDays(T, -110 - k * 40);
    const i = await invoice('Banyan Retail', issued, '20000.00');
    await receipt('Banyan Retail', addDays(issued, 70), i.id, '20000.00');
  }
  // Open: one each for Asha and Cedar, and two for Banyan, one of them 35 days past due and partly paid.
  inv.asha = (await invoice('Asha Traders', T, '12000.00', 20)).id;
  inv.cedar = (await invoice('Cedar Foods', T, '7000.00', 15)).id;
  inv.banyanOld = (await invoice('Banyan Retail', addDays(T, -65), '30000.00')).id;
  await receipt('Banyan Retail', addDays(T, -10), inv.banyanOld, '10000.00');
  inv.banyanNew = (await invoice('Banyan Retail', T, '15000.50', 10)).id;
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('payment-delay predictions', () => {
  it('scores every open invoice from how the customer has paid, riskiest first', async () => {
    const r = (await get('', viewer).expect(200)).body as Res;
    expect(r).toMatchObject({ asOf: T, currency: 'INR' });
    const by = Object.fromEntries(r.invoices.map((i) => [i.invoiceId, i]));
    expect(r.invoices.map((i) => i.invoiceId)).toEqual([inv.banyanOld, inv.banyanNew, inv.cedar, inv.asha]);

    expect(by[inv.banyanOld]).toMatchObject({ customer: 'Banyan Retail', outstanding: '20000.00', daysPastDue: 35, expectedDaysLate: 42, predictedPayDate: addDays(T, 7), lateChance: 100, band: 'VERY_LATE', confidence: 'MEDIUM', basedOn: 3 });
    expect(by[inv.banyanOld]!.reasons).toEqual(['Paid 3 invoices 40 days late on average', expect.stringMatching(/^Little history, so the organisation's average/), 'Already 35 days past due']);

    expect(by[inv.banyanNew]).toMatchObject({ outstanding: '15000.50', daysPastDue: 0, band: 'LATE', confidence: 'MEDIUM' });
    expect(by[inv.banyanNew]!.lateChance).toBeGreaterThanOrEqual(80);
    expect(by[inv.banyanNew]!.reasons).toContain('Another invoice to this customer is 35 days overdue');
    expect(by[inv.banyanNew]!.predictedPayDate).toBe(addDays(addDays(T, 10), by[inv.banyanNew]!.expectedDaysLate));

    expect(by[inv.cedar]).toMatchObject({ customer: 'Cedar Foods', confidence: 'ORG_AVERAGE', basedOn: 0 });
    expect(by[inv.cedar]!.reasons[0]).toMatch(/^No paid invoices from this customer yet: uses the organisation's average of \d+ days late$/);

    expect(by[inv.asha]).toMatchObject({ customer: 'Asha Traders', band: 'ON_TIME', confidence: 'HIGH', basedOn: 6 });
    expect(by[inv.asha]!.lateChance).toBeLessThan(by[inv.cedar]!.lateChance);
    expect(by[inv.asha]!.reasons[0]).toBe('Paid 6 invoices on time on average');
  });

  it('totals the open balance by band in decimals and checks the method against paid invoices', async () => {
    const r = (await get().expect(200)).body as Res;
    expect(r.summary).toMatchObject({ invoices: 4, outstanding: '54000.50', unscored: 0, paidHistory: 9 });
    const bands = r.summary.byBand;
    expect(bands.VERY_LATE).toEqual({ invoices: 1, outstanding: '20000.00' });
    expect(bands.ON_TIME!.outstanding).toMatch(/^\d+\.\d{2}$/);
    expect(Object.values(bands).reduce((s, b) => s + b.invoices, 0)).toBe(4);
    expect(r.summary.atRisk).toMatch(/^\d+\.\d{2}$/);
    expect(r.accuracy.tested).toBeGreaterThan(0);
    expect(r.accuracy.meanErrorDays).not.toBeNull();
  });

  it('filters to one customer, checks the query, and keeps to the permission and the organisation', async () => {
    const r = (await get(`?contactId=${c['Banyan Retail']}`).expect(200)).body as Res;
    expect(r.invoices.map((i) => i.invoiceId)).toEqual([inv.banyanOld, inv.banyanNew]);
    expect(r.summary.outstanding).toBe('35000.50');
    await get('?contactId=nope').expect(400);
    await get('?other=1').expect(400);
    await ctx.http().get(`${org.base}/payment-predictions`).set(outsider.auth).expect(404);
    const theirs = (await ctx.http().get(`${other.base}/payment-predictions`).set(outsider.auth).expect(200)).body as Res;
    expect(theirs).toMatchObject({ invoices: [], summary: { invoices: 0, outstanding: '0.00', paidHistory: 0 }, accuracy: { tested: 0 } });
  });
});
