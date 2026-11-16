import { ForbiddenException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  addDays,
  checkTemplateLines,
  describeSchedule,
  dueRuns,
  fillPlaceholders,
  isSupportedCurrency,
  minorUnits,
  runCount,
  scheduleFinished,
  TemplateError,
  upcomingRuns,
  type RecurringFrequency,
  type RecurringSchedule,
} from '@talk2tax/accounting-engine';
import { JournalTemplate, JournalTemplateLine, Prisma } from '@talk2tax/database';
import { hasPermission, RoleName } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService, Tx } from '../common/prisma.service';
import { tenantStorage } from '../common/tenant-context';
import { checkLineDimensions } from '../dimensions/check';
import { JournalsService } from '../journals/journals.service';
import { todayIst } from '../tasks/tasks.service';

type Actor = { id: string };
export interface TemplateOrg {
  id: string;
  role: RoleName;
  functionalCurrency: string;
  fiscalYearStartMonth: number;
}

export interface TemplateLineInput {
  accountId: string;
  debit?: string | null;
  credit?: string | null;
  currency?: string | null;
  description?: string | null;
  departmentId?: string | null;
  projectId?: string | null;
}

export interface TemplateInput {
  name: string;
  description?: string | null;
  journalType: 'STANDARD' | 'ADJUSTING';
  memo?: string | null;
  reference?: string | null;
  lines: TemplateLineInput[];
  /** Null: no schedule (a template used by hand). */
  schedule?: { frequency: RecurringFrequency; startDate: string; endDate?: string | null; monthEnd: boolean; postMode: 'DRAFT' | 'POST' } | null;
}

type Full = JournalTemplate & { lines: (JournalTemplateLine & { account: { code: string; name: string } })[] };
type View = 'active' | 'scheduled' | 'archived' | 'all';

export const templateRef = (n: number) => `JT-${String(n).padStart(4, '0')}`;
const clean = (s: string | null | undefined) => (s?.trim() ? s.trim() : null);
const LINES = { orderBy: { lineNo: 'asc' }, include: { account: { select: { code: true, name: true } } } } satisfies Prisma.JournalTemplate$linesArgs;

/**
 * Journal templates (GL-012) and recurring journals (GL-007). A template keeps the lines of a
 * journal entered again and again; a member starts a journal from it or posts it on a chosen date.
 * A template with a schedule makes its journals itself: every run that has fallen due becomes a
 * draft (for review) or a posted journal, made by the same code as any manual journal, so the
 * period, account, rate and balance checks all apply. Runs are numbered and recorded once, in the
 * same transaction as their journal, so a run is never made twice.
 */
