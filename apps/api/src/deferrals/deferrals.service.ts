import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import {
  checkDeferralTerms,
  D,
  deferralBalance,
  deferralEndDate,
  deferralMonths,
  deferralSchedule,
  firstOfNextMonth,
  minorUnits,
  monthEnd,
  releaseLines,
  addMonth,
  type DeferralKind,
  type DeferralMethod,
  type DeferralTerms,
} from '@talk2tax/accounting-engine';
import { DeferralSchedule } from '@talk2tax/database';
import { hasPermission, RoleName } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService, Tx } from '../common/prisma.service';
import { JournalsService } from '../journals/journals.service';
import { todayIst } from '../tasks/tasks.service';
import { nextCounter } from '../db/counters';
import { lockName, lockRow } from '../db/locks';

export interface DeferralOrg {
  id: string;
  role: RoleName;
  functionalCurrency: string;
}
type Actor = { id: string };

export interface ScheduleInput {
  kind: DeferralKind;
  name: string;
  counterparty?: string | null;
  balanceAccountId: string;
  pnlAccountId: string;
  amount: string;
  startDate: string;
  months: number;
  method: DeferralMethod;
  /** Record the payment (prepaid) or receipt (deferred revenue) here, against this account. */
  fundingAccountId?: string | null;
  /** The date of that payment or receipt; the start date when left out. */
  fundingDate?: string | null;
}

export interface EndInput {
  date: string;
  /** Where what is left goes: the schedule's own expense or revenue account when left out. */
  accountId?: string | null;
  note?: string | null;
}

export interface AccrualInput {
  kind: 'EXPENSE' | 'INCOME';
  description: string;
  counterparty?: string | null;
  month: string;
  pnlAccountId: string;
  balanceAccountId: string;
  amount: string;
}

type Acc = { id: string; code: string; name: string; type: string; subtype: string | null; isPostable: boolean; isActive: boolean };

const PREFIX: Record<DeferralKind, string> = { PREPAID_EXPENSE: 'PP', DEFERRED_REVENUE: 'DR' };
const ref = (kind: DeferralKind, n: number) => `${PREFIX[kind]}-${String(n).padStart(4, '0')}`;
const accrualRef = (n: number) => `AC-${String(n).padStart(4, '0')}`;
const monthLabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Which accounts fit each role. */
const RULES = {
  prepaidBalance: (a: Acc) => a.type === 'ASSET' && ['PREPAID', 'OTHER_CURRENT_ASSET', 'OTHER_NON_CURRENT_ASSET'].includes(a.subtype ?? ''),
  deferredBalance: (a: Acc) => a.type === 'LIABILITY' && ['OTHER_CURRENT_LIABILITY', 'OTHER_NON_CURRENT_LIABILITY', 'ACCRUED_LIABILITY'].includes(a.subtype ?? ''),
  expense: (a: Acc) => a.type === 'EXPENSE' && a.subtype !== 'DEPRECIATION',
  revenue: (a: Acc) => a.type === 'REVENUE',
  accruedLiability: (a: Acc) => a.type === 'LIABILITY' && ['ACCRUED_LIABILITY', 'OTHER_CURRENT_LIABILITY'].includes(a.subtype ?? ''),
  accruedIncome: (a: Acc) => a.type === 'ASSET' && ['OTHER_CURRENT_ASSET', 'PREPAID'].includes(a.subtype ?? ''),
};

