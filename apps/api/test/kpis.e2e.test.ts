import { D, fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * KPIs and the monthly management report against the real API and database, with every
 * figure worked out by hand from the postings below. "M" is the last complete month.
 */
let ctx: Ctx;
let owner: TestUser;
let approver: TestUser;
let viewer: TestUser;
let stranger: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let M: string;
const contacts: Record<string, string> = {};

const shift = (month: string, by: number) => {
  const m = +month.slice(5, 7) - 1 + by;
  const y = +month.slice(0, 4) + Math.floor(m / 12);
  return `${y}-${String((((m % 12) + 12) % 12) + 1).padStart(2, '0')}`;
};
const daysIn = (month: string) => new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate();
const day = (month: string, d: number) => `${month}-${String(d).padStart(2, '0')}`;
const journal = (date: string, debit: string, credit: string, amount: string) =>
  ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date, post: true, memo: 'KPI test', lines: [{ accountId: org.acc[debit], debit: amount }, { accountId: org.acc[credit], credit: amount }] }).expect(201);
const invoice = async (who: string, date: string, amount: string) =>
  (await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: contacts[who], issueDate: date, dueDate: date, post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: amount }] }).expect(201)).body;
const round1 = (x: InstanceType<typeof D>) => x.toDecimalPlaces(1).toFixed(1);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'KPI Owner');
  approver = await registerUser(ctx, 'KPI Approver');
  viewer = await registerUser(ctx, 'KPI Viewer');
  stranger = await registerUser(ctx, 'KPI Stranger');
  org = await createOrg(ctx, owner);
  for (const [u, role] of [[approver, 'APPROVER'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  M = (await ctx.http().get(`${org.base}/kpis`).set(owner.auth).expect(200)).body.month;
  const fyM = fiscalYearForDate(`${M}-01`, 4);
  for (const fy of [fyM - 1, fyM]) await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fy });
  for (const [name, kind] of [['Alpha Retail', 'isCustomer'], ['Beta Foods', 'isCustomer'], ['Granite Supplies', 'isVendor']] as const) {
    contacts[name] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name, [kind]: true }).expect(201)).body.id;
  }
  // A year before M: capital and some revenue.
  const Y = shift(M, -12);
  await journal(day(Y, 15), '1120', '3100', '1000000.00');
  await journal(day(Y, 15), '1120', '4100', '50000.00');
  // The month before M: an invoice, rent paid, a loan.
  const P = shift(M, -1);
  const first = await invoice('Alpha Retail', day(P, 10), '60000.00');
  await journal(day(P, 12), '6200', '1120', '20000.00');
  await journal(day(P, 12), '1120', '2700', '100000.00');
  // M: two invoices, cost of sales, payroll, rent, a bill, and the first invoice paid.
  await invoice('Alpha Retail', day(M, 5), '70000.00');
  await invoice('Beta Foods', day(M, 5), '30000.00');
  await journal(day(M, 6), '5000', '1120', '40000.00');
  await journal(day(M, 7), '6100', '1120', '25000.00');
  await journal(day(M, 8), '6200', '1120', '10000.00');
  await ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: contacts['Granite Supplies'], issueDate: day(M, 9), reference: 'GS-1', post: true, lines: [{ accountId: org.acc['6400'], quantity: '1', unitPrice: '15000.00' }] }).expect(201);
  await ctx.http().post(`${org.base}/sales/payments`).set(owner.auth).send({ contactId: contacts['Alpha Retail'], date: day(M, 20), bankAccountId: org.acc['1120'], amount: '60000.00', allocations: [{ documentId: first.id, amount: '60000.00' }] }).expect(201);
});
afterAll(async () => {
  await ctx.app.close();
});

