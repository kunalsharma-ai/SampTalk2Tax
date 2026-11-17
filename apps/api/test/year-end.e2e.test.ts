import { fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';
import { sqlWrite } from './sql-writes';

/**
 * GL-011 year-end close against the real API and database: the year's profit closed to retained
 * earnings by a CLOSING journal; profit-and-loss reports leaving it out while the balance sheet
 * shows retained earnings; closing again after a late change posting only the difference; reopening
 * reversing the closes; refusals (year not ended, nothing left, a locked last month, a non-equity
 * account), permissions, the database guards and tenant isolation.
 */
let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
const T = today();
const fy = fiscalYearForDate(T, 4);
const prev = fy - 1;
let prevStart: string;
let prevEnd: string;
const raw = (sql: string, ...args: unknown[]) => sqlWrite(ctx, sql, args, { bypass: true });
const journalPost = (date: string, debit: string, credit: string, amount: string, memo: string) =>
  ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date, post: true, memo, lines: [{ accountId: org.acc[debit], debit: amount }, { accountId: org.acc[credit], credit: amount }] }).expect(201);
const overview = async () => (await ctx.http().get(`${org.base}/year-end`).set(owner.auth).expect(200)).body;
const yearOf = async (n: number) => (await overview()).years.find((y: { fiscalYear: number }) => y.fiscalYear === n);
const journal = async (id: string) => (await ctx.http().get(`${org.base}/journals/${id}`).set(owner.auth).expect(200)).body;
const lines = (je: { lines: { accountCode: string; debit: string; credit: string }[] }) => je.lines.map((l) => [l.accountCode, l.debit, l.credit]);
const balanceSheet = async (asOf: string) => (await ctx.http().get(`${org.base}/reports/balance-sheet?asOf=${asOf}`).set(owner.auth).expect(200)).body;
const pl = async () => (await ctx.http().get(`${org.base}/reports/income-statement?from=${prevStart}&to=${prevEnd}`).set(owner.auth).expect(200)).body;
const equity = (bs: { equity: { code: string; amount: string }[] }, code: string) => bs.equity.find((e) => e.code === code)?.amount ?? null;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Year End Owner');
  viewer = await registerUser(ctx, 'Year End Viewer');
  outsider = await registerUser(ctx, 'Year End Outsider');
  org = await createOrg(ctx, owner, { name: 'Year End Traders' });
  other = await createOrg(ctx, outsider, { name: 'Other Year End' });
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  const periods = (await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: prev }).expect(201)).body;
  prevStart = periods[0].startDate;
  prevEnd = periods[periods.length - 1].endDate;
  // Last year: sales 1,00,000 and rent 30,000. This year: sales 10,000.
  await journalPost(`${prevStart.slice(0, 8)}15`, '1120', '4100', '100000.00', 'Cash sales');
  await journalPost(`${prevEnd.slice(0, 8)}10`, '6200', '1120', '30000.00', 'Rent');
  await journalPost(T, '1120', '4100', '10000.00', 'Cash sales this year');
});
afterAll(async () => {
  await ctx.app.close();
});

