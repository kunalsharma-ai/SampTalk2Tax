import { addDays, fiscalYearForDate, periodFor, reportPeriod } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Executive and investor reports (RPT-022, RPT-023) against the real API and database: the last
 * complete fiscal quarter against the quarter before and the same quarter last year, worked out by
 * hand from the postings below; customers named only for executives; the narrative saved and
 * finalised, later postings listed against the frozen copy; validation, permissions and tenants.
 */
const T = today();
let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const contacts: Record<string, string> = {};
const current = reportPeriod(periodFor(T, 4, 'QUARTER'), 4)!;
const Q = reportPeriod(current.prior, 4)!;
const P = reportPeriod(Q.prior, 4)!;
const L = reportPeriod(Q.lastYear, 4)!;
const day = (month: string, d: number) => `${month}-${String(d).padStart(2, '0')}`;
const R = (audience: string, period = Q.key) => `${org.base}/stakeholder-reports/${audience}/${period}`;
const NARRATIVE = { highlights: 'Two new retail customers.', challenges: 'Margins fell on higher input costs.', outlook: 'Price rise from next quarter.', asks: 'Approve the price rise.' };

const journal = (date: string, debit: string, credit: string, amount: string) =>
  ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date, post: true, memo: 'Stakeholder report test', lines: [{ accountId: org.acc[debit], debit: amount }, { accountId: org.acc[credit], credit: amount }] }).expect(201);
