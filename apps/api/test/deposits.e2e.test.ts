import { depositInterest, fiscalYearForDate, type DepositTerms } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Fixed deposits against the real API and database: placing one (Dr deposit, Cr bank), accruing
 * interest to chosen dates so the accruals add up to the maturity interest, accruing every open
 * deposit at once, closing at maturity with tax deducted, closing early after a penalty, reversing
 * the latest posting, permissions and tenant isolation.
 */
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const START = shift(T, -400);
const MATURITY = `${Number(START.slice(0, 4)) + 1}${START.slice(4)}`;
const MID = shift(START, 100);

let ctx: Ctx;
let owner: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let D: string;
const acc: Record<string, string> = {};

const body = (overrides: Record<string, unknown> = {}) => ({
  name: 'One-year FD',
  institution: 'HDFC Bank',
  institutionRef: 'FD/5512',
  principal: '100000.00',
  annualRate: '7',
  compounding: 'QUARTERLY',
  startDate: START,
  maturityDate: MATURITY,
  bankAccountId: org.acc['1120'],
  depositAccountId: acc.fd,
  accruedInterestAccountId: acc.accrued,
  interestIncomeAccountId: org.acc['4900'],
  ...overrides,
});
const terms = (o: Partial<DepositTerms> = {}): DepositTerms => ({ principal: '100000', annualRate: '7', compounding: 'QUARTERLY', startDate: START, maturityDate: MATURITY, ...o });
const journal = async (entryId: string) => (await ctx.http().get(`${org.base}/journals/${entryId}`).set(owner.auth).expect(200)).body;
const amounts = (j: { lines: { accountId: string; debit: string; credit: string }[] }) => Object.fromEntries(j.lines.map((l) => [l.accountId, Number(l.debit) ? `Dr ${l.debit}` : `Cr ${l.credit}`]));
const balance = async (code: string) => {
  const tb = (await ctx.http().get(`${org.base}/reports/trial-balance`).query({ asOf: T }).set(owner.auth).expect(200)).body;
  const row = tb.rows.find((r: { code: string }) => r.code === code);
  return row ? Number(row.debit) - Number(row.credit) : 0;
};

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Deposit Owner');
  viewer = await registerUser(ctx, 'Deposit Viewer');
  outsider = await registerUser(ctx, 'Deposit Outsider');
  org = await createOrg(ctx, owner, { name: 'Savings Pvt Ltd' });
  D = `${org.base}/deposits`;
  await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: viewer.email, role: 'VIEWER' }).expect(201);
  const fy = fiscalYearForDate(T, 4);
  for (const y of [fy - 2, fy - 1, fy, fy + 1]) await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: y });
  acc.fd = (await ctx.http().post(`${org.base}/accounts`).set(owner.auth).send({ code: '1160', name: 'Fixed Deposits', type: 'ASSET', subtype: 'OTHER_CURRENT_ASSET' }).expect(201)).body.id;
  acc.accrued = (await ctx.http().post(`${org.base}/accounts`).set(owner.auth).send({ code: '1170', name: 'Interest Accrued on Deposits', type: 'ASSET', subtype: 'OTHER_CURRENT_ASSET' }).expect(201)).body.id;
  acc.tds = org.acc['1450'];
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('fixed deposits', () => {
  let fd: string;

  it('places a deposit, posting Dr deposit, Cr bank', async () => {
    const choices = (await ctx.http().get(`${D}/accounts`).set(viewer.auth).expect(200)).body;
    expect(choices.deposit.map((a: { code: string }) => a.code)).toEqual(expect.arrayContaining(['1160', '1170']));
    expect(choices.interestIncome.map((a: { code: string }) => a.code)).toContain('4900');
    expect(choices.tds[0].code).toBe('1450');

    await ctx.http().post(D).set(viewer.auth).send(body()).expect(403);
    expect((await ctx.http().post(D).set(owner.auth).send(body({ maturityDate: START })).expect(422)).body.message).toBe('The maturity date must be after the start date');
    expect((await ctx.http().post(D).set(owner.auth).send(body({ depositAccountId: org.acc['1120'] })).expect(422)).body.message).toBe('Hold the deposit in an other current or non-current asset account');
    expect((await ctx.http().post(D).set(owner.auth).send(body({ interestIncomeAccountId: org.acc['4100'] })).expect(422)).body.message).toBe('Book the interest to an other income account');
    expect((await ctx.http().post(D).set(owner.auth).send(body({ accruedInterestAccountId: acc.fd })).expect(422)).body.message).toBe('Use different accounts for the deposit and its accrued interest');
    await ctx.http().post(D).set(owner.auth).send(body({ compounding: 'DAILY' })).expect(400);

    const d = (await ctx.http().post(D).set(owner.auth).send(body()).expect(201)).body;
    fd = d.id;
    expect(d).toMatchObject({ number: 'FD-000001', status: 'OPEN', principal: '100000.00', accrued: '0.00', accruedTo: null, maturityInterest: '7185.90', maturityValue: '107185.90' });
    expect(d.events).toHaveLength(1);
    expect(d.events[0]).toMatchObject({ kind: 'PLACED', amount: '100000.00', canReverse: false });
    expect(amounts(await journal(d.events[0].entryId))).toEqual({ [acc.fd]: 'Dr 100000.00', [org.acc['1120']]: 'Cr 100000.00' });
    expect(d.earnedToDate).toBe('7185.90');
    expect(d.notAccrued).toBe('7185.90');
  });

  it('accrues interest to a date, and refuses dates it cannot use', async () => {
    await ctx.http().post(`${D}/${fd}/accrue`).set(viewer.auth).send({ date: MID }).expect(403);
    expect((await ctx.http().post(`${D}/${fd}/accrue`).set(owner.auth).send({ date: START }).expect(422)).body.message).toBe('Accrue to a date after the deposit started');
    expect((await ctx.http().post(`${D}/${fd}/accrue`).set(owner.auth).send({ date: shift(MATURITY, 1) }).expect(422)).body.message).toBe(`Accrue to ${MATURITY} at the latest; close the deposit after that`);

    const d = (await ctx.http().post(`${D}/${fd}/accrue`).set(owner.auth).send({ date: MID }).expect(200)).body;
    const expected = depositInterest(terms(), MID, 2).toFixed(2);
    expect(d).toMatchObject({ accrued: expected, accruedTo: MID });
    const ev = d.events.at(-1);
    expect(ev).toMatchObject({ kind: 'ACCRUED', amount: expected, canReverse: true });
    expect(amounts(await journal(ev.entryId))).toEqual({ [acc.accrued]: `Dr ${expected}`, [org.acc['4900']]: `Cr ${expected}` });
    expect((await ctx.http().post(`${D}/${fd}/accrue`).set(owner.auth).send({ date: MID }).expect(422)).body.message).toBe(`Interest is already accrued to ${MID}`);
  });

  it('reverses the latest accrual and puts the accrued figure back', async () => {
    await ctx.http().post(`${D}/${fd}/reverse`).set(owner.auth).send({ date: MID, reason: '' }).expect(400);
    const d = (await ctx.http().post(`${D}/${fd}/reverse`).set(owner.auth).send({ date: MID, reason: 'Wrong date' }).expect(200)).body;
    expect(d).toMatchObject({ accrued: '0.00', accruedTo: null });
    expect(d.events.at(-1)).toMatchObject({ kind: 'ACCRUED', reversed: true, canReverse: false });
    expect(await balance('1170')).toBe(0);
    expect((await ctx.http().post(`${D}/${fd}/reverse`).set(owner.auth).send({ date: MID, reason: 'Again' }).expect(422)).body.message).toBe('Nothing to reverse: only interest accruals and the closing can be reversed');
  });

  it('accrues every open deposit at once, in steps that add up to the maturity interest', async () => {
    const r1 = (await ctx.http().post(`${D}/accrue`).set(owner.auth).send({ date: MID }).expect(200)).body;
    expect(r1.accrued).toEqual([{ number: 'FD-000001', amount: depositInterest(terms(), MID, 2).toFixed(2) }]);
    const r2 = (await ctx.http().post(`${D}/accrue`).set(owner.auth).send({ date: T }).expect(200)).body;
    expect(r2.accrued).toHaveLength(1);
    const d = (await ctx.http().get(`${D}/${fd}`).set(viewer.auth).expect(200)).body;
    expect(d).toMatchObject({ accrued: '7185.90', accruedTo: MATURITY, notAccrued: '0.00' });
    expect((await ctx.http().post(`${D}/accrue`).set(owner.auth).send({ date: T }).expect(200)).body.accrued).toEqual([]);
    expect(await balance('1170')).toBeCloseTo(7185.9, 2);
  });

  it('closes at maturity with tax deducted, clearing the deposit and the accrued interest', async () => {
    const close = { date: MATURITY, received: '106467.31', tds: '718.59', tdsAccountId: acc.tds };
    expect((await ctx.http().post(`${D}/${fd}/close`).set(owner.auth).send({ ...close, tdsAccountId: org.acc['4900'] }).expect(422)).body.message).toBe('Claim the tax deducted in a tax receivable or other current asset account');
    expect((await ctx.http().post(`${D}/${fd}/close`).set(owner.auth).send({ ...close, tdsAccountId: acc.fd }).expect(422)).body.message).toBe('Claim the tax deducted in an account other than the deposit and its accrued interest');
    expect((await ctx.http().post(`${D}/${fd}/close`).set(owner.auth).send({ ...close, date: MID }).expect(422)).body.message).toBe(`Interest is accrued to ${MATURITY}; close on or after that date`);
    const d = (await ctx.http().post(`${D}/${fd}/close`).set(owner.auth).send(close).expect(200)).body;
    expect(d.status).toBe('CLOSED');
    const ev = d.events.at(-1);
    expect(ev).toMatchObject({ kind: 'CLOSED', received: '106467.31', tds: '718.59', interest: '7185.90', incomeNow: '0.00', early: false, canReverse: true });
    expect(amounts(await journal(ev.entryId))).toEqual({ [org.acc['1120']]: 'Dr 106467.31', [acc.tds]: 'Dr 718.59', [acc.fd]: 'Cr 100000.00', [acc.accrued]: 'Cr 7185.90' });
    expect(await balance('1160')).toBe(0);
    expect(await balance('1170')).toBe(0);
    await ctx.http().post(`${D}/${fd}/accrue`).set(owner.auth).send({ date: T }).expect(422);
  });

  it('reverses a closing and reopens the deposit', async () => {
    const d = (await ctx.http().post(`${D}/${fd}/reverse`).set(owner.auth).send({ date: MATURITY, reason: 'Wrong TDS' }).expect(200)).body;
    expect(d.status).toBe('OPEN');
    expect(await balance('1160')).toBe(100000);
    const again = (await ctx.http().post(`${D}/${fd}/close`).set(owner.auth).send({ date: MATURITY, received: '106467.31', tds: '718.59', tdsAccountId: acc.tds }).expect(200)).body;
    expect(again.status).toBe('CLOSED');
  });

  it('closes early after a penalty, taking back interest accrued but not paid', async () => {
    const start = shift(T, -200);
    const d = (await ctx.http().post(D).set(owner.auth).send(body({ name: 'Two-year FD', principal: '50000.00', annualRate: '7.5', compounding: 'SIMPLE', startDate: start, maturityDate: shift(start, 730) })).expect(201)).body;
    expect(d.number).toBe('FD-000002');
    const a = (await ctx.http().post(`${D}/${d.id}/accrue`).set(owner.auth).send({ date: shift(start, 100) }).expect(200)).body;
    expect(a.accrued).toBe('1027.40'); // 50000 × 7.5% × 100 / 365
    const c = (await ctx.http().post(`${D}/${d.id}/close`).set(owner.auth).send({ date: shift(start, 150), received: '50900.00', tds: '0' }).expect(200)).body;
    const ev = c.events.at(-1);
    expect(ev).toMatchObject({ early: true, interest: '900.00', incomeNow: '-127.40' });
    expect(amounts(await journal(ev.entryId))).toEqual({ [org.acc['1120']]: 'Dr 50900.00', [acc.fd]: 'Cr 50000.00', [acc.accrued]: 'Cr 1027.40', [org.acc['4900']]: 'Dr 127.40' });
    expect((await ctx.http().post(`${D}/${d.id}/close`).set(owner.auth).send({ date: shift(start, 150), received: '1', tds: '0' }).expect(422)).body.message).toBe('This deposit is already closed');
  });

  it('lists deposits with totals for the open ones, and keeps them to the organisation', async () => {
    const list = (await ctx.http().get(D).set(viewer.auth).expect(200)).body;
    expect(list.items.map((d: { number: string }) => d.number).sort()).toEqual(['FD-000001', 'FD-000002']);
    expect(list.totals.principal).toBe('0.00');
    await ctx.http().get(D).set(outsider.auth).expect(404);
    await ctx.http().get(`${D}/${fd}`).set(outsider.auth).expect(404);
    const other = await createOrg(ctx, outsider, { name: 'Other Co' });
    await ctx.http().get(`${other.base}/deposits/${fd}`).set(outsider.auth).expect(404);
  });
});
