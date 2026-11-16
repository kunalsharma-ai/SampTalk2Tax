import { addDays, addMonthsAnchored, fiscalYearForDate, forecastMonths } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RevenueForecastService } from '../src/crm/revenue-forecast.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * CRM slice 5 against the real API and database: the revenue forecast from an active contract,
 * what is left on an open order, a weighted deal and the run rate of other sales; saving it
 * (RF-0001, never changed) and comparing it with what was invoiced once months are over;
 * permissions and tenant isolation.
 */
const T = today();
const M = forecastMonths(T, 12);
const first = (m: string) => `${m}-01`;
const lastOf = (m: string) => addDays(addMonthsAnchored(first(m), 1), -1);
const before = (k: number) => forecastMonths(addMonthsAnchored(first(M[0]!), -k), 1)[0]!;
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const c: Record<string, string> = {};
let savedId: string;

const post = async (path: string, body: unknown, status = 201) => {
  const r = await ctx.http().post(`${org.base}${path}`).set(owner.auth).send(body as object);
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const invoice = (who: string, issueDate: string, amount: string) => post('/sales/documents', { kind: 'INVOICE', contactId: c[who], issueDate, dueDate: addDays(issueDate, 30), post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: amount }] });

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Forecast Owner');
  viewer = await registerUser(ctx, 'Forecast Viewer');
  outsider = await registerUser(ctx, 'Forecast Outsider');
  org = await createOrg(ctx, owner, { name: 'Forecast Traders Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Forecasts Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fiscalYearForDate(T, 4) - 1 });
  for (const name of ['Asha Traders', 'Banyan Retail', 'Cedar Foods']) c[name] = (await post('/contacts', { name, isCustomer: true })).id;

  // A monthly contract for three months from next month.
  const ct = await post('/sales/contracts', { contactId: c['Asha Traders'], title: 'Cold-room upkeep', frequency: 'MONTHLY', timing: 'ADVANCE', startDate: first(M[1]!), endDate: lastOf(M[3]!), autoRenew: false, noticeDays: 30, lines: [{ accountId: org.acc['4100'], description: 'Upkeep', quantity: '1', unitPrice: '10000.00' }] });
  await post(`/sales/contracts/${ct.id}/activate`, {}, 200);
  // An order of 4 × 5,000 with one billed (a draft invoice).
  const o = await post('/sales/orders', { contactId: c['Banyan Retail'], orderDate: T, reference: 'PO-9', lines: [{ accountId: org.acc['4100'], quantity: '4', unitPrice: '5000.00' }] });
  await post(`/sales/orders/${o.id}/invoices`, { issueDate: T, lines: [{ orderLineId: o.lines[0].id, quantity: '1' }] });
  // A deal at negotiation (75%) closing in two months.
  await post('/crm/deals', { name: 'Racking', contactId: c['Cedar Foods'], amount: '100000.00', stage: 'NEGOTIATION', expectedCloseDate: first(M[2]!) });
  // Other sales: 30,000 and 60,000 in the last three complete months (a 30,000 run rate), and 8,000 this month.
  await invoice('Cedar Foods', first(before(3)), '30000.00');
  await invoice('Cedar Foods', first(before(1)), '60000.00');
  await invoice('Cedar Foods', first(M[0]!), '8000.00');
});
afterAll(async () => {
  await ctx.app.close();
});

