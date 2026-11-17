import { addDays } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';
import { sqlWrite } from './sql-writes';

/**
 * Cash-flow forecasting against the real API and database: payment history sets the expected
 * dates of open invoices, planned items add receipts and payments, the minimum balance warns,
 * and saved forecasts and backtests are fixed and measured against the actual cash.
 */
let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let viewer: TestUser;
let stranger: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let today: string;
const d = (n: number) => addDays(today, n);
const contacts: Record<string, string> = {};

const contact = async (name: string, kind: 'isCustomer' | 'isVendor') =>
  (contacts[name] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name, [kind]: true }).expect(201)).body.id);
const invoice = async (who: string, issueDate: string, dueDate: string, amount: string) =>
  (await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: contacts[who], issueDate, dueDate, post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: amount }] }).expect(201)).body;
const receive = (who: string, date: string, documentId: string, amount: string) =>
  ctx.http().post(`${org.base}/sales/payments`).set(owner.auth).send({ contactId: contacts[who], date, bankAccountId: org.acc['1120'], amount, allocations: [{ documentId, amount }] }).expect(201);
const forecast = (q: string, u = viewer) => ctx.http().get(`${org.base}/cash-flow/forecast?${q}`).set(u.auth);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Cash Owner');
  accountant = await registerUser(ctx, 'Cash Accountant');
  viewer = await registerUser(ctx, 'Cash Viewer');
  stranger = await registerUser(ctx, 'Cash Stranger');
  org = await createOrg(ctx, owner);
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [viewer, 'VIEWER']] as const) {
    await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  }
  // The server's today (India time), so the test does not depend on the time of day.
  today = (await forecast('horizonDays=30', owner).expect(200)).body.today;
  // Opening cash.
  await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: d(-160), post: true, memo: 'Capital', lines: [{ accountId: org.acc['1120'], debit: '500000.00' }, { accountId: org.acc['4100'], credit: '500000.00' }] }).expect(201);
  await contact('Prompt Ltd', 'isCustomer');
  await contact('New Co', 'isCustomer');
  await contact('Old Debt Pvt', 'isCustomer');
  await contact('Granite Supplies', 'isVendor');
  // Prompt Ltd pays ten days after the due date, three times.
  for (const [issue, due, paid] of [[-90, -80, -70], [-60, -50, -40], [-40, -30, -20]]) {
    const inv = await invoice('Prompt Ltd', d(issue), d(due), '1000.00');
    await receive('Prompt Ltd', d(paid), inv.id, '1000.00');
  }
  await invoice('Prompt Ltd', d(-5), d(5), '10000.00');
  await invoice('New Co', d(-2), d(20), '8000.00');
  await invoice('Old Debt Pvt', d(-150), d(-120), '7000.00');
  await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: contacts['Granite Supplies'], issueDate: d(-3), dueDate: d(10), reference: 'GS-1', post: true, lines: [{ accountId: org.acc['6400'], quantity: '1', unitPrice: '5000.00' }] }).expect(201);
});
afterAll(async () => {
  await ctx.app.close();
});

