import { addMonth, fiscalYearForDate, loanSchedule } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';
import { sqlWrite } from './sql-writes';

/**
 * Loans against the real API and database: adding a loan with its money received, installments
 * as scheduled and as the lender charged them, rate changes keeping the installment or the term,
 * prepayments with charges, reversal of the latest entry, closing a loan, the treasury overview
 * with its ledger check, permissions, tenant isolation and the database guards.
 */
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const M = T.slice(0, 7);
const DISB = `${addMonth(M, -5)}-10`;
const FIRST = `${addMonth(M, -4)}-01`;
const due = (k: number) => `${addMonth(M, -5 + k)}-01`;

let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let L: string;
const id: Record<string, string> = {};

const raw = (sql: string, ...args: unknown[]) => sqlWrite(ctx, sql, args, { bypass: true });
const loan = (overrides: Record<string, unknown> = {}) => ({
  name: 'Warehouse term loan',
  lender: 'State Bank of India',
  accountNumber: 'TL-778812',
  method: 'EMI',
  principal: '1000000.00',
  annualRate: '9.5',
  months: 60,
  disbursementDate: DISB,
  firstDueDate: FIRST,
  liabilityAccountId: org.acc['2700'],
  interestAccountId: org.acc['7100'],
  bankAccountId: org.acc['1120'],
  recordDisbursement: true,
  ...overrides,
});
const get = async (loanId: string) => (await ctx.http().get(`${L}/${loanId}`).set(owner.auth).expect(200)).body;
const journal = async (entryId: string) => (await ctx.http().get(`${org.base}/journals/${entryId}`).set(owner.auth).expect(200)).body;
const lineOf = (j: { lines: { accountId: string; debit: string; credit: string }[] }, code: string) => j.lines.find((l) => l.accountId === org.acc[code]);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Loan Owner');
  viewer = await registerUser(ctx, 'Loan Viewer');
  outsider = await registerUser(ctx, 'Loan Outsider');
  org = await createOrg(ctx, owner, { name: 'Borrowings Pvt Ltd' });
  L = `${org.base}/loans`;
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  const fy = fiscalYearForDate(T, 4);
  for (const y of [fy - 1, fy, fy + 1]) await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: y });
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('loans', () => {
  it('adds a loan, posting the money received, with its full schedule', async () => {
    const acc = (await ctx.http().get(`${L}/accounts`).set(viewer.auth).expect(200)).body;
    expect(acc.liability.map((a: { code: string }) => a.code)).toContain('2700');
    expect(acc.interest.map((a: { code: string }) => a.code)).toContain('7100');
    expect(acc.bank.map((a: { code: string }) => a.code)).toEqual(['1110', '1120']);

    await ctx.http().post(L).set(viewer.auth).send(loan()).expect(403);
    expect((await ctx.http().post(L).set(owner.auth).send(loan({ firstDueDate: DISB })).expect(422)).body.message).toBe('The first installment must fall after the loan is taken');
    expect((await ctx.http().post(L).set(owner.auth).send(loan({ months: 0 })).expect(422)).body.message).toBe('The term must be 1 to 480 months');
    expect((await ctx.http().post(L).set(owner.auth).send(loan({ liabilityAccountId: org.acc['2100'] })).expect(422)).body.message).toBe('The loan account must be a long-term debt or other liability account');
    expect((await ctx.http().post(L).set(owner.auth).send(loan({ bankAccountId: org.acc['6100'] })).expect(422)).body.message).toBe('Installments are paid from a bank or cash account');
    await ctx.http().post(L).set(owner.auth).send(loan({ annualRate: '120' })).expect(400);

    const l = (await ctx.http().post(L).set(owner.auth).send(loan()).expect(201)).body;
    id.term = l.id;
    expect(l).toMatchObject({ reference: 'LN-0001', status: 'ACTIVE', balance: '1000000.00', installment: '21001.86', annualRate: '9.5', months: 60, lastNo: 60 });
    expect(l.rows).toHaveLength(60);
    expect(l.rows[0]).toMatchObject({ no: 1, dueDate: FIRST, interest: '7916.67', principal: '13085.19', payment: '21001.86' });
    expect(l.rows).toEqual(loanSchedule({ principal: '1000000.00', annualRate: '9.5', months: 60, method: 'EMI', disbursementDate: DISB, firstDueDate: FIRST }, 2));
    expect(l.remaining.principal).toBe('1000000.00');
    expect(+l.maturity.current + +l.maturity.nonCurrent).toBe(1000000);
    const je = await journal(l.disbursementEntry.id);
    expect(je).toMatchObject({ source: 'LOAN', reference: 'LN-0001', date: DISB });
    expect(lineOf(je, '1120')!.debit).toBe('1000000.00');
    expect(lineOf(je, '2700')!.credit).toBe('1000000.00');
  });

  it('records installments as scheduled or as the lender charged them, in date order', async () => {
    const one = (await ctx.http().post(`${L}/${id.term}/repayments`).set(owner.auth).send({ date: due(1) }).expect(201)).body;
    expect(one).toMatchObject({ balance: '986914.81', paid: { installments: 1, principal: '13085.19', interest: '7916.67' } });
    expect(one.next.no).toBe(2);
    const je = await journal(one.events[0].entry.id);
    expect(lineOf(je, '2700')!.debit).toBe('13085.19');
    expect(lineOf(je, '7100')!.debit).toBe('7916.67');
    expect(lineOf(je, '1120')!.credit).toBe('21001.86');
    expect(je.memo).toBe('Installment 1 of LN-0001: Warehouse term loan');

    expect((await ctx.http().post(`${L}/${id.term}/repayments`).set(owner.auth).send({ date: due(2), principal: '13000.00' }).expect(422)).body.message).toMatch(/Give both the principal and the interest/);
    expect((await ctx.http().post(`${L}/${id.term}/repayments`).set(owner.auth).send({ date: DISB }).expect(422)).body.error).toBe('LOAN_DATE');
    const two = (await ctx.http().post(`${L}/${id.term}/repayments`).set(owner.auth).send({ date: due(2), principal: '13101.86', interest: '7900.00', note: 'Bank charged 30 days' }).expect(201)).body;
    expect(two.balance).toBe('973812.95');
    expect(two.paidRows.map((r: { no: number; payment: string }) => [r.no, r.payment])).toEqual([[1, '21001.86'], [2, '21001.86']]);
    expect(two.rows[0]).toMatchObject({ no: 3, opening: '973812.95' });
    expect(two.rows.at(-1).no).toBe(60);
  });

  it('changes the rate keeping the installment (longer term) or the term (higher installment)', async () => {
    const keep = (await ctx.http().post(`${L}/${id.term}/rate-changes`).set(owner.auth).send({ date: due(2), annualRate: '10.25', mode: 'KEEP_INSTALLMENT' }).expect(201)).body;
    expect(keep).toMatchObject({ annualRate: '10.25', installment: '21001.86', lastNo: null });
    expect(keep.rows.length).toBeGreaterThan(58);
    expect(keep.rows[0].interest).toBe('8317.99');
    const ev = keep.events.at(-1);
    expect(ev).toMatchObject({ kind: 'RATE_CHANGE', rateBefore: '9.5', rateAfter: '10.25', entry: null, canReverse: true });
    expect((await ctx.http().post(`${L}/${id.term}/rate-changes`).set(owner.auth).send({ date: due(2), annualRate: '10.25', mode: 'KEEP_TENURE' }).expect(422)).body.message).toBe('The rate is already 10.25%');
    const back = (await ctx.http().post(`${L}/${id.term}/events/${ev.id}/reverse`).set(owner.auth).expect(200)).body;
    expect(back).toMatchObject({ annualRate: '9.5', installment: '21001.86', lastNo: 60 });
    expect(back.rows).toHaveLength(58);
    const tenure = (await ctx.http().post(`${L}/${id.term}/rate-changes`).set(owner.auth).send({ date: due(2), annualRate: '10.25', mode: 'KEEP_TENURE' }).expect(201)).body;
    expect(tenure.rows).toHaveLength(58);
    expect(+tenure.installment).toBeGreaterThan(21001.86);
    expect(tenure.rows.at(-1).closing).toBe('0.00');
    // Too low an installment to cover the interest is refused.
    expect((await ctx.http().post(`${L}/${id.term}/rate-changes`).set(owner.auth).send({ date: due(2), annualRate: '30', mode: 'KEEP_INSTALLMENT' }).expect(422)).body.message).toMatch(/does not cover the interest/);
  });

  it('prepays principal with charges, shortening the term, and reverses only the latest entry', async () => {
    const before = await get(id.term);
    const pre = (await ctx.http().post(`${L}/${id.term}/prepayments`).set(owner.auth).send({ date: due(3), amount: '200000', charges: '4000', mode: 'REDUCE_TENURE' }).expect(201)).body;
    expect(pre.balance).toBe(new (await import('@talk2tax/accounting-engine')).D(before.balance).minus(200000).toFixed(2));
    expect(pre.installment).toBe(before.installment);
    expect(pre.rows.length).toBeLessThan(before.rows.length - 10);
    const ev = pre.events.at(-1);
    const je = await journal(ev.entry.id);
    expect(lineOf(je, '2700')!.debit).toBe('200000.00');
    expect(lineOf(je, '7100')!.debit).toBe('4000.00');
    expect(lineOf(je, '1120')!.credit).toBe('204000.00');
    expect((await ctx.http().post(`${L}/${id.term}/prepayments`).set(owner.auth).send({ date: due(3), amount: '99999999', mode: 'REDUCE_TENURE' }).expect(422)).body.message).toMatch(/cannot be more than/);

    const rateEvent = pre.events.find((e: { kind: string; status: string }) => e.kind === 'RATE_CHANGE' && e.status === 'POSTED');
    expect((await ctx.http().post(`${L}/${id.term}/events/${rateEvent.id}/reverse`).set(owner.auth).expect(409)).body.error).toBe('NOT_LATEST_EVENT');
    const undone = (await ctx.http().post(`${L}/${id.term}/events/${ev.id}/reverse`).set(owner.auth).expect(200)).body;
    expect(undone.balance).toBe(before.balance);
    expect(undone.rows).toHaveLength(before.rows.length);
    const rev = undone.events.find((e: { id: string }) => e.id === ev.id);
    expect(rev.status).toBe('REVERSED');
    expect(rev.reversal.by).toBe('Loan Owner');
    expect((await journal(rev.reversal.entry.id)).lines.find((l: { accountId: string }) => l.accountId === org.acc['1120']).debit).toBe('204000.00');

    // Lowering the installment instead keeps the planned last installment.
    const lower = (await ctx.http().post(`${L}/${id.term}/prepayments`).set(owner.auth).send({ date: due(3), amount: '200000', mode: 'REDUCE_INSTALLMENT' }).expect(201)).body;
    expect(lower.rows).toHaveLength(before.rows.length);
    expect(+lower.installment).toBeLessThan(+before.installment);
    expect(lower.rows.at(-1).no).toBe(60);
  });

  it('closes a loan when the last of it is repaid, and reopens it if that is reversed', async () => {
    const l = (await ctx.http().post(L).set(owner.auth).send(loan({ name: 'Delivery van', lender: 'Tata Capital', accountNumber: null, method: 'EQUAL_PRINCIPAL', principal: '120000', annualRate: '12', months: 3, recordDisbursement: false })).expect(201)).body;
    id.van = l.id;
    expect(l).toMatchObject({ reference: 'LN-0002', installment: '40000.00', disbursementEntry: null });
    expect(l.rows.map((r: { payment: string }) => r.payment)).toEqual(['41200.00', '40800.00', '40400.00']);
    await ctx.http().post(`${L}/${id.van}/repayments`).set(owner.auth).send({ date: due(1) }).expect(201);
    const closed = (await ctx.http().post(`${L}/${id.van}/prepayments`).set(owner.auth).send({ date: due(2), amount: '80000', mode: 'REDUCE_TENURE' }).expect(201)).body;
    expect(closed).toMatchObject({ status: 'CLOSED', balance: '0.00', closedOn: due(2), rows: [], next: null });
    expect((await ctx.http().post(`${L}/${id.van}/repayments`).set(owner.auth).send({ date: due(2) }).expect(422)).body.error).toBe('LOAN_CLOSED');
    const open = (await ctx.http().post(`${L}/${id.van}/events/${closed.events.at(-1).id}/reverse`).set(owner.auth).expect(200)).body;
    expect(open).toMatchObject({ status: 'ACTIVE', balance: '80000.00', closedOn: null });
    expect(open.rows).toHaveLength(2);
  });

  it('shows the treasury position, with the ledger check and what is due', async () => {
    const list = (await ctx.http().get(L).set(viewer.auth).expect(200)).body;
    expect(list.can).toEqual({ manage: false });
    const term = list.loans.find((l: { id: string }) => l.id === id.term);
    expect(term.overdue.count).toBeGreaterThanOrEqual(1);
    const t = (await ctx.http().get(`${L}/treasury`).set(viewer.auth).expect(200)).body;
    const total = list.loans.reduce((s: number, l: { balance: string }) => s + +l.balance, 0);
    expect(+t.borrowings.balance).toBeCloseTo(total, 2);
    const bank = t.cash.accounts.find((a: { code: string }) => a.code === '1120');
    expect(+t.cash.total).toBeCloseTo(+bank.balance + +t.cash.accounts.find((a: { code: string }) => a.code === '1110').balance, 2);
    expect(+t.netCash).toBeCloseTo(+t.cash.total - total, 2);
    // The van loan was already in the books before, so the ledger shows less than the loans by what is still owed on it, plus its repayment.
    const check = t.ledger.find((x: { account: { code: string } }) => x.account.code === '2700');
    expect(+check.loans).toBeCloseTo(total, 2);
    expect(+check.difference).toBeCloseTo(-120000, 2);
    expect(t.upcoming.some((u: { reference: string; overdue: boolean }) => u.reference === 'LN-0001' && u.overdue)).toBe(true);
    expect(t.byMonth.length).toBeGreaterThanOrEqual(12);
    expect(+t.interestThisYear.amount).toBeGreaterThan(0);
  });

  it('keeps loans to their organisation and to people who may manage them', async () => {
    await ctx.http().post(`${L}/${id.term}/repayments`).set(viewer.auth).send({ date: T }).expect(403);
    const other = await createOrg(ctx, outsider, { name: 'Other Pvt Ltd' });
    await ctx.http().get(`${other.base}/loans/${id.term}`).set(outsider.auth).expect(404);
    await ctx.http().post(`${other.base}/loans/${id.term}/repayments`).set(outsider.auth).send({ date: T }).expect(404);
    expect((await ctx.http().get(`${other.base}/loans`).set(outsider.auth).expect(200)).body.loans).toEqual([]);
  });

  it('keeps loans and their entries in the database', async () => {
    await expect(raw(`DELETE FROM loans WHERE id = $1::uuid`, id.term)).rejects.toThrow(/never deleted/);
    await expect(raw(`UPDATE loans SET principal = 1 WHERE id = $1::uuid`, id.term)).rejects.toThrow(/keeps its amount/);
    await expect(raw(`UPDATE loan_events SET principal = 1 WHERE loan_id = $1::uuid`, id.term)).rejects.toThrow(/changes only to record its reversal/);
    await expect(raw(`DELETE FROM loan_events WHERE loan_id = $1::uuid`, id.term)).rejects.toThrow(/never deleted/);
    await expect(raw(`UPDATE loans SET installment = 0 WHERE id = $1::uuid`, id.term)).rejects.toThrow(/loans_chk/);
  });
});
