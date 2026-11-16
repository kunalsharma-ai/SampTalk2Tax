import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AlertsRunnerService } from '../src/alerts/alerts-runner.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser } from './helpers';

/**
 * Prioritised alerts and the work queue against the real API and database: every alert gets a
 * score with its reasons, new and reopened alerts become tasks by the notification setting,
 * those tasks close themselves when the alert is dismissed or clears, the checks run in the
 * background, and every task says where it came from.
 */
let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let viewer: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let customer: string;

const T = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const shift = (month: string, by: number) => {
  const m = +month.slice(5, 7) - 1 + by;
  return `${+month.slice(0, 4) + Math.floor(m / 12)}-${String((((m % 12) + 12) % 12) + 1).padStart(2, '0')}`;
};

interface Priority {
  score: number;
  band: string;
  reasons: string[];
}
interface Alert {
  id: string;
  rule: string;
  severity: string;
  title: string;
  status: string;
  priority: Priority;
}
interface Task {
  id: string;
  title: string;
  description: string | null;
  status: string;
  source: string;
  sourceLabel: string;
  dueDate: string | null;
  assignee: { type: string; role?: string };
  link: { path: string; label: string } | null;
  closeNote: string | null;
}
const alerts = async (auth = owner.auth) => (await ctx.http().get(`${org.base}/alerts`).set(auth).expect(200)).body as { monthlyRevenue: string | null; bands: Record<string, number>; alerts: Alert[] };
const alertTasks = async (status = 'ALL') => ((await ctx.http().get(`${org.base}/tasks`).query({ scope: 'all', status, source: 'ALERT' }).set(owner.auth).expect(200)).body.tasks as Task[]);
const rule = (key: string, enabled: boolean) => ctx.http().put(`${org.base}/alert-rules/${key}`).set(owner.auth).send({ enabled, params: {} }).expect(200);
const scan = () => ctx.http().post(`${org.base}/alerts/scan`).set(owner.auth).expect(200);
beforeAll(async () => {
  ctx = await bootApp();
  owner = await registerUser(ctx, 'Queue Owner');
  accountant = await registerUser(ctx, 'Queue Accountant');
  viewer = await registerUser(ctx, 'Queue Viewer');
  org = await createOrg(ctx, owner);
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [viewer, 'VIEWER']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  customer = (await ctx.http().post(`${org.base}/contacts`).set(owner.auth).send({ name: 'Late Payers', isCustomer: true }).expect(201)).body.id;
  // Revenue in the last complete months.
  const M = shift(T.slice(0, 7), -1);
  for (const k of [-2, -1]) await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: customer, issueDate: `${shift(M, k)}-10`, dueDate: addDays(T, 20), post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: '30000.00' }] }).expect(201);
  // And one 70 days overdue: a warning.
  await ctx.http().post(`${org.base}/sales/documents`).set(owner.auth).send({ kind: 'INVOICE', contactId: customer, issueDate: addDays(T, -80), dueDate: addDays(T, -70), post: true, lines: [{ accountId: org.acc['4100'], quantity: '1', unitPrice: '30000.00' }] }).expect(201);
  // A minimum balance the forecast cannot meet: a critical alert.
  await ctx.http().put(`${org.base}/cash-flow/settings`).set(owner.auth).send({ minimumBalance: '100000000' }).expect(200);
});
afterAll(async () => {
  await ctx.app.close();
});

describe('notification settings', () => {
  it('start with critical alerts going to the owners, due the same day, and only alert managers change them', async () => {
    const d = (await ctx.http().get(`${org.base}/alerts/notifications`).set(viewer.auth).expect(200)).body;
    expect(d).toEqual({ minSeverity: 'CRITICAL', taskRole: 'OWNER', dueDays: 0, isDefault: true, updatedBy: null, updatedAt: null });
    await ctx.http().put(`${org.base}/alerts/notifications`).set(viewer.auth).send({ minSeverity: 'WARNING', taskRole: 'OWNER', dueDays: 0 }).expect(403);
    const bad = await ctx.http().put(`${org.base}/alerts/notifications`).set(owner.auth).send({ minSeverity: 'WARNING', taskRole: 'VIEWER', dueDays: 31 }).expect(400);
    expect(JSON.stringify(bad.body)).toMatch(/At most 30 days/);
  });
});

