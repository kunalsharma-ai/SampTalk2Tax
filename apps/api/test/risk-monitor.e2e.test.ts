import { addDays } from '@talk2tax/accounting-engine';
import { gstinCheckCharacter } from '@talk2tax/tax-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * DASH-036 against the real API and database: the risk monitor reads each area from the same
 * checks as its own page (alerts, payment fraud, expense risk, unusual bank activity, compliance
 * deadline risk, vendor risk), scores them, keeps one reading a day for the trend and compares
 * with the day before; reports.read; tenant isolation.
 */
const T = today();
const gstin = (state: string, pan: string) => `${state}${pan}1Z${gstinCheckCharacter(`${state}${pan}1Z`)}`;
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let employee: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
type Area = { area: string; name: string; href: string; high: number; medium: number; low: number; score: number; level: string; active: boolean; available: boolean; change: number | null; top: { title: string; level: string }[] };

const monitor = async (auth = viewer.auth) => (await ctx.http().get(`${org.base}/reports/risk-monitor`).set(auth).expect(200)).body;
const area = (r: { areas: Area[] }, key: string) => r.areas.find((a) => a.area === key)!;
const src = async (path: string) => (await ctx.http().get(`${org.base}${path}`).set(owner.auth).expect(200)).body;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Risk Owner');
  viewer = await registerUser(ctx, 'Risk Viewer');
  employee = await registerUser(ctx, 'Risk Employee');
  outsider = await registerUser(ctx, 'Risk Outsider');
  org = await createOrg(ctx, owner, { name: 'Risk Watch Traders Pvt Ltd' });
  for (const [u, role] of [[viewer, 'VIEWER'], [employee, 'EMPLOYEE']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
});
afterAll(async () => {
  await ctx.app.close();
});

describe('the risk monitor', () => {
  it('is clear for a new organisation, with compliance not yet set up', async () => {
    const r = await monitor();
    expect(r).toMatchObject({ today: T, score: 0, level: 'CLEAR', change: null, previous: null, complete: true, focus: [] });
    expect(r.areas.map((a: Area) => a.area)).toEqual(['ALERTS', 'PAYMENTS', 'EXPENSES', 'BANK', 'COMPLIANCE', 'VENDORS']);
    expect(area(r, 'COMPLIANCE')).toMatchObject({ active: false, available: true, score: 0, href: '/tax/compliance-predictions' });
    expect(area(r, 'VENDORS').active).toBe(false);
    expect(r.history).toEqual([{ date: T, score: 0, level: 'CLEAR', areas: { ALERTS: 0, PAYMENTS: 0, EXPENSES: 0, BANK: 0, COMPLIANCE: 0, VENDORS: 0 } }]);
  });

  it('scores overdue GST returns and agrees with each area\'s own checks', async () => {
    // Registered five months ago with nothing filed: the GST returns since are overdue.
    await ctx.http().put(`${org.base}/gst/registration`).set(owner.auth).send({ gstin: gstin('27', 'ZZZRM0001Z'), effectiveFrom: `${addDays(T, -150).slice(0, 7)}-01` }).expect(200);
    await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Unvetted Supplies', isVendor: true }).expect(201);
    const r = await monitor();
    const c = area(r, 'COMPLIANCE');
    const deadlines = await src('/compliance/predictions?days=30');
    expect(c).toMatchObject({ active: true, high: deadlines.summary.high, medium: deadlines.summary.medium, low: deadlines.summary.low });
    expect(c.high).toBeGreaterThanOrEqual(4);
    expect(c.score).toBe(Math.min(100, c.high * 25 + c.medium * 10 + c.low * 3));
    expect(c.level).toBe('SEVERE');
    expect(c.top.length).toBe(Math.min(3, c.high + c.medium + c.low));
    expect(c.top[0]!.title).toMatch(/GSTR/);
    expect(r.focus[0]).toBe('COMPLIANCE');
    expect(r.score).toBeGreaterThanOrEqual(60);

    const vendors = await src('/purchases/vendor-risk');
    expect(area(r, 'VENDORS')).toMatchObject({ active: true, high: vendors.totals.high, medium: vendors.totals.medium, low: vendors.totals.low });
    const fraud = await src('/payment-fraud');
    expect(area(r, 'PAYMENTS')).toMatchObject({ high: fraud.summary.high, medium: fraud.summary.medium, low: fraud.summary.low });
    const expenses = await src('/expense-risk?days=90');
    expect(area(r, 'EXPENSES')).toMatchObject({ high: expenses.summary.high, medium: expenses.summary.medium, low: expenses.summary.low });
    const bank = await src('/banking/unusual-activity?days=30');
    expect(area(r, 'BANK')).toMatchObject({ high: bank.summary.high, medium: bank.summary.medium, low: bank.summary.low });
    const alerts = await src('/alerts?status=ACTIVE');
    expect(area(r, 'ALERTS')).toMatchObject({ high: alerts.summary.critical, medium: alerts.summary.warning, low: alerts.summary.info });

    // Still one reading for today, now with the new score.
    expect(r.history).toHaveLength(1);
    expect(r.history[0]).toMatchObject({ date: T, score: r.score, areas: { COMPLIANCE: c.score } });
  });

  it('compares with the last earlier reading and keeps the trend', async () => {
    const before = addDays(T, -1);
    await ctx.db.collection<{ _id: string; [k: string]: unknown }>('risk_readings').insertOne({ _id: crypto.randomUUID(), orgId: org.orgId, date: before, score: 10, level: 'LOW', areas: [{ area: 'COMPLIANCE', score: 10, high: 0, medium: 1, low: 0, active: true }], takenAt: new Date() });
    await ctx.db.collection<{ _id: string; [k: string]: unknown }>('risk_readings').insertOne({ _id: crypto.randomUUID(), orgId: org.orgId, date: addDays(T, -200), score: 90, level: 'SEVERE', areas: [], takenAt: new Date() });
    const r = await monitor(owner.auth);
    expect(r.previous).toEqual({ date: before, score: 10, level: 'LOW' });
    expect(r.change).toBe(r.score - 10);
    expect(area(r, 'COMPLIANCE').change).toBe(area(r, 'COMPLIANCE').score - 10);
    expect(area(r, 'ALERTS').change).toBeNull();
    // The 200-day-old reading is outside the 90 days shown.
    expect(r.history.map((h: { date: string }) => h.date)).toEqual([before, T]);
  });

  it('needs reports access and keeps to its organisation', async () => {
    await ctx.http().get(`${org.base}/reports/risk-monitor`).set(employee.auth).expect(403);
    await ctx.http().get(`${org.base}/reports/risk-monitor`).set(outsider.auth).expect(404);
    const other = await createOrg(ctx, outsider, { name: 'Other Risk Ltd' });
    const r = (await ctx.http().get(`${other.base}/reports/risk-monitor`).set(outsider.auth).expect(200)).body;
    expect(r).toMatchObject({ score: 0, previous: null });
    expect(r.history).toHaveLength(1);
  });
});
