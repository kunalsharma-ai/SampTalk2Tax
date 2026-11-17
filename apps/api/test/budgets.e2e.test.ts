import { fiscalYearForDate } from '@talk2tax/accounting-engine';
import { mirrorRows } from '../src/common/prisma.service';
import { tenantStorage } from '../src/common/tenant-context';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';
import { sqlWrite } from './sql-writes';

const FY = fiscalYearForDate(today(), 4);
const PRIOR_APR = `${FY - 2}-04-15`;
const PRIOR_MAY = `${FY - 2}-05-10`;
const twelve = (v: string) => Array.from({ length: 12 }, () => v);
const zeroWith = (i: number, v: string) => twelve('0.00').map((x, k) => (k === i ? v : x));

let ctx: Ctx;
let owner: TestUser;
let approver: TestUser;
let accountant: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let v1: string;

interface V {
  budget: string;
  actual: string | null;
  variance: string | null;
  percent: string | null;
  favourable: boolean | null;
}

const journal = (date: string, debit: string, credit: string, amount: string) =>
  ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date, post: true, memo: 'Budget test', lines: [{ accountId: org.acc[debit], debit: amount }, { accountId: org.acc[credit], credit: amount }] }).expect(201);

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Budget Owner');
  approver = await registerUser(ctx, 'Budget Approver');
  accountant = await registerUser(ctx, 'Budget Accountant');
  viewer = await registerUser(ctx, 'Budget Viewer');
  org = await createOrg(ctx, owner);
  for (const [u, role] of [[approver, 'APPROVER'], [accountant, 'ACCOUNTANT'], [viewer, 'VIEWER']] as const) {
    await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  }
  // Last year's books, for a budget built from actuals.
  await ctx.http().post(`${org.base}/periods/fiscal-years`).set(owner.auth).send({ fiscalYear: FY - 1 }).expect(201);
  await journal(PRIOR_APR, '1120', '4100', '100000.00');
  await journal(PRIOR_MAY, '6200', '1120', '30000.00');
  // This year so far.
  await journal(today(), '1120', '4100', '50000.00');
  await journal(today(), '6200', '1120', '20000.00');
  await journal(today(), '6300', '1120', '1000.00');
});
afterAll(async () => {
  await ctx.app.close();
});