describe('priority and the work queue', () => {
  let cash: Alert;

  it('scores every alert with its reasons and lists the most urgent first', async () => {
    const r = await alerts();
    expect(r.monthlyRevenue).not.toBeNull();
    cash = r.alerts.find((a) => a.rule === 'CASH_BELOW_MINIMUM')!;
    expect(cash).toMatchObject({ severity: 'CRITICAL', status: 'OPEN' });
    expect(cash.priority.band).toBe('URGENT');
    expect(cash.priority.reasons[0]).toBe('Critical (60)');
    expect(cash.priority.reasons.some((x) => /Amount at stake is more than a month of revenue \(25\)/.test(x))).toBe(true);
    const scores = r.alerts.map((a) => a.priority.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(r.bands.urgent + r.bands.high + r.bands.normal + r.bands.low).toBe(r.alerts.length);
    const one = (await ctx.http().get(`${org.base}/alerts/${cash.id}`).set(viewer.auth).expect(200)).body;
    expect(one.priority).toEqual(cash.priority);
  });

  it('turns a new critical alert into one task for the owners, from the alert, linked to it', async () => {
    const tasks = await alertTasks();
    const cashTasks = tasks.filter((t) => t.link?.path === `/alerts?alert=${cash.id}`);
    expect(cashTasks).toHaveLength(1);
    expect(cashTasks[0]).toMatchObject({ status: 'OPEN', source: 'ALERT', sourceLabel: 'An alert', dueDate: T, assignee: { type: 'role', role: 'OWNER' } });
    expect(cashTasks[0].title).toBe(`Critical alert: ${cash.title}`);
    expect(cashTasks[0].description).toMatch(/closes itself when the alert is cleared or dismissed\.$/);
    // Only critical alerts by default: none of the warnings made a task.
    const warnings = (await alerts()).alerts.filter((a) => a.severity !== 'CRITICAL');
    for (const w of warnings) expect(tasks.some((t) => t.link?.path === `/alerts?alert=${w.id}`)).toBe(false);
    // Checking again does not make a second task.
    await scan();
    expect((await alertTasks()).filter((t) => t.link?.path === `/alerts?alert=${cash.id}`)).toHaveLength(1);
  });

  it('cancels the task when the alert is dismissed, and makes a new one when it is reopened', async () => {
    await ctx.http().post(`${org.base}/alerts/${cash.id}/dismiss`).set(owner.auth).send({ reason: 'Minimum balance set too high for this test' }).expect(200);
    let mine = (await alertTasks()).filter((t) => t.link?.path === `/alerts?alert=${cash.id}`);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ status: 'CANCELLED', closeNote: 'The alert was dismissed: Minimum balance set too high for this test' });
    const dismissed = (await ctx.http().get(`${org.base}/alerts/${cash.id}`).set(owner.auth).expect(200)).body;
    expect(dismissed.priority).toMatchObject({ score: 0, band: 'LOW' });

    await ctx.http().post(`${org.base}/alerts/${cash.id}/reopen`).set(owner.auth).send({ note: null }).expect(200);
    mine = (await alertTasks()).filter((t) => t.link?.path === `/alerts?alert=${cash.id}`);
    expect(mine.map((t) => t.status).sort()).toEqual(['CANCELLED', 'OPEN']);
  });

  it('follows a changed setting: warnings go to the accountants with three days, and the task is done when the alert clears', async () => {
    const saved = (await ctx.http().put(`${org.base}/alerts/notifications`).set(owner.auth).send({ minSeverity: 'WARNING', taskRole: 'ACCOUNTANT', dueDays: 3 }).expect(200)).body;
    expect(saved).toMatchObject({ minSeverity: 'WARNING', taskRole: 'ACCOUNTANT', dueDays: 3, isDefault: false, updatedBy: 'Queue Owner' });
    const audit = await ctx.prisma.auditEvent.findFirst({ where: { orgId: org.orgId, action: 'alerts.notifications_changed' } });
    expect(audit?.data).toMatchObject({ before: { minSeverity: 'CRITICAL', taskRole: 'OWNER', dueDays: 0 }, after: { minSeverity: 'WARNING', taskRole: 'ACCOUNTANT', dueDays: 3 } });

    const overdue = (await alerts()).alerts.find((a) => a.rule === 'OVERDUE_RECEIVABLES');
    expect(overdue).toMatchObject({ severity: 'WARNING' });
    // Turning the check off clears the alert; turning it on finds it again and reopens it.
    await rule('OVERDUE_RECEIVABLES', false);
    await scan();
    await rule('OVERDUE_RECEIVABLES', true);
    await scan();
    let t = (await alertTasks()).find((x) => x.link?.path === `/alerts?alert=${overdue!.id}`);
    expect(t).toMatchObject({ status: 'OPEN', dueDate: addDays(T, 3), assignee: { type: 'role', role: 'ACCOUNTANT' } });
    expect(t!.title).toBe(`Warning: ${overdue!.title}`);
    // The accountant sees it in their own queue.
    const theirs = (await ctx.http().get(`${org.base}/tasks`).query({ source: 'ALERT' }).set(accountant.auth).expect(200)).body.tasks as Task[];
    expect(theirs.map((x) => x.id)).toContain(t!.id);

    await rule('OVERDUE_RECEIVABLES', false);
    await scan();
    t = (await alertTasks()).find((x) => x.id === t!.id);
    expect(t).toMatchObject({ status: 'DONE', closeNote: 'The alert cleared: the check was turned off.' });
    const closed = await ctx.prisma.auditEvent.findFirst({ where: { orgId: org.orgId, action: 'task.completed', entityId: t!.id } });
    expect(closed?.data).toMatchObject({ automatic: true });
  });
});

