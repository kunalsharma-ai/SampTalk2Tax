import { addDays, addMonthsAnchored } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * Cash movement forecasting (BANK-022) against the real API and database: an imported statement
 * with monthly rent going out, a weekly settlement coming in and a few one-offs; the movements that
 * repeat, the weekly balance from the books, a shorter horizon, excluding a line, checks on the
 * query, permissions and tenant isolation.
 */
const T = today();
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let bank: string;
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const mapping = { date: 0, description: 1, reference: 2, amount: 3, dateFormat: 'DD/MM/YYYY', hasHeader: true };
type Recurring = { narration: string; direction: string; frequency: string; amount: string; count: number; running: boolean; next: { date: string; amount: string; late: boolean }[] };
type Week = { from: string; to: string; recurringIn: string; recurringOut: string; balance: string; low: string; high: string };
type Acc = { account: { id: string; name: string; currency: string }; startBalance: string; basis: { lines: number; otherWeeks: number }; recurring: Recurring[]; other: { weeklyIn: string; weeklyOut: string }; weeks: Week[]; endBalance: string; lowest: { balance: string; weekTo: string }; thin: boolean };
type Res = { asOf: string; days: number; summary: { accounts: number; recurring: number; belowZero: number }; accounts: Acc[] };
const get = async (query = '', user = owner) => (await ctx.http().get(`${org.base}/banking/cash-movements${query}`).set(user.auth).expect(200)).body as Res;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Movement Owner');
  viewer = await registerUser(ctx, 'Movement Viewer');
  outsider = await registerUser(ctx, 'Movement Outsider');
  org = await createOrg(ctx, owner, { name: 'Steady Cash Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Cash Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  bank = org.acc['1120']!;
  const csv = [
    'Date,Narration,Ref,Amount',
    ...[1, 2, 3, 4, 5, 6].map((k) => `${dmy(addMonthsAnchored(T, -k))},RENT SHREE ESTATES,,-50000.00`),
    ...Array.from({ length: 10 }, (_, k) => `${dmy(addDays(T, -7 * (k + 1)))},UPI CR SWIGGY SETTLEMENT ${k},,${k % 2 ? '13000.00' : '12000.00'}`),
    `${dmy(addDays(T, -20))},NEFT CR CUSTOMER A,UTR1,26000.00`,
    `${dmy(addDays(T, -11))},POS DR AMAZON,,-1300.00`,
  ].join('\n');
  await ctx.http().post(`${org.base}/banking/accounts/${bank}/imports`).set(owner.auth).send({ fileName: 'year.csv', csv, mapping }).expect(201);
  await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: T, memo: 'Opening balance', post: true, lines: [{ accountId: bank, debit: '300000.00' }, { accountId: org.acc['3100'], credit: '300000.00' }] }).expect(201);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('cash movement forecast', () => {
  it('projects what repeats on the statement and the rest, from the balance in the books', async () => {
    const r = await get('', viewer);
    expect(r).toMatchObject({ asOf: T, days: 90, summary: { accounts: 1, recurring: 2, belowZero: 0 } });
    const a = r.accounts[0]!;
    expect(a).toMatchObject({ account: { id: bank, name: 'Operating Bank Account', currency: 'INR' }, startBalance: '300000.00', basis: { lines: 18, otherWeeks: 13 }, thin: false });
    expect(a.recurring.map((x) => [x.narration, x.direction, x.frequency, x.amount, x.count, x.running])).toEqual([
      ['RENT SHREE ESTATES', 'OUT', 'MONTHLY', '-50000.00', 6, true],
      ['UPI CR SWIGGY SETTLEMENT 0', 'IN', 'WEEKLY', '12500.00', 10, true],
    ]);
    const end = addDays(T, 90);
    // From the last rent a month ago; one due today and not on a statement yet comes first, tomorrow.
    const last = addMonthsAnchored(T, -1);
    const rent = [1, 2, 3, 4].map((k) => addMonthsAnchored(last, k)).filter((d) => d <= end).map((d) => (d <= T ? addDays(T, 1) : d));
    expect(a.recurring[0]!.next.map((x) => x.date)).toEqual(rent);
    expect(a.recurring[1]!.next[0]).toEqual({ date: addDays(T, 1), amount: '12500.00', late: true });
    expect(a.other).toEqual({ weeklyIn: '2000.00', weeklyOut: '-100.00', lowNet: '0.00', highNet: '1900.00' });
    expect(a.weeks).toHaveLength(13);
    expect(a.weeks[0]).toMatchObject({ from: addDays(T, 1), to: addDays(T, 7), recurringIn: '25000.00' });
    for (const w of a.weeks) {
      expect(Number(w.low)).toBeLessThanOrEqual(Number(w.balance)); // not money: comparing forecast figures
      expect(Number(w.high)).toBeGreaterThanOrEqual(Number(w.balance)); // not money: comparing forecast figures
    }
    expect(a.endBalance).toBe(a.weeks.at(-1)!.balance);
  });

  it('takes a shorter horizon, and leaves excluded lines out', async () => {
    expect((await get('?days=30')).accounts[0]!.weeks).toHaveLength(5);
    const list = (await ctx.http().get(`${org.base}/banking/accounts/${bank}/lines?limit=100`).set(owner.auth).expect(200)).body.lines as { id: string; date: string; description: string }[];
    const rentLine = list.find((l) => l.description === 'RENT SHREE ESTATES' && l.date === addMonthsAnchored(T, -3))!;
    await ctx.http().post(`${org.base}/banking/lines/${rentLine.id}/exclude`).set(owner.auth).send({ reason: 'Paid twice by the bank, refunded' }).expect(200);
    expect((await get(`?accountId=${bank}`)).accounts[0]!.recurring.map((x) => x.narration)).toEqual(['UPI CR SWIGGY SETTLEMENT 0']);
  });

  it('checks the query', async () => {
    await ctx.http().get(`${org.base}/banking/cash-movements?days=45`).set(owner.auth).expect(400);
    await ctx.http().get(`${org.base}/banking/cash-movements?accountId=nope`).set(owner.auth).expect(400);
    await ctx.http().get(`${org.base}/banking/cash-movements?accountId=00000000-0000-4000-8000-000000000000`).set(owner.auth).expect(404);
  });

  it('keeps organisations apart', async () => {
    await ctx.http().get(`${org.base}/banking/cash-movements`).set(outsider.auth).expect(404);
    await ctx.http().get(`${other.base}/banking/cash-movements?accountId=${bank}`).set(outsider.auth).expect(404);
    expect(((await ctx.http().get(`${other.base}/banking/cash-movements`).set(outsider.auth).expect(200)).body as Res).accounts).toEqual([]);
  });
});
