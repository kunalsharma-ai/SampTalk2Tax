import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';
import { todayIst } from '../src/cash-flow/cash-flow.service';

/**
 * Business impact engine against the real API and database: sales, HR, procurement and
 * operations changes built from the organisation's own figures, saving and changing assessments,
 * turning one into a digital-twin scenario, validation, permissions, tenant isolation, the audit
 * trail, and proof that nothing is posted.
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
let id = '';
let journalsBefore = 0;

const shift = (ym: string, n: number) => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const t = y * 12 + m - 1 + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const journalCount = () => ctx.prisma.journalEntry.count({ where: { orgId: org.orgId } });
const newCustomer = { lever: 'NEW_CUSTOMER', label: 'Zenith Foods', monthlyRevenue: '60000', rampMonths: 3 };

beforeAll(async () => {
  ctx = await bootApp();
  lastMonth = shift(todayIst().slice(0, 7), -1);
  owner = await registerUser(ctx, 'Impact Owner');
  viewer = await registerUser(ctx, 'Impact Viewer');
  employee = await registerUser(ctx, 'Impact Employee');
  outsider = await registerUser(ctx, 'Impact Outsider');
  org = await createOrg(ctx, owner, { name: 'Impact Co' });
  other = await createOrg(ctx, outsider, { name: 'Other Impact Co' });
  for (const [u, role] of [[viewer, 'VIEWER'], [employee, 'EMPLOYEE']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  const contact = async (name: string, kind: 'isCustomer' | 'isVendor') => (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name, [kind]: true }).expect(201)).body.id as string;
  acme = await contact('Acme Retail', 'isCustomer');
  const beta = await contact('Beta Stores', 'isCustomer');
  await contact('Never Bought', 'isCustomer');
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

describe('business impact engine', () => {
  it('offers the levers by business area, with the customers and suppliers from the books', async () => {
    const r = (await ctx.http().get(`${org.base}/impact/options?baselineMonths=3&horizonMonths=6`).set(viewer.auth).expect(200)).body;
    expect(r.areas.map((a: { key: string }) => a.key)).toEqual(['SALES', 'HR', 'PROCUREMENT', 'OPERATIONS']);
    expect(r.levers).toHaveLength(13);
    expect(r.levers.find((l: { key: string }) => l.key === 'HEADCOUNT_REDUCTION').area).toBe('HR');
    // Cost of sales 1,20,000 on revenue 4,00,000 over the three months.
    expect(r.costOfSalesPercent).toBe('30.00');
    expect(r.monthly).toMatchObject({ revenue: '133333.33', costOfSales: '40000.00' });
    // Customers with no sales in the baseline months cannot be lost, so they are not offered.
    expect(r.customers.map((c: { name: string; monthlyRevenue: string }) => [c.name, c.monthlyRevenue])).toEqual([
      ['Acme Retail', '100000.00'],
      ['Beta Stores', '33333.33'],
    ]);
    expect(r.suppliers).toEqual([{ contactId: granite, name: 'Granite Parts', monthlySpend: '40000.00' }]);
  });

  it('assesses changes across business areas from the organisation’s own figures', async () => {
    const r = (await ctx.http().post(`${org.base}/impact/assess`).set(viewer.auth).send({ baselineMonths: 3, horizonMonths: 6, changes: [newCustomer, { lever: 'HIRE', count: 2, monthlyCostPerHead: '25000', oneOffCostPerHead: '10000' }, { lever: 'SUPPLIER_PRICE', contactId: granite, percent: '10' }] }).expect(200)).body;
    expect(r.costOfSalesPercent).toBe('30.00');
    expect(r.changes.map((c: { title: string; area: string }) => [c.title, c.area])).toEqual([
      ['New customer: Zenith Foods', 'SALES'],
      ['Hire 2 people', 'HR'],
      ['Granite Parts up 10%', 'PROCUREMENT'],
    ]);
    // New revenue 20,000 + 40,000 + 4 × 60,000 = 3,00,000, at the business's own 30% cost of sales.
    expect(r.changes[0].alone.revenue).toBe('300000.00');
    expect(r.changes[0].alone.grossProfit).toBe('210000.00');
    expect(r.changes[1].lines.map((l: { key: string; change: string }) => [l.key, l.change])).toEqual(expect.arrayContaining([['payroll', '300000.00'], ['otherOperating', '20000.00']]));
    expect(r.areas.map((a: { area: string }) => a.area)).toEqual(['SALES', 'HR', 'PROCUREMENT']);
    expect(r.months).toHaveLength(6);
    expect(r.summary).toMatch(/^These 3 changes together leave net profit/);

    const bad = (await ctx.http().post(`${org.base}/impact/assess`).set(viewer.auth).send({ baselineMonths: 3, horizonMonths: 6, changes: [{ lever: 'LOSE_CUSTOMER', contactId: granite }, { lever: 'PAY_RISE', percent: '0' }] }).expect(422)).body;
    expect(bad.details.issues).toEqual(['Change 1: Choose a customer from the list', 'Change 2: Enter the pay change']);
    await ctx.http().post(`${org.base}/impact/assess`).set(viewer.auth).send({ baselineMonths: 3, horizonMonths: 6, changes: [] }).expect(400);
    await ctx.http().post(`${org.base}/impact/assess`).set(viewer.auth).send({ baselineMonths: 3, horizonMonths: 6, changes: [{ lever: 'TELEPORT' }] }).expect(400);
    expect((await ctx.http().post(`${other.base}/impact/assess`).set(outsider.auth).send({ baselineMonths: 3, horizonMonths: 6, changes: [newCustomer] }).expect(422)).body.message).toBe('There are no posted months to assess from yet');
  });

  it('saves, changes and lists assessments, and turns one into a digital-twin scenario', async () => {
    const body = { name: 'Zenith contract', description: 'Win Zenith and staff up for it.', baselineMonths: 3, horizonMonths: 6, changes: [newCustomer] };
    await ctx.http().post(`${org.base}/impact/assessments`).set(viewer.auth).send(body).expect(403);
    const s = (await ctx.http().post(`${org.base}/impact/assessments`).set(owner.auth).send(body).expect(201)).body;
    id = s.id;
    expect(s).toMatchObject({ number: 'BI-0001', name: 'Zenith contract', problem: null });
    await ctx.http().post(`${org.base}/impact/assessments`).set(owner.auth).send(body).expect(409);

    const u = (await ctx.http().put(`${org.base}/impact/assessments/${id}`).set(owner.auth).send({ ...body, changes: [newCustomer, { lever: 'EQUIPMENT', label: 'a packing line', cost: '240000', usefulLifeMonths: 48, monthlySaving: '8000' }] }).expect(200)).body;
    expect(u.result.changes.map((x: { title: string }) => x.title)).toEqual(['New customer: Zenith Foods', 'Buy a packing line']);
    expect(u.result.changes[1].payback.status).toMatch(/NOT_WITHIN|NEVER_AHEAD|PAYS_BACK/);
    const list = (await ctx.http().get(`${org.base}/impact/assessments`).set(viewer.auth).expect(200)).body.items;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ number: 'BI-0001', areas: ['SALES', 'OPERATIONS'], netProfitChange: u.result.change.netProfit });

    const t = (await ctx.http().post(`${org.base}/impact/assessments/${id}/scenario`).set(owner.auth).expect(201)).body;
    const sc = (await ctx.http().get(`${org.base}/twin/scenarios/${t.scenarioId}`).set(viewer.auth).expect(200)).body.scenario;
    expect(sc.name).toBe('Zenith contract (BI-0001)');
    expect(sc.drivers.map((d: { kind: string }) => d.kind)).toEqual(['EXPANSION', 'INVESTMENT', 'EXPENSE_CHANGE']);
    expect(sc.drivers[0].costOfSalesPercent).toBe('30.00');

    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=impact_assessment&entityId=${id}`).set(owner.auth).expect(200)).body;
    expect((audit.items ?? audit).map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(['impact_assessment.created', 'impact_assessment.updated', 'impact_assessment.scenario_created']));
  });

  it('never posts, and stays within the organisation and its permissions', async () => {
    expect(await journalCount()).toBe(journalsBefore);
    await ctx.http().get(`${org.base}/impact/options`).set(employee.auth).expect(403);
    await ctx.http().get(`${org.base}/impact/assessments/${id}`).set(outsider.auth).expect(404);
    await ctx.http().get(`${other.base}/impact/assessments/${id}`).set(outsider.auth).expect(404);
    await ctx.http().delete(`${org.base}/impact/assessments/${id}`).set(viewer.auth).expect(403);
    await ctx.http().delete(`${org.base}/impact/assessments/${id}`).set(owner.auth).expect(204);
    await ctx.http().get(`${org.base}/impact/assessments/${id}`).set(owner.auth).expect(404);
  });
});