const invoice = (who: string, date: string, amount: string) =>
  ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: contacts[who], issueDate: date, dueDate: date, post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: amount }] }).expect(201);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Report Owner');
  accountant = await registerUser(ctx, 'Report Accountant');
  viewer = await registerUser(ctx, 'Report Viewer');
  outsider = await registerUser(ctx, 'Report Outsider');
  org = await createOrg(ctx, owner, { name: 'Board Ready Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Board Ltd' });
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  for (const fy of new Set([L.from, P.from, Q.from, T].map((d) => fiscalYearForDate(d, 4)))) await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fy });
  for (const name of ['Alpha Retail', 'Beta Foods']) contacts[name] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name, isCustomer: true }).expect(201)).body.id;
  // Same quarter last year: capital and some revenue.
  await journal(day(L.months[0]!, 10), '1120', '3100', '1000000.00');
  await journal(day(L.months[0]!, 10), '1120', '4100', '50000.00');
  // The quarter before: an invoice and cost of sales paid.
  await invoice('Alpha Retail', day(P.months[0]!, 10), '300000.00');
  await journal(day(P.months[0]!, 11), '5000', '1120', '90000.00');
  // The quarter: two invoices, cost of sales and rent paid.
  await invoice('Alpha Retail', day(Q.months[0]!, 10), '120000.00');
  await invoice('Beta Foods', day(Q.months[1]!, 10), '80000.00');
  await journal(day(Q.months[1]!, 12), '5000', '1120', '100000.00');
  await journal(day(Q.months[2]!, 12), '6200', '1120', '160000.00');
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('executive and investor reports', () => {
  it('works out the last quarter against the quarter before and last year', async () => {
    const r = (await ctx.http().get(R('executive')).set(viewer.auth).expect(200)).body;
    expect(r).toMatchObject({ title: `Executive report, ${Q.label}`, status: 'DRAFT', saved: false, inProgress: false, currency: 'INR', period: { key: Q.key, from: Q.from, to: Q.to }, prior: { key: P.key }, lastYear: { key: L.key } });
    expect(r.headline).toEqual({
      revenue: '200000.00',
      revenueGrowthPrior: '-33.3',
      revenueGrowthYear: '300.0',
      grossProfit: '100000.00',
      grossMargin: '50.0',
      grossMarginPrior: '70.0',
      operatingProfit: '-60000.00',
      netIncome: '-60000.00',
      netMargin: '-30.0',
      cashOpening: '960000.00',
      cashClosing: '700000.00',
      cashChange: '-260000.00',
      averageMonthlyCashChange: '-86666.67',
      runwayMonths: '8.1',
      receivables: '500000.00',
      payables: '0.00',
    });
    expect(r.lines.find((l: { key: string }) => l.key === 'operatingRevenue')).toMatchObject({ current: '200000.00', prior: '300000.00', lastYear: '50000.00', changePrior: '-33.3', changeYear: '300.0' });
    expect(r.months.map((m: { month: string; revenue: string }) => [m.month, m.revenue])).toEqual([[Q.months[0], '120000.00'], [Q.months[1], '80000.00'], [Q.months[2], '0.00']]);
    expect(r.attention.map((a: { code: string; severity: string }) => [a.code, a.severity])).toEqual([['NET_LOSS', 'HIGH'], ['REVENUE_DOWN', 'MEDIUM'], ['MARGIN_DOWN', 'MEDIUM'], ['SHORT_RUNWAY', 'MEDIUM'], ['CONCENTRATION', 'MEDIUM']]);
    expect(r.customers).toEqual({ count: 2, largestShare: '60.0', topFiveShare: '100.0', top: [{ name: 'Alpha Retail', revenue: '120000.00', share: '60.0' }, { name: 'Beta Foods', revenue: '80000.00', share: '40.0' }] });
  });

  it('never names customers or lists internal points in an investor report', async () => {
    const r = (await ctx.http().get(R('INVESTOR')).set(viewer.auth).expect(200)).body;
    expect(r.title).toBe(`Investor report, ${Q.label}`);
    expect(r.headline.revenue).toBe('200000.00');
    expect(r.attention).toEqual([]);
    expect(r.customers).toEqual({ count: 2, largestShare: '60.0', topFiveShare: '100.0', top: [] });
    expect(JSON.stringify(r)).not.toMatch(/Alpha Retail|Beta Foods/);
  });

  it('saves the narrative, finalises and lists later postings against the frozen copy', async () => {
    await ctx.http().put(`${R('executive')}/narrative`).set(viewer.auth).send(NARRATIVE).expect(403);
    const saved = (await ctx.http().put(`${R('executive')}/narrative`).set(accountant.auth).send(NARRATIVE).expect(200)).body;
    expect(saved).toMatchObject({ saved: true, status: 'DRAFT', narrative: NARRATIVE, updatedBy: 'Report Accountant' });
    await ctx.http().post(`${R('executive')}/finalise`).set(viewer.auth).expect(403);
    const final = (await ctx.http().post(`${R('executive')}/finalise`).set(owner.auth).expect(200)).body;
    expect(final).toMatchObject({ status: 'FINAL', finalisedBy: 'Report Owner', narrative: NARRATIVE, changedSince: [] });
    expect(final.headline.revenue).toBe('200000.00');

    await invoice('Beta Foods', day(Q.months[2]!, 20), '10000.00');
    const after = (await ctx.http().get(R('executive')).set(viewer.auth).expect(200)).body;
    expect(after.headline.revenue).toBe('200000.00');
    expect(after.changedSince).toEqual(expect.arrayContaining([{ key: 'operatingRevenue', label: 'Revenue', then: '200000.00', now: '210000.00' }]));
    // The investor report is separate and still a draft, so it shows the new figure.
    expect((await ctx.http().get(R('investor')).set(viewer.auth).expect(200)).body.headline.revenue).toBe('210000.00');

    expect((await ctx.http().put(`${R('executive')}/narrative`).set(owner.auth).send(NARRATIVE).expect(409)).body.error).toBe('REPORT_FINAL');
    expect((await ctx.http().post(`${R('executive')}/finalise`).set(owner.auth).expect(409)).body.error).toBe('REPORT_FINAL');
    const events = await ctx.db.collection('audit_events').find({ orgId: org.orgId, entityType: 'stakeholder_report' }).sort({ idNumber: 1 }).toArray();
    expect(events.map((e) => e.action).sort()).toEqual(['stakeholder_report.finalised', 'stakeholder_report.narrative_saved']);
    expect(events.find((e) => e.action === 'stakeholder_report.finalised')!.data).toMatchObject({ audience: 'EXECUTIVE', period: Q.key, revenue: '200000.00', netIncome: '-60000.00' });
  });

  it('lists saved reports and the periods to start from', async () => {
    const r = (await ctx.http().get(`${org.base}/stakeholder-reports`).set(viewer.auth).expect(200)).body;
    expect(r.suggested.slice(0, 2)).toEqual([{ key: current.key, label: current.label, ended: false }, { key: Q.key, label: Q.label, ended: true }]);
    expect(r.suggested.map((s: { key: string }) => s.key)).toEqual([current.key, Q.key, P.key, reportPeriod(P.prior, 4)!.key, reportPeriod(reportPeriod(P.prior, 4)!.prior, 4)!.key, `FY${current.fiscalYear}`, `FY${current.fiscalYear - 1}`, `FY${current.fiscalYear - 2}`]);
    expect(r.reports).toEqual([expect.objectContaining({ audience: 'EXECUTIVE', period: Q.key, label: Q.label, status: 'FINAL', finalisedBy: 'Report Owner' })]);
  });

  it('keeps the current quarter open and refuses periods that are malformed or not started', async () => {
    const live = (await ctx.http().get(R('executive', current.key)).set(viewer.auth).expect(200)).body;
    expect(live).toMatchObject({ inProgress: true, status: 'DRAFT' });
    expect((await ctx.http().post(`${R('executive', current.key)}/finalise`).set(owner.auth).expect(409)).body.error).toBe('PERIOD_NOT_ENDED');
    const next = reportPeriod(`FY${current.fiscalYear + 1}`, 4)!;
    expect((await ctx.http().get(R('executive', next.key)).set(viewer.auth).expect(422)).body.error).toBe('PERIOD_NOT_STARTED');
    await ctx.http().get(R('executive', '2026-Q1')).set(viewer.auth).expect(400);
    await ctx.http().get(R('board')).set(viewer.auth).expect(400);
    await ctx.http().put(`${R('investor')}/narrative`).set(owner.auth).send({ ...NARRATIVE, extra: 'x' }).expect(400);
    await ctx.http().put(`${R('investor')}/narrative`).set(owner.auth).send({ ...NARRATIVE, outlook: 'x'.repeat(5001) }).expect(400);
  });

  it('keeps each organisation to itself', async () => {
    await ctx.http().get(R('executive')).set(outsider.auth).expect(404);
    const theirs = (await ctx.http().get(`${other.base}/stakeholder-reports/executive/${Q.key}`).set(outsider.auth).expect(200)).body;
    expect(theirs.headline.revenue).toBe('0.00');
    expect((await ctx.http().get(`${other.base}/stakeholder-reports`).set(outsider.auth).expect(200)).body.reports).toEqual([]);
    expect(addDays(Q.to, 1) <= T).toBe(true);
  });
});
