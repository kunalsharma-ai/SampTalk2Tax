import { addDays, addMonthsAnchored, fiscalYearForDate, forecastMonths } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RevenueForecastService } from '../src/crm/revenue-forecast.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * DASH-032 against the real API and database: the revenue forecast carries an 80% range around
 * the expected figure for each month. With no past forecasts to judge by, the range runs from what
 * is committed to the best case. Once forecasts saved in earlier months can be compared with what
 * was invoiced, the range comes from how far off those forecasts were, by months ahead.
 */
const T = today();
const M = forecastMonths(T, 6);
const first = (m: string) => `${m}-01`;
const before = (k: number) => forecastMonths(addMonthsAnchored(first(M[0]!), -k), 1)[0]!;
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let customer: string;
type Band = { month: string; expected: string; low: string; high: string; errorPct: string | null; basis: number };

const post = async (path: string, body: unknown, status = 201) => {
  const r = await ctx.http().post(`${org.base}${path}`).set(owner.auth).send(body as object);
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const invoice = (issueDate: string, amount: string) => post('/sales/documents', { kind: 'INVOICE', contactId: customer, issueDate, dueDate: addDays(issueDate, 30), post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: amount }] });
const forecast = async () => (await ctx.http().get(`${org.base}/sales/revenue-forecast?months=6`).set(viewer.auth).expect(200)).body;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Bands Owner');
  viewer = await registerUser(ctx, 'Bands Viewer');
  org = await createOrg(ctx, owner, { name: 'Band Width Traders Pvt Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  for (const k of [8, 0]) await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fiscalYearForDate(addMonthsAnchored(first(M[0]!), -k), 4) });
  customer = (await post('/contacts', { name: 'Steady Buyer', isCustomer: true })).id;
  // A deal at negotiation (75%) closing next month gives a best case above the expected figure.
  await post('/crm/deals', { name: 'Shelving', contactId: customer, amount: '40000.00', stage: 'NEGOTIATION', expectedCloseDate: first(M[1]!) });
});
afterAll(async () => {
  await ctx.app.close();
});

describe('forecast confidence bands', () => {
  it('with no past forecasts, runs from committed to the best case', async () => {
    const r = await forecast();
    expect(r.confidence).toMatchObject({ method: 'SCENARIOS', level: 80, samples: 0 });
    expect(r.confidence.bands).toHaveLength(6);
    r.confidence.bands.forEach((b: Band, i: number) => expect(b).toEqual({ month: M[i], expected: r.months[i].expected, low: r.months[i].committed, high: r.months[i].best, errorPct: null, basis: 0 }));
    expect(r.confidence.bands[1]).toMatchObject({ low: '0.00', high: '40000.00' });
  });

  it('once saved forecasts can be judged, widens by how far off they were', async () => {
    // Sales of 10,000, 10,000, 10,000, then 13,000 and 7,000: forecasts saved along the way miss by varying amounts.
    for (const [k, amount] of [[7, '10000.00'], [6, '10000.00'], [5, '10000.00'], [4, '13000.00'], [3, '7000.00'], [2, '10000.00'], [1, '12000.00']] as const) await invoice(addDays(first(before(k)), 4), amount);
    const svc = ctx.app.get(RevenueForecastService);
    const o = { id: org.orgId, role: 'OWNER' as const, functionalCurrency: 'INR' };
    // One forecast saved at the start of each of the last four months; a second save in the same month does not count twice.
    for (const k of [4, 3, 2, 1]) await svc.save(o, { id: owner.id }, { months: 3 }, first(before(k)));
    await svc.save(o, { id: owner.id }, { months: 3, note: 'again' }, addDays(first(before(1)), 1));

    const r = await forecast();
    expect(r.confidence.method).toBe('HISTORY');
    expect(r.confidence.level).toBe(80);
    // Four kept forecasts of three months each: 3 + 3 + 2 + 1 months are over (this month is not).
    expect(r.confidence.samples).toBe(9);
    const b: Band[] = r.confidence.bands;
    expect(b.map((x) => x.month)).toEqual(M);
    for (const [i, x] of b.entries()) {
      expect(Number(x.low)).toBeLessThanOrEqual(Number(r.months[i].expected));
      expect(Number(x.high)).toBeGreaterThanOrEqual(Number(r.months[i].expected));
      expect(x.errorPct).not.toBeNull();
    }
    // Four errors made for their own month set the first band, three made a month ahead the second;
    // only two were made two months ahead, so later bands use all nine.
    expect(b.map((x) => x.basis)).toEqual([4, 3, 9, 9, 9, 9]);
    // Expected sales run at 9,666.67 a month (plus 30,000 of the deal next month). Same-month
    // forecasts missed by up to 36.4% at the 80th percentile, the rest by up to 30%.
    expect(b.map((x) => [x.low, x.high, x.errorPct])).toEqual([
      ['6151.87', '13181.47', '36.4'],
      ['27766.67', '51566.67', '30'],
      ...Array(4).fill(['6766.67', '12566.67', '30']),
    ]);
  });

  it('is part of what anyone with reports access sees, and only for their organisation', async () => {
    const outsider = await registerUser(ctx, 'Bands Outsider');
    const other = await createOrg(ctx, outsider, { name: 'Other Bands Ltd' });
    // This month's range covers the whole month, including what is already invoiced.
    await ctx.http().post(`${other.base}/periods/fiscal-years`).set(outsider.auth).send({ fiscalYear: fiscalYearForDate(T, 4) });
    const buyer = (await ctx.http().post(`${other.base}/contacts`).set(outsider.auth).send({ name: 'Early Buyer', isCustomer: true }).expect(201)).body.id;
    await ctx.http().post(`${other.base}/sales/documents`).set(outsider.auth).send({ kind: 'INVOICE', contactId: buyer, issueDate: T, dueDate: addDays(T, 30), post: true, lines: [{ accountId: other.acc['4100'], quantity: '1', unitPrice: '5000.00' }] }).expect(201);
    const r = (await ctx.http().get(`${other.base}/sales/revenue-forecast?months=6`).set(outsider.auth).expect(200)).body;
    expect(r.actualSoFar).toBe('5000.00');
    expect(r.confidence).toMatchObject({ method: 'SCENARIOS', samples: 0 });
    expect(r.confidence.bands[0]).toMatchObject({ expected: '5000.00', low: '5000.00', high: '5000.00' });
    await ctx.http().get(`${org.base}/sales/revenue-forecast?months=6`).set(outsider.auth).expect(404);
  });
});
