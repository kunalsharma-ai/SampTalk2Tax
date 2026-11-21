import { addDays } from '@talk2tax/accounting-engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startSmtpStandIn, type SmtpStandIn } from '../../../test-support/smtp-stand-in.mjs';
import { runInOrg } from '../src/common/tenant-context';
import { ReportSchedulesService } from '../src/report-schedules/report-schedules.service';
import { bootApp, createOrg, Ctx, registerUser, TestUser, today } from './helpers';

/** Scheduled reports by email (RPT-031, RPT-032) against the real API, database and a local SMTP stand-in. */
let smtp: SmtpStandIn;
let ctx: Ctx;
let owner: TestUser;
let accountant: TestUser;
let viewer: TestUser;
let employee: TestUser;
let org: Awaited<ReturnType<typeof createOrg>>;
let service: ReportSchedulesService;

const body = (over: Record<string, unknown> = {}) => ({ name: 'Monthly P&L', report: 'income-statement', format: 'pdf', period: 'MONTH_TO_DATE', frequency: 'MONTHLY', weekday: null, dayOfMonth: 3, recipientIds: [owner.id, viewer.id], ...over });

beforeAll(async () => {
  smtp = await startSmtpStandIn();
  ctx = await bootApp({ SMTP_URL: `smtp://127.0.0.1:${smtp.port}`, EMAIL_FROM: 'Talk2Tax <robot@talk2tax.test>' });
  owner = await registerUser(ctx, 'Owner');
  accountant = await registerUser(ctx, 'Accountant');
  viewer = await registerUser(ctx, 'Viewer');
  employee = await registerUser(ctx, 'Employee');
  org = await createOrg(ctx, owner);
  for (const [u, role] of [[accountant, 'ACCOUNTANT'], [viewer, 'VIEWER'], [employee, 'EMPLOYEE']] as const) await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: u.email, role }).expect(201);
  const d = addDays(today(), -1).slice(0, 7) === today().slice(0, 7) ? addDays(today(), -1) : today();
  await ctx.http().post(`${org.base}/journals`).set(owner.auth).send({ date: d, post: true, lines: [{ accountId: org.acc['1120'], debit: '1250.00' }, { accountId: org.acc['4100'], credit: '1250.00' }] }).expect(201);
  service = ctx.app.get(ReportSchedulesService);
});
afterAll(async () => {
  await ctx.app.close();
  await smtp?.close();
});

describe('setting up a schedule', () => {
  it('checks the schedule and only lets members who read reports receive it', async () => {
    const bad = await ctx.http().post(`${org.base}/report-schedules`).set(accountant.auth).send(body({ dayOfMonth: 30, recipientIds: [employee.id] })).expect(422);
    expect(bad.body.details.issues).toEqual(['Pick a day of the month from 1 to 28', 'Recipients must be members of this organisation who can read reports']);
    const outsider = await registerUser(ctx, 'Outsider');
    await ctx.http().post(`${org.base}/report-schedules`).set(accountant.auth).send(body({ recipientIds: [outsider.id] })).expect(422);
    await ctx.http().post(`${org.base}/report-schedules`).set(viewer.auth).send(body()).expect(403);
  });

  it('saves it with the next run date, lists it for readers, and records it in the audit trail', async () => {
    const s = (await ctx.http().post(`${org.base}/report-schedules`).set(accountant.auth).send(body()).expect(201)).body;
    expect(s).toMatchObject({ name: 'Monthly P&L', reportLabel: 'Profit and loss', periodLabel: 'This month to the day before', isActive: true, lastRun: null });
    expect(s.nextRunOn > today()).toBe(true);
    expect(s.nextRunOn.slice(8)).toBe('03');
    expect(s.recipients.map((r: { email: string }) => r.email)).toEqual([owner.email, viewer.email]);
    const list = (await ctx.http().get(`${org.base}/report-schedules`).set(viewer.auth).expect(200)).body;
    expect(list.emailReady).toBe(true);
    expect(list.items.map((x: { id: string }) => x.id)).toContain(s.id);
    expect(list.recipients.map((r: { email: string }) => r.email).sort()).toEqual([owner.email, accountant.email, viewer.email].sort());
    const audit = (await ctx.http().get(`${org.base}/audit-events?entityType=report_schedule`).set(owner.auth).expect(200)).body;
    expect(JSON.stringify(audit)).toContain('report_schedule.created');
    await ctx.http().get(`${org.base}/report-schedules`).set(employee.auth).expect(403);
  });
});

