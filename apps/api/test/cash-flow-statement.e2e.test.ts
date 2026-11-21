import { addDays } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/** RPT-004: the statement of cash flows, read from posted journals. */
let ctx: Ctx;
let owner: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let yearStart: string;

const post = (date: string, debit: string, credit: string, amount: string) =>
  ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date, post: true, memo: `${debit}/${credit}`, lines: [{ accountId: org.acc[debit], debit: amount }, { accountId: org.acc[credit], credit: amount }] }).then((r) => { if (r.status !== 201) throw new Error(`${date} ${debit}/${credit}: ${JSON.stringify(r.body)}`); return r; });

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Owner');
  // The fiscal year starts next month, so it began eleven months ago and today is well inside it.
  const startMonth = (Number(today().slice(5, 7)) % 12) + 1;
  org = await createOrg(ctx, owner, { fiscalYearStartMonth: startMonth });
  const periods = (await ctx.http().get(`${org.base}/periods`).set(owner.auth).expect(200)).body as { startDate: string }[];
  yearStart = periods[0]!.startDate;
  await post(yearStart, '1120', '3100', '50000.00'); // before the statement: shares for cash
  const d = today();
  await post(d, '1120', '3100', '100000.00'); // more shares
  await post(d, '1510', '1120', '30000.00'); // equipment
  await post(d, '1120', '4100', '50000.00'); // cash sales
  await post(d, '1400', '1120', '12000.00'); // rent paid a year ahead
  await post(d, '6200', '1110', '10000.00'); // rent from petty cash
  await post(d, '1110', '1120', '15000.00'); // cash withdrawn for the till: not a cash flow
  await post(d, '6800', '1520', '3000.00'); // depreciation
  await post(d, '1120', '2700', '25000.00'); // loan
  await post(d, '6200', '2200', '8000.00'); // rent accrued, not yet paid
  await post(d, '3300', '1120', '2000.00'); // owner drew cash
});
afterAll(async () => {
  await ctx.app.close();
});

describe('statement of cash flows', () => {
  it('starts from profit, adds back depreciation and working capital, then investing and financing', async () => {
    const d = today();
    const s = (await ctx.http().get(`${org.base}/reports/cash-flow-statement?from=${d}&to=${d}`).set(owner.auth).expect(200)).body;
    expect(s.currency).toBe('INR');
    expect(s.profit).toBe('29000.00');
    expect(s.operating.lines.map((l: { code: string; amount: string }) => [l.code, l.amount])).toEqual([['1520', '3000.00'], ['1400', '-12000.00'], ['2200', '8000.00']]);
    expect(s.operating.total).toBe('28000.00');
    expect(s.investing).toEqual({ lines: [expect.objectContaining({ code: '1510', amount: '-30000.00', group: 'INVESTING' })], total: '-30000.00' });
    expect(s.financing.lines.map((l: { code: string; amount: string }) => [l.code, l.amount])).toEqual([['2700', '25000.00'], ['3100', '100000.00'], ['3300', '-2000.00']]);
    expect(s.financing.total).toBe('123000.00');
    expect(s.netChange).toBe('121000.00');
    expect(s.reconciles).toBe(true);
    expect(s.unexplained).toBe('0.00');
    expect(s.unclassified).toEqual([]);
  });

  it('opens and closes on the cash and bank balances of the balance sheet', async () => {
    const d = today();
    const s = (await ctx.http().get(`${org.base}/reports/cash-flow-statement?from=${d}&to=${d}`).set(owner.auth).expect(200)).body;
    expect(s.openingCash).toBe('50000.00');
    expect(s.closingCash).toBe('171000.00');
    const cashOn = async (asOf: string) => {
      const bs = (await ctx.http().get(`${org.base}/reports/balance-sheet?asOf=${asOf}`).set(owner.auth).expect(200)).body;
      const cents = bs.assets.filter((a: { subtype: string }) => a.subtype === 'CASH' || a.subtype === 'BANK').reduce((t: bigint, a: { amount: string }) => t + BigInt(a.amount.replace('.', '')), 0n);
      return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
    };
    expect(await cashOn(addDays(d, -1))).toBe(s.openingCash);
    expect(await cashOn(d)).toBe(s.closingCash);
  });

  it('covers the whole year, including what happened before today', async () => {
    const s = (await ctx.http().get(`${org.base}/reports/cash-flow-statement?from=${yearStart}&to=${today()}`).set(owner.auth).expect(200)).body;
    expect(s.openingCash).toBe('0.00');
    expect(s.financing.lines.find((l: { code: string }) => l.code === '3100').amount).toBe('150000.00');
    expect(s.closingCash).toBe('171000.00');
    expect(s.reconciles).toBe(true);
  });

  it('checks the dates and needs reports access', async () => {
    const d = today();
    expect((await ctx.http().get(`${org.base}/reports/cash-flow-statement?from=${d}&to=${addDays(d, -1)}`).set(owner.auth).expect(400)).body.error).toBe('INVALID_RANGE');
    await ctx.http().get(`${org.base}/reports/cash-flow-statement?from=${d}`).set(owner.auth).expect(400);
    const stranger = await registerUser(ctx, 'Stranger');
    await ctx.http().get(`${org.base}/reports/cash-flow-statement?from=${d}&to=${d}`).set(stranger.auth).expect(404);
  });
});