describe('budget versions', () => {
  it('starts with no versions and offers last, this and next year', async () => {
    const r = await ctx.http().get(`${org.base}/budgets`).set(viewer.auth).expect(200);
    expect(r.body).toMatchObject({ currentFiscalYear: FY, fiscalYear: FY, budgets: [], currency: 'INR' });
    expect(r.body.years.map((y: { fiscalYear: number }) => y.fiscalYear)).toEqual([FY + 1, FY, FY - 1]);
    expect(r.body.years[1]).toMatchObject({ label: `FY${FY}`, from: `${FY - 1}-04-01`, to: `${FY}-03-31` });
  });

  it('creates an empty draft and saves monthly amounts, checking accounts and amounts', async () => {
    await ctx.http().post(`${org.base}/budgets`).set(viewer.auth).send({ basis: 'EMPTY', fiscalYear: FY, name: 'Plan' }).expect(403);
    const created = await ctx.http().post(`${org.base}/budgets`).set(accountant.auth).send({ basis: 'EMPTY', fiscalYear: FY, name: 'Original plan' }).expect(201);
    v1 = created.body.budget.id;
    expect(created.body.budget).toMatchObject({ version: 1, status: 'DRAFT', basis: 'EMPTY', createdBy: { name: 'Budget Accountant' } });
    expect(created.body.periods[0]).toMatchObject({ periodNo: 1, label: `Apr ${FY - 1}`, startDate: `${FY - 1}-04-01` });
    expect(created.body.rows.find((r: { code: string }) => r.code === '4100')).toMatchObject({ amounts: null, total: null });
    expect(created.body.rows.some((r: { code: string }) => r.code === '1120' || r.code === '4000')).toBe(false);

    const bad = await ctx
      .http()
      .put(`${org.base}/budgets/${v1}/lines`)
      .set(accountant.auth)
      .send({ lines: [{ accountId: org.acc['1120'], amounts: twelve('1') }, { accountId: org.acc['4100'], amounts: [...twelve('1').slice(1), '1.005'] }] })
      .expect(422);
    expect(bad.body.error).toBe('BUDGET_INVALID');
    expect(bad.body.details.issues.map((i: { message: string }) => i.message)).toEqual([expect.stringMatching(/revenue and expense accounts only/), '4100 Sales Revenue, month 12: at most 2 decimal places']);
    await ctx.http().put(`${org.base}/budgets/${v1}/lines`).set(accountant.auth).send({ lines: [{ accountId: org.acc['4100'], amounts: ['1'] }] }).expect(400);
  });

  it('keeps the totals by type and month', async () => {
    const r = await ctx
      .http()
      .put(`${org.base}/budgets/${v1}/lines`)
      .set(accountant.auth)
      .send({ lines: [{ accountId: org.acc['4100'], amounts: twelve('40000') }, { accountId: org.acc['6200'], amounts: twelve('25000') }, { accountId: org.acc['6500'], amounts: twelve('1000.5') }] })
      .expect(200);
    expect(r.body.rows.find((x: { code: string }) => x.code === '4100')).toMatchObject({ amounts: twelve('40000.00'), total: '480000.00' });
    expect(r.body.totals.year).toEqual({ revenue: '480000.00', expenses: '312006.00', netIncome: '167994.00' });
    // Taking an account out
    const out = await ctx.http().put(`${org.base}/budgets/${v1}/lines`).set(accountant.auth).send({ lines: [{ accountId: org.acc['6500'], amounts: null }] }).expect(200);
    expect(out.body.totals.year).toEqual({ revenue: '480000.00', expenses: '300000.00', netIncome: '180000.00' });
    const list = await ctx.http().get(`${org.base}/budgets`).query({ fiscalYear: FY }).set(viewer.auth).expect(200);
    expect(list.body.budgets[0]).toMatchObject({ version: 1, accounts: 2, revenue: '480000.00', expenses: '300000.00', netIncome: '180000.00' });
  });

  it('starts a version from last year’s actuals with a change, or from another version', async () => {
    const prior = await ctx.http().post(`${org.base}/budgets`).set(accountant.auth).send({ basis: 'PRIOR_ACTUALS', fiscalYear: FY, name: 'Last year + 10%', changePercent: '10' }).expect(201);
    expect(prior.body.budget).toMatchObject({ version: 2, basis: 'PRIOR_ACTUALS', changePercent: '10.00' });
    const row = (code: string) => prior.body.rows.find((x: { code: string }) => x.code === code);
    expect(row('4100').amounts).toEqual(zeroWith(0, '110000.00'));
    expect(row('6200').amounts).toEqual(zeroWith(1, '33000.00'));
    expect(row('6300').amounts).toBeNull();

    const none = await ctx.http().post(`${org.base}/budgets`).set(accountant.auth).send({ basis: 'PRIOR_ACTUALS', fiscalYear: FY - 3, name: 'Nothing', changePercent: '0' }).expect(422);
    expect(none.body.error).toBe('NO_PRIOR_ACTUALS');

    const copy = await ctx.http().post(`${org.base}/budgets`).set(accountant.auth).send({ basis: 'COPY', fiscalYear: FY, name: 'Revised', sourceBudgetId: v1 }).expect(201);
    expect(copy.body.budget).toMatchObject({ version: 3, basis: 'COPY', sourceBudgetId: v1 });
    expect(copy.body.source).toMatchObject({ id: v1, version: 1 });
    expect(copy.body.totals.year).toEqual({ revenue: '480000.00', expenses: '300000.00', netIncome: '180000.00' });

    // A version that was copied is kept; others can be deleted while drafts.
    expect((await ctx.http().delete(`${org.base}/budgets/${v1}`).set(accountant.auth).expect(409)).body.error).toBe('BUDGET_IN_USE');
    await ctx.http().delete(`${org.base}/budgets/${prior.body.budget.id}`).set(accountant.auth).expect(200);
    await ctx.http().get(`${org.base}/budgets/${prior.body.budget.id}`).set(accountant.auth).expect(404);
    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, entityType: 'budget' }, select: { action: true } });
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['budget.created', 'budget.lines_saved', 'budget.deleted']));
  });
});