describe('closing a year', () => {
  it('shows each year, and previews the closing journal', async () => {
    const o = await overview();
    expect(o.years.map((y: { fiscalYear: number }) => y.fiscalYear)).toEqual([fy, prev]);
    expect(await yearOf(prev)).toMatchObject({ status: 'NOT_CLOSED', ended: true, profit: '70000.00', leftToClose: '70000.00', accountsLeft: 2, closedToRetainedEarnings: '0.00' });
    expect(await yearOf(fy)).toMatchObject({ ended: false, profit: '10000.00' });
    expect(o.retainedEarningsAccountId).toBe(org.acc['3200']);
    const p = (await ctx.http().get(`${org.base}/year-end/${prev}/preview`).set(viewer.auth).expect(200)).body;
    expect(p).toMatchObject({ closingDate: prevEnd, profit: '70000.00', toRetainedEarnings: '70000.00' });
    expect(p.lines.map((l: { account: string; debit: string; credit: string }) => [l.account, l.debit, l.credit])).toEqual([
      ['4100 · Sales Revenue', '100000.00', '0.00'],
      ['6200 · Rent', '0.00', '30000.00'],
      ['3200 · Retained Earnings', '0.00', '70000.00'],
    ]);
  });

  it('refuses the wrong role, a year not ended, and a non-equity account', async () => {
    await ctx.http().post(`${org.base}/year-end/${prev}/close`).set(viewer.auth).send({ retainedEarningsAccountId: org.acc['3200'] }).expect(403);
    expect((await ctx.http().post(`${org.base}/year-end/${fy}/close`).set(owner.auth).send({ retainedEarningsAccountId: org.acc['3200'] }).expect(409)).body.error).toBe('YEAR_NOT_ENDED');
    expect((await ctx.http().post(`${org.base}/year-end/${prev}/close`).set(owner.auth).send({ retainedEarningsAccountId: org.acc['1120'] }).expect(422)).body.error).toBe('RE_ACCOUNT');
    expect((await ctx.http().post(`${org.base}/year-end/${prev - 5}/close`).set(owner.auth).send({ retainedEarningsAccountId: org.acc['3200'] }).expect(404)).body.error).toBe('NOT_FOUND');
  });

  it('moves the profit to retained earnings with a closing journal the income statement leaves out', async () => {
    const before = await balanceSheet(prevEnd);
    expect(before.unclosedEarnings).toBe('70000.00');
    const c = (await ctx.http().post(`${org.base}/year-end/${prev}/close`).set(owner.auth).send({ retainedEarningsAccountId: org.acc['3200'] }).expect(201)).body;
    expect(c).toMatchObject({ reference: 'YE-0001', fiscalYear: prev, closingDate: prevEnd, profit: '70000.00', toRetainedEarnings: '70000.00', accounts: 2, status: 'ACTIVE', retainedEarningsAccount: { code: '3200' } });
    const je = await journal(c.journalEntryId);
    expect(je).toMatchObject({ type: 'CLOSING', source: 'YEAR_END', status: 'POSTED', date: prevEnd, reference: 'YE-0001' });
    expect(lines(je)).toEqual([['4100', '100000.00', '0.00'], ['6200', '0.00', '30000.00'], ['3200', '0.00', '70000.00']]);

    // The year's profit is still reported; the balance sheet carries it in retained earnings.
    expect((await pl()).netIncome).toBe('70000.00');
    const after = await balanceSheet(prevEnd);
    expect(after).toMatchObject({ unclosedEarnings: '0.00', balanced: true, totalEquity: before.totalEquity });
    expect(equity(after, '3200')).toBe('70000.00');
    // This year's earnings stay unclosed.
    expect((await balanceSheet(T)).unclosedEarnings).toBe('10000.00');
    expect(await yearOf(prev)).toMatchObject({ status: 'CLOSED', leftToClose: '0.00', closedToRetainedEarnings: '70000.00' });
    expect((await ctx.http().post(`${org.base}/year-end/${prev}/close`).set(owner.auth).send({ retainedEarningsAccountId: org.acc['3200'] }).expect(409)).body.error).toBe('NOTHING_TO_CLOSE');
    // A closing journal is reversed only by reopening the year.
    await ctx.http().post(`${org.base}/journals/${c.journalEntryId}/reverse`).set(owner.auth).send({ date: prevEnd }).expect((r) => expect(r.status).toBeGreaterThanOrEqual(400));
  });

  it('closes only what changed after a late adjustment, and reopens the year', async () => {
    await journalPost(prevEnd, '6200', '1120', '5000.00', 'Late rent');
    expect(await yearOf(prev)).toMatchObject({ status: 'OUT_OF_DATE', profit: '65000.00', leftToClose: '-5000.00', accountsLeft: 1 });
    const c2 = (await ctx.http().post(`${org.base}/year-end/${prev}/close`).set(owner.auth).send({ retainedEarningsAccountId: org.acc['3200'], memo: "After the auditors' adjustment" }).expect(201)).body;
    expect(c2).toMatchObject({ reference: 'YE-0002', profit: '65000.00', toRetainedEarnings: '-5000.00', accounts: 1, memo: "After the auditors' adjustment" });
    expect(lines(await journal(c2.journalEntryId))).toEqual([['6200', '0.00', '5000.00'], ['3200', '5000.00', '0.00']]);
    expect(await yearOf(prev)).toMatchObject({ status: 'CLOSED', closedToRetainedEarnings: '65000.00' });
    expect(equity(await balanceSheet(prevEnd), '3200')).toBe('65000.00');

    await ctx.http().post(`${org.base}/year-end/${prev}/reopen`).set(viewer.auth).send({ reason: 'Restating' }).expect(403);
    const r = (await ctx.http().post(`${org.base}/year-end/${prev}/reopen`).set(owner.auth).send({ reason: 'Restating the year' }).expect(200)).body;
    expect(r.map((x: { reference: string; status: string }) => [x.reference, x.status])).toEqual([['YE-0002', 'REVERSED'], ['YE-0001', 'REVERSED']]);
    const rev = await journal(r[1].reversalJournalEntryId);
    expect(rev).toMatchObject({ type: 'CLOSING', date: prevEnd });
    expect(await yearOf(prev)).toMatchObject({ status: 'NOT_CLOSED', leftToClose: '65000.00', closedToRetainedEarnings: '0.00' });
    const bs = await balanceSheet(prevEnd);
    expect(bs.unclosedEarnings).toBe('65000.00');
    expect(equity(bs, '3200') ?? '0.00').toBe('0.00');
    expect((await pl()).netIncome).toBe('65000.00');
    expect((await ctx.http().post(`${org.base}/year-end/${prev}/reopen`).set(owner.auth).send({ reason: 'Again' }).expect(409)).body.error).toBe('NOT_CLOSED');
  });

  it('needs the last month of the year open', async () => {
    const periods = (await ctx.http().get(`${org.base}/periods?fiscalYear=${prev}`).set(owner.auth).expect(200)).body;
    const last = periods[periods.length - 1];
    await ctx.http().post(`${org.base}/periods/${last.id}/lock`).set(owner.auth).expect(200);
    expect((await ctx.http().post(`${org.base}/year-end/${prev}/close`).set(owner.auth).send({ retainedEarningsAccountId: org.acc['3200'] }).expect(409)).body.error).toBe('PERIOD_NOT_OPEN');
    await ctx.http().post(`${org.base}/periods/${last.id}/unlock`).set(owner.auth).expect(200);
    await ctx.http().post(`${org.base}/year-end/${prev}/close`).set(owner.auth).send({ retainedEarningsAccountId: org.acc['3200'] }).expect(201);
    expect((await overview()).closes.map((x: { reference: string }) => x.reference)).toEqual(['YE-0003', 'YE-0002', 'YE-0001']);
  });
});

describe('records', () => {
  it('keep closes as they are in the database', async () => {
    await expect(raw(`UPDATE year_end_closes SET profit = 1 WHERE org_id = '${org.orgId}'`)).rejects.toThrow(/immutable/);
    await expect(raw(`DELETE FROM year_end_closes WHERE org_id = '${org.orgId}'`)).rejects.toThrow(/cannot be deleted/);
    await expect(raw(`UPDATE journal_entries SET type = 'STANDARD' WHERE org_id = '${org.orgId}' AND type = 'CLOSING'`)).rejects.toThrow(/cannot change|immutable/);
  });

  it('keep each organisation to its own', async () => {
    await ctx.http().get(`${org.base}/year-end`).set(outsider.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/year-end`).set(outsider.auth).expect(200)).body.closes).toEqual([]);
  });
});