describe('KPIs', () => {
  it('computes every KPI for the last complete month from posted journals', async () => {
    const r = (await ctx.http().get(`${org.base}/kpis`).set(viewer.auth).expect(200)).body;
    expect(r).toMatchObject({ currency: 'INR', month: M, from: `${M}-01`, to: day(M, daysIn(M)), inProgress: false, previousMonth: shift(M, -1), sameMonthLastYear: shift(M, -12) });
    const k = Object.fromEntries(r.kpis.map((x: { key: string }) => [x.key, x]));
    const days3 = [-2, -1, 0].reduce((a, i) => a + daysIn(shift(M, i)), 0);
    expect(Object.fromEntries(Object.entries(k).map(([key, v]) => [key, (v as { value: string | null }).value]))).toEqual({
      revenue: '100000.00',
      grossMargin: '60.0',
      operatingMargin: '10.0', // 1,00,000 − 40,000 − (25,000 + 10,000 + 15,000)
      netMargin: '10.0',
      opexRatio: '50.0',
      currentRatio: '81.00', // (11,15,000 cash + 1,00,000 receivables) ÷ 15,000 payables
      quickRatio: '81.00',
      workingCapital: '1200000.00',
      debtToEquity: '0.10', // 1,15,000 ÷ 11,00,000
      dso: round1(new D(100000).dividedBy(160000).times(days3)),
      dpo: round1(new D(15000).dividedBy(85000).times(days3)), // 20,000 + 65,000 of spending
      netCashFlow: '21666.67', // (0 + 80,000 − 15,000) ÷ 3
      runway: null,
    });
    expect(k.runway.reason).toBe('Cash is not falling');
    expect(k.revenue).toMatchObject({ previous: '60000.00', change: '40000.00', improved: true, lastYear: '50000.00', unit: 'MONEY', better: 'HIGHER' });
    expect(k.revenue.series).toHaveLength(13);
    expect(k.revenue.series[0]).toEqual({ month: shift(M, -12), value: '50000.00' });
    expect(k.currentRatio.components).toEqual([{ label: 'Current assets', amount: '1215000.00' }, { label: 'Current liabilities', amount: '15000.00' }]);
    // Revenue by customer over the last 12 months (the journal a year ago had no customer).
    expect(r.customers).toMatchObject({ total: '160000.00', customers: 2, largestShare: '81.2', top: [{ name: 'Alpha Retail', revenue: '130000.00', share: '81.2' }, { name: 'Beta Foods', revenue: '30000.00', share: '18.8' }] });
  });

  it('shows a month in progress and refuses a month not started', async () => {
    const now = (await ctx.http().get(`${org.base}/kpis?month=${shift(M, 1)}`).set(viewer.auth).expect(200)).body;
    expect(now.inProgress).toBe(true);
    expect((await ctx.http().get(`${org.base}/kpis?month=${shift(M, 2)}`).set(viewer.auth).expect(422)).body.error).toBe('INVALID_MONTH');
    await ctx.http().get(`${org.base}/kpis?month=2026-13`).set(viewer.auth).expect(400);
  });

  it('keeps targets and says whether each is met', async () => {
    await ctx.http().put(`${org.base}/kpis/targets/dso`).set(viewer.auth).send({ comparator: 'AT_MOST', target: '30' }).expect(403);
    await ctx.http().put(`${org.base}/kpis/targets/dso`).set(owner.auth).send({ comparator: 'AT_MOST', target: '30', note: 'Collect within a month' }).expect(200);
    await ctx.http().put(`${org.base}/kpis/targets/currentRatio`).set(owner.auth).send({ comparator: 'AT_LEAST', target: '1.5' }).expect(200);
    await ctx.http().put(`${org.base}/kpis/targets/runway`).set(owner.auth).send({ comparator: 'AT_LEAST', target: '12' }).expect(200);
    expect((await ctx.http().put(`${org.base}/kpis/targets/dso`).set(owner.auth).send({ comparator: 'AT_MOST', target: '-1' }).expect(422)).body.message).toMatch(/cannot be negative/);
    await ctx.http().put(`${org.base}/kpis/targets/ebitda`).set(owner.auth).send({ comparator: 'AT_MOST', target: '1' }).expect(400);
    await ctx.http().put(`${org.base}/kpis/targets/dso`).set(owner.auth).send({ comparator: 'AT_MOST', target: '1.23456' }).expect(400);
    const k = Object.fromEntries((await ctx.http().get(`${org.base}/kpis`).set(viewer.auth).expect(200)).body.kpis.map((x: { key: string }) => [x.key, x]));
    expect(k.dso.target).toEqual({ comparator: 'AT_MOST', target: '30', note: 'Collect within a month', status: 'MISSED' });
    expect(k.currentRatio.target.status).toBe('MET');
    expect(k.runway.target.status).toBe('NO_VALUE');
    await ctx.http().delete(`${org.base}/kpis/targets/runway`).set(owner.auth).expect(200);
    await ctx.http().delete(`${org.base}/kpis/targets/runway`).set(owner.auth).expect(404);
    expect((await ctx.http().get(`${org.base}/kpis/targets`).set(viewer.auth).expect(200)).body.map((t: { kpi: string }) => t.kpi)).toEqual(['currentRatio', 'dso']);
    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, entityType: 'kpi_target' }, select: { action: true } });
    expect(audit.map((a) => a.action).sort()).toEqual(['kpi.target_removed', 'kpi.target_set', 'kpi.target_set', 'kpi.target_set']);
  });
});