describe('planned items and the minimum balance', () => {
  it('adds, changes and removes planned items, with checks and an audit trail', async () => {
    const rent = (await ctx.http().post(`${org.base}/cash-flow/items`).set(accountant.auth).send({ name: 'Office rent', direction: 'OUT', amount: '20000', frequency: 'MONTHLY', startDate: d(7) }).expect(201)).body;
    expect(rent).toMatchObject({ name: 'Office rent', amount: '20000.00', frequency: 'MONTHLY', endDate: null, isActive: true });
    const grant = (await ctx.http().post(`${org.base}/cash-flow/items`).set(owner.auth).send({ name: 'Grant', direction: 'IN', amount: '2500.00', frequency: 'ONCE', startDate: d(3) }).expect(201)).body;
    await ctx.http().put(`${org.base}/cash-flow/items/${grant.id}`).set(owner.auth).send({ name: 'Startup grant', direction: 'IN', amount: '3000.00', frequency: 'ONCE', startDate: d(3) }).expect(200);
    const temp = (await ctx.http().post(`${org.base}/cash-flow/items`).set(owner.auth).send({ name: 'Temp', direction: 'OUT', amount: '1.00', frequency: 'WEEKLY', startDate: d(1) }).expect(201)).body;
    await ctx.http().delete(`${org.base}/cash-flow/items/${temp.id}`).set(owner.auth).expect(200);

    const bad = (body: object) => ctx.http().post(`${org.base}/cash-flow/items`).set(owner.auth).send({ name: 'X', direction: 'OUT', amount: '10', frequency: 'MONTHLY', startDate: d(1), ...body });
    await bad({ amount: '0' }).expect(400);
    await bad({ amount: '10.005' }).expect(400);
    await bad({ amount: '-5' }).expect(400);
    expect((await bad({ frequency: 'ONCE', endDate: d(40) }).expect(422)).body.message).toMatch(/one-off/);
    expect((await bad({ endDate: d(-1) }).expect(422)).body.message).toMatch(/before the start/);
    await bad({}).set(viewer.auth).expect(403);

    const list = (await ctx.http().get(`${org.base}/cash-flow/items`).set(viewer.auth).expect(200)).body;
    expect(list.map((i: { name: string }) => i.name).sort()).toEqual(['Office rent', 'Startup grant']);
    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, entityType: 'cash_flow_item' }, select: { action: true } });
    expect(audit.map((a) => a.action).sort()).toEqual(['cashflow.item_created', 'cashflow.item_created', 'cashflow.item_created', 'cashflow.item_deleted', 'cashflow.item_updated']);
  });

  it('keeps a minimum balance', async () => {
    expect((await ctx.http().get(`${org.base}/cash-flow/settings`).set(viewer.auth).expect(200)).body).toEqual({ minimumBalance: '0.00', currency: 'INR' });
    await ctx.http().put(`${org.base}/cash-flow/settings`).set(viewer.auth).send({ minimumBalance: '485000' }).expect(403);
    await ctx.http().put(`${org.base}/cash-flow/settings`).set(owner.auth).send({ minimumBalance: '1.234' }).expect(400);
    expect((await ctx.http().put(`${org.base}/cash-flow/settings`).set(owner.auth).send({ minimumBalance: '485000' }).expect(200)).body.minimumBalance).toBe('485000.00');
  });
});