describe('approval', () => {
  it('needs amounts, freezes the submitted version and keeps approval with someone else', async () => {
    const empty = await ctx.http().post(`${org.base}/budgets`).set(accountant.auth).send({ basis: 'EMPTY', fiscalYear: FY + 1, name: 'Next year' }).expect(201);
    expect((await ctx.http().post(`${org.base}/budgets/${empty.body.budget.id}/submit`).set(accountant.auth).expect(422)).body.error).toBe('BUDGET_EMPTY');

    const s = await ctx.http().post(`${org.base}/budgets/${v1}/submit`).set(accountant.auth).expect(200);
    expect(s.body.budget).toMatchObject({ status: 'SUBMITTED', submittedBy: { name: 'Budget Accountant' } });
    expect((await ctx.http().put(`${org.base}/budgets/${v1}/lines`).set(accountant.auth).send({ lines: [{ accountId: org.acc['4100'], amounts: twelve('1') }] }).expect(409)).body.error).toBe('BUDGET_NOT_DRAFT');
    expect((await ctx.http().patch(`${org.base}/budgets/${v1}`).set(accountant.auth).send({ name: 'x' }).expect(409)).body.error).toBe('BUDGET_NOT_DRAFT');
    await ctx.http().post(`${org.base}/budgets/${v1}/approve`).set(accountant.auth).expect(403); // no approvals.decide

    // Sent back with a reason, fixed, sent again
    await ctx.http().post(`${org.base}/budgets/${v1}/return`).set(approver.auth).send({ reason: "x" }).expect(400);
    const back = await ctx.http().post(`${org.base}/budgets/${v1}/return`).set(approver.auth).send({ reason: 'Rent goes up in October' }).expect(200);
    expect(back.body.budget).toMatchObject({ status: 'DRAFT', submittedBy: null, returned: { by: { name: 'Budget Approver' }, reason: 'Rent goes up in October' } });
    await ctx.http().patch(`${org.base}/budgets/${v1}`).set(accountant.auth).send({ name: 'Original plan (rent fixed)' }).expect(200);
    await ctx.http().post(`${org.base}/budgets/${v1}/submit`).set(owner.auth).expect(200);
    const self = await ctx.http().post(`${org.base}/budgets/${v1}/approve`).set(owner.auth).expect(403);
    expect(self.body.error).toBe('SELF_APPROVAL');
    const ok = await ctx.http().post(`${org.base}/budgets/${v1}/approve`).set(approver.auth).expect(200);
    expect(ok.body.budget).toMatchObject({ status: 'APPROVED', approvedBy: { name: 'Budget Approver' }, submittedBy: { name: 'Budget Owner' }, returned: { reason: 'Rent goes up in October' } });
    await ctx.http().post(`${org.base}/budgets/${v1}/withdraw`).set(owner.auth).expect(409);
    await ctx.http().delete(`${org.base}/budgets/${v1}`).set(owner.auth).expect(409);
  });

  it('supersedes the earlier approved version when another is approved', async () => {
    const list = await ctx.http().get(`${org.base}/budgets`).set(owner.auth).expect(200);
    const v3 = list.body.budgets.find((b: { version: number }) => b.version === 3).id;
    await ctx.http().post(`${org.base}/budgets/${v3}/submit`).set(owner.auth).expect(200);
    await ctx.http().post(`${org.base}/budgets/${v3}/withdraw`).set(accountant.auth).expect(200);
    await ctx.http().post(`${org.base}/budgets/${v3}/submit`).set(owner.auth).expect(200);
    await ctx.http().post(`${org.base}/budgets/${v3}/approve`).set(approver.auth).expect(200);
    const after = await ctx.http().get(`${org.base}/budgets`).set(owner.auth).expect(200);
    const st = Object.fromEntries(after.body.budgets.map((b: { version: number; status: string }) => [b.version, b.status]));
    expect(st).toEqual({ 1: 'SUPERSEDED', 3: 'APPROVED' });
    expect(after.body.budgets.find((b: { version: number }) => b.version === 1).supersededAt).toBeTruthy();
    const audit = await ctx.prisma.auditEvent.findMany({ where: { orgId: org.orgId, entityId: v3 }, orderBy: { id: 'asc' }, select: { action: true } });
    expect(audit.map((a) => a.action)).toEqual(['budget.created', 'budget.submitted', 'budget.withdrawn', 'budget.submitted', 'budget.approved']);
  });
});

