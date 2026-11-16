import { addMonths, fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * The forecast evaluation lab against the real API and database: backtests of every model on the
 * organisation's own months, saving a run, saved forecasts measured against the books once their
 * month is over, the database refusing changes to saved runs, permissions and tenant isolation.
 */
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let employee: TestUser;
let outsider: TestUser;
type Org = Awaited<ReturnType<typeof createOrg>>;
let org: Org;
let other: Org;
const LAST = addMonths(today().slice(0, 7), -1);
const MONTHS = Array.from({ length: 12 }, (_, i) => addMonths(LAST, i - 11));
let runId = '';

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Lab Owner');
  viewer = await registerUser(ctx, 'Lab Viewer');
  employee = await registerUser(ctx, 'Lab Employee');
  outsider = await registerUser(ctx, 'Lab Outsider');
  org = await createOrg(ctx, owner, { name: 'Forecast Lab Traders' });
  other = await createOrg(ctx, outsider, { name: 'Other Lab Co' });
  for (const [u, role] of [[viewer, 'VIEWER'], [employee, 'EMPLOYEE']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  for (const fy of new Set(MONTHS.map((m) => fiscalYearForDate(`${m}-01`, 4)))) await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fy });
  // Revenue rising by 10,000 a month, received in the bank: 1,00,000 … 2,10,000.
  for (const [i, m] of MONTHS.entries()) {
    await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: `${m}-15`, memo: 'Lab sales', post: true, lines: [{ accountId: org.acc['1120'], debit: `${100000 + i * 10000}.00` }, { accountId: org.acc['4100'], credit: `${100000 + i * 10000}.00` }] }).expect(201);
  }
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('forecast evaluation lab', () => {
  it('backtests every model on the organisation’s own months and ranks them', async () => {
    const r = (await ctx.http().get(`${org.base}/forecast-lab?window=6`).set(viewer.auth).expect(200)).body;
    expect(r).toMatchObject({ baseMonth: LAST, window: 6, historyMonths: 12, firstMonth: MONTHS[0], currency: 'INR' });
    const rev = r.series.find((s: { series: string }) => s.series === 'revenue');
    expect(rev.months).toEqual(MONTHS.slice(-6));
    expect(['LINEAR', 'DRIFT']).toContain(rev.best);
    const linear = rev.models.find((m: { model: string }) => m.model === 'LINEAR');
    // 6 months × 3 horizons, less the 3 forecasts made before it had 6 months of history.
    expect(linear.stats).toMatchObject({ count: 15, wape: '0.0', mae: '0.00', within10: '100.0' });
    const naive = rev.models.find((m: { model: string }) => m.model === 'NAIVE');
    expect(naive.byHorizon.map((x: { stats: { mae: string } }) => x.stats.mae)).toEqual(['10000.00', '20000.00', '30000.00']);
    // With 12 months of books, the 12-month average and last year's month cannot be tested yet.
    expect(rev.models.find((m: { model: string }) => m.model === 'SEASONAL')).toMatchObject({ rank: null, note: 'Needs at least 12 months of history before the first month checked' });
    expect(rev.summary).toMatch(/^Over the last 6 months, .* forecast revenue best, with an error of 0\.0% of the actual figures/);
    // Cash came in with the sales, so cash flow follows revenue.
    expect(r.series.find((s: { series: string }) => s.series === 'netCashFlow').best).toBe(rev.best);
    // Next months, by every model.
    const next = addMonths(LAST, 1);
    expect(r.ahead.find((f: { series: string; model: string; horizon: number }) => f.series === 'revenue' && f.model === 'NAIVE' && f.horizon === 1)).toEqual({ series: 'revenue', model: 'NAIVE', month: next, horizon: 1, value: '210000.00' });
    expect(r.ahead.find((f: { series: string; model: string; horizon: number }) => f.series === 'revenue' && f.model === 'LINEAR' && f.horizon === 2).value).toBe('230000.00');
    expect(r.meta.models).toHaveLength(8);
    await ctx.http().get(`${org.base}/forecast-lab?window=7`).set(viewer.auth).expect(400);
  });

  it('saves a run with its forecasts, and measures saved forecasts once their month is over', async () => {
    await ctx.http().post(`${org.base}/forecast-lab/runs`).set(viewer.auth).send({ window: 12 }).expect(403);
    const run = (await ctx.http().post(`${org.base}/forecast-lab/runs`).set(owner.auth).send({ window: 12, note: 'Before the budget meeting' }).expect(201)).body;
    runId = run.id;
    expect(run).toMatchObject({ number: 'FL-0001', baseMonth: LAST, window: 12, note: 'Before the budget meeting', createdBy: 'Lab Owner' });
    expect(run.results.revenue.best).toMatch(/LINEAR|DRIFT/);
    expect(run.forecasts.every((f: { month: string; actual: string | null }) => f.month > LAST && f.actual === null)).toBe(true);
    // A run saved three months ago forecast last month: it is measured against the books now.
    const old = await ctx.prisma.forecastLabRun.create({
      data: {
        orgId: org.orgId,
        number: 2,
        baseMonth: addMonths(LAST, -3),
        window: 6,
        results: {},
        forecasts: [
          { series: 'revenue', model: 'NAIVE', month: LAST, horizon: 3, value: '180000.00' },
          { series: 'revenue', model: 'LINEAR', month: LAST, horizon: 3, value: '205000.00' },
        ],
        createdById: owner.id,
      },
    });
    const g = (await ctx.http().get(`${org.base}/forecast-lab/runs/${old.id}`).set(viewer.auth).expect(200)).body;
    expect(g.forecasts[0]).toMatchObject({ month: LAST, value: '180000.00', actual: '210000.00' });
    const t = g.tracking.find((s: { series: string }) => s.series === 'revenue');
    expect(t.best).toBe('LINEAR');
    expect(t.models.find((m: { model: string }) => m.model === 'NAIVE').stats).toMatchObject({ count: 1, mae: '30000.00', wape: '14.3', bias: '-30000.00' });
    // The lab's tracking adds up every saved run.
    const o = (await ctx.http().get(`${org.base}/forecast-lab`).set(viewer.auth).expect(200)).body;
    expect(o.tracking.runs).toBe(2);
    expect(o.tracking.series.find((s: { series: string }) => s.series === 'revenue').models.find((m: { model: string }) => m.model === 'LINEAR').stats.count).toBe(1);
    const list = (await ctx.http().get(`${org.base}/forecast-lab/runs`).set(viewer.auth).expect(200)).body.items;
    expect(list.map((x: { number: string; measuredMonths: string[] }) => [x.number, x.measuredMonths])).toEqual([['FL-0002', [LAST]], ['FL-0001', []]]);
    // Saved runs are evidence: the database refuses changes and deletion.
    await expect(ctx.prisma.forecastLabRun.update({ where: { id: runId }, data: { note: 'changed' } })).rejects.toThrow(/cannot be changed or deleted/);
    await expect(ctx.prisma.forecastLabRun.delete({ where: { id: runId } })).rejects.toThrow(/cannot be changed or deleted/);
    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=forecast_lab_run&entityId=${runId}`).set(owner.auth).expect(200)).body;
    expect((audit.items ?? audit).map((e: { action: string }) => e.action)).toContain('forecast_lab.run_saved');
  });

  it('needs books to save, and stays within the organisation', async () => {
    const empty = (await ctx.http().post(`${other.base}/forecast-lab/runs`).set(outsider.auth).send({}).expect(422)).body;
    expect(empty.message).toBe('At least two months of posted books are needed to save a forecast run');
    expect((await ctx.http().get(`${other.base}/forecast-lab`).set(outsider.auth).expect(200)).body).toMatchObject({ historyMonths: 0, firstMonth: null });
    await ctx.http().get(`${org.base}/forecast-lab`).set(employee.auth).expect(403);
    await ctx.http().get(`${org.base}/forecast-lab/runs/${runId}`).set(outsider.auth).expect(404);
    await ctx.http().get(`${other.base}/forecast-lab/runs/${runId}`).set(outsider.auth).expect(404);
  });
});
