import { ForbiddenException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  addDays,
  describeSchedule,
  dueRuns,
  fillPlaceholders,
  minorUnits,
  recurringBillRef,
  recurringReferenceIssue,
  runCount,
  scheduleFinished,
  TemplateError,
  upcomingRuns,
  type RecurringFrequency,
  type RecurringSchedule,
} from '@talk2tax/accounting-engine';
import { Prisma, RecurringBill, RecurringBillLine } from '@talk2tax/database';
import { hasPermission, RoleName } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { DOCUMENTS } from '../db/collections/sales';
import { MovedTables } from '../db/moved-table';
import { PrismaService, Tx } from '../common/prisma.service';
import { tenantStorage } from '../common/tenant-context';
import { DocumentInput, DocumentsService } from '../ledgers/documents.service';
import { todayIst } from '../tasks/tasks.service';
import { nextCounter } from '../db/counters';

type Actor = { id: string };
export interface BillOrg {
  id: string;
  role: RoleName;
  functionalCurrency: string;
  fiscalYearStartMonth: number;
}

export interface RecurringBillLineInput {
  accountId: string;
  description?: string | null;
  quantity: string;
  unitPrice: string;
  taxRateId?: string | null;
  hsnCode?: string | null;
  departmentId?: string | null;
  projectId?: string | null;
}

export interface RecurringBillInput {
  name: string;
  contactId: string;
  reference?: string | null;
  memo?: string | null;
  placeOfSupply?: string | null;
  reverseCharge?: boolean;
  withholdingSectionId?: string | null;
  dueDays?: number | null;
  frequency: RecurringFrequency;
  startDate: string;
  endDate?: string | null;
  monthEnd: boolean;
  postMode: 'DRAFT' | 'POST';
  lines: RecurringBillLineInput[];
}

type Full = RecurringBill & {
  contact: { id: string; name: string };
  lines: (RecurringBillLine & { account: { code: string; name: string } | null })[];
};
type Base = RecurringBill & { lines: RecurringBillLine[] };
type View = 'active' | 'paused' | 'ended' | 'all';

const clean = (s: string | null | undefined) => (s?.trim() ? s.trim() : null);
const INCLUDE = { contact: { select: { id: true, name: true } }, lines: { orderBy: { lineNo: 'asc' } } } satisfies Prisma.RecurringBillInclude;

/**
 * Recurring bills (AP-005). A recurring bill keeps a vendor, its lines and a schedule; every run
 * that has fallen due becomes a bill dated the run date, as a draft to review or posted, made by
 * the same code as a bill entered by hand, so GST, TDS, approval rules, periods and the duplicate
 * vendor-reference check all apply. Each run is recorded once, in the same transaction as its
 * bill, so a run is never made twice; a failure leaves nothing made and is kept on the schedule.
 */
