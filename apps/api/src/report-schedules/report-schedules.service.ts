import { HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  nextScheduleRun,
  SCHEDULE_PERIOD_LABEL,
  scheduleIssues,
  scheduleParams,
  SCHEDULED_REPORT_LABEL,
  type ScheduledReport,
  type ScheduleInput,
  type SchedulePeriod,
} from '@talk2tax/accounting-engine';
import { isDuplicateKeyError } from '@talk2tax/document-db';
import { hasPermission, type RoleName } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { AuthUser, OrgContext } from '../auth/decorators';
import { todayIso } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { runInOrg, tenantStorage } from '../common/tenant-context';
import { users } from '../db/collections/identity';
import { ReportScheduleDoc, reportScheduleRuns, ReportScheduleRunDoc, reportSchedules } from '../db/collections/report-schedules';
import { memberships, organizations } from '../db/collections/tenancy';
import { ReportExportService } from '../report-exports/report-exports.service';
import { MailerService } from '../workflows/email';

/** Due schedules are read this many at a time. */
const DUE_PAGE = 500;

export type ScheduleBody = ScheduleInput & { isActive?: boolean };

/**
 * Scheduled reports by email (RPT-031, RPT-032). reports.design sets them up; everyone with
 * reports.read sees them. A run renders the report with the same export as the Reports screens,
 * as the member who set the schedule up (with their access at the time of the run), and emails
 * it to the recipients who are still members able to read reports. Each run is kept with the
 * file's hash.
 */
