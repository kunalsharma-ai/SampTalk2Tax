import { addMonth, deferralSchedule, fiscalYearForDate, firstOfNextMonth, monthEnd } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Prepaid expenses, deferred revenue and accruals against the real API and database: schedules
 * with the payment or receipt posted, monthly release runs posted as one journal with catch-up of
 * missed months, reversing the latest run, ending a schedule early with a refund, accruals posted
 * with their automatic reversal and cancelled, the month-end close check, and the database guards.
 */
const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const M = T.slice(0, 7);
const M1 = addMonth(M, -1);
const M2 = addMonth(M, -2);

let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let F: string;
let insurance: string;
let support: string;
const supportTerms = { amount: '36500.00', startDate: `${M1}-15`, months: 12, method: 'DAILY' as const };

const raw = (sql: string, ...args: unknown[]) =>
  ctx.prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('t2t.bypass', 'on', true)`);
    return tx.$executeRawUnsafe(sql, ...args);
  });
const schedule = async (id: string) => (await ctx.http().get(`${F}/${id}`).set(owner.auth).expect(200)).body;
const rel = async (month?: string) => (await ctx.http().get(`${F}/releases${month ? `?month=${month}` : ''}`).set(owner.auth).expect(200)).body;
const entry = async (number: number) => {
  const list = (await ctx.http().get(`${org.base}/journals?limit=200`).set(owner.auth).expect(200)).body;
  const e = (list.items ?? list).find((j: { entryNumber: number }) => j.entryNumber === number);
  return (await ctx.http().get(`${org.base}/journals/${e.id}`).set(owner.auth).expect(200)).body;
};
const lineMap = (e: { lines: { accountId: string; debit: string; credit: string }[] }) =>
  Object.fromEntries(Object.entries(org.acc).filter(([, id]) => e.lines.some((l) => l.accountId === id)).map(([code, id]) => {
    const ls = e.lines.filter((l) => l.accountId === id);
    return [code, ls.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0).toFixed(2)];
  }));
const daily = (through: string) => deferralSchedule(supportTerms, through).reduce((s, r) => s + Number(r.amount), 0);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Deferral Owner');
  accountant = await registerUser(ctx, 'Deferral Accountant');
  viewer = await registerUser(ctx, 'Deferral Viewer');
  outsider = await registerUser(ctx, 'Deferral Outsider');
  org = await createOrg(ctx, owner, { name: 'Prepaid Pvt Ltd' });
  F = `${org.base}/deferrals`;
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  const fy = fiscalYearForDate(T, 4);
  for (const y of [fy - 1, fy, fy + 1]) await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: y });
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('prepaid and deferred revenue schedules', () => {
  it('adds a prepaid expense and posts its payment', async () => {
    const body = { kind: 'PREPAID_EXPENSE', name: 'Office insurance', counterparty: 'Shield General Insurance', balanceAccountId: org.acc['1400'], pnlAccountId: org.acc['6600'], amount: '120000.00', startDate: `${M2}-01`, months: 12, method: 'EVEN', fundingAccountId: org.acc['1120'], fundingDate: `${M2}-01` };
    await ctx.http().post(F).set(viewer.auth).send(body).expect(403);
    expect((await ctx.http().post(F).set(accountant.auth).send({ ...body, pnlAccountId: org.acc['4100'] }).expect(422)).body.message).toBe('Release a prepaid expense to an expense account (not depreciation)');
    expect((await ctx.http().post(F).set(accountant.auth).send({ ...body, months: 0 }).expect(422)).body.message).toBe('The period must be 1 to 120 months');
    const r = await ctx.http().post(F).set(accountant.auth).send(body).expect(201);
    insurance = r.body.id;
    expect(r.body).toMatchObject({ reference: 'PP-0001', status: 'ACTIVE', amount: '120000.00', released: '0.00', remaining: '120000.00', firstMonth: M2, lastMonth: addMonth(M2, 11), termsFixed: false, createdBy: 'Deferral Accountant' });
    expect(r.body.schedule).toHaveLength(12);
    expect(r.body.schedule[0]).toMatchObject({ month: M2, amount: '10000.00' });
    const paid = await entry(r.body.initialEntry.entryNumber);
    expect(paid).toMatchObject({ source: 'DEFERRAL', reference: 'PP-0001', date: `${M2}-01` });
    expect(lineMap(paid)).toEqual({ '1120': '-120000.00', '1400': '120000.00' });
  });

  it('adds deferred revenue spread by days, to the deferred revenue account every new organisation has', async () => {
    const accounts = (await ctx.http().get(`${F}/accounts`).set(viewer.auth).expect(200)).body;
    expect(accounts.deferred.map((a: { code: string }) => a.code)).toContain('2350');
    const body = { kind: 'DEFERRED_REVENUE', name: 'Annual support contract', counterparty: 'Asha Traders', balanceAccountId: org.acc['2350'], pnlAccountId: org.acc['4200'], ...supportTerms, fundingAccountId: org.acc['1120'] };
    expect((await ctx.http().post(F).set(accountant.auth).send({ ...body, balanceAccountId: org.acc['2100'] }).expect(422)).body.message).toMatch(/deferred revenue account must be/);
    const r = await ctx.http().post(F).set(accountant.auth).send(body).expect(201);
    support = r.body.id;
    expect(r.body).toMatchObject({ reference: 'DR-0001', firstMonth: M1, lastMonth: addMonth(M1, 12) });
    expect(r.body.schedule).toHaveLength(13);
    expect(r.body.schedule.at(-1).remaining).toBe('0.00');
    const got = await entry(r.body.initialEntry.entryNumber);
    expect(lineMap(got)).toEqual({ '1120': '36500.00', '2350': '-36500.00' });
  });

  it('the close checklist warns about releases not posted', async () => {
    const periods = (await ctx.http().get(`${org.base}/periods`).set(owner.auth).expect(200)).body as { id: string; startDate: string }[];
    const p = periods.find((x) => x.startDate === `${M1}-01`)!;
    const v = (await ctx.http().get(`${org.base}/close/${p.id}`).set(owner.auth).expect(200)).body;
    const c = v.checks.find((x: { key: string }) => x.key === 'DEFERRALS_NOT_POSTED');
    expect(c).toMatchObject({ ok: false, count: 2, severity: 'WARNING', link: '/deferrals/releases' });
    expect(c.detail).toMatch(/due to be released from 2 schedules is not posted/);
  });

  it('posts a month of releases as one journal, catching up a missed month', async () => {
    const d = await rel();
    expect(d).toMatchObject({ nextMonth: M2, lastPosted: null, month: M2 });
    expect(d.preview).toEqual([expect.objectContaining({ reference: 'PP-0001', month: M2, amount: '10000.00', catchUp: false })]);
    const p = await rel(M1);
    expect(p.preview.map((l: { reference: string; month: string; catchUp: boolean }) => [l.reference, l.month, l.catchUp])).toEqual([
      ['PP-0001', M2, true],
      ['PP-0001', M1, false],
      ['DR-0001', M1, false],
    ]);
    const supportM1 = deferralSchedule(supportTerms, M1)[0]!.amount;
    expect(p.previewTotals).toEqual({ prepaid: '20000.00', deferred: supportM1, total: (20000 + Number(supportM1)).toFixed(2) });

    await ctx.http().post(`${F}/releases/runs`).set(viewer.auth).send({ month: M1 }).expect(403);
    expect((await ctx.http().post(`${F}/releases/runs`).set(owner.auth).send({ month: addMonth(M, 1) }).expect(409)).body.error).toBe('MONTH_NOT_OVER');
    const after = (await ctx.http().post(`${F}/releases/runs`).set(accountant.auth).send({ month: M1 }).expect(201)).body;
    expect(after).toMatchObject({ lastPosted: M1, nextMonth: M });
    expect(after.runs[0]).toMatchObject({ month: M1, status: 'POSTED', lines: 3, postedBy: 'Deferral Accountant', canReverse: true });
    const je = await entry(after.runs[0].entry.entryNumber);
    expect(je).toMatchObject({ source: 'DEFERRAL', reference: `REL-${M1}`, date: monthEnd(M1) });
    expect(lineMap(je)).toEqual({ '1400': '-20000.00', '6600': '20000.00', '2350': supportM1, '4200': `-${supportM1}` });
    expect((await ctx.http().post(`${F}/releases/runs`).set(owner.auth).send({ month: M1 }).expect(409)).body.error).toBe('MONTH_ALREADY_RUN');
    expect(await schedule(insurance)).toMatchObject({ released: '20000.00', remaining: '100000.00', termsFixed: true });
  });

  it('fixes a schedule\'s terms once a release is posted, but its name can change', async () => {
    const s = await schedule(insurance);
    const body = { name: 'Office and stock insurance', counterparty: s.counterparty, balanceAccountId: org.acc['1400'], pnlAccountId: org.acc['6600'], amount: '120000.00', startDate: s.startDate, months: 12, method: 'EVEN' };
    expect((await ctx.http().put(`${F}/${insurance}`).set(owner.auth).send({ ...body, months: 24 }).expect(409)).body.error).toBe('SCHEDULE_TERMS_FIXED');
    expect((await ctx.http().put(`${F}/${insurance}`).set(owner.auth).send(body).expect(200)).body.name).toBe('Office and stock insurance');
  });

  it('reverses only the latest run, and posts the current month after it', async () => {
    const first = (await ctx.http().post(`${F}/releases/runs`).set(owner.auth).send({ month: M }).expect(201)).body;
    const [latest, earlier] = first.runs;
    expect([latest.canReverse, earlier.canReverse]).toEqual([true, false]);
    expect((await ctx.http().post(`${F}/releases/runs/${earlier.id}/reverse`).set(owner.auth).expect(409)).body.error).toBe('NOT_LATEST_RUN');
    const after = (await ctx.http().post(`${F}/releases/runs/${latest.id}/reverse`).set(owner.auth).expect(200)).body;
    expect(after.runs[0]).toMatchObject({ status: 'REVERSED', reversedBy: 'Deferral Owner' });
    expect((await entry(after.runs[0].reversal.entryNumber)).type).toBe('REVERSING');
    expect((await schedule(insurance)).released).toBe('20000.00');
    await ctx.http().post(`${F}/releases/runs`).set(owner.auth).send({ month: M }).expect(201);
    expect((await schedule(insurance)).released).toBe('30000.00');
    expect(Number((await schedule(support)).released)).toBeCloseTo(daily(M), 2);
  });

  it('ends a schedule early, refunding what is left', async () => {
    const body = { date: T, accountId: org.acc['1120'], note: 'Contract cancelled; balance refunded' };
    expect((await ctx.http().post(`${F}/${support}/end`).set(owner.auth).send({ ...body, accountId: org.acc['2350'] }).expect(422)).body.message).toBe('What is left cannot go back to the same account');
    const s = (await ctx.http().post(`${F}/${support}/end`).set(owner.auth).send(body).expect(200)).body;
    const left = (36500 - daily(M)).toFixed(2);
    expect(s).toMatchObject({ status: 'ENDED', remaining: '0.00', released: '36500.00', end: { date: T, amount: left, note: 'Contract cancelled; balance refunded', by: 'Deferral Owner' } });
    expect(lineMap(await entry(s.end.entry.entryNumber))).toEqual({ '1120': `-${left}`, '2350': left });
    expect((await ctx.http().post(`${F}/${support}/end`).set(owner.auth).send(body).expect(409)).body.error).toBe('SCHEDULE_ENDED');
    const d = await rel();
    expect((await ctx.http().post(`${F}/releases/runs/${d.runs[0].id}/reverse`).set(owner.auth).expect(409)).body.error).toBe('SCHEDULE_ENDED');
    const list = (await ctx.http().get(F).set(viewer.auth).expect(200)).body;
    expect(list.schedules.map((x: { reference: string; status: string }) => [x.reference, x.status])).toEqual([
      ['PP-0001', 'ACTIVE'],
      ['DR-0001', 'ENDED'],
    ]);
    expect(list.totals).toEqual({ prepaid: '90000.00', deferred: '0.00' });
    expect(list.can).toEqual({ manage: false });
  });

  it('keeps other organisations out', async () => {
    const other = await createOrg(ctx, outsider, { name: 'Other Pvt Ltd' });
    await ctx.http().get(`${F}/${insurance}`).set(outsider.auth).expect(404);
    await ctx.http().get(`${other.base}/deferrals/${insurance}`).set(outsider.auth).expect(404);
    expect((await ctx.http().get(`${other.base}/deferrals`).set(outsider.auth).expect(200)).body.schedules).toEqual([]);
  });

  it('keeps release history in the database', async () => {
    await expect(raw(`DELETE FROM deferral_schedules WHERE id = $1::uuid`, insurance)).rejects.toThrow(/never deleted/);
    await expect(raw(`UPDATE deferral_lines SET amount = 1 WHERE schedule_id = $1::uuid`, insurance)).rejects.toThrow(/never changed/);
    await expect(raw(`UPDATE deferral_schedules SET months = 24 WHERE id = $1::uuid`, insurance)).rejects.toThrow(/are fixed/);
    await expect(raw(`UPDATE deferral_schedules SET name = 'x' WHERE id = $1::uuid`, support)).rejects.toThrow(/ended schedule/);
    await expect(raw(`DELETE FROM deferral_runs WHERE org_id = $1::uuid`, org.orgId)).rejects.toThrow(/never deleted/);
  });
});

describe('accruals', () => {
  let accrual: string;

  it('posts an accrual on the month end and its reversal on the first of the next month', async () => {
    const body = { kind: 'EXPENSE', description: 'Electricity, bill not yet received', counterparty: 'State Power Co', month: M1, pnlAccountId: org.acc['6300'], balanceAccountId: org.acc['2200'], amount: '8500.00' };
    await ctx.http().post(`${F}/accruals`).set(viewer.auth).send(body).expect(403);
    expect((await ctx.http().post(`${F}/accruals`).set(owner.auth).send({ ...body, month: addMonth(M, 1) }).expect(422)).body.message).toBe('An accrual can be for this month or an earlier one, not a month still to come');
    expect((await ctx.http().post(`${F}/accruals`).set(owner.auth).send({ ...body, balanceAccountId: org.acc['1120'] }).expect(422)).body.message).toBe('The accrued liability account must be an accrued or other current liability');
    expect((await ctx.http().post(`${F}/accruals`).set(owner.auth).send({ ...body, kind: 'INCOME' }).expect(422)).body.error).toBe('ACCRUAL_INVALID');
    const a = (await ctx.http().post(`${F}/accruals`).set(accountant.auth).send(body).expect(201)).body;
    accrual = a.id;
    expect(a).toMatchObject({ reference: 'AC-0001', status: 'POSTED', amount: '8500.00', month: M1, createdBy: 'Deferral Accountant' });
    const je = await entry(a.entry.entryNumber);
    expect(je).toMatchObject({ source: 'ACCRUAL', date: monthEnd(M1), reference: 'AC-0001' });
    expect(lineMap(je)).toEqual({ '6300': '8500.00', '2200': '-8500.00' });
    const rev = await entry(a.reversal.entryNumber);
    expect(rev).toMatchObject({ type: 'REVERSING', date: firstOfNextMonth(M1) });
    expect(lineMap(rev)).toEqual({ '6300': '-8500.00', '2200': '8500.00' });
  });

  it('cancels an accrual that was wrong, putting both months back', async () => {
    await ctx.http().post(`${F}/accruals/${accrual}/cancel`).set(owner.auth).send({ note: 'no' }).expect(400);
    const a = (await ctx.http().post(`${F}/accruals/${accrual}/cancel`).set(owner.auth).send({ note: 'Bill arrived and was posted in the month' }).expect(200)).body;
    expect(a).toMatchObject({ status: 'CANCELLED', cancel: { note: 'Bill arrived and was posted in the month', by: 'Deferral Owner' } });
    const undo = await entry(a.cancel.entry.entryNumber);
    const redo = await entry(a.cancel.reversal.entryNumber);
    expect([undo.date, redo.date]).toEqual([monthEnd(M1), firstOfNextMonth(M1)]);
    expect(lineMap(undo)).toEqual({ '6300': '-8500.00', '2200': '8500.00' });
    expect(lineMap(redo)).toEqual({ '6300': '8500.00', '2200': '-8500.00' });
    expect((await ctx.http().post(`${F}/accruals/${accrual}/cancel`).set(owner.auth).send({ note: 'Again, by mistake' }).expect(409)).body.error).toBe('ACCRUAL_CANCELLED');
    await expect(raw(`DELETE FROM accruals WHERE id = $1::uuid`, accrual)).rejects.toThrow(/never deleted/);
  });

  it('accrues income and lists accruals by month', async () => {
    const acc = (await ctx.http().post(`${org.base}/accounts`).set(owner.auth).send({ code: '1460', name: 'Accrued Income', type: 'ASSET', subtype: 'OTHER_CURRENT_ASSET' }).expect(201)).body;
    const a = (await ctx.http().post(`${F}/accruals`).set(owner.auth).send({ kind: 'INCOME', description: 'Consulting hours not yet invoiced', month: M1, pnlAccountId: org.acc['4200'], balanceAccountId: acc.id, amount: '15000.00' }).expect(201)).body;
    expect(a.reference).toBe('AC-0002');
    const list = (await ctx.http().get(`${F}/accruals?month=${M1}`).set(viewer.auth).expect(200)).body;
    expect(list.accruals.map((x: { reference: string; status: string }) => [x.reference, x.status])).toEqual([
      ['AC-0002', 'POSTED'],
      ['AC-0001', 'CANCELLED'],
    ]);
    expect(list.totals).toEqual({ expense: '0.00', income: '15000.00' });
  });
});