@Injectable()
export class RecurringBillsService {
  private readonly logger = new Logger('RecurringBills');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly documents: DocumentsService,
    private readonly moved: MovedTables,
  ) {}

  // ---------- reads ----------

  async list(org: BillOrg, view: View = 'active') {
    const where: Prisma.RecurringBillWhereInput = { orgId: org.id };
    if (view === 'active') where.status = 'ACTIVE';
    if (view === 'paused') where.status = 'PAUSED';
    if (view === 'ended') where.status = 'ENDED';
    const rows = await this.prisma.recurringBill.findMany({ where, include: { ...INCLUDE, _count: { select: { runs: true } } }, orderBy: { number: 'asc' }, take: 500 });
    const groups = await this.prisma.recurringBill.groupBy({ by: ['status'], where: { orgId: org.id }, _count: true });
    const count = (s?: string) => groups.filter((g) => !s || g.status === s).reduce((n, g) => n + g._count, 0);
    const full = await this.withAccounts(org.id, rows);
    return {
      items: full.map((b, i) => ({ ...this.summary(org, b), runs: rows[i]!._count.runs })),
      counts: { active: count('ACTIVE'), paused: count('PAUSED'), ended: count('ENDED'), all: count() },
      can: this.can(org),
    };
  }

  async get(org: BillOrg, id: string) {
    const row = await this.prisma.recurringBill.findFirst({ where: { id, orgId: org.id }, include: INCLUDE });
    if (!row) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Recurring bill not found' });
    const [b] = await this.withAccounts(org.id, [row]);
    const runs = await this.prisma.recurringBillRun.findMany({ where: { recurringBillId: id, orgId: org.id }, orderBy: { runNo: 'desc' }, take: 200 });
    const docIds = runs.map((r) => r.documentId).filter((x): x is string => !!x);
    const docs = docIds.length
      ? await this.prisma.document.findMany({ where: { orgId: org.id, id: { in: docIds } }, select: { id: true, number: true, status: true, total: true, reference: true, dueDate: true, currency: true } })
      : [];
    const byId = new Map(docs.map((d) => [d.id, d]));
    const actorIds = [...new Set(runs.map((r) => r.actorId).filter((x): x is string => !!x))];
    const actors = actorIds.length ? await this.prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, email: true } }) : [];
    const actorName = new Map(actors.map((a) => [a.id, a.name || a.email]));
    const s = this.schedule(b!);
    return {
      ...this.summary(org, b!),
      upcoming: b!.status !== 'ENDED' ? upcomingRuns(s, 6).map((r) => ({ ...r, reference: this.fill(org, b!.reference, r.date) })) : [],
      runs: runs.map((r) => {
        const d = r.documentId ? byId.get(r.documentId) : undefined;
        return {
          id: r.id,
          runNo: r.runNo,
          date: fromDbDate(r.runDate),
          posted: r.posted,
          by: r.actorId ? (actorName.get(r.actorId) ?? 'A member') : 'Schedule',
          createdAt: r.createdAt.toISOString(),
          bill: d
            ? { id: d.id, number: d.number, status: d.status, total: this.money(d.total, d.currency), reference: d.reference, dueDate: fromDbDate(d.dueDate) }
            : null,
        };
      }),
    };
  }

  // ---------- writes ----------

  async create(org: BillOrg, actor: Actor, input: RecurringBillInput) {
    this.assertMode(org, input.postMode);
    const id = await this.prisma.$transaction(async (tx) => {
      const data = this.prepare(org, input);
      await this.assertVendor(tx, org.id, input.contactId);
      const [{ value: number }] = [{ value: await nextCounter(tx, org.id, 'recurring_bill') }];
      const b = await tx.recurringBill.create({ data: { ...data.header, orgId: org.id, number, createdById: actor.id, lines: { create: data.lines(org.id) } }, include: INCLUDE });
      await this.check(tx, org, actor, b, data.header.startDate);
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'recurring_bill.created', entityType: 'recurring_bill', entityId: b.id, data: { reference: recurringBillRef(number), name: b.name, contactId: b.contactId, frequency: b.frequency, postMode: b.postMode } });
      return b.id;
    });
    return this.get(org, id);
  }

  async update(org: BillOrg, actor: Actor, id: string, input: RecurringBillInput) {
    this.assertMode(org, input.postMode);
    await this.prisma.$transaction(async (tx) => {
      const t = await this.lock(tx, org.id, id);
      if (t.status === 'ENDED') throw new DomainError('RECURRING_BILL_ENDED', 'This recurring bill has ended. Make a new one to bill again.', HttpStatus.CONFLICT);
      const data = this.prepare(org, input);
      await this.assertVendor(tx, org.id, input.contactId);
      if (t.nextRunNo > 1 && (fromDbDate(t.startDate) !== input.startDate || t.frequency !== input.frequency || t.monthEnd !== input.monthEnd || t.contactId !== input.contactId)) {
        throw new DomainError('RECURRING_BILL_RAN', 'This recurring bill has made bills, so its vendor, start date, frequency and run day stay as they are. You can change the lines, the end date and whether bills are posted, or end it and make a new one.', HttpStatus.CONFLICT);
      }
      if (data.header.endDate && scheduleFinished({ ...this.schedule(t), end: fromDbDate(data.header.endDate) })) {
        throw new DomainError('TEMPLATE_END', 'Every run up to this end date has been made. Choose a later end date, or end the recurring bill.');
      }
      await tx.recurringBillLine.deleteMany({ where: { recurringBillId: id, orgId: org.id } });
      const b = await tx.recurringBill.update({ where: { id }, data: { ...data.header, lastError: null, lastErrorAt: null, lines: { create: data.lines(org.id) } }, include: INCLUDE });
      const next = upcomingRuns(this.schedule(b), 1)[0];
      await this.check(tx, org, actor, b, next ? toDbDate(next.date) : b.startDate);
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'recurring_bill.updated', entityType: 'recurring_bill', entityId: id, data: { reference: recurringBillRef(t.number), lines: input.lines.length, postMode: input.postMode, endDate: input.endDate ?? null } });
    });
    return this.get(org, id);
  }

  async remove(org: BillOrg, actor: Actor, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.lock(tx, org.id, id);
      if (await tx.recurringBillRun.count({ where: { recurringBillId: id } })) {
        throw new DomainError('RECURRING_BILL_USED', 'This recurring bill has made bills. End it instead, so its history stays.', HttpStatus.CONFLICT);
      }
      await tx.recurringBill.delete({ where: { id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'recurring_bill.deleted', entityType: 'recurring_bill', entityId: id, data: { reference: recurringBillRef(t.number), name: t.name } });
    });
  }

  /**
   * Pause, resume or end. Resuming makes the runs that fell due while paused at the next pass,
   * unless `skipMissed`: then runs dated before today are passed over (and not made).
   */
  async setStatus(org: BillOrg, actor: Actor, id: string, action: 'pause' | 'resume' | 'end', opts: { skipMissed?: boolean } = {}) {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.lock(tx, org.id, id);
      if (t.status === 'ENDED') throw new DomainError('RECURRING_BILL_ENDED', 'This recurring bill has ended. Make a new one to bill again.', HttpStatus.CONFLICT);
      if (action === 'resume') this.assertMode(org, t.postMode);
      let nextRunNo = t.nextRunNo;
      let skipped = 0;
      if (action === 'resume' && opts.skipMissed) {
        skipped = dueRuns(this.schedule(t), addDays(todayIst(), -1), 1200).length;
        nextRunNo += skipped;
      }
      const status = action === 'pause' ? 'PAUSED' : action === 'resume' ? 'ACTIVE' : 'ENDED';
      await tx.recurringBill.update({ where: { id }, data: { status, nextRunNo, lastError: null, lastErrorAt: null } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: `recurring_bill.${action === 'end' ? 'ended' : action === 'pause' ? 'paused' : 'resumed'}`, entityType: 'recurring_bill', entityId: id, data: { reference: recurringBillRef(t.number), skipped } });
    });
    return this.get(org, id);
  }

  /**
   * Make every run that has fallen due, as of `today`, in one transaction: each run's bill and its
   * run record together, then the next run number. A failure (a closed period, an inactive vendor,
   * an approval rule, a repeated vendor reference) leaves nothing made and is kept on the
   * recurring bill, so the next pass tries again.
   */
  async runDue(org: BillOrg, actor: Actor | null, id: string, today = todayIst()): Promise<{ made: number; error: string | null }> {
    try {
      const made = await this.prisma.$transaction(async (tx) => {
        const t = await this.lock(tx, org.id, id);
        if (t.status !== 'ACTIVE') return 0;
        const s = this.schedule(t);
        if (scheduleFinished(s)) {
          await tx.recurringBill.update({ where: { id }, data: { status: 'ENDED', lastError: null, lastErrorAt: null } });
          await this.audit.append(tx, { orgId: org.id, actorId: actor?.id ?? null, action: 'recurring_bill.ended', entityType: 'recurring_bill', entityId: id, data: { reference: recurringBillRef(t.number), endDate: s.end } });
          return 0;
        }
        const due = dueRuns(s, today);
        if (!due.length) {
          if (t.lastError) await tx.recurringBill.update({ where: { id }, data: { lastError: null, lastErrorAt: null } });
          return 0;
        }
        const post = t.postMode === 'POST';
        if (!actor && post) await this.assertCreatorMayPost(tx, org.id, t);
        const by = actor ?? { id: t.createdById };
        const ids: string[] = [];
        for (const r of due) {
          const doc = await this.documents.createDraftInTx(tx, org, by, 'PURCHASES', this.billInput(org, t, r.date));
          if (post) await this.documents.postDraftInTx(tx, org, by, doc.id);
          await tx.recurringBillRun.create({ data: { orgId: org.id, recurringBillId: t.id, runNo: r.no, runDate: toDbDate(r.date), documentId: doc.id, posted: post, actorId: actor?.id ?? null } });
          ids.push(doc.id);
        }
        const after = { ...s, nextNo: t.nextRunNo + due.length };
        await tx.recurringBill.update({ where: { id }, data: { nextRunNo: after.nextNo, lastError: null, lastErrorAt: null, ...(scheduleFinished(after) ? { status: 'ENDED' } : {}) } });
        await this.audit.append(tx, { orgId: org.id, actorId: actor?.id ?? null, action: 'recurring_bill.ran', entityType: 'recurring_bill', entityId: id, data: { reference: recurringBillRef(t.number), runs: due.map((r) => r.no), documentIds: ids, posted: post } });
        return due.length;
      });
      return { made, error: null };
    } catch (e) {
      const message = this.describe(e);
      await this.prisma.recurringBill.updateMany({ where: { id, orgId: org.id }, data: { lastError: message, lastErrorAt: new Date() } });
      this.logger.warn(`Recurring bill ${id} could not run: ${message}`);
      return { made: 0, error: message };
    }
  }

  /** Make one recurring bill's due runs now, as a member (the *Make due bills now* button). */
  async runNow(org: BillOrg, actor: Actor, id: string) {
    const t = await this.prisma.recurringBill.findFirst({ where: { id, orgId: org.id }, select: { postMode: true } });
    if (!t) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Recurring bill not found' });
    this.assertMode(org, t.postMode);
    const r = await this.runDue(org, actor, id);
    return { ...r, recurringBill: await this.get(org, id) };
  }

  /** Every active recurring bill of the organisation, now. */
  async runOrg(org: BillOrg, actor: Actor) {
    const rows = await this.prisma.recurringBill.findMany({ where: { orgId: org.id, status: 'ACTIVE' }, select: { id: true, postMode: true }, orderBy: { number: 'asc' } });
    const mayPost = hasPermission(org.role, 'journals.post');
    let made = 0;
    const errors: { id: string; error: string }[] = [];
    for (const r of rows) {
      if (r.postMode === 'POST' && !mayPost) continue;
      const res = await this.runDue(org, actor, r.id);
      made += res.made;
      if (res.error) errors.push({ id: r.id, error: res.error });
    }
    return { recurringBills: rows.length, made, errors };
  }

  /** The runner's pass over every organisation's active recurring bills (or `orgIds`), as of `today`. */
  async runAll(today = todayIst(), orgIds?: string[]) {
    const rows = await tenantStorage.run({ bypass: true }, async () =>
      await this.prisma.recurringBill.findMany({
        where: { status: 'ACTIVE', ...(orgIds ? { orgId: { in: orgIds } } : {}) },
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
    return { recurringBills: rows.length, made, failed };
  }

  // ---------- helpers ----------

  /** The bill one run makes, dated `date`. */
  private billInput(org: BillOrg, t: Base, date: string): DocumentInput {
    return {
      kind: 'BILL',
      contactId: t.contactId,
      issueDate: date,
      dueDate: t.dueDays !== null ? addDays(date, t.dueDays) : undefined,
      reference: this.fill(org, t.reference, date),
      memo: this.fill(org, t.memo, date) ?? `${recurringBillRef(t.number)} ${t.name}`.slice(0, 1000),
      placeOfSupply: t.placeOfSupply,
      reverseCharge: t.reverseCharge,
      withholdingSectionId: t.withholdingSectionId,
      lines: t.lines.map((l) => ({
        accountId: l.accountId,
        description: l.description ? this.fill(org, l.description, date) ?? undefined : undefined,
        quantity: l.quantity.toFixed(),
        unitPrice: l.unitPrice.toFixed(),
        taxRateId: l.taxRateId,
        hsnCode: l.hsnCode,
        departmentId: l.departmentId,
        projectId: l.projectId,
      })),
    };
  }

  /**
   * Check a recurring bill as its first (or next) bill would be checked, by making that bill
   * inside a savepoint and rolling it back: the vendor, accounts, tax rates, GST, TDS and the
   * vendor reference are refused now, not on the night the schedule runs.
   */
  private async check(tx: Tx, org: BillOrg, actor: Actor, b: Base, date: Date) {
    await tx.$executeRawUnsafe('SAVEPOINT recurring_bill_check');
    const draft = await this.documents.createDraftInTx(tx, org, actor, 'PURCHASES', this.billInput(org, b, fromDbDate(date)));
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT recurring_bill_check');
    // MongoDB has no savepoints: the trial bill kept there is removed by hand.
    await this.moved.remove(tx, DOCUMENTS, org.id, draft.id);
  }

  private prepare(org: BillOrg, input: RecurringBillInput) {
    try {
      runCount({ start: input.startDate, end: input.endDate ?? null, frequency: input.frequency, monthEnd: input.monthEnd });
    } catch (e) {
      if (e instanceof TemplateError) throw new DomainError(e.code, e.message);
      throw e;
    }
    const refIssue = recurringReferenceIssue(input.reference, input.frequency);
    if (refIssue) throw new DomainError('RECURRING_BILL_REFERENCE', refIssue);
    return {
      header: {
        name: input.name.trim(),
        contactId: input.contactId,
        reference: clean(input.reference),
        memo: clean(input.memo),
        placeOfSupply: input.placeOfSupply ?? null,
        reverseCharge: input.reverseCharge ?? false,
        withholdingSectionId: input.withholdingSectionId ?? null,
        dueDays: input.dueDays ?? null,
        frequency: input.frequency,
        startDate: toDbDate(input.startDate),
        endDate: input.endDate ? toDbDate(input.endDate) : null,
        monthEnd: input.monthEnd,
        postMode: input.postMode,
      },
      lines: (orgId: string) =>
        input.lines.map((l, i) => ({
          orgId,
          lineNo: i + 1,
          accountId: l.accountId,
          description: clean(l.description),
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          taxRateId: l.taxRateId ?? null,
          hsnCode: clean(l.hsnCode),
          departmentId: l.departmentId ?? null,
          projectId: l.projectId ?? null,
        })),
    };
  }

  private async assertVendor(tx: Tx, orgId: string, contactId: string) {
    const c = await tx.contact.findFirst({ where: { id: contactId, orgId }, select: { name: true, isVendor: true, isActive: true } });
    if (!c) throw new DomainError('RECURRING_BILL_VENDOR', 'Choose a vendor of this organisation');
    if (!c.isVendor) throw new DomainError('RECURRING_BILL_VENDOR', `${c.name} is not a vendor`);
    if (!c.isActive) throw new DomainError('RECURRING_BILL_VENDOR', `${c.name} is inactive`);
  }

  /** The runner posts in the creator's name, so the creator must still be a member who may post. */
  private async assertCreatorMayPost(tx: Tx, orgId: string, t: RecurringBill) {
    const m = await tx.membership.findFirst({ where: { orgId, userId: t.createdById }, select: { role: true } });
    if (!m || !hasPermission(m.role as RoleName, 'journals.post')) {
      throw new DomainError('RECURRING_BILL_POSTER', 'The member who set up this recurring bill can no longer post bills. Someone who can should open it and save it again, or set it to make drafts.');
    }
  }

  private assertMode(org: BillOrg, mode: 'DRAFT' | 'POST' | undefined) {
    if (mode === 'POST' && !hasPermission(org.role, 'journals.post')) {
      throw new ForbiddenException({ error: 'FORBIDDEN', message: `A recurring bill that posts its bills needs journals.post, which your role (${org.role}) does not have. Set it to make drafts instead.` });
    }
  }

  private describe(e: unknown) {
    const details = e instanceof DomainError ? (e.details as { issues?: string[] } | undefined) : undefined;
    const issues = details?.issues ?? (e as { issues?: string[] }).issues;
    const base = e instanceof Error ? e.message : String(e);
    return (issues?.length ? `${base}: ${issues.join('; ')}` : base).slice(0, 1000);
  }

  private async lock(tx: Tx, orgId: string, id: string): Promise<Full> {
    await tx.$queryRaw`SELECT id FROM recurring_bills WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid FOR UPDATE`;
    const t = await tx.recurringBill.findFirst({ where: { id, orgId }, include: INCLUDE });
    if (!t) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Recurring bill not found' });
    const [full] = await this.withAccounts(orgId, [t], tx);
    return full!;
  }

  /** Line accounts by id (the lines table has a composite FK to accounts, without a Prisma relation). */
  private async withAccounts<T extends RecurringBill & { contact: { id: string; name: string }; lines: RecurringBillLine[] }>(orgId: string, rows: T[], tx: Tx | PrismaService = this.prisma): Promise<(T & Full)[]> {
    const ids = [...new Set(rows.flatMap((r) => r.lines.map((l) => l.accountId)))];
    const accounts = ids.length ? await tx.account.findMany({ where: { orgId, id: { in: ids } }, select: { id: true, code: true, name: true } }) : [];
    const byId = new Map(accounts.map((a) => [a.id, { code: a.code, name: a.name }]));
    return rows.map((r) => ({ ...r, lines: r.lines.map((l) => ({ ...l, account: byId.get(l.accountId) ?? null })) }));
  }

  private schedule(t: RecurringBill): RecurringSchedule {
    return { start: fromDbDate(t.startDate), end: t.endDate ? fromDbDate(t.endDate) : null, frequency: t.frequency, monthEnd: t.monthEnd, nextNo: t.nextRunNo };
  }

  private fill(org: BillOrg, text: string | null, date: string) {
    return text ? fillPlaceholders(text, date, org.fiscalYearStartMonth) : null;
  }

  private money(v: Prisma.Decimal | string, currency: string) {
    return new Prisma.Decimal(v).toFixed(minorUnits(currency));
  }

  private can(org: BillOrg) {
    return { manage: hasPermission(org.role, 'purchases.manage'), post: hasPermission(org.role, 'journals.post') };
  }

  private summary(org: BillOrg, t: Full) {
    const s = this.schedule(t);
    const next = t.status !== 'ENDED' ? (upcomingRuns(s, 1)[0] ?? null) : null;
    // Before tax: the tax depends on the rates and GST facts on the day each bill is made.
    const subtotal = t.lines.reduce((sum, l) => sum.plus(l.quantity.times(l.unitPrice)), new Prisma.Decimal(0));
    return {
      id: t.id,
      number: t.number,
      reference: recurringBillRef(t.number),
      name: t.name,
      contact: t.contact,
      vendorReference: t.reference,
      memo: t.memo,
      placeOfSupply: t.placeOfSupply,
      reverseCharge: t.reverseCharge,
      withholdingSectionId: t.withholdingSectionId,
      dueDays: t.dueDays,
      subtotal: this.money(subtotal, org.functionalCurrency),
      currency: org.functionalCurrency,
      lines: t.lines.map((l) => ({
        lineNo: l.lineNo,
        accountId: l.accountId,
        account: l.account,
        description: l.description,
        quantity: l.quantity.toFixed(),
        unitPrice: l.unitPrice.toFixed(),
        amount: this.money(l.quantity.times(l.unitPrice), org.functionalCurrency),
        taxRateId: l.taxRateId,
        hsnCode: l.hsnCode,
        departmentId: l.departmentId,
        projectId: l.projectId,
      })),
      schedule: {
        frequency: s.frequency,
        startDate: s.start,
        endDate: s.end,
        monthEnd: s.monthEnd,
        postMode: t.postMode,
        status: t.status,
        nextRunNo: t.nextRunNo,
        runsTotal: runCount(s),
        description: describeSchedule(s),
        nextRun: next ? { ...next, reference: this.fill(org, t.reference, next.date) } : null,
        dueNow: t.status === 'ACTIVE' ? dueRuns(s, todayIst()).length : 0,
        lastError: t.lastError,
        lastErrorAt: t.lastErrorAt?.toISOString() ?? null,
      },
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    };
  }
}
