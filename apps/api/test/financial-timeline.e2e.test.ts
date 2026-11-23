import { addDays, fiscalYearForDate } from '@talk2tax/accounting-engine';
import { gstinCheckCharacter } from '@talk2tax/tax-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * DASH-033 against the real API and database: the financial timeline buckets posted entries by
 * day, week or month with the cash they moved through cash and bank accounts and the cash balance
 * carried from before the range; transfers between cash accounts move nothing; closing entries
 * and drafts are left out; compliance deadlines fall in their buckets; ranges are checked;
 * reports.read and tenant isolation.
 */
const T = today();
const d = (k: number) => addDays(T, k);
const gstin = (state: string, pan: string) => `${state}${pan}1Z${gstinCheckCharacter(`${state}${pan}1Z`)}`;
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
const ids: Record<string, string> = {};

const journal = async (key: string, date: string, lines: object[], post = true, memo = key) => {
  const r = await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date, memo, reference: key, post, lines });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  ids[key] = r.body.id;
};
const get = async (query: Record<string, string>, auth = viewer.auth, status = 200) => (await ctx.http().get(`${org.base}/reports/timeline`).query(query).set(auth).expect(status)).body;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Timeline Owner');
  viewer = await registerUser(ctx, 'Timeline Viewer');
  outsider = await registerUser(ctx, 'Timeline Outsider');
  org = await createOrg(ctx, owner, { name: 'Timeline Traders Pvt Ltd' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  for (const k of [-400, 0]) await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: fiscalYearForDate(d(k), 4) });
  const a = org.acc;
  // Before the range: 10,000 into the bank.
  await journal('OPEN', d(-30), [{ accountId: a['1120'], debit: '10000.00' }, { accountId: a['3100'], credit: '10000.00' }]);
  // In the range: a 50,000 receipt, a bank-to-cash transfer, a cash expense, an accrual with no cash, and a draft.
  await journal('RECEIPT', d(-8), [{ accountId: a['1120'], debit: '50000.00' }, { accountId: a['4100'], credit: '50000.00' }]);
  await journal('TRANSFER', d(-8), [{ accountId: a['1110'], debit: '2000.00' }, { accountId: a['1120'], credit: '2000.00' }]);
  await journal('PETTY', d(-3), [{ accountId: a['6100'], debit: '1500.00' }, { accountId: a['1110'], credit: '1500.00' }]);
  await journal('ACCRUAL', d(-3), [{ accountId: a['6200'], debit: '700.00' }, { accountId: a['2200'], credit: '700.00' }]);
  await journal('DRAFT', d(-2), [{ accountId: a['6100'], debit: '99.00' }, { accountId: a['1120'], credit: '99.00' }], false);
});
afterAll(async () => {
  await ctx.app.close();
});

describe('the financial timeline', () => {
  it('buckets entries by day with cash in, cash out and the cash balance', async () => {
    const r = await get({ from: d(-10), to: d(5) });
    expect(r).toMatchObject({ currency: 'INR', today: T, from: d(-10), to: d(5), size: 'DAY', complianceConfigured: false, deadlines: [] });
    expect(r.buckets).toHaveLength(16);
    expect(r.totals).toEqual({ openingCash: '10000.00', cashIn: '50000.00', cashOut: '1500.00', closingCash: '58500.00', entries: 4, deadlines: 0 });
    const day = (k: number) => r.buckets.find((b: { start: string }) => b.start === d(k));
    expect(day(-8)).toMatchObject({ cashIn: '50000.00', cashOut: '0.00', closingCash: '60000.00', entries: 2, bySource: [{ source: 'MANUAL', count: 2 }], future: false });
    expect(day(-3)).toMatchObject({ cashIn: '0.00', cashOut: '1500.00', closingCash: '58500.00', entries: 2 });
    expect(day(-1)).toMatchObject({ entries: 0, closingCash: '58500.00' });
    expect(day(1)).toMatchObject({ future: true, closingCash: null });
    expect(r.entries.map((e: { reference: string; cashIn: string; cashOut: string }) => `${e.reference} ${e.cashIn}/${e.cashOut}`)).toEqual(['RECEIPT 50000.00/0.00', 'TRANSFER 0.00/0.00', 'PETTY 0.00/1500.00', 'ACCRUAL 0.00/0.00']);
    expect(r.entries[0]).toMatchObject({ id: ids.RECEIPT, date: d(-8), source: 'MANUAL', memo: 'RECEIPT', amount: '50000.00', bucket: d(-8) });
    expect(r.sources).toEqual([{ source: 'MANUAL', count: 4, amount: '54200.00' }]);
  });

  it('uses weeks or months for longer ranges, and places compliance deadlines', async () => {
    await ctx.http().put(`${org.base}/gst/registration`).set(owner.auth).send({ gstin: gstin('27', 'ZZZTL0001Z'), effectiveFrom: `${d(-200).slice(0, 7)}-01` }).expect(200);
    const def = await get({});
    expect(def).toMatchObject({ from: d(-90), to: d(30), size: 'WEEK', complianceConfigured: true });
    const r = await get({ from: d(-200), to: d(199) });
    expect(r.size).toBe('MONTH');
    expect(r.buckets[0].start).toBe(`${d(-200).slice(0, 7)}-01`);
    expect(r.deadlines.length).toBeGreaterThanOrEqual(20);
    for (const x of r.deadlines) {
      expect(x.date >= d(-200) && x.date <= d(199)).toBe(true);
      expect(x.bucket).toBe(`${x.date.slice(0, 7)}-01`);
      expect(['OVERDUE', 'DUE_SOON', 'UPCOMING', 'DONE']).toContain(x.status);
    }
    expect(r.deadlines.some((x: { name: string }) => x.name.startsWith('GSTR-3B') || x.name.includes('3B'))).toBe(true);
    expect(r.buckets.reduce((t: number, b: { deadlines: number }) => t + b.deadlines, 0)).toBe(r.deadlines.length);
    expect(r.totals).toMatchObject({ openingCash: '0.00', closingCash: '58500.00', entries: 5 });
    expect((await get({ size: 'DAY', from: d(-3), to: d(-3) })).buckets).toHaveLength(1);
  });

  it('checks the range and who may see it', async () => {
    expect((await get({ from: d(0), to: d(-1) }, owner.auth, 422)).error).toBe('INVALID_PERIOD');
    expect((await get({ from: d(-400), to: d(0) }, owner.auth, 422)).error).toBe('PERIOD_TOO_LONG');
    await get({ from: '2026-13-01' }, owner.auth, 400);
    await ctx.http().get(`${org.base}/reports/timeline`).set(outsider.auth).expect(404);
    const other = await createOrg(ctx, outsider, { name: 'Other Timeline Ltd' });
    const r = (await ctx.http().get(`${other.base}/reports/timeline`).set(outsider.auth).expect(200)).body;
    expect(r.totals).toMatchObject({ entries: 0, cashIn: '0.00', openingCash: '0.00' });
  });
});