describe('budget against actual', () => {
  const thisMonth = today().slice(0, 7);

  it('compares each month with posted actuals, including spending nobody budgeted', async () => {
    const r = await ctx.http().get(`${org.base}/budgets/${v1}/variance`).query({ granularity: 'MONTH' }).set(viewer.auth).expect(200);
    const started: number = r.body.periodsStarted;
    expect(started).toBeGreaterThanOrEqual(1);
    expect(r.body.buckets).toHaveLength(12);
    const i = r.body.buckets.findIndex((b: { key: string }) => b.key === thisMonth);
    expect(r.body.buckets[i]).toMatchObject({ started: true });
    expect(r.body.buckets.slice(i + 1).every((b: { started: boolean }) => !b.started)).toBe(true);
    const row = (code: string) => r.body.rows.find((x: { code: string }) => x.code === code);
    expect(row('4100').buckets[i] as V).toEqual({ budget: '40000.00', actual: '50000.00', variance: '10000.00', percent: '25.0', favourable: true });
    expect(row('6200').buckets[i] as V).toMatchObject({ budget: '25000.00', actual: '20000.00', variance: '-5000.00', favourable: true });
    expect(row('6300')).toMatchObject({ budgeted: false, fullYearBudget: '0.00' });
    expect(row('6300').buckets[i] as V).toMatchObject({ budget: '0.00', actual: '1000.00', favourable: false, percent: null });
    if (i + 1 < 12) expect(row('4100').buckets[i + 1]).toMatchObject({ budget: '40000.00', actual: null });
    expect(r.body.revenue.yearToDate).toMatchObject({ budget: (40000 * started).toFixed(2), actual: '50000.00' });
    expect(r.body.netIncome.yearToDate).toMatchObject({ actual: '29000.00' });
    expect(r.body.netIncome.fullYearBudget).toBe('180000.00');
  });

  it('groups by quarter and year, and has no actuals before the year starts', async () => {
    const q = await ctx.http().get(`${org.base}/budgets/${v1}/variance`).query({ granularity: 'QUARTER' }).set(owner.auth).expect(200);
    expect(q.body.buckets.map((b: { key: string }) => b.key)).toEqual(['Q1', 'Q2', 'Q3', 'Q4']);
    expect(q.body.buckets[0].label).toBe(`Q1 (Apr ${FY - 1} – Jun ${FY - 1})`);
    expect(q.body.buckets.filter((b: { inProgress: boolean }) => b.inProgress)).toHaveLength(1);
    const y = await ctx.http().get(`${org.base}/budgets/${v1}/variance`).query({ granularity: 'YEAR' }).set(owner.auth).expect(200);
    expect(y.body.netIncome.buckets[0]).toMatchObject({ budget: '180000.00', actual: '29000.00' });
    const before = await ctx.http().get(`${org.base}/budgets/${v1}/variance`).query({ granularity: 'YEAR', asOf: `${FY - 1}-03-31` }).set(owner.auth).expect(200);
    expect(before.body).toMatchObject({ periodsStarted: 0, actualsThrough: null });
    expect(before.body.revenue.buckets[0]).toMatchObject({ budget: '480000.00', actual: null });
    await ctx.http().get(`${org.base}/budgets/${v1}/variance`).query({ granularity: "WEEK" }).set(owner.auth).expect(400);
  });
});

