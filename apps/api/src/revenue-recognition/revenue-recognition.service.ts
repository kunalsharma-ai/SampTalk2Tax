import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import {
  D,
  deferralBalance,
  functionalNet,
  minorUnits,
  recognitionEnd,
  recognitionIssues,
  revenueWaterfall,
  type DeferralMethod,
} from '@talk2tax/accounting-engine';
import { hasPermission, RoleName } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService, Tx } from '../common/prisma.service';
import { JournalsService } from '../journals/journals.service';
import { todayIst } from '../tasks/tasks.service';
import { nextCounter } from '../db/counters';
import { lockName, lockRow } from '../db/locks';

type Actor = { id: string };
type Db = Tx | PrismaService;
export interface RecOrg {
  id: string;
  role: RoleName;
  functionalCurrency: string;
}
export interface LineRecognitionInput {
  lineNo: number;
  startDate: string;
  months: number;
  method: DeferralMethod;
}

const DEFERRED_SUBTYPES = ['OTHER_CURRENT_LIABILITY', 'OTHER_NON_CURRENT_LIABILITY', 'ACCRUED_LIABILITY'];
const drRef = (n: number) => `DR-${String(n).padStart(4, '0')}`;

/**
 * Revenue recognition (AR-028). A draft invoice's lines can be marked to be recognised over a
 * service period. Posting the invoice credits those lines to the deferred revenue account and
 * opens a deferred revenue schedule for each (DR-0001…), which the monthly release run moves to
 * the line's revenue account. Voiding the invoice takes back what was recognised and ends the
 * schedules.
 */