describe('the management report', () => {
  const fyM = () => fiscalYearForDate(`${M}-01`, 4);
  // Months of M's fiscal year up to and including M.
  const monthsSoFar = () => ((+M.slice(5, 7) - 4 + 12) % 12) + 1;

  it('compares the month with the month before, a year before and the approved budget', async () => {
    const b = (await ctx.http().post(`${org.base}/budgets`).set(owner.auth).send({ basis: 'EMPTY', fiscalYear: fyM(), name: 'Plan' }).expect(201)).body.budget.id;
    await ctx.http().put(`${org.base}/budgets/${b}/lines`).set(owner.auth).send({ lines: [{ accountId: org.acc['4100'], amounts: Array(12).fill('80000.00') }, { accountId: org.acc['6200'], amounts: Array(12).fill('12000.00') }] }).expect(200);
    await ctx.http().post(`${org.base}/budgets/${b}/submit`).set(owner.auth).expect(200);
    await ctx.http().post(`${org.base}/budgets/${b}/approve`).set(approver.auth).expect(200);

    const r = (await ctx.http().get(`${org.base}/management-reports/${M}`).set(viewer.auth).expect(200)).body;
    expect(r).toMatchObject({ month: M, status: 'DRAFT', commentary: '', inProgress: false, fiscalYear: fyM(), budget: { label: 'v1 Plan' }, changedSince: [] });
    const line = Object.fromEntries(r.lines.map((l: { key: string }) => [l.key, l]));
    expect(line.operatingRevenue).toMatchObject({ actual: '100000.00', previous: '60000.00', lastYear: '50000.00', budget: '80000.00', variance: '20000.00', favourable: true });
    expect(line.operatingExpenses).toMatchObject({ actual: '50000.00', previous: '20000.00', budget: '12000.00', variance: '38000.00', favourable: false });
    expect(line.grossProfit).toMatchObject({ actual: '60000.00', budget: '80000.00' });
    expect(line.netIncome).toMatchObject({ actual: '10000.00', previous: '40000.00', lastYear: '50000.00', budget: '68000.00', favourable: false });
    const both = fiscalYearForDate(`${shift(M, -1)}-01`, 4) === fyM();
    expect(line.operatingRevenue.ytd).toBe(both ? '160000.00' : '100000.00');
    expect(line.operatingRevenue.ytdBudget).toBe(new D(80000).times(monthsSoFar()).toFixed(2));
    expect(r.cash).toEqual({ opening: '1130000.00', change: '-15000.00', closing: '1115000.00' });
    expect(r.customers.top.map((c: { name: string; share: string }) => `${c.name} ${c.share}`)).toEqual(['Alpha Retail 70.0', 'Beta Foods 30.0']);
    expect(r.kpis.find((k: { key: string }) => k.key === 'grossMargin')).toMatchObject({ value: '60.0', previous: '100.0', change: '-40.0', improved: false });
  });

  it('saves commentary, then finalises the month so later postings do not change it', async () => {
    const list0 = (await ctx.http().get(`${org.base}/management-reports`).set(viewer.auth).expect(200)).body;
    expect(list0).toHaveLength(24);
    expect(list0[0]).toMatchObject({ month: shift(M, 1), ended: false, status: null });
    await ctx.http().put(`${org.base}/management-reports/${M}/commentary`).set(viewer.auth).send({ commentary: 'x' }).expect(403);
    const saved = (await ctx.http().put(`${org.base}/management-reports/${M}/commentary`).set(owner.auth).send({ commentary: 'Revenue beat plan; spending ran ahead of budget.' }).expect(200)).body;
    expect(saved).toMatchObject({ status: 'DRAFT', commentary: 'Revenue beat plan; spending ran ahead of budget.', updatedBy: 'KPI Owner' });
    await ctx.http().put(`${org.base}/management-reports/${M}/commentary`).set(owner.auth).send({ commentary: 'x'.repeat(10001) }).expect(400);

    expect((await ctx.http().post(`${org.base}/management-reports/${shift(M, 1)}/finalise`).set(owner.auth).expect(409)).body.error).toBe('MONTH_NOT_ENDED');
    const fin = (await ctx.http().post(`${org.base}/management-reports/${M}/finalise`).set(owner.auth).expect(200)).body;
    expect(fin).toMatchObject({ status: 'FINAL', finalisedBy: 'KPI Owner', commentary: 'Revenue beat plan; spending ran ahead of budget.' });
    await ctx.http().post(`${org.base}/management-reports/${M}/finalise`).set(owner.auth).expect(409);
    expect((await ctx.http().put(`${org.base}/management-reports/${M}/commentary`).set(owner.auth).send({ commentary: 'Changed' }).expect(409)).body.error).toBe('REPORT_FINAL');

    // A late posting into M: the final report keeps its figures and lists what changed.
    await journal(day(M, 28), '1120', '4100', '5000.00');
    const after = (await ctx.http().get(`${org.base}/management-reports/${M}`).set(viewer.auth).expect(200)).body;
    expect(after.lines.find((l: { key: string }) => l.key === 'operatingRevenue').actual).toBe('100000.00');
    expect(after.changedSince.map((c: { key: string; then: string; now: string }) => `${c.key} ${c.then} → ${c.now}`)).toEqual([
      'operatingRevenue 100000.00 → 105000.00',
      'grossProfit 60000.00 → 65000.00',
      'operatingProfit 10000.00 → 15000.00',
      'netIncome 10000.00 → 15000.00',
    ]);
    const list = (await ctx.http().get(`${org.base}/management-reports`).set(viewer.auth).expect(200)).body;
    expect(list.find((x: { month: string }) => x.month === M)).toMatchObject({ status: 'FINAL', hasCommentary: true, finalisedBy: 'KPI Owner', ended: true });
    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, entityType: 'management_report' }, select: { action: true } });
    expect(audit.map((a) => a.action)).toEqual(['management_report.commentary_saved', 'management_report.finalised']);
  });

  it('the database keeps a final report as it was', async () => {
    const raw = (sql: string, ...args: unknown[]) =>
      ctx.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('t2t.bypass', 'on', true)`);
        return tx.$executeRawUnsafe(sql, ...args);
      });
    await expect(raw(`UPDATE management_reports SET commentary = 'edited' WHERE org_id = $1::uuid`, org.orgId)).rejects.toThrow(/immutable/);
    await expect(raw(`DELETE FROM management_reports WHERE org_id = $1::uuid`, org.orgId)).rejects.toThrow(/cannot be deleted/);
    await expect(raw(`INSERT INTO management_reports (id, org_id, month, status, snapshot, finalised_by_id, finalised_at, updated_by_id, updated_at) VALUES (gen_random_uuid(), $1::uuid, '2020-01-01', 'FINAL', '{}', $2::uuid, now(), $2::uuid, now())`, org.orgId, owner.id)).rejects.toThrow(/starts as a draft/);
    await expect(raw(`INSERT INTO management_reports (id, org_id, month, updated_by_id, updated_at) VALUES (gen_random_uuid(), $1::uuid, '2020-01-15', $2::uuid, now())`, org.orgId, owner.id)).rejects.toThrow(/check/i);
    await expect(raw(`INSERT INTO kpi_targets (id, org_id, kpi, comparator, target, updated_by_id, updated_at) VALUES (gen_random_uuid(), $1::uuid, 'ebitda', 'AT_LEAST', 1, $2::uuid, now())`, org.orgId, owner.id)).rejects.toThrow(/check/i);
  });

  it('keeps each organisation’s figures to itself', async () => {
    await ctx.http().get(`${org.base}/kpis`).set(stranger.auth).expect(404);
    await ctx.http().get(`${org.base}/management-reports/${M}`).set(stranger.auth).expect(404);
    const other = await createOrg(ctx, stranger);
    const r = (await ctx.http().get(`${other.base}/management-reports/${M}`).set(stranger.auth).expect(200)).body;
    expect(r).toMatchObject({ status: 'DRAFT', commentary: '', customers: { customers: 0 } });
    expect(r.lines.every((l: { actual: string }) => l.actual === '0.00')).toBe(true);
    expect((await ctx.http().get(`${other.base}/kpis/targets`).set(stranger.auth).expect(200)).body).toEqual([]);
  });
});