describe('the revenue forecast', () => {
  it('adds contracts, orders, weighted deals and other sales by month', async () => {
    const r = (await ctx.http().get(`${org.base}/sales/revenue-forecast?months=12`).set(viewer.auth).expect(200)).body;
    expect(r).toMatchObject({ horizon: 12, currency: 'INR', otherRunRate: '30000.00', actualSoFar: '8000.00', can: { save: false } });
    expect(r.months).toHaveLength(12);
    expect(r.months[0]).toEqual({ month: M[0], contracts: '0.00', orders: '15000.00', pipelineWeighted: '0.00', pipelineFull: '0.00', otherSales: '22000.00', committed: '15000.00', expected: '37000.00', best: '37000.00' });
    expect(r.months[1]).toMatchObject({ contracts: '10000.00', expected: '40000.00' });
    expect(r.months[2]).toMatchObject({ contracts: '10000.00', pipelineWeighted: '75000.00', pipelineFull: '100000.00', expected: '115000.00', best: '140000.00' });
    expect(r.months[3]).toMatchObject({ contracts: '10000.00', expected: '40000.00' });
    expect(r.months[4]).toMatchObject({ contracts: '0.00', expected: '30000.00' });
    expect(r.totals).toMatchObject({ contracts: '30000.00', orders: '15000.00', committed: '45000.00', expected: '472000.00', best: '497000.00' });
    expect(r.items.map((i: { reference: string; stream: string }) => `${i.stream} ${i.reference}`)).toEqual(['ORDER SO-0001', 'CONTRACT CT-0001', 'CONTRACT CT-0001', 'DEAL DL-0001', 'CONTRACT CT-0001']);
    expect((await ctx.http().get(`${org.base}/sales/revenue-forecast?months=30`).set(owner.auth).expect(400)).body.error).toBeDefined();
    expect((await ctx.http().get(`${org.base}/sales/revenue-forecast?months=3`).set(owner.auth).expect(200)).body.totals.expected).toBe('192000.00');
  });

  it('is saved as it stands, never changed, and compared with what was invoiced', async () => {
    await ctx.http().post(`${org.base}/sales/revenue-forecast/saved`).set(viewer.auth).send({ months: 12 }).expect(403);
    const s = await post('/sales/revenue-forecast/saved', { months: 12, note: 'Board pack, November' });
    savedId = s.id;
    expect(s).toMatchObject({ reference: 'RF-0001', asOf: T, horizon: 12, note: 'Board pack, November', createdBy: 'Forecast Owner', actualSoFar: '8000.00', totals: { committed: '45000.00', expected: '472000.00', best: '497000.00' }, accuracy: { months: [], wape: null } });
    expect(s.months[2].expected).toBe('115000.00');
    expect(s.totals).toMatchObject({ contracts: '30000.00', orders: '15000.00', pipelineWeighted: '75000.00', otherSales: '352000.00' });
    const list = (await ctx.http().get(`${org.base}/sales/revenue-forecast/saved`).set(viewer.auth).expect(200)).body;
    expect(list.forecasts).toEqual([expect.objectContaining({ reference: 'RF-0001', expected: '472000.00', monthsOver: 0, wape: null })]);

    // Two months on: the first two months are over. This month brought only the 8,000 so far.
    const later = first(M[2]!);
    const g = await ctx.app.get(RevenueForecastService).get({ id: org.orgId, role: 'OWNER', functionalCurrency: 'INR' }, savedId, later);
    expect(g.accuracy.months).toEqual([
      { month: M[0], forecast: '45000.00', committed: '23000.00', actual: '8000.00', variance: '-37000.00', variancePct: '-0.8222' },
      { month: M[1], forecast: '40000.00', committed: '10000.00', actual: '0.00', variance: '-40000.00', variancePct: '-1' },
    ]);
    expect(g.accuracy.wape).toBe('9.625');

    await expect(
      ctx.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('t2t.bypass', 'on', true)`);
        return tx.$executeRawUnsafe(`UPDATE revenue_forecasts SET note = 'x' WHERE id = '${savedId}'`);
      }),
    ).rejects.toThrow(/never changes/);
  });

  it('keeps forecasts to their organisation', async () => {
    await ctx.http().get(`${org.base}/sales/revenue-forecast`).set(outsider.auth).expect(404);
    await ctx.http().get(`${other.base}/sales/revenue-forecast/saved/${savedId}`).set(outsider.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/sales/revenue-forecast/saved`).set(outsider.auth).expect(200)).body.forecasts).toEqual([]);
  });
});