describe('background checks', () => {
  it('check an organisation whose last check is stale, as the system', async () => {
    const runner = ctx.app.get(AlertsRunnerService);
    // Just checked: nothing to do.
    expect(await runner.tick({ orgIds: [org.orgId] })).toEqual({ checked: 0, failed: 0 });
    // Two hours later, the last check is stale.
    expect(await runner.tick({ orgIds: [org.orgId], now: new Date(Date.now() + 2 * 3_600_000) })).toEqual({ checked: 1, failed: 0 });
    const last = await ctx.prisma.alertScan.findFirst({ where: { orgId: org.orgId }, orderBy: { finishedAt: 'desc' } });
    expect(last).toMatchObject({ ranById: null });
    expect(Date.now() - last!.finishedAt.getTime()).toBeLessThan(60_000);
  });

  it('leave out organisations with nothing posted', async () => {
    const empty = await createOrg(ctx, owner, { name: 'Empty Books Pvt Ltd' });
    expect(await ctx.app.get(AlertsRunnerService).tick({ orgIds: [empty.orgId] })).toEqual({ checked: 0, failed: 0 });
  });
});

describe('the work queue', () => {
  it('says where each task came from and filters by it', async () => {
    await ctx.http().post(`${org.base}/tasks`).set(owner.auth).send({ title: 'Call the bank', assignTo: { role: 'OWNER' } }).expect(201);
    const all = (await ctx.http().get(`${org.base}/tasks`).query({ scope: 'all', status: 'ALL' }).set(owner.auth).expect(200)).body.tasks as Task[];
    expect(new Set(all.map((t) => t.source))).toEqual(new Set(['PERSON', 'ALERT']));
    expect(all.find((t) => t.title === 'Call the bank')).toMatchObject({ source: 'PERSON', sourceLabel: 'A person' });
    const people = (await ctx.http().get(`${org.base}/tasks`).query({ scope: 'all', status: 'ALL', source: 'PERSON' }).set(owner.auth).expect(200)).body.tasks as Task[];
    expect(people.map((t) => t.title)).toEqual(['Call the bank']);
    await ctx.http().get(`${org.base}/tasks`).query({ source: 'ROBOT' }).set(owner.auth).expect(400);
  });
});