describe('sending', () => {
  it('sends now: the report as an attachment to each recipient, with the run and file hash kept', async () => {
    const s = (await ctx.http().post(`${org.base}/report-schedules`).set(accountant.auth).send(body({ name: 'Send now' })).expect(201)).body;
    const before = smtp.messages.length;
    const run = (await ctx.http().post(`${org.base}/report-schedules/${s.id}/send`).set(accountant.auth).expect(201)).body;
    expect(run).toMatchObject({ status: 'SENT', manual: true, recipients: [owner.email, viewer.email], error: null });
    expect(run.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(run.params.to).toBe(addDays(today(), -1));
    const m = smtp.messages[before]!;
    expect(m.to.sort()).toEqual([owner.email, viewer.email].sort());
    expect(m.subject).toMatch(/^Profit and loss, .* to .*: Acme Test Pvt Ltd$/);
    expect(m.text).toContain('is attached');
    const pdf = m.attachments.find((a) => a.contentType.startsWith('application/pdf'))!;
    expect(pdf.data.subarray(0, 5).toString()).toBe('%PDF-');
    const detail = (await ctx.http().get(`${org.base}/report-schedules/${s.id}`).set(viewer.auth).expect(200)).body;
    expect(detail.runs).toHaveLength(1);
    expect(detail.nextRunOn).toBe(s.nextRunOn); // sending now does not move the next run
  });

  it('sends each due run once, even when two runners try at the same moment, then moves to the next date', async () => {
    const s = (await ctx.http().post(`${org.base}/report-schedules`).set(accountant.auth).send(body({ name: 'Due run', format: 'csv', report: 'trial-balance', period: 'LAST_MONTH' })).expect(201)).body;
    const before = smtp.messages.length;
    const runDay = s.nextRunOn;
    const [a, b] = await Promise.all([runInOrg(org.orgId, () => service.runIfDue(s.id, runDay)), runInOrg(org.orgId, () => service.runIfDue(s.id, runDay))]);
    expect([a?.status, b?.status].filter(Boolean)).toEqual(['SENT']);
    expect(smtp.messages.length - before).toBe(1);
    expect(smtp.messages[before]!.attachments.some((x) => x.contentType.startsWith('text/csv'))).toBe(true);
    const after = (await ctx.http().get(`${org.base}/report-schedules/${s.id}`).set(owner.auth).expect(200)).body;
    expect(after.nextRunOn > runDay).toBe(true);
    expect(after.lastRun).toMatchObject({ status: 'SENT', manual: false, runOn: runDay });
    expect(await runInOrg(org.orgId, () => service.runIfDue(s.id, runDay))).toBeNull();
  });

  it('a run before its date sends nothing, and a paused schedule never runs', async () => {
    const s = (await ctx.http().post(`${org.base}/report-schedules`).set(accountant.auth).send(body({ name: 'Paused', frequency: 'WEEKLY', weekday: 1, dayOfMonth: null })).expect(201)).body;
    expect(await runInOrg(org.orgId, () => service.runIfDue(s.id, addDays(s.nextRunOn, -1)))).toBeNull();
    await ctx.http().put(`${org.base}/report-schedules/${s.id}`).set(accountant.auth).send(body({ name: 'Paused', frequency: 'WEEKLY', weekday: 1, dayOfMonth: null, isActive: false })).expect(200);
    expect(await runInOrg(org.orgId, () => service.runIfDue(s.id, addDays(s.nextRunOn, 30)))).toBeNull();
  });

  it('drops recipients who left, and fails (without sending) once its owner cannot read reports', async () => {
    const leaver = await registerUser(ctx, 'Leaver');
    await ctx.http().post(`${org.base}/members`).set(owner.auth).send({ email: leaver.email, role: 'ACCOUNTANT' }).expect(201);
    const s = (await ctx.http().post(`${org.base}/report-schedules`).set(leaver.auth).send(body({ name: 'Leaver', recipientIds: [leaver.id, viewer.id] })).expect(201)).body;
    const members = (await ctx.http().get(`${org.base}/members`).set(owner.auth).expect(200)).body as { userId: string }[];
    expect(members.some((m) => m.userId === leaver.id)).toBe(true);
    await ctx.http().put(`${org.base}/members/${leaver.id}`).set(owner.auth).send({ role: 'EMPLOYEE' }).expect(200);
    const before = smtp.messages.length;
    const run = (await ctx.http().post(`${org.base}/report-schedules/${s.id}/send`).set(owner.auth).expect(201)).body;
    expect(run).toMatchObject({ status: 'FAILED', recipients: [viewer.email] });
    expect(run.error).toMatch(/can no longer read reports/);
    expect(smtp.messages.length).toBe(before);
  });

  it('keeps a failed delivery with the mail server’s reason', async () => {
    const s = (await ctx.http().post(`${org.base}/report-schedules`).set(accountant.auth).send(body({ name: 'Refused', recipientIds: [viewer.id] })).expect(201)).body;
    smtp.answers.set(viewer.email.toLowerCase(), '550 5.1.1 No such mailbox');
    const run = (await ctx.http().post(`${org.base}/report-schedules/${s.id}/send`).set(accountant.auth).expect(201)).body;
    smtp.answers.delete(viewer.email.toLowerCase());
    expect(run.status).toBe('FAILED');
    expect(run.error).toMatch(/550/);
  });

  it('is closed to other organisations', async () => {
    const s = (await ctx.http().post(`${org.base}/report-schedules`).set(accountant.auth).send(body({ name: 'Private' })).expect(201)).body;
    const other = await registerUser(ctx, 'Other');
    const otherOrg = await createOrg(ctx, other);
    await ctx.http().get(`${otherOrg.base}/report-schedules/${s.id}`).set(other.auth).expect(404);
    await ctx.http().post(`${otherOrg.base}/report-schedules/${s.id}/send`).set(other.auth).expect(404);
    await ctx.http().get(`${org.base}/report-schedules/${s.id}`).set(other.auth).expect(404);
  });
});
