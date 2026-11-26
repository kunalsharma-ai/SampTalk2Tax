import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Scenario surface (DASH-027) against the real API and database: the twin baseline read from
 * posted journals, re-run over a grid of two changes, one outcome per point and month; checked
 * in words; reports.read; isolation; nothing posted.
 */
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let employee: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let lastMonth: string;

const shift = (ym: string, n: number) => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const t = y * 12 + m - 1 + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const journal = (debit: string, credit: string, amount: string, memo: string) =>
  ctx
    .http()
    .post(`${org.base}/journals`)
    .set(owner.auth)
    .send({
      date: `${lastMonth}-15`,
      post: true,
      memo,
      lines: [
        { accountId: org.acc[debit], debit: amount },
        { accountId: org.acc[credit], credit: amount },
      ],
    })
    .expect(201);
const body = { baselineMonths: 3, horizonMonths: 2, measure: 'NET_PROFIT', x: { axis: 'PRICE', min: -10, max: 10, steps: 3 }, y: { axis: 'PAYROLL', min: -10, max: 10, steps: 3 } };

beforeAll(async () => {
  ctx = await bootApp();
  lastMonth = shift(today().slice(0, 7), -1);
  owner = await registerUser(ctx, 'Surface Owner');
  viewer = await registerUser(ctx, 'Surface Viewer');
  employee = await registerUser(ctx, 'Surface Employee');
  outsider = await registerUser(ctx, 'Surface Outsider');
  org = await createOrg(ctx, owner, { name: 'Surface Co' });
  for (const [u, role] of [
    [viewer, 'VIEWER'],
    [employee, 'EMPLOYEE'],
  ] as const)
    await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  // Over three months: revenue 100,000, cost of sales 40,000, payroll 30,000, rent 10,000 a month.
  await journal('1120', '3100', '1000000.00', 'Capital');
  await journal('1120', '4100', '300000.00', 'Sales');
  await journal('5000', '1120', '120000.00', 'Stock sold');
  await journal('6100', '1120', '90000.00', 'Salaries');
  await journal('6200', '1120', '30000.00', 'Rent');
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('scenario surface', () => {
  it('measures profit at every point of price against payroll, month by month', async () => {
    const journalsBefore = (await ctx.http().get(`${org.base}/journals`).set(owner.auth).expect(200)).body;
    const r = (await ctx.http().post(`${org.base}/twin/surface`).set(viewer.auth).send(body).expect(200)).body;
    expect(r).toMatchObject({ baselineMonths: 3, actualTo: lastMonth, measure: 'NET_PROFIT', currency: 'INR', runs: 9, current: '40000.00', cashNegativeCells: 0 });
    expect(r.x).toEqual({ axis: 'PRICE', label: 'Price change', unit: '%', values: ['-10', '0', '10'] });
    expect(r.frames.map((f: { month: string }) => f.month)).toEqual([shift(lastMonth, 1), shift(lastMonth, 2)]);
    expect(r.frames[0].values[0]).toEqual(['13000.00', '23000.00', '33000.00']);
    expect(r.best).toEqual({ x: '10', y: '-10', value: '66000.00' });
    expect(r.worst).toEqual({ x: '-10', y: '10', value: '14000.00' });
    // Nothing is posted or saved.
    expect((await ctx.http().get(`${org.base}/journals`).set(owner.auth).expect(200)).body).toEqual(journalsBefore);
  });

  it('measures cash too, under other changes', async () => {
    const r = (
      await ctx
        .http()
        .post(`${org.base}/twin/surface`)
        .set(viewer.auth)
        .send({ ...body, measure: 'CLOSING_CASH', drivers: [{ kind: 'HIRING', count: 1, monthlyCostPerHead: '10000' }] })
        .expect(200)
    ).body;
    // At no change: cash 1,060,000 plus 2 months of 10,000 profit after the hire.
    expect(r.current).toBe('1080000.00');
  });

  it('says in words what to fix', async () => {
    const bad = (
      await ctx
        .http()
        .post(`${org.base}/twin/surface`)
        .set(viewer.auth)
        .send({ ...body, horizonMonths: 30, y: { axis: 'PRICE', min: 0, max: 80, steps: 3 } })
        .expect(422)
    ).body;
    expect(bad.error).toBe('SCENARIO_INVALID');
    expect(bad.details.issues).toEqual(['Choose two different changes', 'Choose a horizon from 1 to 24 months', 'Up: Price change must stay between -50 and 50 %']);
    await ctx
      .http()
      .post(`${org.base}/twin/surface`)
      .set(viewer.auth)
      .send({ ...body, measure: 'REVENUE' })
      .expect(400);
    await ctx
      .http()
      .post(`${org.base}/twin/surface`)
      .set(viewer.auth)
      .send({ ...body, x: { axis: 'NOPE', min: 0, max: 1, steps: 3 } })
      .expect(400);
  });

  it('needs reports access and keeps to its organisation', async () => {
    await ctx.http().post(`${org.base}/twin/surface`).set(employee.auth).send(body).expect(403);
    await ctx.http().post(`${org.base}/twin/surface`).set(outsider.auth).send(body).expect(404);
    const other = await createOrg(ctx, outsider, { name: 'Other Surface Co' });
    // Another organisation's surface is built from its own (empty) books: nothing moves.
    const r = (await ctx.http().post(`${other.base}/twin/surface`).set(outsider.auth).send(body).expect(200)).body;
    expect(r.current).toBe('0.00');
    expect(r.best.value).toBe('0.00');
  });
});