describe('the forecast', () => {
  it('puts open invoices at their expected dates from payment history', async () => {
    const f = (await forecast('horizonDays=30').expect(200)).body;
    expect(f).toMatchObject({ asOf: today, start: d(1), end: d(30), isBacktest: false, opening: '503000.00', minimumBalance: '485000.00' });
    expect(f.days).toHaveLength(30);
    const r = Object.fromEntries(f.receivables.map((x: { contactName: string }) => [x.contactName, x]));
    // Its own history: three payments ten days late.
    expect(r['Prompt Ltd']).toMatchObject({ open: '10000.00', dueDate: d(5), expected: { early: d(15), base: d(15), late: d(15) }, basis: { source: 'CONTACT', samples: 3, medianDelay: 10 }, doubtful: false, inHorizon: true });
    // No history of its own: everyone's history.
    expect(r['New Co']).toMatchObject({ expected: { base: d(30) }, basis: { source: 'ALL_CONTACTS' } });
    // 120 days overdue: doubtful, never before tomorrow.
    expect(r['Old Debt Pvt']).toMatchObject({ expected: { base: d(1) }, doubtful: true, pastTypical: true });
    // No vendor history: the due date.
    expect(f.payables[0]).toMatchObject({ contactName: 'Granite Supplies', open: '5000.00', expected: { base: d(10) }, basis: { source: 'DUE_DATE', samples: 0 } });
    expect(f.planned).toEqual([
      expect.objectContaining({ name: 'Startup grant', date: d(3), amount: '3000.00', direction: 'IN' }),
      expect.objectContaining({ name: 'Office rent', date: d(7), amount: '20000.00', direction: 'OUT' }),
    ]);
    expect(f.delays.customers).toEqual({ samples: 3, p25: 10, median: 10, p75: 10 });
  });

  it('adds up the base case, the range and the warning', async () => {
    const f = (await forecast('horizonDays=30').expect(200)).body;
    // 503,000 + 10,000 + 8,000 + 3,000 − 20,000 − 5,000; the doubtful 7,000 only in the high case.
    expect(f.closing).toEqual({ base: '499000.00', low: '499000.00', high: '506000.00' });
    expect(f.totals).toMatchObject({ RECEIVABLE: '18000.00', PAYABLE: '5000.00', PLANNED_IN: '3000.00', PLANNED_OUT: '20000.00' });
    expect(f.lowest.base).toEqual({ date: d(10), amount: '481000.00' });
    expect(f.belowBuffer.base).toBe(d(10));
    const day = (n: number) => f.days.find((x: { date: string }) => x.date === d(n));
    expect(day(1)).toEqual({ date: d(1), base: '503000.00', low: '503000.00', high: '510000.00' });
    expect(day(7).base).toBe('486000.00');
    // Weekly buckets up to 90 days; their flows add up to the closing balance.
    expect(f.buckets[0]).toMatchObject({ from: d(1), to: d(7), opening: '503000.00', closing: '486000.00', inflows: { PLANNED_IN: '3000.00' }, outflows: { PLANNED_OUT: '20000.00' } });
    expect(f.buckets[f.buckets.length - 1].closing).toBe('499000.00');
    // Beyond 90 days the buckets are months.
    const long = (await forecast('horizonDays=180').expect(200)).body;
    expect(long.days).toHaveLength(180);
    expect(long.buckets.length).toBeLessThanOrEqual(7);
    expect(long.planned.filter((p: { name: string }) => p.name === 'Office rent').length).toBeGreaterThanOrEqual(5);
  });

  it('refuses a horizon not offered and a day in the future', async () => {
    await forecast('horizonDays=45').expect(400);
    expect((await forecast(`horizonDays=30&asOf=${d(1)}`).expect(422)).body.error).toBe('INVALID_DATE');
    expect((await forecast(`horizonDays=30&asOf=${d(-800)}`).expect(422)).body.message).toMatch(/two years/);
  });

  it('rebuilds the forecast as the books stood on an earlier day', async () => {
    const f = (await forecast(`horizonDays=30&asOf=${d(-45)}`).expect(200)).body;
    expect(f).toMatchObject({ asOf: d(-45), isBacktest: true, opening: '501000.00' });
    // One payment seen by then: too few to use, so due dates.
    expect(f.delays.customers.samples).toBe(1);
    const nums = f.receivables.map((x: { contactName: string; dueDate: string }) => `${x.contactName} ${x.dueDate}`).sort();
    expect(nums).toEqual([`Old Debt Pvt ${d(-120)}`, `Prompt Ltd ${d(-50)}`]);
    expect(f.receivables.find((x: { contactName: string }) => x.contactName === 'Old Debt Pvt').doubtful).toBe(false);
  });
});