@Injectable()
export class JournalTemplatesService {
  private readonly logger = new Logger('RecurringJournals');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly journals: JournalsService,
  ) {}

  // ---------- reads ----------

  async list(org: TemplateOrg, view: View = 'active') {
    const where: Prisma.JournalTemplateWhereInput = { orgId: org.id };
    if (view === 'active') where.status = 'ACTIVE';
    if (view === 'archived') where.status = 'ARCHIVED';
    if (view === 'scheduled') where.scheduleStatus = { in: ['ACTIVE', 'PAUSED'] };
    const rows = await this.prisma.journalTemplate.findMany({ where, include: { lines: LINES, _count: { select: { runs: true } } }, orderBy: { number: 'asc' }, take: 500 });
    const all = await this.prisma.journalTemplate.groupBy({ by: ['status', 'scheduleStatus'], where: { orgId: org.id }, _count: true });
    const count = (f: (r: (typeof all)[number]) => boolean) => all.filter(f).reduce((n, r) => n + r._count, 0);
    return {
      items: rows.map((t) => ({ ...this.summary(org, t), runs: t._count.runs })),
      counts: {
        active: count((r) => r.status === 'ACTIVE'),
        scheduled: count((r) => r.scheduleStatus === 'ACTIVE' || r.scheduleStatus === 'PAUSED'),
        archived: count((r) => r.status === 'ARCHIVED'),
        all: count(() => true),
      },
      can: this.can(org),
    };
  }

  async get(org: TemplateOrg, id: string) {
    const t = await this.prisma.journalTemplate.findFirst({ where: { id, orgId: org.id }, include: { lines: LINES } });
    if (!t) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Template not found' });
    const runs = await this.prisma.journalTemplateRun.findMany({ where: { templateId: id, orgId: org.id }, orderBy: [{ createdAt: 'desc' }], take: 200 });
    const entryIds = runs.map((r) => r.journalEntryId).filter((x): x is string => !!x);
    const entries = entryIds.length
      ? await this.prisma.journalEntry.findMany({ where: { orgId: org.id, id: { in: entryIds } }, select: { id: true, status: true, entryNumber: true, totalDebit: true, memo: true, reversedBy: { select: { id: true } } } })
      : [];
    const byId = new Map(entries.map((e) => [e.id, e]));
    const actorIds = [...new Set(runs.map((r) => r.actorId).filter((x): x is string => !!x))];
    const actors = actorIds.length ? await this.prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, email: true } }) : [];
    const actorName = new Map(actors.map((a) => [a.id, a.name || a.email]));
    const s = this.schedule(t);
    return {
      ...this.summary(org, t),
      upcoming: s && t.scheduleStatus !== 'ENDED' ? upcomingRuns(s, 6).map((r) => ({ ...r, memo: this.fill(org, t.memo, r.date) })) : [],
      runs: runs.map((r) => {
        const e = r.journalEntryId ? byId.get(r.journalEntryId) : undefined;
        return {
          id: r.id,
          runNo: r.runNo,
          date: fromDbDate(r.runDate),
          scheduled: r.runNo !== null,
          posted: r.posted,
          by: r.actorId ? (actorName.get(r.actorId) ?? 'A member') : 'Schedule',
          createdAt: r.createdAt.toISOString(),
          entry: e
            ? { id: e.id, status: e.status, entryNumber: e.entryNumber, total: this.money(org, e.totalDebit), memo: e.memo, reversed: !!e.reversedBy }
            : null,
          entryNumber: r.entryNumber,
        };
      }),
    };
  }

  // ---------- writes ----------

  async create(org: TemplateOrg, actor: Actor, input: TemplateInput) {
    this.assertMode(org, input.schedule?.postMode);
    const id = await this.prisma.$transaction(async (tx) => {
      const data = await this.prepare(tx, org, input);
      const [{ value: number }] = await tx.$queryRaw<{ value: number }[]>`
        INSERT INTO org_counters (org_id, key, value) VALUES (${org.id}::uuid, 'journal_template', 1)
        ON CONFLICT (org_id, key) DO UPDATE SET value = org_counters.value + 1
        RETURNING value`;
      const t = await tx.journalTemplate.create({ data: { ...data.header, orgId: org.id, number, createdById: actor.id, lines: { create: data.lines } } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'journal_template.created', entityType: 'journal_template', entityId: t.id, data: { reference: templateRef(number), name: t.name, schedule: data.header.frequency ?? null } });
      return t.id;
    });
    return this.get(org, id);
  }

  /** A template from an existing journal's lines (the *Save as template* button). */
  async fromJournal(org: TemplateOrg, actor: Actor, entryId: string, name: string) {
    const e = await this.prisma.journalEntry.findFirst({ where: { id: entryId, orgId: org.id }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
    if (!e) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Journal entry not found' });
    if (e.source !== 'MANUAL') throw new DomainError('TEMPLATE_SOURCE', 'Only journals entered by hand can be saved as templates; this one was made by another part of the books');
    return this.create(org, actor, {
      name,
      journalType: e.type === 'ADJUSTING' ? 'ADJUSTING' : 'STANDARD',
      memo: e.memo,
      reference: e.reference,
      lines: e.lines.map((l) => ({
        accountId: l.accountId,
        debit: l.debit.isZero() ? null : l.debit.toFixed(),
        credit: l.credit.isZero() ? null : l.credit.toFixed(),
        currency: l.currency === org.functionalCurrency ? null : l.currency,
        description: l.description,
        departmentId: l.departmentId,
        projectId: l.projectId,
      })),
      schedule: null,
    });
  }

  async update(org: TemplateOrg, actor: Actor, id: string, input: TemplateInput) {
    this.assertMode(org, input.schedule?.postMode);
    await this.prisma.$transaction(async (tx) => {
      const t = await this.lock(tx, org.id, id);
      if (t.status === 'ARCHIVED') throw new DomainError('TEMPLATE_ARCHIVED', 'Restore the template before changing it', HttpStatus.CONFLICT);
      const data = await this.prepare(tx, org, input, t);
      await tx.journalTemplateLine.deleteMany({ where: { templateId: id, orgId: org.id } });
      await tx.journalTemplate.update({ where: { id }, data: { ...data.header, lines: { create: data.lines } } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'journal_template.updated', entityType: 'journal_template', entityId: id, data: { reference: templateRef(t.number), lines: data.lines.length, schedule: data.header.frequency ?? null } });
    });
    return this.get(org, id);
  }

  async remove(org: TemplateOrg, actor: Actor, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.lock(tx, org.id, id);
      if (await tx.journalTemplateRun.count({ where: { templateId: id } })) {
        throw new DomainError('TEMPLATE_USED', 'This template has made journals. Archive it instead, so its history stays.', HttpStatus.CONFLICT);
      }
      await tx.journalTemplate.delete({ where: { id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'journal_template.deleted', entityType: 'journal_template', entityId: id, data: { reference: templateRef(t.number), name: t.name } });
    });
  }

  async setArchived(org: TemplateOrg, actor: Actor, id: string, archived: boolean) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.lock(tx, org.id, id);
      const pause = archived && t.scheduleStatus === 'ACTIVE';
      await tx.journalTemplate.update({ where: { id }, data: { status: archived ? 'ARCHIVED' : 'ACTIVE', ...(pause ? { scheduleStatus: 'PAUSED' } : {}) } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: archived ? 'journal_template.archived' : 'journal_template.restored', entityType: 'journal_template', entityId: id, data: { reference: templateRef(t.number), schedulePaused: pause } });
    });
    return this.get(org, id);
  }

  /**
   * Pause, resume or end a schedule. Resuming makes the runs that fell due while paused at the
   * next pass, unless `skipMissed`: then runs dated before today are passed over (and not made).
   */
  async setSchedule(org: TemplateOrg, actor: Actor, id: string, action: 'pause' | 'resume' | 'end', opts: { skipMissed?: boolean } = {}) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.lock(tx, org.id, id);
      const s = this.schedule(t);
      if (!s || !t.scheduleStatus) throw new DomainError('TEMPLATE_NO_SCHEDULE', 'This template has no schedule', HttpStatus.CONFLICT);
      if (t.scheduleStatus === 'ENDED') throw new DomainError('TEMPLATE_SCHEDULE_ENDED', 'This schedule has ended. Set a new schedule to run it again.', HttpStatus.CONFLICT);
      if (action === 'resume' && t.status === 'ARCHIVED') throw new DomainError('TEMPLATE_ARCHIVED', 'Restore the template before resuming its schedule', HttpStatus.CONFLICT);
      if (action === 'resume') this.assertMode(org, t.postMode);
      let nextRunNo = t.nextRunNo;
      let skipped = 0;
      if (action === 'resume' && opts.skipMissed) {
        const missed = dueRuns(s, addDays(todayIst(), -1), 1200);
        skipped = missed.length;
        nextRunNo += skipped;
      }
      const status = action === 'pause' ? 'PAUSED' : action === 'resume' ? 'ACTIVE' : 'ENDED';
      await tx.journalTemplate.update({ where: { id }, data: { scheduleStatus: status, nextRunNo, lastError: null, lastErrorAt: null } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: `journal_template.schedule_${action === 'end' ? 'ended' : action === 'pause' ? 'paused' : 'resumed'}`, entityType: 'journal_template', entityId: id, data: { reference: templateRef(t.number), skipped } });
    });
    return this.get(org, id);
  }

  /** Make one journal from the template now, dated `date` (draft, or posted with `post`). */
  async use(org: TemplateOrg, actor: Actor, id: string, input: { date: string; post: boolean }) {
    if (input.post && !hasPermission(org.role, 'journals.post')) throw new ForbiddenException({ error: 'FORBIDDEN', message: `Your role (${org.role}) does not have journals.post` });
    return this.prisma.$transaction(async (tx) => {
      const t = await this.lock(tx, org.id, id);
      if (t.status === 'ARCHIVED') throw new DomainError('TEMPLATE_ARCHIVED', 'Restore the template before using it', HttpStatus.CONFLICT);
      const made = await this.makeJournal(tx, org, actor, t, input.date, input.post, null);
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'journal_template.used', entityType: 'journal_template', entityId: id, data: { reference: templateRef(t.number), date: input.date, journalEntryId: made.id, posted: input.post } });
      return { journalEntryId: made.id, entryNumber: made.entryNumber, posted: input.post };
    });
  }

  /**
   * Make every run of a template's schedule that has fallen due, as of `today`, in one
   * transaction: each run's journal and its run record together, then the next run number. A
   * failure (a closed period, an inactive account, a missing rate) leaves nothing made and is
   * kept on the template, so the next pass tries again.
   */
  async runDue(org: TemplateOrg, actor: Actor | null, id: string, today = todayIst()): Promise<{ made: number; error: string | null }> {
    try {
      const made = await this.prisma.$transaction(async (tx) => {
        const t = await this.lock(tx, org.id, id);
        const s = this.schedule(t);
        if (!s || t.scheduleStatus !== 'ACTIVE' || t.status !== 'ACTIVE') return 0;
        if (scheduleFinished(s)) {
          await tx.journalTemplate.update({ where: { id }, data: { scheduleStatus: 'ENDED', lastError: null, lastErrorAt: null } });
          await this.audit.append(tx, { orgId: org.id, actorId: actor?.id ?? null, action: 'journal_template.schedule_ended', entityType: 'journal_template', entityId: id, data: { reference: templateRef(t.number), endDate: s.end } });
          return 0;
        }
        const due = dueRuns(s, today);
        if (!due.length) {
          if (t.lastError) await tx.journalTemplate.update({ where: { id }, data: { lastError: null, lastErrorAt: null } });
          return 0;
        }
        if (!actor && t.postMode === 'POST') await this.assertCreatorMayPost(tx, org.id, t);
        const by = actor ?? { id: t.createdById };
        const ids: string[] = [];
        for (const r of due) {
          const m = await this.makeJournal(tx, org, by, t, r.date, t.postMode === 'POST', r.no, actor === null);
          ids.push(m.id);
        }
        const after = { ...s, nextNo: t.nextRunNo + due.length };
        await tx.journalTemplate.update({ where: { id }, data: { nextRunNo: after.nextNo, lastError: null, lastErrorAt: null, ...(scheduleFinished(after) ? { scheduleStatus: 'ENDED' } : {}) } });
        await this.audit.append(tx, { orgId: org.id, actorId: actor?.id ?? null, action: 'journal_template.ran', entityType: 'journal_template', entityId: id, data: { reference: templateRef(t.number), runs: due.map((r) => r.no), journalEntryIds: ids, posted: t.postMode === 'POST' } });
        return due.length;
      });
      return { made, error: null };
    } catch (e) {
      const issues = e instanceof DomainError ? (e.details as { issues?: string[] } | undefined)?.issues : (e as { issues?: string[] }).issues;
      const message = (issues?.length ? `${e instanceof Error ? e.message : 'Invalid'}: ${issues.join('; ')}` : e instanceof Error ? e.message : String(e)).slice(0, 1000);
      await this.prisma.journalTemplate.updateMany({ where: { id, orgId: org.id }, data: { lastError: message, lastErrorAt: new Date() } });
      this.logger.warn(`Recurring journal ${id} could not run: ${message}`);
      return { made: 0, error: message };
    }
  }

  /** Run one template's schedule now, as a member (the *Run due now* button). */
  async runNow(org: TemplateOrg, actor: Actor, id: string) {
    const t = await this.prisma.journalTemplate.findFirst({ where: { id, orgId: org.id }, select: { postMode: true } });
    if (!t) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Template not found' });
    this.assertMode(org, t.postMode);
    const r = await this.runDue(org, actor, id);
    return { ...r, template: await this.get(org, id) };
  }

  /** Run every active schedule of the organisation now. */
  async runOrg(org: TemplateOrg, actor: Actor) {
    const rows = await this.prisma.journalTemplate.findMany({ where: { orgId: org.id, scheduleStatus: 'ACTIVE', status: 'ACTIVE' }, select: { id: true, postMode: true }, orderBy: { number: 'asc' } });
    const mayPost = hasPermission(org.role, 'journals.post');
    let made = 0;
    const errors: { id: string; error: string }[] = [];
    for (const r of rows) {
      if (r.postMode === 'POST' && !mayPost) continue;
      const res = await this.runDue(org, actor, r.id);
      made += res.made;
      if (res.error) errors.push({ id: r.id, error: res.error });
    }
    return { templates: rows.length, made, errors };
  }

  /** The runner's pass over every organisation's active schedules (or `orgIds`), as of `today`. */
  async runAll(today = todayIst(), orgIds?: string[]) {
    const rows = await tenantStorage.run({ bypass: true }, async () =>
      await this.prisma.journalTemplate.findMany({
        where: { scheduleStatus: 'ACTIVE', status: 'ACTIVE', ...(orgIds ? { orgId: { in: orgIds } } : {}) },
        select: { id: true, org: { select: { id: true, functionalCurrency: true, fiscalYearStartMonth: true } } },
        orderBy: [{ orgId: 'asc' }, { number: 'asc' }],
        take: 5000,
      }),
    );
    let made = 0;
    let failed = 0;
    for (const r of rows) {
      const res = await tenantStorage.run({ bypass: true }, async () => await this.runDue({ id: r.org.id, role: 'OWNER', functionalCurrency: r.org.functionalCurrency, fiscalYearStartMonth: r.org.fiscalYearStartMonth }, null, r.id, today));
      made += res.made;
      if (res.error) failed++;
    }
    return { templates: rows.length, made, failed };
  }

  // ---------- helpers ----------

  private async makeJournal(tx: Tx, org: TemplateOrg, actor: Actor, t: Full, date: string, post: boolean, runNo: number | null, byRunner = false) {
    const lines = t.lines.map((l) => ({
      accountId: l.accountId,
      debit: l.debit.isZero() ? undefined : l.debit.toFixed(),
      credit: l.credit.isZero() ? undefined : l.credit.toFixed(),
      currency: l.currency ?? undefined,
      description: l.description ? this.fill(org, l.description, date) ?? undefined : undefined,
      departmentId: l.departmentId,
      projectId: l.projectId,
    }));
    const made = await this.journals.createInTx(
      tx,
      org,
      actor,
      { date, type: runNo !== null ? 'RECURRING' : (t.journalType as 'STANDARD' | 'ADJUSTING'), memo: this.fill(org, t.memo, date) ?? undefined, reference: this.fill(org, t.reference, date) ?? templateRef(t.number), lines },
      { post, auditData: { templateId: t.id, template: templateRef(t.number), runNo, byRunner } },
    );
    await tx.journalTemplateRun.create({ data: { orgId: org.id, templateId: t.id, runNo, runDate: toDbDate(date), journalEntryId: made.id, entryNumber: made.entryNumber, posted: post, actorId: byRunner ? null : actor.id } });
    return made;
  }

  /** The runner posts in the creator's name, so the creator must still be a member who may post. */
  private async assertCreatorMayPost(tx: Tx, orgId: string, t: JournalTemplate) {
    const m = await tx.membership.findFirst({ where: { orgId, userId: t.createdById }, select: { role: true } });
    if (!m || !hasPermission(m.role as RoleName, 'journals.post')) {
      throw new DomainError('TEMPLATE_POSTER', 'The member who set this schedule can no longer post journals. Someone who can should open the template and save the schedule again, or set it to make drafts.');
    }
  }

  private async prepare(tx: Tx, org: TemplateOrg, input: TemplateInput, existing?: Full) {
    const lines = input.lines.map((l) => ({ ...l, currency: l.currency && l.currency !== org.functionalCurrency ? l.currency : null }));
    const { issues } = checkTemplateLines(lines, org.functionalCurrency);
    for (const [i, l] of lines.entries()) {
      const cur = l.currency ?? org.functionalCurrency;
      if (!isSupportedCurrency(cur)) {
        issues.push(`Line ${i + 1}: ${cur} is not a supported currency`);
        continue;
      }
      for (const amount of [l.debit, l.credit]) {
        if (amount && (amount.split('.')[1]?.replace(/0+$/, '').length ?? 0) > minorUnits(cur)) issues.push(`Line ${i + 1}: ${amount} has more decimals than ${cur} allows`);
      }
    }
    const ids = [...new Set(lines.map((l) => l.accountId))];
    const [accounts, o] = await Promise.all([
      tx.account.findMany({ where: { orgId: org.id, id: { in: ids } }, select: { id: true, code: true, isPostable: true, isActive: true } }),
      tx.organization.findUniqueOrThrow({ where: { id: org.id }, select: { arAccountId: true, apAccountId: true, claimsAccountId: true } }),
    ]);
    const byId = new Map(accounts.map((a) => [a.id, a]));
    lines.forEach((l, i) => {
      const a = byId.get(l.accountId);
      if (!a) issues.push(`Line ${i + 1}: account not found`);
      else if (!a.isPostable) issues.push(`Line ${i + 1}: account ${a.code} is a heading and takes no postings`);
      else if (!a.isActive) issues.push(`Line ${i + 1}: account ${a.code} is inactive`);
      else if ([o.arAccountId, o.apAccountId, o.claimsAccountId].includes(l.accountId)) issues.push(`Line ${i + 1}: account ${a.code} is a receivables or payables control account and only takes postings from invoices, bills and payments`);
    });
    if (issues.length) throw new DomainError('TEMPLATE_INVALID', issues[0]!, HttpStatus.UNPROCESSABLE_ENTITY, { issues });
    await checkLineDimensions(tx, org.id, lines, { code: 'TEMPLATE_INVALID' });

    const sc = input.schedule ?? null;
    let schedule: Pick<Prisma.JournalTemplateUncheckedCreateInput, 'frequency' | 'startDate' | 'endDate' | 'monthEnd' | 'postMode' | 'scheduleStatus' | 'nextRunNo'>;
    if (sc) {
      try {
        runCount({ start: sc.startDate, end: sc.endDate ?? null, frequency: sc.frequency, monthEnd: sc.monthEnd });
      } catch (e) {
        if (e instanceof TemplateError) throw new DomainError(e.code, e.message);
        throw e;
      }
      const ran = !!existing && existing.nextRunNo > 1;
      if (ran && existing.startDate && (fromDbDate(existing.startDate) !== sc.startDate || existing.frequency !== sc.frequency || existing.monthEnd !== sc.monthEnd)) {
        throw new DomainError('TEMPLATE_SCHEDULE_RAN', 'This schedule has made journals, so its start date, frequency and run day stay as they are. You can change the end date and whether runs are posted, or end it and make a new template.', HttpStatus.CONFLICT);
      }
      const wasEnded = existing?.scheduleStatus === 'ENDED';
      // A schedule set again after it ended runs on from where it stopped.
      schedule = { frequency: sc.frequency, startDate: toDbDate(sc.startDate), endDate: sc.endDate ? toDbDate(sc.endDate) : null, monthEnd: sc.monthEnd, postMode: sc.postMode, scheduleStatus: existing?.scheduleStatus && !wasEnded ? existing.scheduleStatus : 'ACTIVE' };
      if (wasEnded && sc.endDate && scheduleFinished({ start: sc.startDate, end: sc.endDate, frequency: sc.frequency, monthEnd: sc.monthEnd, nextNo: existing!.nextRunNo })) {
        throw new DomainError('TEMPLATE_END', 'Every run up to this end date has been made. Choose a later end date to run the schedule again.');
      }
    } else {
      if (existing && existing.nextRunNo > 1) throw new DomainError('TEMPLATE_SCHEDULE_RAN', 'This schedule has made journals. End it instead of removing it, so its history stays.', HttpStatus.CONFLICT);
      schedule = { frequency: null, startDate: null, endDate: null, monthEnd: false, postMode: 'DRAFT', scheduleStatus: null };
    }
    return {
      header: {
        name: input.name.trim(),
        description: clean(input.description),
        journalType: input.journalType,
        memo: clean(input.memo),
        reference: clean(input.reference),
        ...schedule,
        lastError: null,
        lastErrorAt: null,
      },
      lines: lines.map((l, i) => ({
        orgId: org.id,
        lineNo: i + 1,
        accountId: l.accountId,
        debit: l.debit || '0',
        credit: l.credit || '0',
        currency: l.currency,
        description: clean(l.description),
        departmentId: l.departmentId ?? null,
        projectId: l.projectId ?? null,
      })),
    };
  }

  private assertMode(org: TemplateOrg, mode: 'DRAFT' | 'POST' | undefined) {
    if (mode === 'POST' && !hasPermission(org.role, 'journals.post')) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: `A schedule that posts its journals needs journals.post, which your role (${org.role}) does not have. Set it to make drafts instead.` });
    }
  }

  private async lock(tx: Tx, orgId: string, id: string): Promise<Full> {
    await tx.$queryRaw`SELECT id FROM journal_templates WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid FOR UPDATE`;
    const t = await tx.journalTemplate.findFirst({ where: { id, orgId }, include: { lines: LINES } });
    if (!t) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Template not found' });
    return t;
  }

  private schedule(t: JournalTemplate): RecurringSchedule | null {
    if (!t.frequency || !t.startDate) return null;
    return { start: fromDbDate(t.startDate), end: t.endDate ? fromDbDate(t.endDate) : null, frequency: t.frequency, monthEnd: t.monthEnd, nextNo: t.nextRunNo };
  }

  private fill(org: TemplateOrg, text: string | null, date: string) {
    return text ? fillPlaceholders(text, date, org.fiscalYearStartMonth) : null;
  }

  private money(org: TemplateOrg, v: Prisma.Decimal | string, currency = org.functionalCurrency) {
    return new Prisma.Decimal(v).toFixed(minorUnits(currency));
  }

  private can(org: TemplateOrg) {
    return { manage: hasPermission(org.role, 'journals.create'), post: hasPermission(org.role, 'journals.post') };
  }

  private summary(org: TemplateOrg, t: Full) {
    const s = this.schedule(t);
    const { totals } = checkTemplateLines(
      t.lines.map((l) => ({ accountId: l.accountId, debit: l.debit.toFixed(), credit: l.credit.toFixed(), currency: l.currency })),
      org.functionalCurrency,
    );
    const next = s && t.scheduleStatus !== 'ENDED' ? upcomingRuns(s, 1)[0] ?? null : null;
    return {
      id: t.id,
      number: t.number,
      reference: templateRef(t.number),
      name: t.name,
      description: t.description,
      journalType: t.journalType,
      memo: t.memo,
      journalReference: t.reference,
      status: t.status,
      totals: totals.map((x) => ({ currency: x.currency, amount: this.money(org, x.debit, x.currency) })),
      lines: t.lines.map((l) => ({
        lineNo: l.lineNo,
        accountId: l.accountId,
        account: { code: l.account.code, name: l.account.name },
        debit: l.debit.isZero() ? null : this.money(org, l.debit, l.currency ?? org.functionalCurrency),
        credit: l.credit.isZero() ? null : this.money(org, l.credit, l.currency ?? org.functionalCurrency),
        currency: l.currency ?? org.functionalCurrency,
        description: l.description,
        departmentId: l.departmentId,
        projectId: l.projectId,
      })),
      schedule: s
        ? {
            frequency: s.frequency,
            startDate: s.start,
            endDate: s.end,
            monthEnd: s.monthEnd,
            postMode: t.postMode,
            status: t.scheduleStatus,
            nextRunNo: t.nextRunNo,
            runsTotal: runCount(s),
            description: describeSchedule(s),
            nextRun: next,
            dueNow: t.scheduleStatus === 'ACTIVE' ? dueRuns(s, todayIst()).length : 0,
            lastError: t.lastError,
            lastErrorAt: t.lastErrorAt?.toISOString() ?? null,
          }
        : null,
      updatedAt: t.updatedAt.toISOString(),
    };
  }
}

