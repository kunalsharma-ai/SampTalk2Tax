import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';
import { todayIst } from '../src/cash-flow/cash-flow.service';

/**
 * Opportunity intelligence against the real API and database: lapsed customers, a line to
 * cross-sell and a slipped margin found in twelve months of posted sales, each measured; taking
 * one forward as an impact assessment; permissions, tenant isolation and proof nothing is posted.
 */
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let employee: TestUser;
let outsider: TestUser;
type Org = Awaited<ReturnType<typeof createOrg>>;
let org: Org;
let other: Org;
let journalsBefore = 0;
const names: Record<string, string> = {};

const shift = (ym: string, n: number) => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const t = y * 12 + m - 1 + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const fyOf = (ym: string) => (+ym.slice(5, 7) >= 4 ? +ym.slice(0, 4) + 1 : +ym.slice(0, 4));
const LAST = shift(todayIst().slice(0, 7), -1);
const M = (k: number) => shift(LAST, k - 11); // M(0) = oldest of the twelve months, M(11) = last month
const journalCount = () => ctx.prisma.journalEntry.count({ where: { orgId: org.orgId } });

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Opp Owner');
  viewer = await registerUser(ctx, 'Opp Viewer');
  employee = await registerUser(ctx, 'Opp Employee');
  outsider = await registerUser(ctx, 'Opp Outsider');
  org = await createOrg(ctx, owner, { name: 'Opportunity Co' });
  other = await createOrg(ctx, outsider, { name: 'Other Opportunity Co' });
  for (const [u, role] of [[viewer, 'VIEWER'], [employee, 'EMPLOYEE']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  const years = new Set(((await ctx.http().get(`${org.base}/periods`).set(owner.auth).expect(200)).body as { fiscalYear: number }[]).map((p) => p.fiscalYear));
  for (const fy of new Set(Array.from({ length: 12 }, (_, k) => fyOf(M(k))))) if (!years.has(fy)) await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fy }).expect(201);
  const contact = async (name: string) => (names[name] = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name, isCustomer: true }).expect(201)).body.id as string);
  const vendor = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Mill Supplies', isVendor: true }).expect(201)).body.id as string;
  for (const n of ['Lapsed Ltd', 'Alpha', 'Beta', 'Gamma', 'Delta']) await contact(n);
  // A second revenue line.
  const acc = (await ctx.http().post(`${org.base}/accounts`).set(owner.auth).send({ code: '4150', name: 'Warehousing', type: 'REVENUE' }).expect(201)).body.id as string;
  const invoice = (who: string, month: string, lines: [string, string][]) =>
    ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: names[who], issueDate: `${month}-02`, dueDate: `${month}-20`, post: true, lines: lines.map(([a, p]) => ({ accountId: a, quantity: '1', unitPrice: p })) }).expect(201);
  const bill = (month: string, amount: string) =>
    ctx.http().post(`${org.base}/purchases/documents`).set(owner.auth).send({ kind: 'BILL', contactId: vendor, issueDate: `${month}-03`, reference: `B-${month}`, post: true, lines: [{ accountId: org.acc['5000'], quantity: '1', unitPrice: amount }] }).expect(201);
  for (let k = 0; k < 12; k++) {
    const m = M(k);
    if (k < 6) await invoice('Lapsed Ltd', m, [[org.acc['4100']!, '30000.00']]);
    for (const n of ['Alpha', 'Beta', 'Gamma']) await invoice(n, m, [[org.acc['4100']!, '20000.00'], [acc, '10000.00']]);
    await invoice('Delta', m, [[org.acc['4100']!, '50000.00']]);
    // Cost of sales 40% of sales in the nine earlier months, then 50% in the last three.
    await bill(m, k < 9 ? (k < 6 ? '68000.00' : '56000.00') : '70000.00');
  }
  journalsBefore = await journalCount();
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('opportunity intelligence', () => {
  it('finds lapsed customers, a line to cross-sell and a slipped margin, each measured', async () => {
    const r = (await ctx.http().get(`${org.base}/opportunities?horizonMonths=12`).set(viewer.auth).expect(200)).body;
    expect(r.window).toEqual({ from: M(0), to: M(11) });
    const kinds = r.opportunities.map((o: { kind: string }) => o.kind).sort();
    expect(kinds).toEqual(['CROSS_SELL', 'MARGIN_RECOVERY', 'WIN_BACK']);
    const win = r.opportunities.find((o: { kind: string }) => o.kind === 'WIN_BACK');
    expect(win.title).toBe('Win back 1 lapsed customer');
    expect(win.evidence.rows[0].slice(0, 2)).toEqual(['Lapsed Ltd', '6']);
    // 1,80,000 over nine months = 20,000 a month; 25% of it.
    expect(win.changes[0]).toMatchObject({ lever: 'NEW_CUSTOMER', monthlyRevenue: '5000.00' });
    expect(Number(win.effect.netProfit)).toBeGreaterThan(0);
    const cross = r.opportunities.find((o: { kind: string }) => o.kind === 'CROSS_SELL');
    expect(cross.title).toBe('Sell Warehousing to 1 more customer');
    expect(cross.evidence.rows).toEqual([['Delta', 'INR 600000.00']]);
    const margin = r.opportunities.find((o: { kind: string }) => o.kind === 'MARGIN_RECOVERY');
    expect(margin.finding).toMatch(/^Gross margin was 60\.0% from .* and 50\.0% from /);
    expect(margin.changes[0]).toEqual({ lever: 'PRICE_CHANGE', pricePercent: '25.00', volumePercent: '0', month: 2 });
    expect(r.checks.find((c: { kind: string }) => c.kind === 'GROW_SEGMENT').note).toBe('No sales are tagged to departments or projects.');
    const profits = r.opportunities.map((o: { effect: { netProfit: string } }) => Number(o.effect.netProfit));
    expect(profits).toEqual([...profits].sort((a, b) => b - a));
  });

  it('uses the rates given and explains bad ones', async () => {
    const r = (await ctx.http().get(`${org.base}/opportunities?horizonMonths=12&winBackRatePercent=50`).set(viewer.auth).expect(200)).body;
    expect(r.opportunities.find((o: { kind: string }) => o.kind === 'WIN_BACK').changes[0].monthlyRevenue).toBe('10000.00');
    const bad = (await ctx.http().get(`${org.base}/opportunities?crossSellRatePercent=150`).set(viewer.auth).expect(422)).body;
    expect(bad.details.issues).toEqual(['Customers taking up the line (%) must be a number above 0 and at most 100']);
    expect((await ctx.http().get(`${other.base}/opportunities`).set(outsider.auth).expect(422)).body.message).toBe('There are no posted sales in the last twelve months to look for opportunities in');
  });

  it('takes an opportunity forward as an impact assessment', async () => {
    await ctx.http().post(`${org.base}/opportunities/WIN_BACK/assessment?horizonMonths=12`).set(viewer.auth).expect(403);
    const a = (await ctx.http().post(`${org.base}/opportunities/WIN_BACK/assessment?horizonMonths=12`).set(owner.auth).expect(201)).body;
    expect(a).toMatchObject({ number: 'BI-0001', name: 'Win back 1 lapsed customer', horizonMonths: 12, problem: null });
    expect(a.description).toMatch(/^From opportunity intelligence: 1 customer bought/);
    expect(a.result.changes[0].title).toBe('Win back: 1 lapsed customer');
    const again = (await ctx.http().post(`${org.base}/opportunities/WIN_BACK/assessment?horizonMonths=12`).set(owner.auth).expect(201)).body;
    expect(again.name).toBe('Win back 1 lapsed customer (2)');
    await ctx.http().post(`${org.base}/opportunities/GROW_SEGMENT:nothing/assessment`).set(owner.auth).expect(404);
  });

  it('never posts, and stays within the organisation and its permissions', async () => {
    expect(await journalCount()).toBe(journalsBefore);
    await ctx.http().get(`${org.base}/opportunities`).set(employee.auth).expect(403);
    await ctx.http().get(`${org.base}/opportunities`).set(outsider.auth).expect(404);
  });
});