describe('database guards', () => {
  const raw = async (sql: string, ...args: unknown[]) => sqlWrite(ctx, sql, args, { bypass: true });

  it('keeps approved budgets and their lines fixed', async () => {
    await expect(raw(`UPDATE budget_lines SET amount = 1 WHERE budget_id = $1::uuid`, v1)).rejects.toThrow(/only while the budget is a draft/);
    await expect(raw(`DELETE FROM budget_lines WHERE budget_id = $1::uuid`, v1)).rejects.toThrow(/only while the budget is a draft/);
    await expect(raw(`UPDATE budgets SET name = 'changed' WHERE id = $1::uuid`, v1)).rejects.toThrow(/Only a draft budget can be renamed/);
    await expect(raw(`DELETE FROM budgets WHERE id = $1::uuid`, v1)).rejects.toThrow(/Only draft budgets can be deleted/);
    await expect(raw(`UPDATE budgets SET status = 'APPROVED', superseded_at = NULL WHERE id = $1::uuid`, v1)).rejects.toThrow(/cannot move from SUPERSEDED to APPROVED/);
    await expect(raw(`UPDATE budgets SET version = 99 WHERE id = $1::uuid`, v1)).rejects.toThrow(/never change/);
  });

  it('refuses self-approval, a second approved version and lines for balance sheet accounts', async () => {
    const draft = await ctx.http().post(`${org.base}/budgets`).set(owner.auth).send({ basis: 'COPY', fiscalYear: FY, name: 'Tamper', sourceBudgetId: v1 }).expect(201);
    const id = draft.body.budget.id;
    await expect(raw(`INSERT INTO budget_lines (id, org_id, budget_id, account_id, period_no, amount) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 1, 5)`, org.orgId, id, org.acc['1120'])).rejects.toThrow(/revenue and expense accounts only/);
    await expect(raw(`INSERT INTO budget_lines (id, org_id, budget_id, account_id, period_no, amount) VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 13, 5)`, org.orgId, id, org.acc['6300'])).rejects.toThrow(/budget_lines_chk/);
    await expect(raw(`UPDATE budgets SET status = 'APPROVED', approved_at = now(), approved_by_id = created_by_id WHERE id = $1::uuid`, id)).rejects.toThrow(/cannot move from DRAFT to APPROVED/);
    await raw(`UPDATE budgets SET status = 'SUBMITTED', submitted_at = now(), submitted_by_id = $2::uuid WHERE id = $1::uuid`, id, owner.id);
    // Written past the API, so MongoDB is brought in step by hand.
    await tenantStorage.run({ bypass: true }, () => mirrorRows(ctx.prisma, 'Budget', { id }));
    await expect(raw(`UPDATE budgets SET status = 'APPROVED', approved_at = now(), approved_by_id = $2::uuid WHERE id = $1::uuid`, id, owner.id)).rejects.toThrow(/budgets_approver_chk/);
    await expect(raw(`UPDATE budgets SET status = 'APPROVED', approved_at = now(), approved_by_id = $2::uuid WHERE id = $1::uuid`, id, approver.id)).rejects.toThrow(/23505|Unique constraint/);
  });

  it('keeps organisations apart', async () => {
    const stranger = await registerUser(ctx, 'Other Org Owner');
    const other = await createOrg(ctx, stranger);
    await ctx.http().get(`${other.base}/budgets/${v1}`).set(stranger.auth).expect(404);
    await ctx.http().get(`${org.base}/budgets/${v1}`).set(stranger.auth).expect(404);
    const copy = await ctx.http().post(`${other.base}/budgets`).set(stranger.auth).send({ basis: 'COPY', fiscalYear: FY, name: 'Steal', sourceBudgetId: v1 }).expect(404);
    expect(copy.body.error).toBe('NOT_FOUND');
    const mine = await ctx.http().post(`${other.base}/budgets`).set(stranger.auth).send({ basis: 'EMPTY', fiscalYear: FY, name: 'Mine' }).expect(201);
    await ctx.http().put(`${other.base}/budgets/${mine.body.budget.id}/lines`).set(stranger.auth).send({ lines: [{ accountId: org.acc['4100'], amounts: twelve('1') }] }).expect(422);
  });
});