@Injectable()
export class RevenueRecognitionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly journals: JournalsService,
  ) {}

  private invalid(message: string, code = 'RECOGNITION_INVALID', details?: unknown): never {
    throw new DomainError(code, message, HttpStatus.UNPROCESSABLE_ENTITY, details);
  }

  can(org: RecOrg) {
    return { manage: hasPermission(org.role, 'sales.manage'), settings: hasPermission(org.role, 'org.manage') || hasPermission(org.role, 'journals.post') };
  }

  // ------------------------------------------------------------------ settings

  private async deferredAccount(db: Db, orgId: string) {
    const s = await db.revenueRecognitionSettings.findUnique({ where: { orgId } });
    if (s) return s.deferredAccountId;
    // The standard chart's 2350 Deferred Revenue, when there is one.
    const a = await db.account.findFirst({ where: { orgId, code: '2350', type: 'LIABILITY', isPostable: true, isActive: true, subtype: { in: DEFERRED_SUBTYPES } }, select: { id: true } });
    return a?.id ?? null;
  }

  async settings(org: RecOrg) {
    const s = await this.prisma.revenueRecognitionSettings.findUnique({ where: { orgId: org.id } });
    const id = await this.deferredAccount(this.prisma, org.id);
    const acc = id ? await this.prisma.account.findFirst({ where: { id, orgId: org.id }, select: { id: true, code: true, name: true } }) : null;
    return { deferredAccount: acc, chosen: !!s, can: this.can(org) };
  }

  async saveSettings(org: RecOrg, actor: Actor, deferredAccountId: string) {
    if (!this.can(org).settings) throw new DomainError('FORBIDDEN', 'Choosing the deferred revenue account needs org.manage or journals.post', HttpStatus.FORBIDDEN);
    await this.prisma.$transaction(async (tx) => {
      const a = await tx.account.findFirst({ where: { id: deferredAccountId, orgId: org.id } });
      if (!a || a.type !== 'LIABILITY' || !DEFERRED_SUBTYPES.includes(a.subtype ?? '') || !a.isPostable || !a.isActive) {
        this.invalid('Choose an active current or non-current liability account (not payables, tax or payroll) for deferred revenue');
      }
      await tx.revenueRecognitionSettings.upsert({ where: { orgId: org.id }, create: { orgId: org.id, deferredAccountId, updatedById: actor.id }, update: { deferredAccountId, updatedById: actor.id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'revenue_recognition.settings_saved', entityType: 'organization', entityId: org.id, data: { deferredAccountId, account: `${a.code} ${a.name}` } });
    });
    return this.settings(org);
  }

  // ------------------------------------------------------------------ an invoice's lines

  /** The recognition terms of an invoice's lines, and for a posted one each schedule's progress. */
  async forDocument(org: RecOrg, documentId: string) {
    const doc = await this.prisma.document.findFirst({ where: { id: documentId, orgId: org.id }, select: { id: true, kind: true, status: true, exchangeRate: true, lines: { select: { lineNo: true, description: true, netAmount: true, account: { select: { code: true, name: true, type: true } } }, orderBy: { lineNo: 'asc' } } } });
    if (!doc || doc.kind !== 'INVOICE') throw new NotFoundException({ error: 'NOT_FOUND', message: 'Invoice not found' });
    const rows = await this.prisma.invoiceLineRecognition.findMany({ where: { orgId: org.id, documentId }, orderBy: { lineNo: 'asc' } });
    const schedules = await this.scheduleProgress(this.prisma, org, rows.map((r) => r.scheduleId).filter((x): x is string => !!x));
    const deferred = await this.deferredAccount(this.prisma, org.id);
    return {
      status: doc.status,
      deferredAccountReady: !!deferred,
      lines: doc.lines.map((l) => {
        const r = rows.find((x) => x.lineNo === l.lineNo);
        const s = r?.scheduleId ? schedules.get(r.scheduleId) : undefined;
        return {
          lineNo: l.lineNo,
          description: l.description,
          account: { code: l.account.code, name: l.account.name },
          revenue: l.account.type === 'REVENUE',
          netAmount: l.netAmount.toFixed(),
          recognition: r ? { startDate: fromDbDate(r.startDate), months: r.months, method: r.method as DeferralMethod, endDate: recognitionEnd({ startDate: fromDbDate(r.startDate), months: r.months }) } : null,
          schedule: s ?? null,
        };
      }),
      can: this.can(org),
    };
  }

  /** Set (or clear, with an empty list) which lines of a draft invoice are recognised over time. */
  async setForDocument(org: RecOrg, actor: Actor, documentId: string, lines: LineRecognitionInput[]) {
    if (!this.can(org).manage) throw new DomainError('FORBIDDEN', 'Changing revenue recognition needs sales.manage', HttpStatus.FORBIDDEN);
    await this.prisma.$transaction(async (tx) => {
      await lockRow(tx, 'documents', documentId, org.id);
      const doc = await tx.document.findFirst({ where: { id: documentId, orgId: org.id }, select: { kind: true, status: true, lines: { select: { lineNo: true, netAmount: true, account: { select: { type: true } } } } } });
      if (!doc || doc.kind !== 'INVOICE') throw new NotFoundException({ error: 'NOT_FOUND', message: 'Invoice not found' });
      if (doc.status !== 'DRAFT') this.invalid('Revenue recognition is set while the invoice is a draft', 'NOT_DRAFT');
      const issues: string[] = [];
      const seen = new Set<number>();
      for (const l of lines) {
        const line = doc.lines.find((x) => x.lineNo === l.lineNo);
        if (!line) issues.push(`The invoice has no line ${l.lineNo}`);
        else if (seen.has(l.lineNo)) issues.push(`Line ${l.lineNo} is given twice`);
        else issues.push(...recognitionIssues(l, { no: l.lineNo, accountType: line.account.type, net: line.netAmount.toFixed() }));
        seen.add(l.lineNo);
      }
      if (issues.length) this.invalid(issues[0]!, 'RECOGNITION_INVALID', { issues });
      if (lines.length && !(await this.deferredAccount(tx, org.id))) this.invalid('Choose the deferred revenue account first, under Sales → Revenue recognition', 'NO_DEFERRED_ACCOUNT');
      await tx.invoiceLineRecognition.deleteMany({ where: { orgId: org.id, documentId } });
      if (lines.length) await tx.invoiceLineRecognition.createMany({ data: lines.map((l) => ({ orgId: org.id, documentId, lineNo: l.lineNo, startDate: toDbDate(l.startDate), months: l.months, method: l.method, createdById: actor.id })) });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'revenue_recognition.lines_set', entityType: 'document', entityId: documentId, data: { lines: lines.map((l) => ({ lineNo: l.lineNo, startDate: l.startDate, months: l.months, method: l.method })) } });
    });
    return this.forDocument(org, documentId);
  }

  // ------------------------------------------------------------------ posting and voiding (called by DocumentsService)

  /**
   * Before an invoice's journal is built: which lines go to deferred revenue. Checks the terms
   * again against the lines as they stand.
   */
  async planForPosting(tx: Tx, orgId: string, documentId: string, lines: { lineNo: number; accountId: string; netAmount: { toFixed(): string } }[]) {
    const rows = await tx.invoiceLineRecognition.findMany({ where: { orgId, documentId }, orderBy: { lineNo: 'asc' } });
    if (!rows.length) return null;
    const deferredAccountId = await this.deferredAccount(tx, orgId);
    if (!deferredAccountId) this.invalid('Choose the deferred revenue account first, under Sales → Revenue recognition', 'NO_DEFERRED_ACCOUNT');
    const accounts = await tx.account.findMany({ where: { orgId, id: { in: lines.map((l) => l.accountId) } }, select: { id: true, type: true } });
    const issues: string[] = [];
    const plan: { lineNo: number; revenueAccountId: string; net: string; row: (typeof rows)[number] }[] = [];
    for (const r of rows) {
      const l = lines.find((x) => x.lineNo === r.lineNo);
      if (!l) {
        issues.push(`Line ${r.lineNo} is set to be recognised over time but the invoice no longer has it; review revenue recognition on the draft`);
        continue;
      }
      issues.push(...recognitionIssues({ startDate: fromDbDate(r.startDate), months: r.months, method: r.method as DeferralMethod }, { no: r.lineNo, accountType: accounts.find((a) => a.id === l.accountId)?.type ?? null, net: l.netAmount.toFixed() }));
      plan.push({ lineNo: r.lineNo, revenueAccountId: l.accountId, net: l.netAmount.toFixed(), row: r });
    }
    if (issues.length) this.invalid(issues[0]!, 'RECOGNITION_INVALID', { issues });
    return { deferredAccountId: deferredAccountId!, plan };
  }

  /** After the invoice's journal is posted: one deferred revenue schedule per line. */
  async openSchedules(tx: Tx, org: RecOrg, actor: Actor, doc: { id: string; number: string; contactName: string; exchangeRate: string; journalEntryId: string }, p: NonNullable<Awaited<ReturnType<RecognitionPlan>>>) {
    const scale = minorUnits(org.functionalCurrency);
    // What the journal actually credited to deferred revenue, line by line, in the functional currency.
    const credited = await tx.journalLine.findMany({ where: { entryId: doc.journalEntryId, accountId: p.deferredAccountId }, orderBy: { lineNo: 'asc' }, select: { functionalCredit: true, functionalDebit: true } });
    const useJournal = credited.length === p.plan.length;
    const docLines = await tx.documentLine.findMany({ where: { documentId: doc.id }, select: { lineNo: true, description: true } });
    const out: string[] = [];
    for (const [i, x] of p.plan.entries()) {
      const amount = useJournal ? new D(credited[i]!.functionalCredit.toFixed()).minus(credited[i]!.functionalDebit.toFixed()).toFixed(scale) : functionalNet(x.net, doc.exchangeRate, scale);
      const [{ value: number }] = [{ value: await nextCounter(tx, org.id, 'deferred_revenue') }];
      const desc = docLines.find((l) => l.lineNo === x.lineNo)?.description;
      const s = await tx.deferralSchedule.create({
        data: {
          orgId: org.id,
          kind: 'DEFERRED_REVENUE',
          number,
          name: `${doc.number} line ${x.lineNo}${desc ? `: ${desc}` : ''}`.slice(0, 200),
          counterparty: doc.contactName.slice(0, 200),
          balanceAccountId: p.deferredAccountId,
          pnlAccountId: x.revenueAccountId,
          amount,
          startDate: x.row.startDate,
          months: x.row.months,
          method: x.row.method,
          initialEntryId: doc.journalEntryId,
          createdById: actor.id,
        },
      });
      await tx.invoiceLineRecognition.update({ where: { id: x.row.id }, data: { scheduleId: s.id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'deferral.created', entityType: 'deferral_schedule', entityId: s.id, data: { reference: drRef(number), kind: 'DEFERRED_REVENUE', amount, startDate: fromDbDate(x.row.startDate), months: x.row.months, method: x.row.method, initialEntryId: doc.journalEntryId, documentId: doc.id, lineNo: x.lineNo } });
      out.push(drRef(number));
    }
    return out;
  }

  /**
   * When the invoice is voided: what its schedules already recognised is taken back (debit
   * revenue, credit deferred revenue) on the void date, and the schedules end. The invoice's own
   * reversal clears the rest of the deferred balance.
   */
  async onVoid(tx: Tx, org: RecOrg, actor: Actor, doc: { id: string; number: string }, date: string) {
    const rows = await tx.invoiceLineRecognition.findMany({ where: { orgId: org.id, documentId: doc.id, scheduleId: { not: null } } });
    if (!rows.length) return;
    await lockName(tx, 'deferrals:' + org.id);
    const scale = minorUnits(org.functionalCurrency);
    for (const r of rows) {
      const s = await tx.deferralSchedule.findUniqueOrThrow({ where: { id: r.scheduleId! } });
      if (s.status === 'ENDED') continue;
      const posted = await this.posted(tx, org.id, [s.id]);
      const released = new D(deferralBalance(s.amount.toFixed(), posted.get(s.id) ?? {}, scale).released);
      // The schedule itself ends with nothing released at its end (end_amount 0, no end entry);
      // the take-back journal is named in its end note and the audit trail.
      let takeBack: { id: string; entryNumber: number | null } | null = null;
      if (released.gt(0)) {
        const je = await this.journals.postSystemEntry(tx, org, actor, {
          date,
          source: 'DEFERRAL',
          memo: `${doc.number} voided: revenue recognised under ${drRef(s.number)} taken back`,
          reference: drRef(s.number),
          lines: [
            { accountId: s.pnlAccountId, debit: released.toFixed(scale), description: `${s.name}: invoice voided` },
            { accountId: s.balanceAccountId, credit: released.toFixed(scale), description: `${s.name}: invoice voided` },
          ],
        });
        takeBack = { id: je.id, entryNumber: je.entryNumber };
      }
      const endNote = `${doc.number} voided${takeBack ? `; ${released.toFixed(scale)} recognised was taken back in journal #${takeBack.entryNumber}` : ''}`;
      await tx.deferralSchedule.update({ where: { id: s.id }, data: { status: 'ENDED', endedOn: toDbDate(date), endAmount: '0', endEntryId: null, endNote, endedById: actor.id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'deferral.ended', entityType: 'deferral_schedule', entityId: s.id, data: { reference: drRef(s.number), date, reason: 'invoice voided', documentId: doc.id, reversed: released.toFixed(scale), journalEntryId: takeBack?.id ?? null } });
    }
  }

  // ------------------------------------------------------------------ overview

  private async posted(db: Db, orgId: string, ids: string[]) {
    const lines = await db.deferralLine.findMany({ where: { orgId, scheduleId: { in: ids }, run: { status: 'POSTED' } }, select: { scheduleId: true, month: true, amount: true } });
    const map = new Map<string, Record<string, string>>();
    for (const l of lines) {
      const m = map.get(l.scheduleId) ?? {};
      m[l.month] = new D(m[l.month] ?? 0).plus(l.amount.toFixed()).toFixed();
      map.set(l.scheduleId, m);
    }
    return map;
  }

  private async scheduleProgress(db: Db, org: RecOrg, ids: string[]) {
    const scale = minorUnits(org.functionalCurrency);
    const rows = ids.length ? await db.deferralSchedule.findMany({ where: { orgId: org.id, id: { in: ids } } }) : [];
    const posted = await this.posted(db, org.id, ids);
    return new Map(
      rows.map((s) => {
        const b = deferralBalance(s.amount.toFixed(), posted.get(s.id) ?? {}, scale);
        return [s.id, { id: s.id, reference: drRef(s.number), amount: s.amount.toFixed(scale), recognised: b.released, deferred: s.status === 'ENDED' ? new D(0).toFixed(scale) : b.remaining, status: s.status, endedOn: s.endedOn ? fromDbDate(s.endedOn) : null }];
      }),
    );
  }

  /**
   * Revenue recognition overview: every invoice line recognised over time, what each has
   * recognised and what is still deferred, and the waterfall of all deferred revenue schedules
   * (from invoices and entered by hand) for the next twelve months.
   */
  async overview(org: RecOrg, from?: string) {
    const scale = minorUnits(org.functionalCurrency);
    const start = from ?? todayIst().slice(0, 7);
    const rows = await this.prisma.invoiceLineRecognition.findMany({ where: { orgId: org.id, scheduleId: { not: null } }, orderBy: { createdAt: 'desc' }, take: 500 });
    const docs = await this.prisma.document.findMany({ where: { orgId: org.id, id: { in: [...new Set(rows.map((r) => r.documentId))] } }, select: { id: true, number: true, status: true, issueDate: true, contact: { select: { id: true, name: true } } } });
    const all = await this.prisma.deferralSchedule.findMany({ where: { orgId: org.id, kind: 'DEFERRED_REVENUE' } });
    const posted = await this.posted(this.prisma, org.id, all.map((s) => s.id));
    const progress = await this.scheduleProgress(this.prisma, org, rows.map((r) => r.scheduleId!));
    const live = all.filter((s) => s.status === 'ACTIVE' || (posted.get(s.id) && Object.keys(posted.get(s.id)!).length));
    const w = revenueWaterfall(
      live.map((s) => ({ amount: s.amount.toFixed(), startDate: fromDbDate(s.startDate), months: s.months, method: s.method as DeferralMethod, endedOn: s.endedOn ? fromDbDate(s.endedOn) : null, posted: posted.get(s.id) ?? {} })),
      start,
      12,
      scale,
    );
    const lines = rows.map((r) => {
      const d = docs.find((x) => x.id === r.documentId)!;
      const s = progress.get(r.scheduleId!)!;
      return {
        documentId: d.id,
        invoice: d.number,
        invoiceStatus: d.status,
        issueDate: fromDbDate(d.issueDate),
        customer: d.contact,
        lineNo: r.lineNo,
        startDate: fromDbDate(r.startDate),
        endDate: recognitionEnd({ startDate: fromDbDate(r.startDate), months: r.months }),
        months: r.months,
        method: r.method,
        schedule: s,
      };
    });
    const deferredNow = lines.filter((l) => l.schedule.status === 'ACTIVE').reduce((t, l) => t.plus(l.schedule.deferred), new D(0));
    return {
      from: start,
      functionalCurrency: org.functionalCurrency,
      lines,
      totals: { lines: lines.length, deferredNow: deferredNow.toFixed(scale), recognised: lines.reduce((t, l) => t.plus(l.schedule.recognised), new D(0)).toFixed(scale) },
      waterfall: w,
      settings: await this.settings(org),
    };
  }
}

type RecognitionPlan = RevenueRecognitionService['planForPosting'];
