import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * General ledger foundation (GL-008, GL-015, GL-017, GL-022) against the real API and database:
 * fiscal calendars for any starting month, multi-period posting, adjusting journals kept apart by
 * type, and the account ledger report across periods. Posting controls (GL-019) are covered in
 * ledger.e2e (balance, header accounts, locks, immutability), auth-tenancy.e2e (roles) and
 * journal-approvals.e2e (approval policy); the controls on adjusting journals are checked here.
 */
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
type Period = { id: string; name: string; fiscalYear: number; startDate: string; endDate: string; status: string };
const periodsOf = async (base: string) => ((await ctx.http().get(`${base}/periods`).set(owner.auth).expect(200)).body as Period[]).sort((a, b) => a.startDate.localeCompare(b.startDate));
const je = (acc: Record<string, string>, dr: string, cr: string, amount: string, extra: Record<string, unknown> = {}) => ({ date: today(), post: true, lines: [{ accountId: acc[dr], debit: amount }, { accountId: acc[cr], credit: amount }], ...extra });

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'GL Owner');
  viewer = await registerUser(ctx, 'GL Viewer');
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('fiscal calendars (GL-017)', () => {
  it.each([
    [1, '01-01', '12-31'],
    [4, '04-01', '03-31'],
    [7, '07-01', '06-30'],
    [10, '10-01', '09-30'],
  ])('a year starting in month %i has twelve months, first to last day, with no gaps', async (month, first, last) => {
    const org = await createOrg(ctx, owner, { name: `Calendar ${month} Ltd`, fiscalYearStartMonth: month });
    const ps = await periodsOf(org.base);
    expect(ps).toHaveLength(12);
    expect(ps[0].startDate.slice(5)).toBe(first);
    expect(ps[11].endDate.slice(5)).toBe(last);
    for (let i = 1; i < 12; i++) {
      const next = new Date(Date.parse(`${ps[i - 1].endDate}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      expect(ps[i].startDate).toBe(next);
    }
    expect(new Set(ps.map((p) => p.fiscalYear)).size).toBe(1);
    // Today falls inside the year made at onboarding.
    expect(ps[0].startDate <= today() && today() <= ps[11].endDate).toBe(true);
    // The next year continues straight on.
    const fy = ps[0].fiscalYear + 1;
    const next = (await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fy }).expect(201)).body as Period[];
    const nextFirst = [...next].sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
    expect(nextFirst.startDate).toBe(new Date(Date.parse(`${ps[11].endDate}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10));
  });

  it('refuses a starting month outside 1 to 12', async () => {
    await ctx.http().post('/v1/orgs').set(owner.auth).send({ name: 'Bad Calendar Ltd', countryCode: 'IN', functionalCurrency: 'INR', fiscalYearStartMonth: 13 }).expect(400);
  });
});

describe('multi-period posting (GL-015)', () => {
  it('posts into any open month, and a locked month stops only journals dated in it', async () => {
    const org = await createOrg(ctx, owner, { name: 'Periods Ltd' });
    const ps = await periodsOf(org.base);
    const [a, b] = [ps[0], ps[1]];
    const first = (await ctx.http().post(`${org.base}/journals`).set(owner.auth).send(je(org.acc, '1120', '3100', '100.00', { date: a.endDate })).expect(201)).body;
    const second = (await ctx.http().post(`${org.base}/journals`).set(owner.auth).send(je(org.acc, '1120', '3100', '200.00', { date: b.startDate })).expect(201)).body;
    expect([first.date, second.date]).toEqual([a.endDate, b.startDate]);
    await ctx.http().post(`${org.base}/periods/${a.id}/lock`).set(owner.auth).expect(200);
    expect((await ctx.http().post(`${org.base}/journals`).set(owner.auth).send(je(org.acc, '1120', '3100', '1.00', { date: a.startDate })).expect(409)).body.error).toBe('PERIOD_NOT_OPEN');
    await ctx.http().post(`${org.base}/journals`).set(owner.auth).send(je(org.acc, '1120', '3100', '1.00', { date: b.endDate })).expect(201);
    // A date with no period at all is refused, not filed somewhere else.
    const before = new Date(Date.parse(`${a.startDate}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    expect((await ctx.http().post(`${org.base}/journals`).set(owner.auth).send(je(org.acc, '1120', '3100', '1.00', { date: before }))).status).toBeGreaterThanOrEqual(400);
  });
});

describe('adjusting journals (GL-008)', () => {
  it('keeps adjusting journals as their own type, in the reports, and listable on their own', async () => {
    const org = await createOrg(ctx, owner, { name: 'Adjusting Ltd' });
    await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
    const ps = await periodsOf(org.base);
    const month = ps.find((p) => p.startDate <= today() && today() <= p.endDate)!;
    await ctx.http().post(`${org.base}/journals`).set(owner.auth).send(je(org.acc, '6200', '1120', '85000.00', { memo: 'Rent' })).expect(201);
    const adj = (await ctx.http().post(`${org.base}/journals`).set(owner.auth).send(je(org.acc, '6200', '2200', '85000.00', { type: 'ADJUSTING', date: month.endDate, memo: 'Accrue next month rent' })).expect(201)).body;
    expect(adj).toMatchObject({ type: 'ADJUSTING', status: 'POSTED', date: month.endDate });
    const list = (await ctx.http().get(`${org.base}/journals?type=ADJUSTING`).set(viewer.auth).expect(200)).body;
    expect(list.items.map((e: { id: string }) => e.id)).toEqual([adj.id]);
    const is = (await ctx.http().get(`${org.base}/reports/income-statement?from=${month.startDate}&to=${month.endDate}`).set(owner.auth).expect(200)).body;
    expect(JSON.stringify(is)).toContain('170000.00');
    // Viewers cannot make them; a reversal undoes one exactly.
    await ctx.http().post(`${org.base}/journals`).set(viewer.auth).send(je(org.acc, '6200', '2200', '1.00', { type: 'ADJUSTING' })).expect(403);
    await ctx.http().post(`${org.base}/journals/${adj.id}/reverse`).set(owner.auth).send({ date: month.endDate }).expect(201);
    const after = (await ctx.http().get(`${org.base}/reports/income-statement?from=${month.startDate}&to=${month.endDate}`).set(owner.auth).expect(200)).body;
    expect(JSON.stringify(after)).toContain('85000.00');
    expect(JSON.stringify(after)).not.toContain('170000.00');
    expect((await ctx.http().get(`${org.base}/journals?type=REVERSING`).set(owner.auth).expect(200)).body.total).toBe(1);
  });
});

describe('general ledger report (GL-022)', () => {
  it('opens with the balance before the range, lists only entries in it, and closes on the trial balance', async () => {
    const org = await createOrg(ctx, owner, { name: 'Ledger Report Ltd' });
    const ps = await periodsOf(org.base);
    const month = ps.find((p) => p.startDate <= today() && today() <= p.endDate)!;
    const earlier = ps[0].id === month.id ? null : ps[0];
    if (earlier) await ctx.http().post(`${org.base}/journals`).set(owner.auth).send(je(org.acc, '1120', '3100', '1000.00', { date: earlier.startDate })).expect(201);
    await ctx.http().post(`${org.base}/journals`).set(owner.auth).send(je(org.acc, '1120', '4100', '250.50', { date: month.startDate })).expect(201);
    await ctx.http().post(`${org.base}/journals`).set(owner.auth).send(je(org.acc, '6200', '1120', '100.25', { date: month.startDate })).expect(201);
    await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ ...je(org.acc, '1120', '4100', '999.00', { date: month.startDate }), post: false }).expect(201);
    const r = (await ctx.http().get(`${org.base}/reports/general-ledger?accountId=${org.acc['1120']}&from=${month.startDate}&to=${today()}`).set(owner.auth).expect(200)).body;
    expect(r.openingBalance).toBe(earlier ? '1000.00' : '0.00');
    expect(r.rows.map((x: { debit: string; credit: string }) => [x.debit, x.credit])).toEqual([
      ['250.50', '0.00'],
      ['0.00', '100.25'],
    ]);
    const opening = earlier ? 1000 : 0;
    expect(r.rows.map((x: { runningBalance: string }) => x.runningBalance)).toEqual([(opening + 250.5).toFixed(2), (opening + 150.25).toFixed(2)]);
    const tb = (await ctx.http().get(`${org.base}/reports/trial-balance?asOf=${today()}`).set(owner.auth).expect(200)).body as { rows: { code: string; netDebit: string }[] };
    expect(tb.rows.find((x) => x.code === '1120')!.netDebit).toBe(r.closingBalance);
    // From after to is refused rather than read as an empty ledger.
    await ctx.http().get(`${org.base}/reports/general-ledger?accountId=${org.acc['1120']}&from=${today()}&to=${month.startDate}`).set(owner.auth).expect(today() > month.startDate ? 400 : 200);
  });
});
