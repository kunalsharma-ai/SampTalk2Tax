import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * EXP-025: expense forecasting against the real API and database. Approved claims over six
 * months make a forecast by account with a range; an account used once is listed as occasional;
 * money owed to employees and claims waiting for approval are shown; drafts and rejected claims
 * do not count.
 */
const H = 3_600_000;
const T = new Date(Date.now() + 5.5 * H).toISOString().slice(0, 10);
const monthDay = (back: number, day = 10) => {
  // This month's claims are dated today, so they are never in the future.
  if (back === 0) return T;
  const d = new Date(Date.parse(`${T.slice(0, 7)}-01T00:00:00Z`));
  d.setUTCMonth(d.getUTCMonth() - back);
  return `${d.toISOString().slice(0, 8)}${String(day).padStart(2, '0')}`;
};

let ctx: Ctx;
let owner: TestUser;
let employee: TestUser;
let approver: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;

async function claim(lines: { back: number; code: string; amount: string }[], then: 'draft' | 'submit' | 'approve' | 'reimburse' | 'reject') {
  const c = (await ctx.http().post(`${org.base}/expense-claims`).set(employee.auth).send({ title: 'Synthetic trip', lines: lines.map((l) => ({ date: monthDay(l.back), accountId: org.acc[l.code], merchant: 'Synthetic Travels', amount: l.amount })) }).expect(201)).body;
  if (then === 'draft') return c;
  await ctx.http().post(`${org.base}/expense-claims/${c.id}/submit`).set(employee.auth).send({}).expect(200);
  if (then === 'reject') return (await ctx.http().post(`${org.base}/expense-claims/${c.id}/reject`).set(approver.auth).send({ note: 'Not a business trip' }).expect(200)).body;
  if (then === 'submit') return c;
  await ctx.http().post(`${org.base}/expense-claims/${c.id}/approve`).set(approver.auth).send({}).expect(200);
  if (then === 'reimburse') await ctx.http().post(`${org.base}/expense-claims/${c.id}/reimburse`).set(owner.auth).send({ bankAccountId: org.acc['1120'], date: T }).expect(200);
  return c;
}

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Forecast Owner');
  employee = await registerUser(ctx, 'Forecast Employee');
  approver = await registerUser(ctx, 'Forecast Approver');
  org = await createOrg(ctx, owner, { name: 'Expense Forecast Pvt Ltd' });
  for (const [u, role] of [[employee, 'EMPLOYEE'], [approver, 'APPROVER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('expense forecast', () => {
  it('has nothing to forecast before any claim', async () => {
    const f = (await ctx.http().get(`${org.base}/expense-forecast`).set(owner.auth).expect(200)).body;
    expect(f).toMatchObject({ currency: 'INR', accounts: [], occasional: [], thisMonthSoFar: '0.00', owed: { approvedNotPaid: '0.00', approvedClaims: 0, waitingApproval: '0.00', waitingClaims: 0 } });
    expect(f.months).toHaveLength(3);
  });

  it('forecasts each account from approved claims, with a range, and lists what is owed', async () => {
    // Travel (6700): 3000, 3000, 3000, 4000, 5000, 6000 over the last six full months, all paid back.
    for (const [back, amount] of [[6, '3000.00'], [5, '3000.00'], [4, '3000.00'], [3, '4000.00'], [2, '5000.00'], [1, '6000.00']] as const) await claim([{ back, code: '6700', amount }], 'reimburse');
    // Office supplies (6600) once, five months ago: occasional.
    await claim([{ back: 5, code: '6600', amount: '2500.00' }], 'reimburse');
    // This month: approved and owed, plus one waiting; drafts and rejections do not count.
    await claim([{ back: 0, code: '6700', amount: '1200.00' }], 'approve');
    await claim([{ back: 0, code: '6700', amount: '700.00' }], 'submit');
    await claim([{ back: 1, code: '6700', amount: '99999.00' }], 'draft');
    await claim([{ back: 1, code: '6700', amount: '88888.00' }], 'reject');

    const f = (await ctx.http().get(`${org.base}/expense-forecast?months=2`).set(owner.auth).expect(200)).body;
    expect(f.months).toEqual([monthDay(0).slice(0, 7), monthDay(-1).slice(0, 7)]);
    expect(f.accounts).toHaveLength(1);
    const travel = f.accounts[0];
    expect(travel).toMatchObject({ accountId: org.acc['6700'], method: 'RECENT_AVERAGE', thisMonthSoFar: '1200.00', trendPercent: '66.7' });
    expect(travel.months[0]).toEqual({ month: monthDay(0).slice(0, 7), forecast: '5000.00', low: '3845.30', high: '6154.70' });
    expect(travel.history.slice(-6).map((h: { amount: string }) => h.amount)).toEqual(['3000.00', '3000.00', '3000.00', '4000.00', '5000.00', '6000.00']);
    expect(f.occasional).toEqual([expect.objectContaining({ accountId: org.acc['6600'], lastSpent: monthDay(5), total12Months: '2500.00' })]);
    expect(f.totals[1]).toEqual({ month: monthDay(-1).slice(0, 7), forecast: '5000.00', low: '3845.30', high: '6154.70' });
    expect(f.thisMonthSoFar).toBe('1200.00');
    expect(f.owed).toEqual({ approvedNotPaid: '1200.00', approvedClaims: 1, waitingApproval: '700.00', waitingClaims: 1 });
  });

  it('checks the horizon and who may read it', async () => {
    await ctx.http().get(`${org.base}/expense-forecast?months=7`).set(owner.auth).expect(400);
    await ctx.http().get(`${org.base}/expense-forecast?months=0`).set(owner.auth).expect(400);
    expect((await ctx.http().get(`${org.base}/expense-forecast?months=6`).set(approver.auth).expect(200)).body.months).toHaveLength(6);
    await ctx.http().get(`${org.base}/expense-forecast`).set(employee.auth).expect(403);
    const other = await createOrg(ctx, owner, { name: 'Other Forecast Ltd' });
    expect((await ctx.http().get(`${other.base}/expense-forecast`).set(owner.auth).expect(200)).body.accounts).toEqual([]);
  });
});