@Injectable()
export class ReportSchedulesService {
  private readonly logger = new Logger('ReportSchedules');

  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly exports: ReportExportService,
    private readonly mailer: MailerService,
  ) {}

  /** Members who can read reports, by user id. */
  private async readers(): Promise<Map<string, { email: string; name: string; role: RoleName }>> {
    const ms = await this.store.collection(memberships).find({});
    const people = new Map((await this.store.collection(users).find({ id: { $in: ms.map((m) => m.userId) } })).map((u) => [u.id, u]));
    const out = new Map<string, { email: string; name: string; role: RoleName }>();
    for (const m of ms) {
      const u = people.get(m.userId);
      if (u && u.isActive && hasPermission(m.role, 'reports.read')) out.set(u.id, { email: u.email, name: u.name, role: m.role });
    }
    return out;
  }

  private invalid(issues: string[]) {
    return new DomainError('SCHEDULE_INVALID', issues[0] ?? 'The schedule is invalid', HttpStatus.UNPROCESSABLE_ENTITY, { issues });
  }

  private serialize(s: ReportScheduleDoc, readers: Map<string, { email: string; name: string }>, last: ReportScheduleRunDoc | null) {
    return {
      id: s.id,
      name: s.name,
      report: s.report,
      reportLabel: SCHEDULED_REPORT_LABEL[s.report as ScheduledReport] ?? s.report,
      format: s.format,
      period: s.period,
      periodLabel: SCHEDULE_PERIOD_LABEL[s.period as SchedulePeriod] ?? s.period,
      frequency: s.frequency,
      weekday: s.weekday,
      dayOfMonth: s.dayOfMonth,
      recipients: s.recipientIds.map((id) => ({ userId: id, name: readers.get(id)?.name ?? null, email: readers.get(id)?.email ?? null, canRead: readers.has(id) })),
      isActive: s.isActive,
      nextRunOn: s.isActive ? s.nextRunOn : null,
      lastRun: last ? this.run(last) : null,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    };
  }

  private run(r: ReportScheduleRunDoc) {
    return { id: r.id, runOn: r.runOn, manual: r.slot.startsWith('manual:'), status: r.status, params: r.params, recipients: r.recipients, fileName: r.fileName, sha256: r.sha256, bytes: r.bytes, error: r.error, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null };
  }

  private async lastRuns(ids: string[]) {
    const runs = ids.length ? await this.store.collection(reportScheduleRuns).find({ scheduleId: { $in: ids } }, { sort: { startedAt: -1 } }) : [];
    const last = new Map<string, ReportScheduleRunDoc>();
    for (const r of runs) if (!last.has(r.scheduleId)) last.set(r.scheduleId, r);
    return last;
  }

  async list(orgId: string) {
    const rows = await this.store.collection(reportSchedules).find({}, { sort: { name: 1 } });
    const readers = await this.readers();
    const last = await this.lastRuns(rows.map((r) => r.id));
    const mail = await this.mailer.status(orgId);
    return {
      items: rows.map((r) => this.serialize(r, readers, last.get(r.id) ?? null)),
      recipients: [...readers.entries()].map(([userId, p]) => ({ userId, name: p.name, email: p.email })),
      emailReady: mail.ready,
    };
  }

  async get(id: string) {
    const s = await this.store.collection(reportSchedules).findById(id);
    if (!s) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Schedule not found' });
    const runs = await this.store.collection(reportScheduleRuns).find({ scheduleId: id }, { sort: { startedAt: -1 }, limit: 50 });
    return { ...this.serialize(s, await this.readers(), runs[0] ?? null), runs: runs.map((r) => this.run(r)) };
  }

  private clean(b: ScheduleBody): ScheduleInput {
    return {
      name: b.name.trim(),
      report: b.report,
      format: b.format,
      period: b.period,
      frequency: b.frequency,
      weekday: b.frequency === 'WEEKLY' ? b.weekday : null,
      dayOfMonth: b.frequency === 'MONTHLY' ? b.dayOfMonth : null,
      recipientIds: b.recipientIds,
    };
  }

  async create(org: OrgContext, actor: AuthUser, body: ScheduleBody) {
    const s = this.clean(body);
    const issues = scheduleIssues(s, new Set((await this.readers()).keys()));
    if (issues.length) throw this.invalid(issues);
    const now = new Date();
    const doc = await this.store.collection(reportSchedules).insertOne({
      orgId: org.id,
      ...s,
      frequency: s.frequency,
      isActive: body.isActive ?? true,
      nextRunOn: nextScheduleRun(s, todayIso()),
      createdById: actor.id,
      createdAt: now,
      updatedAt: now,
    });
    await this.log(org.id, actor.id, 'report_schedule.created', doc.id, { name: s.name, report: s.report, frequency: s.frequency, recipients: s.recipientIds.length });
    return this.get(doc.id);
  }

  async update(org: OrgContext, actor: AuthUser, id: string, body: ScheduleBody) {
    const before = await this.store.collection(reportSchedules).findById(id);
    if (!before) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Schedule not found' });
    const s = this.clean(body);
    const issues = scheduleIssues(s, new Set((await this.readers()).keys()));
    if (issues.length) throw this.invalid(issues);
    const isActive = body.isActive ?? before.isActive;
    const timingChanged = s.frequency !== before.frequency || s.weekday !== before.weekday || s.dayOfMonth !== before.dayOfMonth;
    const nextRunOn = timingChanged || (isActive && !before.isActive) ? nextScheduleRun(s, todayIso()) : before.nextRunOn;
    await this.store.collection(reportSchedules).updateOne({ id }, { $set: { ...s, isActive, nextRunOn, updatedAt: new Date() } });
    await this.log(org.id, actor.id, 'report_schedule.updated', id, { name: s.name, report: s.report, isActive, recipients: s.recipientIds.length });
    return this.get(id);
  }

  async remove(org: OrgContext, actor: AuthUser, id: string) {
    const before = await this.store.collection(reportSchedules).findById(id);
    if (!before) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Schedule not found' });
    await this.store.collection(reportSchedules).deleteOne({ id });
    await this.log(org.id, actor.id, 'report_schedule.deleted', id, { name: before.name });
    return { deleted: true };
  }

  /** Send a schedule's report now, for the dates a run today would cover. Does not move the next run. */
  async sendNow(org: OrgContext, actor: AuthUser, id: string) {
    const s = await this.store.collection(reportSchedules).findById(id);
    if (!s) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Schedule not found' });
    const run = await this.deliver(s, todayIso(), `manual:${crypto.randomUUID()}`, actor.id);
    return this.run(run);
  }

  /**
   * Every organisation's schedules that are due today or earlier (the background runner). Only
   * schedules whose date has come somewhere in the world are read (today where it is latest, 14
   * hours ahead of UTC), by index, a page at a time, so the pass costs what is due and not every
   * schedule of every organisation (PERF-001); each organisation's own today decides.
   */
  async runDueAll(now = new Date()): Promise<{ sent: number; failed: number }> {
    const latestToday = new Date(now.getTime() + 14 * 3_600_000).toISOString().slice(0, 10);
    const due: ReportScheduleDoc[] = [];
    for (let after = ''; ; ) {
      const page = await tenantStorage.run({ bypass: true }, async () =>
        await this.store.collection(reportSchedules).find({ isActive: true, nextRunOn: { $lte: latestToday }, ...(after ? { id: { $gt: after } } : {}) }, { sort: { id: 1 }, limit: DUE_PAGE }),
      );
      due.push(...page);
      if (page.length < DUE_PAGE) break;
      after = page[page.length - 1].id;
    }
    let sent = 0;
    let failed = 0;
    for (const s of due) {
      try {
        const r = await runInOrg(s.orgId, () => this.runIfDue(s.id));
        if (r?.status === 'SENT') sent++;
        else if (r?.status === 'FAILED') failed++;
      } catch (e) {
        failed++;
        this.logger.warn(`Scheduled report ${s.id} could not run: ${(e as Error).message}`);
      }
    }
    return { sent, failed };
  }

  /** In the organisation: send the schedule if its run date has come, then move it to the next date. */
  async runIfDue(id: string, today = todayIso()) {
    const s = await this.store.collection(reportSchedules).findById(id);
    if (!s || !s.isActive || s.nextRunOn > today) return null;
    let run: ReportScheduleRunDoc | null = null;
    try {
      run = await this.deliver(s, s.nextRunOn, s.nextRunOn, null);
    } catch (e) {
      if (!isDuplicateKeyError(e)) throw e; // another process has this run
    }
    // Missed runs (the server was down) are not sent one by one: the next run is after today.
    await this.store.collection(reportSchedules).updateOne({ id, nextRunOn: s.nextRunOn }, { $set: { nextRunOn: nextScheduleRun(s, today), updatedAt: new Date() } });
    return run;
  }

  private async deliver(s: ReportScheduleDoc, runOn: string, slot: string, requestedById: string | null): Promise<ReportScheduleRunDoc> {
    const org = await this.store.collection(organizations).findById(s.orgId);
    if (!org) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Organisation not found' });
    const params = scheduleParams(s.report as ScheduledReport, s.period as SchedulePeriod, runOn, org.fiscalYearStartMonth);
    const readers = await this.readers();
    const recipients = s.recipientIds.map((id) => readers.get(id)?.email).filter((e): e is string => !!e);
    const runs = this.store.collection(reportScheduleRuns);
    const run = await runs.insertOne({ orgId: s.orgId, scheduleId: s.id, slot, runOn, status: 'SENDING', params, recipients, fileName: null, sha256: null, bytes: null, error: null, startedAt: new Date(), finishedAt: null, requestedById });
    const finish = async (patch: Partial<ReportScheduleRunDoc>) => {
      await runs.updateOne({ id: run.id }, { $set: { ...patch, finishedAt: new Date() } });
      const done = (await runs.findById(run.id))!;
      await this.log(s.orgId, requestedById ?? s.createdById, done.status === 'SENT' ? 'report_schedule.sent' : 'report_schedule.failed', s.id, { runId: run.id, runOn, report: s.report, params, recipients, fileName: done.fileName, sha256: done.sha256, error: done.error });
      return done;
    };
    const owner = readers.get(s.createdById);
    if (!owner) return finish({ status: 'FAILED', error: 'The member who set this schedule up can no longer read reports. Edit the schedule to take it over.' });
    if (!recipients.length) return finish({ status: 'FAILED', error: 'None of the recipients can read reports any more.' });
    let file;
    try {
      const ctx: OrgContext = { id: s.orgId, role: owner.role, functionalCurrency: org.functionalCurrency, fiscalYearStartMonth: org.fiscalYearStartMonth };
      file = await this.exports.export(ctx, { id: s.createdById, email: owner.email, name: owner.name, platformRole: null }, s.report, s.format, params);
    } catch (e) {
      return finish({ status: 'FAILED', error: `The report could not be produced: ${(e as Error).message}`.slice(0, 1000) });
    }
    const label = SCHEDULED_REPORT_LABEL[s.report as ScheduledReport] ?? s.report;
    const dates = params.asOf && !params.from ? `as at ${params.asOf}` : `${params.from} to ${params.to ?? params.asOf}`;
    const sent = await this.mailer.send(s.orgId, {
      to: recipients,
      subject: `${label}, ${dates}: ${org.name}`,
      text: `${s.name}\n\n${label} for ${org.name}, ${dates}, is attached (${file.fileName}).\n\nIt is the same report as on the Reports screen in Talk2Tax for these dates. You get it because you are on the "${s.name}" schedule; a member who can design reports can change or stop it under Reports › Scheduled reports.`,
      messageId: `<report-run-${run.id}@talk2tax>`,
      files: [{ fileName: file.fileName, contentType: file.contentType, content: file.body }],
    });
    return finish(sent.ok ? { status: 'SENT', fileName: file.fileName, sha256: file.sha256, bytes: file.body.length } : { status: 'FAILED', fileName: file.fileName, sha256: file.sha256, bytes: file.body.length, error: sent.error });
  }

  private log(orgId: string, actorId: string, action: string, entityId: string, data: Record<string, unknown>) {
    return this.prisma.$transaction((tx) => this.audit.append(tx, { orgId, actorId, action, entityType: 'report_schedule', entityId, data }));
  }
}