@Injectable()
export class DeferralsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly journals: JournalsService,
  ) {}

  // ------------------------------------------------------------------ helpers

  private terms(s: DeferralSchedule): DeferralTerms {
    return { amount: new D(s.amount.toString()).toFixed(), startDate: fromDbDate(s.startDate), months: s.months, method: s.method, endedOn: s.endedOn ? fromDbDate(s.endedOn) : null };
  }

  /** Amounts posted for each schedule by month, from runs that stand. */
  private async posted(db: Tx | PrismaService, orgId: string, ids?: string[]) {
    const lines = await db.deferralLine.findMany({ where: { orgId, run: { status: 'POSTED' }, ...(ids ? { scheduleId: { in: ids } } : {}) }, select: { scheduleId: true, month: true, amount: true } });
    const map = new Map<string, Record<string, string>>();
    for (const l of lines) {
      const m = map.get(l.scheduleId) ?? {};
      m[l.month] = new D(m[l.month] ?? 0).plus(l.amount.toString()).toFixed();
      map.set(l.scheduleId, m);
    }
    return map;
  }

  private invalid(errors: string[], code = 'DEFERRAL_INVALID'): never {
    throw new DomainError(code, errors[0]!, HttpStatus.UNPROCESSABLE_ENTITY, { errors });
  }

  private async account(db: Tx | PrismaService, orgId: string, id: string): Promise<Acc | null> {
    return db.account.findFirst({ where: { orgId, id }, select: { id: true, code: true, name: true, type: true, subtype: true, isPostable: true, isActive: true } });
  }

  private async controlIds(db: Tx | PrismaService, orgId: string) {
    const c = await db.organization.findUniqueOrThrow({ where: { id: orgId }, select: { arAccountId: true, apAccountId: true, claimsAccountId: true } });
    return new Set([c.arAccountId, c.apAccountId, c.claimsAccountId].filter((x): x is string => !!x));
  }

  private async checkScheduleAccounts(db: Tx, orgId: string, input: Pick<ScheduleInput, 'kind' | 'balanceAccountId' | 'pnlAccountId' | 'fundingAccountId'>) {
    const errors: string[] = [];
    const prepaid = input.kind === 'PREPAID_EXPENSE';
    const usable = (a: Acc | null, ok: (a: Acc) => boolean, label: string) => {
      if (!a || !ok(a)) errors.push(label);
      else if (!a.isPostable || !a.isActive) errors.push(`${a.code} ${a.name} is not an active posting account`);
    };
    usable(await this.account(db, orgId, input.balanceAccountId), prepaid ? RULES.prepaidBalance : RULES.deferredBalance, prepaid ? 'The prepaid account must be a prepaid or other asset account' : 'The deferred revenue account must be a current or non-current liability account (not payables, tax or payroll)');
    usable(await this.account(db, orgId, input.pnlAccountId), prepaid ? RULES.expense : RULES.revenue, prepaid ? 'Release a prepaid expense to an expense account (not depreciation)' : 'Release deferred revenue to a revenue account');
    if (input.fundingAccountId) {
      const f = await this.account(db, orgId, input.fundingAccountId);
      const control = await this.controlIds(db, orgId);
      if (!f || !['ASSET', 'LIABILITY', 'EQUITY'].includes(f.type) || control.has(f.id) || f.id === input.balanceAccountId) errors.push(prepaid ? 'Say which bank, cash or clearing account paid it' : 'Say which bank, cash or clearing account received it');
      else if (!f.isPostable || !f.isActive) errors.push(`${f.code} ${f.name} is not an active posting account`);
    }
    if (errors.length) this.invalid(errors);
  }

  private async nextNumber(tx: Tx, orgId: string, key: string) {
    const [{ value }] = [{ value: await nextCounter(tx, orgId, key) }];
    return value;
  }

  private lockOrg(tx: Tx, orgId: string) {
    return lockName(tx, 'deferrals:' + orgId);
  }

  private async lockSchedule(tx: Tx, orgId: string, id: string) {
    await lockRow(tx, 'deferral_schedules', id, orgId);
    const s = await tx.deferralSchedule.findFirst({ where: { id, orgId } });
    if (!s) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Schedule not found' });
    return s;
  }

  private async names(ids: (string | null | undefined)[]) {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    const users = await this.prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  private async entries(orgId: string, ids: (string | null | undefined)[]) {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    const rows = list.length ? await this.prisma.journalEntry.findMany({ where: { orgId, id: { in: list } }, select: { id: true, entryNumber: true, date: true } }) : [];
    return (id: string | null | undefined) => {
      const e = id ? rows.find((r) => r.id === id) : null;
      return e ? { id: e.id, entryNumber: e.entryNumber, date: fromDbDate(e.date) } : null;
    };
  }

  private can(org: DeferralOrg) {
    return { manage: hasPermission(org.role, 'deferrals.manage') };
  }

  // ------------------------------------------------------------------ schedules

  async list(org: DeferralOrg) {
    const rows = await this.prisma.deferralSchedule.findMany({ where: { orgId: org.id }, orderBy: [{ kind: 'asc' }, { number: 'asc' }] });
    const posted = await this.posted(this.prisma, org.id);
    const accounts = await this.prisma.account.findMany({ where: { orgId: org.id, id: { in: [...new Set(rows.flatMap((r) => [r.balanceAccountId, r.pnlAccountId]))] } }, select: { id: true, code: true, name: true } });
    const acct = (id: string) => accounts.find((a) => a.id === id) ?? null;
    const scale = minorUnits(org.functionalCurrency);
    const schedules = rows.map((s) => {
      const p = posted.get(s.id) ?? {};
      const b = deferralBalance(s.amount.toString(), p, scale);
      const endAmount = s.endAmount ? new D(s.endAmount.toString()) : new D(0);
      const remaining = new D(b.remaining).minus(endAmount);
      const { first, last } = deferralMonths(this.terms(s));
      return {
        id: s.id,
        kind: s.kind,
        reference: ref(s.kind, s.number),
        name: s.name,
        counterparty: s.counterparty,
        status: s.status === 'ENDED' ? 'ENDED' : remaining.lte(0) ? 'COMPLETED' : 'ACTIVE',
        method: s.method,
        amount: new D(s.amount.toString()).toFixed(scale),
        released: new D(b.released).plus(endAmount).toFixed(scale),
        remaining: remaining.toFixed(scale),
        startDate: fromDbDate(s.startDate),
        endDate: deferralEndDate(this.terms(s)),
        firstMonth: first,
        lastMonth: last,
        releasedThrough: Object.keys(p).sort().at(-1) ?? null,
        balanceAccount: acct(s.balanceAccountId),
        pnlAccount: acct(s.pnlAccountId),
      };
    });
    const total = (kind: DeferralKind) => schedules.filter((s) => s.kind === kind).reduce((t, s) => t.plus(s.remaining), new D(0)).toFixed(scale);
    return { schedules, totals: { prepaid: total('PREPAID_EXPENSE'), deferred: total('DEFERRED_REVENUE') }, can: this.can(org) };
  }

  async get(org: DeferralOrg, id: string) {
    const s = await this.prisma.deferralSchedule.findFirst({ where: { id, orgId: org.id } });
    if (!s) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Schedule not found' });
    const scale = minorUnits(org.functionalCurrency);
    const p = (await this.posted(this.prisma, org.id, [s.id])).get(s.id) ?? {};
    const t = this.terms(s);
    const { first, last } = deferralMonths(t);
    const lines = await this.prisma.deferralLine.findMany({ where: { orgId: org.id, scheduleId: s.id }, include: { run: true }, orderBy: { month: 'asc' } });
    const entry = await this.entries(org.id, [s.initialEntryId, s.endEntryId, ...lines.flatMap((l) => [l.run.journalEntryId, l.run.reversalEntryId])]);
    const names = await this.names([s.createdById, s.endedById, ...lines.map((l) => l.run.postedById)]);
    const accounts = await this.prisma.account.findMany({ where: { orgId: org.id, id: { in: [s.balanceAccountId, s.pnlAccountId] } }, select: { id: true, code: true, name: true } });
    const b = deferralBalance(s.amount.toString(), p, scale);
    const endAmount = s.endAmount ? new D(s.endAmount.toString()) : new D(0);
    const remaining = new D(b.remaining).minus(endAmount);
    return {
      id: s.id,
      kind: s.kind,
      reference: ref(s.kind, s.number),
      name: s.name,
      counterparty: s.counterparty,
      status: s.status === 'ENDED' ? 'ENDED' : remaining.lte(0) ? 'COMPLETED' : 'ACTIVE',
      method: s.method,
      amount: new D(s.amount.toString()).toFixed(scale),
      released: new D(b.released).plus(endAmount).toFixed(scale),
      remaining: remaining.toFixed(scale),
      startDate: t.startDate,
      months: s.months,
      endDate: deferralEndDate(t),
      firstMonth: first,
      lastMonth: last,
      accounts: { balance: accounts.find((a) => a.id === s.balanceAccountId) ?? null, pnl: accounts.find((a) => a.id === s.pnlAccountId) ?? null },
      termsFixed: lines.length > 0 || s.status === 'ENDED',
      initialEntry: entry(s.initialEntryId),
      end: s.status === 'ENDED' ? { date: fromDbDate(s.endedOn!), amount: endAmount.toFixed(scale), note: s.endNote, by: names.get(s.endedById!) ?? 'Former member', entry: entry(s.endEntryId) } : null,
      schedule: deferralSchedule(t, '9999-12', p, scale),
      postings: lines.map((l) => ({ month: l.month, amount: new D(l.amount.toString()).toFixed(scale), runMonth: l.run.month, runStatus: l.run.status, entry: entry(l.run.journalEntryId), reversal: entry(l.run.reversalEntryId), postedBy: names.get(l.run.postedById) ?? 'Former member' })),
      createdBy: names.get(s.createdById) ?? 'Former member',
      createdAt: s.createdAt.toISOString(),
      can: this.can(org),
    };
  }

  private validate(org: DeferralOrg, input: ScheduleInput) {
    const errors = checkDeferralTerms({ amount: input.amount, startDate: input.startDate, months: input.months, method: input.method }, minorUnits(org.functionalCurrency));
    if (!input.name.trim()) errors.push('Give the schedule a name');
    if (input.balanceAccountId === input.pnlAccountId) errors.push('The balance sheet account and the income statement account must differ');
    if (input.fundingDate && input.fundingDate > todayIst()) errors.push('The payment or receipt cannot be dated in the future');
    if (errors.length) this.invalid(errors);
  }

  async create(org: DeferralOrg, actor: Actor, input: ScheduleInput) {
    this.validate(org, input);
    const id = await this.prisma.$transaction(async (tx) => {
      await this.checkScheduleAccounts(tx, org.id, input);
      const number = await this.nextNumber(tx, org.id, input.kind === 'PREPAID_EXPENSE' ? 'prepaid' : 'deferred_revenue');
      const reference = ref(input.kind, number);
      let initialEntryId: string | null = null;
      if (input.fundingAccountId) {
        const prepaid = input.kind === 'PREPAID_EXPENSE';
        const je = await this.journals.postSystemEntry(tx, org, actor, {
          date: input.fundingDate || input.startDate,
          source: 'DEFERRAL',
          memo: `${prepaid ? 'Paid in advance' : 'Received in advance'}: ${input.name.trim()} (${reference})`,
          reference,
          lines: prepaid
            ? [
                { accountId: input.balanceAccountId, debit: input.amount, description: input.name.trim() },
                { accountId: input.fundingAccountId, credit: input.amount, description: input.name.trim() },
              ]
            : [
                { accountId: input.fundingAccountId, debit: input.amount, description: input.name.trim() },
                { accountId: input.balanceAccountId, credit: input.amount, description: input.name.trim() },
              ],
        });
        initialEntryId = je.id;
      }
      const s = await tx.deferralSchedule.create({
        data: {
          orgId: org.id,
          kind: input.kind,
          number,
          name: input.name.trim(),
          counterparty: input.counterparty?.trim() || null,
          balanceAccountId: input.balanceAccountId,
          pnlAccountId: input.pnlAccountId,
          amount: input.amount,
          startDate: toDbDate(input.startDate),
          months: input.months,
          method: input.method,
          initialEntryId,
          createdById: actor.id,
        },
      });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'deferral.created', entityType: 'deferral_schedule', entityId: s.id, data: { reference, kind: input.kind, amount: input.amount, startDate: input.startDate, months: input.months, method: input.method, initialEntryId } });
      return s.id;
    });
    return this.get(org, id);
  }

  /** Change a schedule. Its name and counterparty can always change; its terms only until a release is posted. */
  async update(org: DeferralOrg, actor: Actor, id: string, input: Omit<ScheduleInput, 'kind' | 'fundingAccountId' | 'fundingDate'>) {
    await this.prisma.$transaction(async (tx) => {
      const s = await this.lockSchedule(tx, org.id, id);
      if (s.status === 'ENDED') throw new DomainError('SCHEDULE_ENDED', 'An ended schedule cannot be changed', HttpStatus.CONFLICT);
      const termsChanged =
        !new D(input.amount).eq(s.amount.toString()) || input.startDate !== fromDbDate(s.startDate) || input.months !== s.months || input.method !== s.method || input.balanceAccountId !== s.balanceAccountId || input.pnlAccountId !== s.pnlAccountId;
      if (termsChanged) {
        const fromInvoice = await tx.invoiceLineRecognition.findFirst({ where: { orgId: org.id, scheduleId: id }, select: { documentId: true } });
        const invoiceNo = fromInvoice && (await tx.document.findUnique({ where: { id: fromInvoice.documentId }, select: { number: true } }))?.number;
        if (fromInvoice) throw new DomainError('SCHEDULE_TERMS_FIXED', `This schedule comes from invoice ${invoiceNo}, so its terms follow the invoice. Void the invoice and issue a new one to change them.`, HttpStatus.CONFLICT);
        if (await tx.deferralLine.count({ where: { orgId: org.id, scheduleId: id } })) throw new DomainError('SCHEDULE_TERMS_FIXED', 'A release has been posted for this schedule, so its amount, dates, accounts and method are fixed. Reverse the release runs first to change them.', HttpStatus.CONFLICT);
        if (s.initialEntryId && (!new D(input.amount).eq(s.amount.toString()) || input.balanceAccountId !== s.balanceAccountId)) throw new DomainError('SCHEDULE_TERMS_FIXED', 'The payment or receipt for this schedule was posted here, so its amount and balance sheet account are fixed', HttpStatus.CONFLICT);
        this.validate(org, { ...input, kind: s.kind });
        await this.checkScheduleAccounts(tx, org.id, { ...input, kind: s.kind });
      } else if (!input.name.trim()) this.invalid(['Give the schedule a name']);
      await tx.deferralSchedule.update({
        where: { id },
        data: {
          name: input.name.trim(),
          counterparty: input.counterparty?.trim() || null,
          ...(termsChanged ? { amount: input.amount, startDate: toDbDate(input.startDate), months: input.months, method: input.method, balanceAccountId: input.balanceAccountId, pnlAccountId: input.pnlAccountId } : {}),
        },
      });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'deferral.updated', entityType: 'deferral_schedule', entityId: id, data: { termsChanged, name: input.name.trim() } });
    });
    return this.get(org, id);
  }

  /** End a schedule early: whatever is left is released in one entry on the end date, to its own account or another (a refund, say). */
  async end(org: DeferralOrg, actor: Actor, id: string, input: EndInput) {
    if (input.date > todayIst()) this.invalid(['A schedule cannot be ended on a future date']);
    const scale = minorUnits(org.functionalCurrency);
    await this.prisma.$transaction(
      async (tx) => {
        await this.lockOrg(tx, org.id);
        const s = await this.lockSchedule(tx, org.id, id);
        if (s.status === 'ENDED') throw new DomainError('SCHEDULE_ENDED', 'This schedule has already ended', HttpStatus.CONFLICT);
        if (input.date < fromDbDate(s.startDate)) this.invalid(['A schedule cannot end before it starts']);
        const em = input.date.slice(0, 7);
        const p = (await this.posted(tx, org.id, [s.id])).get(s.id) ?? {};
        const later = Object.keys(p).filter((m) => m > em).sort();
        if (later.length) throw new DomainError('RELEASED_AFTER_END', `A release is posted for ${monthLabel(later[0]!)}, after the end date. Reverse the release run for ${monthLabel(later.at(-1)!)} first.`, HttpStatus.CONFLICT);
        const due = deferralSchedule({ ...this.terms(s), endedOn: input.date }, em, p, scale).filter((r) => !r.posted && new D(r.amount).gt(0));
        if (due.length) throw new DomainError('RELEASES_NOT_POSTED', `Post the releases through ${monthLabel(due.at(-1)!.month)} first, so the schedule ends at its right balance`, HttpStatus.CONFLICT);
        const target = input.accountId || s.pnlAccountId;
        if (target === s.balanceAccountId) this.invalid(['What is left cannot go back to the same account']);
        const acc = await this.account(tx, org.id, target);
        if (!acc || !acc.isPostable || !acc.isActive) this.invalid(['Choose an active posting account for what is left']);
        const remaining = new D(deferralBalance(s.amount.toString(), p, scale).remaining);
        const reference = ref(s.kind, s.number);
        let endEntryId: string | null = null;
        if (remaining.gt(0)) {
          const amt = remaining.toFixed(scale);
          const je = await this.journals.postSystemEntry(tx, org, actor, {
            date: input.date,
            source: 'DEFERRAL',
            memo: `Ended early: ${s.name} (${reference})${input.note ? `: ${input.note}` : ''}`,
            reference,
            lines: releaseLines(s.kind, amt).map((l) => ({ accountId: l.role === 'BALANCE' ? s.balanceAccountId : target, debit: l.debit, credit: l.credit, description: `${s.name}: ended early` })),
          });
          endEntryId = je.id;
        }
        await tx.deferralSchedule.update({ where: { id }, data: { status: 'ENDED', endedOn: toDbDate(input.date), endAmount: remaining.toFixed(scale), endEntryId, endNote: input.note?.trim() || null, endedById: actor.id } });
        await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'deferral.ended', entityType: 'deferral_schedule', entityId: id, data: { reference, date: input.date, amount: remaining.toFixed(scale), accountId: target, journalEntryId: endEntryId } });
      },
      { timeout: 30_000 },
    );
    return this.get(org, id);
  }

  // ------------------------------------------------------------------ releases

  /** What a run for `month` would post: each schedule's release for that month and any earlier month not yet posted. */
  private async workOut(db: Tx | PrismaService, org: DeferralOrg, month: string) {
    const rows = await db.deferralSchedule.findMany({ where: { orgId: org.id, status: 'ACTIVE' }, orderBy: [{ kind: 'asc' }, { number: 'asc' }] });
    const posted = await this.posted(db, org.id, rows.map((s) => s.id));
    const scale = minorUnits(org.functionalCurrency);
    const lines: { schedule: DeferralSchedule; month: string; amount: string }[] = [];
    for (const s of rows) {
      for (const r of deferralSchedule(this.terms(s), month, posted.get(s.id) ?? {}, scale)) if (!r.posted && new D(r.amount).gt(0)) lines.push({ schedule: s, month: r.month, amount: r.amount });
    }
    return lines;
  }

  /** Releases due through `month` that are not posted: for the month-end close checklist. */
  async dueThrough(db: Tx | PrismaService, org: DeferralOrg, month: string) {
    const lines = await this.workOut(db, org, month);
    return { schedules: new Set(lines.map((l) => l.schedule.id)).size, amount: lines.reduce((s, l) => s.plus(l.amount), new D(0)).toFixed(2) };
  }

  async releases(org: DeferralOrg, month?: string) {
    const runs = await this.prisma.deferralRun.findMany({ where: { orgId: org.id }, orderBy: [{ month: 'desc' }, { postedAt: 'desc' }], take: 60, include: { _count: { select: { lines: true } } } });
    const current = todayIst().slice(0, 7);
    const lastPosted = runs.find((r) => r.status === 'POSTED')?.month ?? null;
    let next: string | null;
    if (lastPosted) next = addMonth(lastPosted, 1);
    else {
      const active = await this.prisma.deferralSchedule.findMany({ where: { orgId: org.id, status: 'ACTIVE' }, select: { startDate: true } });
      next = active.length ? active.map((s) => fromDbDate(s.startDate).slice(0, 7)).sort()[0]! : null;
    }
    if (next && next > current) next = null;
    const target = month ?? next;
    const scale = minorUnits(org.functionalCurrency);
    const preview = target ? await this.workOut(this.prisma, org, target) : [];
    const entry = await this.entries(org.id, runs.flatMap((r) => [r.journalEntryId, r.reversalEntryId]));
    const names = await this.names(runs.flatMap((r) => [r.postedById, r.reversedById]));
    const period = target ? await this.prisma.fiscalPeriod.findFirst({ where: { orgId: org.id, startDate: { lte: toDbDate(monthEnd(target)) }, endDate: { gte: toDbDate(monthEnd(target)) } } }) : null;
    const sum = (kind: DeferralKind) => preview.filter((l) => l.schedule.kind === kind).reduce((s, l) => s.plus(l.amount), new D(0)).toFixed(scale);
    return {
      currentMonth: current,
      lastPosted,
      nextMonth: next,
      month: target,
      monthName: target ? monthLabel(target) : null,
      period: period ? { name: period.name, status: period.status } : null,
      alreadyPosted: target ? runs.some((r) => r.status === 'POSTED' && r.month === target) : false,
      preview: preview.map((l) => ({ scheduleId: l.schedule.id, kind: l.schedule.kind, reference: ref(l.schedule.kind, l.schedule.number), name: l.schedule.name, month: l.month, amount: l.amount, catchUp: l.month !== target })),
      previewTotals: { prepaid: sum('PREPAID_EXPENSE'), deferred: sum('DEFERRED_REVENUE'), total: preview.reduce((s, l) => s.plus(l.amount), new D(0)).toFixed(scale) },
      runs: runs.map((r) => ({
        id: r.id,
        month: r.month,
        monthName: monthLabel(r.month),
        status: r.status,
        total: new D(r.total.toString()).toFixed(scale),
        lines: r._count.lines,
        entry: entry(r.journalEntryId),
        reversal: entry(r.reversalEntryId),
        postedBy: names.get(r.postedById) ?? 'Former member',
        postedAt: r.postedAt.toISOString(),
        reversedBy: r.reversedById ? (names.get(r.reversedById) ?? 'Former member') : null,
        reversedAt: r.reversedAt?.toISOString() ?? null,
        canReverse: r.status === 'POSTED' && r.month === lastPosted,
      })),
      can: this.can(org),
    };
  }

  /** Post the month's releases as one journal on the last day of the month. */
  async run(org: DeferralOrg, actor: Actor, month: string) {
    if (month > todayIst().slice(0, 7)) throw new DomainError('MONTH_NOT_OVER', 'Releases can be posted for this month or earlier, not for a month still to come', HttpStatus.CONFLICT);
    await this.prisma.$transaction(
      async (tx) => {
        await this.lockOrg(tx, org.id);
        const last = await tx.deferralRun.findFirst({ where: { orgId: org.id, status: 'POSTED' }, orderBy: { month: 'desc' } });
        if (last && month <= last.month) throw new DomainError('MONTH_ALREADY_RUN', `Releases are posted through ${monthLabel(last.month)}. Post ${monthLabel(addMonth(last.month, 1))} next, or reverse ${monthLabel(last.month)} first.`, HttpStatus.CONFLICT);
        const lines = await this.workOut(tx, org, month);
        if (!lines.length) throw new DomainError('NOTHING_TO_RELEASE', `Nothing is due to be released for ${monthLabel(month)}`, HttpStatus.CONFLICT);
        const scale = minorUnits(org.functionalCurrency);
        const byAccount = new Map<string, { debit: InstanceType<typeof D>; credit: InstanceType<typeof D> }>();
        const add = (id: string, side: 'debit' | 'credit', amt: string) => {
          const e = byAccount.get(id) ?? { debit: new D(0), credit: new D(0) };
          e[side] = e[side].plus(amt);
          byAccount.set(id, e);
        };
        for (const l of lines) for (const r of releaseLines(l.schedule.kind, l.amount)) add(r.role === 'BALANCE' ? l.schedule.balanceAccountId : l.schedule.pnlAccountId, r.debit ? 'debit' : 'credit', (r.debit ?? r.credit)!);
        const total = lines.reduce((s, l) => s.plus(l.amount), new D(0));
        const count = new Set(lines.map((l) => l.schedule.id)).size;
        const je = await this.journals.postSystemEntry(tx, org, actor, {
          date: monthEnd(month),
          source: 'DEFERRAL',
          memo: `Prepaid and deferred revenue releases for ${monthLabel(month)} (${count} ${count === 1 ? 'schedule' : 'schedules'})`,
          reference: `REL-${month}`,
          lines: [...byAccount.entries()].flatMap(([accountId, v]) => [
            ...(v.debit.gt(0) ? [{ accountId, debit: v.debit.toFixed(scale), description: `Releases ${monthLabel(month)}` }] : []),
            ...(v.credit.gt(0) ? [{ accountId, credit: v.credit.toFixed(scale), description: `Releases ${monthLabel(month)}` }] : []),
          ]),
        });
        const run = await tx.deferralRun.create({ data: { orgId: org.id, month, total: total.toFixed(scale), journalEntryId: je.id, postedById: actor.id } });
        await tx.deferralLine.createMany({ data: lines.map((l) => ({ orgId: org.id, runId: run.id, scheduleId: l.schedule.id, month: l.month, amount: l.amount })) });
        await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'deferral.released', entityType: 'deferral_run', entityId: run.id, data: { month, total: total.toFixed(scale), schedules: count, lines: lines.length, journalEntryId: je.id, entryNumber: je.entryNumber } });
      },
      { timeout: 60_000 },
    );
    return this.releases(org);
  }

  /** Reverse the latest run (its journal is reversed on the same date). */
  async reverse(org: DeferralOrg, actor: Actor, runId: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.lockOrg(tx, org.id);
      const run = await tx.deferralRun.findFirst({ where: { id: runId, orgId: org.id } });
      if (!run) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Release run not found' });
      if (run.status !== 'POSTED') throw new DomainError('RUN_REVERSED', 'This run is already reversed', HttpStatus.CONFLICT);
      const last = await tx.deferralRun.findFirst({ where: { orgId: org.id, status: 'POSTED' }, orderBy: { month: 'desc' } });
      if (last!.id !== run.id) throw new DomainError('NOT_LATEST_RUN', `Reverse ${monthLabel(last!.month)} first: runs are reversed latest first`, HttpStatus.CONFLICT);
      const ended = await tx.deferralSchedule.findMany({ where: { orgId: org.id, status: 'ENDED', lines: { some: { runId } } }, select: { kind: true, number: true } });
      if (ended.length) throw new DomainError('SCHEDULE_ENDED', `${ref(ended[0]!.kind, ended[0]!.number)} in this run has ended, so the run stands`, HttpStatus.CONFLICT);
      const original = await tx.journalEntry.findFirstOrThrow({ where: { id: run.journalEntryId, orgId: org.id } });
      const rev = await this.journals.reverseSystemEntry(tx, org, actor, run.journalEntryId, { date: fromDbDate(original.date), memo: `Reversal of releases for ${monthLabel(run.month)}` });
      await tx.deferralRun.update({ where: { id: runId }, data: { status: 'REVERSED', reversalEntryId: rev.id, reversedById: actor.id, reversedAt: new Date() } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'deferral.release_reversed', entityType: 'deferral_run', entityId: runId, data: { month: run.month, reversalEntryId: rev.id, entryNumber: rev.entryNumber } });
    });
    return this.releases(org);
  }

  // ------------------------------------------------------------------ accruals

  async accruals(org: DeferralOrg, month?: string) {
    const rows = await this.prisma.accrual.findMany({ where: { orgId: org.id, ...(month ? { month } : {}) }, orderBy: [{ month: 'desc' }, { number: 'desc' }], take: 200 });
    const scale = minorUnits(org.functionalCurrency);
    const entry = await this.entries(org.id, rows.flatMap((a) => [a.entryId, a.reversalEntryId, a.cancelEntryId, a.cancelReversalEntryId]));
    const names = await this.names(rows.flatMap((a) => [a.createdById, a.cancelledById]));
    const accounts = await this.prisma.account.findMany({ where: { orgId: org.id, id: { in: [...new Set(rows.flatMap((a) => [a.pnlAccountId, a.balanceAccountId]))] } }, select: { id: true, code: true, name: true } });
    const acct = (id: string) => accounts.find((a) => a.id === id) ?? null;
    const items = rows.map((a) => ({
      id: a.id,
      reference: accrualRef(a.number),
      kind: a.kind,
      description: a.description,
      counterparty: a.counterparty,
      month: a.month,
      monthName: monthLabel(a.month),
      amount: new D(a.amount.toString()).toFixed(scale),
      pnlAccount: acct(a.pnlAccountId),
      balanceAccount: acct(a.balanceAccountId),
      status: a.status,
      entry: entry(a.entryId),
      reversal: entry(a.reversalEntryId),
      cancel: a.status === 'CANCELLED' ? { note: a.cancelNote, by: names.get(a.cancelledById!) ?? 'Former member', at: a.cancelledAt!.toISOString(), entry: entry(a.cancelEntryId), reversal: entry(a.cancelReversalEntryId) } : null,
      createdBy: names.get(a.createdById) ?? 'Former member',
      createdAt: a.createdAt.toISOString(),
    }));
    const live = items.filter((a) => a.status === 'POSTED');
    const sum = (k: 'EXPENSE' | 'INCOME') => live.filter((a) => a.kind === k).reduce((s, a) => s.plus(a.amount), new D(0)).toFixed(scale);
    return { accruals: items, totals: { expense: sum('EXPENSE'), income: sum('INCOME') }, can: this.can(org) };
  }

  /** Post an accrual on the last day of its month, and its reversal on the first day of the next. */
  async createAccrual(org: DeferralOrg, actor: Actor, input: AccrualInput) {
    const scale = minorUnits(org.functionalCurrency);
    const errors: string[] = [];
    const amount = new D(input.amount);
    if (amount.lte(0) || amount.decimalPlaces() > scale) errors.push(`The amount must be more than zero, with at most ${scale} decimal places`);
    if (!input.description.trim()) errors.push('Say what is being accrued');
    if (input.month > todayIst().slice(0, 7)) errors.push('An accrual can be for this month or an earlier one, not a month still to come');
    if (input.pnlAccountId === input.balanceAccountId) errors.push('The two accounts must differ');
    if (errors.length) this.invalid(errors, 'ACCRUAL_INVALID');
    const id = await this.prisma.$transaction(
      async (tx) => {
        const expense = input.kind === 'EXPENSE';
        const pnl = await this.account(tx, org.id, input.pnlAccountId);
        const bal = await this.account(tx, org.id, input.balanceAccountId);
        const errs: string[] = [];
        if (!pnl || !(expense ? RULES.expense : RULES.revenue)(pnl)) errs.push(expense ? 'Accrue an expense to an expense account (not depreciation)' : 'Accrue income to a revenue account');
        else if (!pnl.isPostable || !pnl.isActive) errs.push(`${pnl.code} ${pnl.name} is not an active posting account`);
        if (!bal || !(expense ? RULES.accruedLiability : RULES.accruedIncome)(bal)) errs.push(expense ? 'The accrued liability account must be an accrued or other current liability' : 'The accrued income account must be an other current asset');
        else if (!bal.isPostable || !bal.isActive) errs.push(`${bal.code} ${bal.name} is not an active posting account`);
        if (errs.length) this.invalid(errs, 'ACCRUAL_INVALID');
        const number = await this.nextNumber(tx, org.id, 'accrual');
        const reference = accrualRef(number);
        const amt = amount.toFixed(scale);
        const description = input.description.trim();
        const je = await this.journals.postSystemEntry(tx, org, actor, {
          date: monthEnd(input.month),
          source: 'ACCRUAL',
          memo: `Accrued ${expense ? 'expense' : 'income'} for ${monthLabel(input.month)}: ${description} (${reference})`,
          reference,
          lines: expense
            ? [
                { accountId: input.pnlAccountId, debit: amt, description },
                { accountId: input.balanceAccountId, credit: amt, description },
              ]
            : [
                { accountId: input.balanceAccountId, debit: amt, description },
                { accountId: input.pnlAccountId, credit: amt, description },
              ],
        });
        const rev = await this.journals.reverseSystemEntry(tx, org, actor, je.id, { date: firstOfNextMonth(input.month), memo: `Automatic reversal of ${reference}: ${description}` });
        const a = await tx.accrual.create({
          data: { orgId: org.id, kind: input.kind, number, description, counterparty: input.counterparty?.trim() || null, month: input.month, pnlAccountId: input.pnlAccountId, balanceAccountId: input.balanceAccountId, amount: amt, entryId: je.id, reversalEntryId: rev.id, createdById: actor.id },
        });
        await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'accrual.posted', entityType: 'accrual', entityId: a.id, data: { reference, kind: input.kind, month: input.month, amount: amt, entryNumber: je.entryNumber, reversalEntryNumber: rev.entryNumber } });
        return a.id;
      },
      { timeout: 30_000 },
    );
    return (await this.accruals(org)).accruals.find((a) => a.id === id)!;
  }

  /** Undo an accrual that was wrong: the opposite entry on its date, and the accrual again on its reversal's date, so both months come back to where they were. */
  async cancelAccrual(org: DeferralOrg, actor: Actor, id: string, note: string) {
    await this.prisma.$transaction(
      async (tx) => {
        await lockRow(tx, 'accruals', id, org.id);
        const a = await tx.accrual.findFirst({ where: { id, orgId: org.id } });
        if (!a) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Accrual not found' });
        if (a.status === 'CANCELLED') throw new DomainError('ACCRUAL_CANCELLED', 'This accrual is already cancelled', HttpStatus.CONFLICT);
        const reference = accrualRef(a.number);
        const lines = await tx.journalLine.findMany({ where: { orgId: org.id, entryId: a.entryId }, orderBy: { lineNo: 'asc' } });
        const flip = (l: (typeof lines)[number], opposite: boolean) => {
          const debit = new D(l.debit.toString());
          const credit = new D(l.credit.toString());
          const [d, c] = opposite ? [credit, debit] : [debit, credit];
          return { accountId: l.accountId, ...(d.gt(0) ? { debit: d.toFixed() } : { credit: c.toFixed() }), description: l.description ?? a.description };
        };
        const undo = await this.journals.postSystemEntry(tx, org, actor, { date: monthEnd(a.month), source: 'ACCRUAL', memo: `Cancellation of ${reference}: ${a.description}`, reference, lines: lines.map((l) => flip(l, true)) });
        const redo = await this.journals.postSystemEntry(tx, org, actor, { date: firstOfNextMonth(a.month), source: 'ACCRUAL', memo: `Cancellation of the reversal of ${reference}: ${a.description}`, reference, lines: lines.map((l) => flip(l, false)) });
        await tx.accrual.update({ where: { id }, data: { status: 'CANCELLED', cancelNote: note.trim(), cancelledById: actor.id, cancelledAt: new Date(), cancelEntryId: undo.id, cancelReversalEntryId: redo.id } });
        await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'accrual.cancelled', entityType: 'accrual', entityId: id, data: { reference, note: note.trim(), entryNumbers: [undo.entryNumber, redo.entryNumber] } });
      },
      { timeout: 30_000 },
    );
    return (await this.accruals(org)).accruals.find((a) => a.id === id)!;
  }

  // ------------------------------------------------------------------ accounts

  /** Accounts the forms offer, by role. */
  async accounts(org: DeferralOrg) {
    const rows = (await this.prisma.account.findMany({ where: { orgId: org.id, isPostable: true, isActive: true }, orderBy: { code: 'asc' }, select: { id: true, code: true, name: true, type: true, subtype: true, isPostable: true, isActive: true } })) as Acc[];
    const control = await this.controlIds(this.prisma, org.id);
    const pick = (ok: (a: Acc) => boolean) => rows.filter(ok).map(({ id, code, name }) => ({ id, code, name }));
    return {
      prepaid: pick(RULES.prepaidBalance),
      deferred: pick(RULES.deferredBalance),
      expense: pick(RULES.expense),
      revenue: pick(RULES.revenue),
      accruedLiability: pick(RULES.accruedLiability),
      accruedIncome: pick(RULES.accruedIncome),
      funding: pick((a) => ['ASSET', 'LIABILITY', 'EQUITY'].includes(a.type) && !control.has(a.id) && !['FIXED_ASSET', 'ACCUMULATED_DEPRECIATION', 'PREPAID'].includes(a.subtype ?? '')),
      any: pick(() => true),
    };
  }
}