describe('saved forecasts and backtests', () => {
  let saved: string;
  let backtest: string;

  it('saves today’s forecast and a backtest, and measures the backtest against actual cash', async () => {
    await ctx.http().post(`${org.base}/cash-flow/forecasts`).set(viewer.auth).send({ horizonDays: 30 }).expect(403);
    const s = (await ctx.http().post(`${org.base}/cash-flow/forecasts`).set(accountant.auth).send({ horizonDays: 30, note: 'Month start' }).expect(201)).body;
    saved = s.id;
    expect(s).toMatchObject({ asOf: today, isBacktest: false, opening: '503000.00', closingBase: '499000.00', note: 'Month start', createdBy: 'Cash Accountant', accuracy: { days: 0 } });
    expect(s.days).toHaveLength(30);

    const b = (await ctx.http().post(`${org.base}/cash-flow/forecasts`).set(owner.auth).send({ horizonDays: 30, asOf: d(-45) }).expect(201)).body;
    backtest = b.id;
    expect(b).toMatchObject({ asOf: d(-45), isBacktest: true, accuracy: { days: 30 } });
    // Without enough history both overdue invoices were expected the next day (8,000); in fact
    // 1,000 came on day −40 and 1,000 on day −20, and the old debt never came.
    const at = (date: string) => b.accuracy.series.find((x: { date: string }) => x.date === date);
    expect(at(d(-44))).toMatchObject({ base: '509000.00', actual: '501000.00', error: '-8000.00' });
    expect(at(d(-40))).toMatchObject({ actual: '502000.00', error: '-7000.00' });
    expect(at(d(-20))).toMatchObject({ actual: '503000.00' });
    expect(Number(b.accuracy.meanAbsoluteError)).toBeGreaterThan(0);

    const list = (await ctx.http().get(`${org.base}/cash-flow/forecasts`).set(viewer.auth).expect(200)).body;
    expect(list.map((x: { id: string }) => x.id)).toEqual([backtest, saved]);
    expect(list[0].accuracy.days).toBe(30);
    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, entityType: 'cash_forecast' }, select: { action: true } });
    expect(audit.map((a) => a.action).sort()).toEqual(['cashflow.backtest_saved', 'cashflow.forecast_saved']);
  });

  it('keeps a saved forecast as it was when the books change', async () => {
    await ctx.http().post(`${org.base}/cash-flow/items`).set(owner.auth).send({ name: 'Late addition', direction: 'OUT', amount: '9000', frequency: 'ONCE', startDate: d(2) }).expect(201);
    expect((await forecast('horizonDays=30').expect(200)).body.closing.base).toBe('490000.00');
    expect((await ctx.http().get(`${org.base}/cash-flow/forecasts/${saved}`).set(viewer.auth).expect(200)).body.closingBase).toBe('499000.00');
  });

  it('the database refuses to change or delete a saved forecast, or to mislabel one', async () => {
    const raw = (sql: string, ...args: unknown[]) => sqlWrite(ctx, sql, args, { bypass: true });
    await expect(raw(`UPDATE cash_forecasts SET closing_base = 1 WHERE id = $1::uuid`, saved)).rejects.toThrow(/immutable/);
    await expect(raw(`DELETE FROM cash_forecasts WHERE id = $1::uuid`, backtest)).rejects.toThrow(/cannot be deleted/);
    await expect(
      raw(`INSERT INTO cash_forecasts (id, org_id, as_of, horizon_days, is_backtest, opening, closing_base, days, inputs, created_by_id) SELECT gen_random_uuid(), org_id, as_of, 30, true, opening, closing_base, days, inputs, created_by_id FROM cash_forecasts WHERE id = $1::uuid`, saved),
    ).rejects.toThrow(/check/i);
    await expect(raw(`INSERT INTO cash_flow_items (id, org_id, name, direction, amount, frequency, start_date, created_by_id, updated_at) VALUES (gen_random_uuid(), $1::uuid, 'Bad', 'OUT', 0, 'ONCE', now()::date, $2::uuid, now())`, org.orgId, owner.id)).rejects.toThrow(/check/i);
  });

  it('keeps each organisation’s forecasts to itself', async () => {
    await ctx.http().get(`${org.base}/cash-flow/forecast?horizonDays=30`).set(stranger.auth).expect(404);
    await ctx.http().get(`${org.base}/cash-flow/forecasts/${saved}`).set(stranger.auth).expect(404);
    const other = await createOrg(ctx, stranger);
    await ctx.http().get(`${other.base}/cash-flow/forecasts/${saved}`).set(stranger.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/cash-flow/forecasts`).set(stranger.auth).expect(200)).body).toEqual([]);
    expect((await ctx.http().get(`${other.base}/cash-flow/items`).set(stranger.auth).expect(200)).body).toEqual([]);
  });
});
