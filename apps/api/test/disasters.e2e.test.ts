import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';
import { todayIst } from '../src/cash-flow/cash-flow.service';

/**
 * Financial disaster simulation against the real API and database: shocks built from the
 * organisation's own customers, suppliers and cash, the standard stress tests, saving and
 * changing simulations, turning one into a digital-twin scenario, validation, permissions,
 * tenant isolation, the audit trail, and proof that nothing is posted.
 */
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let employee: TestUser;
let outsider: TestUser;
type Org = Awaited<ReturnType<typeof createOrg>>;
let org: Org;
let other: Org;
let lastMonth: string;
let acme = '';
let granite = '';
let simId = '';
let journalsBefore = 0;

const shift = (ym: string, n: number) => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const t = y * 12 + m - 1 + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const journalCount = () => ctx.prisma.journalEntry.count({ where: { orgId: org.orgId } });
const defaultAcme = () => ({ kind: 'CUSTOMER_DEFAULT', contactId: acme, writeOffPercent: '100', loseFutureSales: true });

beforeAll(async () => {
  ctx = await bootApp();
  lastMonth = shift(todayIst().slice(0, 7), -1);
  owner = await registerUser(ctx, 'Disaster Owner');
  viewer = await registerUser(ctx, 'Disaster Viewer');
  employee = await registerUser(ctx, 'Disaster Employee');
  outsider = await registerUser(ctx, 'Disaster Outsider');
  org = await createOrg(ctx, owner, { name: 'Disaster Co' });
  other = await createOrg(ctx, outsider, { name: 'Other Disaster Co' });
  for (const [u, role] of [[viewer, 'VIEWER'], [employee, 'EMPLOYEE']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  const contact = async (name: string, kind: 'isCustomer' | 'isVendor') => (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name, [kind]: true }).expect(201)).body.id as string;
  acme = await contact('Acme Retail', 'isCustomer');
  const beta = await contact('Beta Stores', 'isCustomer');
  granite = await contact('Granite Parts', 'isVendor');
  const invoice = (contactId: string, amount: string) =>
    ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId, issueDate: `${lastMonth}-01`, dueDate: `${lastMonth}-28`, post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: amount }] }).expect(201);
  await invoice(acme, '300000.00');
  await invoice(beta, '100000.00');
  await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: granite, issueDate: `${lastMonth}-05`, reference: 'GP-1', post: true, lines: [{ accountId: org.acc['5000'], quantity: '1', unitPrice: '120000.00' }] }).expect(201);
  const journal = (debit: string, credit: string, amount: string, memo: string) =>
    ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: `${lastMonth}-15`, post: true, memo, lines: [{ accountId: org.acc[debit], debit: amount }, { accountId: org.acc[credit], credit: amount }] }).expect(201);
  await journal('1120', '3100', '1000000.00', 'Capital');
  await journal('6100', '1120', '60000.00', 'Salaries');
  journalsBefore = await journalCount();
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('disaster simulation', () => {
  it('lists the customers and suppliers to choose from, with their figures from the books', async () => {
    const r = (await ctx.http().get(`${org.base}/disasters/options?baselineMonths=3&horizonMonths=6`).set(viewer.auth).expect(200)).body;
    expect(r.currency).toBe('INR');
    expect(r.kinds.map((k: { key: string }) => k.key)).toEqual(['CUSTOMER_DEFAULT', 'SUPPLIER_FAILURE', 'LIQUIDITY_SHOCK', 'OPERATIONAL_DISRUPTION', 'DEMAND_SHOCK']);
    // Sales over three baseline months, as a monthly average, and what each customer owes now.
    expect(r.customers.map((c: { name: string; monthlyRevenue: string; balance: string }) => [c.name, c.monthlyRevenue, c.balance])).toEqual([
      ['Acme Retail', '100000.00', '300000.00'],
      ['Beta Stores', '33333.33', '100000.00'],
    ]);
    expect(r.suppliers).toEqual([{ contactId: granite, name: 'Granite Parts', monthlySpend: '40000.00' }]);
  });

  it('simulates a customer default from its own balance and share of sales, and refuses shocks that do not make sense', async () => {
    const r = (await ctx.http().post(`${org.base}/disasters/simulate`).set(viewer.auth).send({ baselineMonths: 3, horizonMonths: 6, shocks: [defaultAcme()] }).expect(200)).body;
    expect(r.shocks[0].title).toBe('Acme Retail defaults');
    expect(r.shocks[0].drivers).toEqual([
      { kind: 'ONE_OFF', label: 'Bad debt: Acme Retail', amount: '-300000.00', month: 1, affectsProfit: true },
      { kind: 'DOWNTURN', label: 'Sales to Acme Retail lost', revenuePercent: '75.00', extraCollectionDays: 0, fromMonth: 1 },
    ]);
    expect(Number(r.impact.profitChange)).toBeLessThan(-300000);
    expect(r.noShock.months).toHaveLength(6);
    expect(r.summary).toMatch(/^With this shock, /);

    const bad = (await ctx.http().post(`${org.base}/disasters/simulate`).set(viewer.auth).send({ baselineMonths: 3, horizonMonths: 6, shocks: [{ ...defaultAcme(), contactId: granite, writeOffPercent: '150' }] }).expect(422)).body;
    expect(bad.details.issues).toEqual(['Shock 1: Choose a customer from the list', 'Shock 1: Share of the balance never paid (%) must be at most 100']);
    await ctx.http().post(`${org.base}/disasters/simulate`).set(viewer.auth).send({ baselineMonths: 3, horizonMonths: 6, shocks: [] }).expect(400);
  });

  it('runs the standard stress tests from the organisation’s own figures, worst first', async () => {
    const r = (await ctx.http().get(`${org.base}/disasters/stress-tests?baselineMonths=3&horizonMonths=12`).set(viewer.auth).expect(200)).body;
    const keys = r.tests.map((t: { key: string }) => t.key);
    expect([...keys].sort()).toEqual(['CUSTOMERS_PAY_LATE', 'DEMAND_DOWN_30', 'HALF_CASH_FROZEN', 'LARGEST_CUSTOMER_DEFAULTS', 'LARGEST_SUPPLIER_FAILS', 'ONE_MONTH_SHUTDOWN', 'PERFECT_STORM']);
    expect(r.tests.find((t: { key: string }) => t.key === 'LARGEST_CUSTOMER_DEFAULTS').title).toBe('Largest customer defaults (Acme Retail)');
    expect(r.tests.find((t: { key: string }) => t.key === 'LARGEST_SUPPLIER_FAILS').title).toBe('Largest supplier fails (Granite Parts)');
    const lows = r.tests.map((t: { impact: { lowestCash: { amount: string } } }) => Number(t.impact.lowestCash.amount));
    expect(lows).toEqual([...lows].sort((a, b) => a - b));
    expect(r.summary).toMatch(/^The business gets through \d of 7 standard shocks/);
    // An organisation with no books cannot be stress-tested.
    expect((await ctx.http().get(`${other.base}/disasters/stress-tests`).set(outsider.auth).expect(422)).body.message).toBe('There are no posted months to simulate from yet');
  });

  it('saves, changes and lists simulations, and turns one into a digital-twin scenario', async () => {
    const body = { name: 'Acme goes under', description: 'Our largest customer fails.', baselineMonths: 3, horizonMonths: 6, shocks: [defaultAcme()] };
    await ctx.http().post(`${org.base}/disasters/simulations`).set(viewer.auth).send(body).expect(403);
    const s = (await ctx.http().post(`${org.base}/disasters/simulations`).set(owner.auth).send(body).expect(201)).body;
    simId = s.id;
    expect(s).toMatchObject({ number: 'DS-0001', name: 'Acme goes under', horizonMonths: 6, problem: null });
    expect(s.result.shocks).toHaveLength(1);
    await ctx.http().post(`${org.base}/disasters/simulations`).set(owner.auth).send(body).expect(409);

    const u = (await ctx.http().put(`${org.base}/disasters/simulations/${simId}`).set(owner.auth).send({ ...body, shocks: [defaultAcme(), { kind: 'SUPPLIER_FAILURE', contactId: granite, disruptionMonths: 1, revenueLostPercent: '20', replacementPremiumPercent: '10' }] }).expect(200)).body;
    expect(u.result.shocks.map((x: { title: string }) => x.title)).toEqual(['Acme Retail defaults', 'Granite Parts fails']);
    const list = (await ctx.http().get(`${org.base}/disasters/simulations`).set(viewer.auth).expect(200)).body.items;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ number: 'DS-0001', verdict: expect.stringMatching(/SURVIVES|BELOW_BUFFER|RUNS_OUT/) });

    const t = (await ctx.http().post(`${org.base}/disasters/simulations/${simId}/scenario`).set(owner.auth).expect(201)).body;
    const sc = (await ctx.http().get(`${org.base}/twin/scenarios/${t.scenarioId}`).set(viewer.auth).expect(200)).body.scenario;
    expect(sc.name).toBe('Acme goes under (DS-0001)');
    expect(sc.drivers.map((d: { kind: string }) => d.kind)).toEqual(['ONE_OFF', 'DOWNTURN', 'DOWNTURN', 'SUPPLIER_COST']);

    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=disaster_simulation&entityId=${simId}`).set(owner.auth).expect(200)).body;
    expect((audit.items ?? audit).map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(['disaster_simulation.created', 'disaster_simulation.updated', 'disaster_simulation.scenario_created']));
  });

  it('never posts, and stays within the organisation and its permissions', async () => {
    expect(await journalCount()).toBe(journalsBefore);
    await ctx.http().get(`${org.base}/disasters/stress-tests`).set(employee.auth).expect(403);
    await ctx.http().get(`${org.base}/disasters/simulations/${simId}`).set(outsider.auth).expect(404);
    await ctx.http().get(`${other.base}/disasters/simulations/${simId}`).set(outsider.auth).expect(404);
    await ctx.http().delete(`${org.base}/disasters/simulations/${simId}`).set(viewer.auth).expect(403);
    await ctx.http().delete(`${org.base}/disasters/simulations/${simId}`).set(owner.auth).expect(204);
    await ctx.http().get(`${org.base}/disasters/simulations/${simId}`).set(owner.auth).expect(404);
  });
});
