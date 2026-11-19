import { fiscalYearForDate } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CloseRunnerService } from '../src/close/close-runner.service';
import { CloseService } from '../src/close/close.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/**
 * WFLOW-021 starting the month-end close automatically, against the real API and database: off
 * until someone who manages the close turns it on; then the close of the month that ended most
 * recently starts on its own (once), in the name of whoever turned it on, with tasks for open
 * checks if asked; earlier months and other organisations are left alone; it stops if the person
 * who set it up can no longer manage the close.
 */
const T = today();
const shift = (month: string, by: number) => {
  const m = +month.slice(5, 7) - 1 + by;
  return `${+month.slice(0, 4) + Math.floor(m / 12)}-${String((((m % 12) + 12) % 12) + 1).padStart(2, '0')}`;
};

let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let other: Awaited<ReturnType<typeof createOrg>>;
let M: string;
let periods: { id: string; startDate: string; name: string }[];

const periodsOf = async (o: typeof org, u: TestUser) => {
  const fy = fiscalYearForDate(`${M}-01`, 4);
  for (const y of [fy - 1, fy]) await ctx.http().post(`${o.base}/periods/fiscal-years`).set(u.auth).send({ fiscalYear: y });
  return (await ctx.http().get(`${o.base}/periods`).set(u.auth).expect(200)).body as { id: string; startDate: string; name: string }[];
};
const closeOf = async (periodId: string, o = org, u = owner) => (await ctx.http().get(`${o.base}/close/${periodId}`).set(u.auth).expect(200)).body;

beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Auto Owner');
  accountant = await registerUser(ctx, 'Auto Accountant');
  viewer = await registerUser(ctx, 'Auto Viewer');
  outsider = await registerUser(ctx, 'Auto Outsider');
  org = await createOrg(ctx, owner, { name: 'Auto Close Pvt Ltd' });
  other = await createOrg(ctx, outsider, { name: 'Other Auto Ltd' });
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  M = shift(T.slice(0, 7), -1);
  periods = await periodsOf(org, owner);
  await periodsOf(other, outsider);
  // A draft journal in last month leaves a blocking check open, so a task is made for it.
  await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: `${M}-10`, memo: 'Draft sale', post: false, lines: [{ accountId: org.acc['1120'], debit: '1000.00' }, { accountId: org.acc['4100'], credit: '1000.00' }] }).expect(201);
});
afterAll(async () => {
  await ctx?.app.close();
});

describe('starting the month-end close automatically', () => {
  it('is off by default, and only those who manage the close can turn it on', async () => {
    expect((await ctx.http().get(`${org.base}/close/settings`).set(viewer.auth).expect(200)).body).toMatchObject({ autoStart: false, createTasks: true, updatedBy: null, canChange: false });
    expect(await ctx.app.get(CloseService).autoStart(org.orgId, T)).toBeNull();
    await ctx.http().put(`${org.base}/close/settings`).set(viewer.auth).send({ autoStart: true, createTasks: true }).expect(403);
    await ctx.http().put(`${org.base}/close/settings`).set(owner.auth).send({ autoStart: 'yes', createTasks: true }).expect(400);
    const s = (await ctx.http().put(`${org.base}/close/settings`).set(accountant.auth).send({ autoStart: true, createTasks: true }).expect(200)).body;
    expect(s).toMatchObject({ autoStart: true, createTasks: true, updatedBy: 'Auto Accountant', canChange: true });
    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=close_settings&entityId=${org.orgId}`).set(owner.auth).expect(200)).body;
    expect((audit.items ?? audit)[0]).toMatchObject({ action: 'close.settings_changed', data: { autoStart: true, createTasks: true, before: null } });
  });

  it('starts the close of the month that ended most recently, once, with tasks for open checks', async () => {
    const last = periods.find((p) => p.startDate === `${M}-01`)!;
    const earlier = periods.find((p) => p.startDate === `${shift(M, -1)}-01`)!;
    const r = await ctx.app.get(CloseRunnerService).tick();
    expect(r).toMatchObject({ started: 1, failed: 0 });
    const v = await closeOf(last.id);
    expect(v.close).toMatchObject({ status: 'IN_PROGRESS', startedBy: 'Auto Accountant', automatic: true });
    const draft = v.checks.find((c: { key: string }) => c.key === 'DRAFT_JOURNALS');
    expect(draft.task).toMatchObject({ status: 'OPEN' });
    expect((await closeOf(earlier.id)).close).toBeNull();
    // The current month has not ended, so nothing starts for it.
    const current = periods.find((p) => p.startDate === `${T.slice(0, 7)}-01`);
    if (current) expect((await closeOf(current.id)).close).toBeNull();

    // Running again changes nothing.
    expect(await ctx.app.get(CloseService).autoStart(org.orgId, T)).toBeNull();
    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=period_close&entityId=${v.close.id}`).set(owner.auth).expect(200)).body;
    const started = (audit.items ?? audit).filter((e: { action: string }) => e.action === 'close.started');
    expect(started).toHaveLength(1);
    expect(started[0].data).toMatchObject({ period: last.name, automatic: true });
    // Other organisations did not ask for it.
    const otherLast = (await ctx.http().get(`${other.base}/close`).set(outsider.auth).expect(200)).body.periods.find((p: { startDate: string }) => p.startDate === `${M}-01`);
    expect(otherLast.closeStatus).toBe('NOT_STARTED');
  });

  it('starts next month without tasks when asked, and stops once its owner cannot manage the close', async () => {
    await ctx.http().put(`${org.base}/close/settings`).set(owner.auth).send({ autoStart: true, createTasks: false }).expect(200);
    const nextMonthEnd = `${shift(T.slice(0, 7), 1)}-01`;
    const r = await ctx.app.get(CloseService).autoStart(org.orgId, nextMonthEnd);
    const thisMonth = periods.find((p) => p.startDate === `${T.slice(0, 7)}-01`)!;
    expect(r).toMatchObject({ periodId: thisMonth.id, tasks: 0 });
    const v = await closeOf(thisMonth.id);
    expect(v.close).toMatchObject({ startedBy: 'Auto Owner', automatic: true });
    expect(v.checks.every((c: { task: unknown }) => c.task === null)).toBe(true);

    await ctx.http().put(`${org.base}/close/settings`).set(accountant.auth).send({ autoStart: true, createTasks: true }).expect(200);
    const m = await ctx.prisma.membership.findFirstOrThrow({ where: { orgId: org.orgId, userId: accountant.id } });
    await ctx.prisma.membership.update({ where: { id: m.id }, data: { role: 'VIEWER' } });
    expect(await ctx.app.get(CloseService).autoStart(org.orgId, `${shift(T.slice(0, 7), 2)}-01`)).toEqual({ skipped: 'SET_UP_BY_SOMEONE_WHO_CANNOT_MANAGE_THE_CLOSE' });
  });
});
