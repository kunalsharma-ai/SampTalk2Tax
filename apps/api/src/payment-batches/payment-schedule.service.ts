import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { dec, minorUnits, planIssues, planTiming, scheduleWeeks, suggestPayDate } from '@talk2tax/accounting-engine';
import { hasPermission, RoleName } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { BankingService } from '../banking/banking.service';
import { fromDbDate, toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { todayIst } from '../tasks/tasks.service';
import { PaymentBatchesService } from './payment-batches.service';

type Actor = { id: string };
export interface ScheduleOrg {
  id: string;
  role: RoleName;
  functionalCurrency: string;
}

/**
 * Payment scheduling (AP-007): the date each open bill is planned to be paid, and the planned
 * payments week by week against the cash in the bank accounts. A plan moves no money; a payment
 * batch is prepared from the bills planned up to a date, and the bank pays it.
 */
@Injectable()
export class PaymentScheduleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly batches: PaymentBatchesService,
    private readonly banking: BankingService,
  ) {}

  async get(org: ScheduleOrg, opts: { weeks?: number; payWeekday?: number | null } = {}) {
    const today = todayIst();
    const c = org.functionalCurrency;
    const scale = minorUnits(c);
    const weeks = opts.weeks ?? 8;
    const bills = await this.batches.payableBills(org);
    const plans = bills.length ? await this.prisma.billPaymentPlan.findMany({ where: { orgId: org.id, documentId: { in: bills.map((b) => b.id) } } }) : [];
    const byDoc = new Map(plans.map((p) => [p.documentId, p]));
    const users = await this.names(plans.map((p) => p.updatedById));
    const rows = bills.map((b) => {
      const p = byDoc.get(b.id);
      const dueDate = b.dueDate ?? b.issueDate;
      // A plan made before part of the bill was paid pays at most what is left.
      const planned = p ? (p.amount && dec(p.amount.toFixed()).lt(dec(b.due)) ? dec(p.amount.toFixed()).toFixed(scale) : b.due) : null;
      return {
        ...b,
        dueDate,
        plan: p
          ? {
              payDate: fromDbDate(p.payDate),
              amount: planned!,
              partial: planned !== b.due,
              note: p.note,
              timing: planTiming(fromDbDate(p.payDate), dueDate, today),
              late: fromDbDate(p.payDate) > dueDate,
              missed: fromDbDate(p.payDate) < today,
              by: users.get(p.updatedById) ?? 'A member',
              at: p.updatedAt.toISOString(),
            }
          : null,
        suggested: suggestPayDate(dueDate, today, opts.payWeekday),
        overdue: dueDate < today,
      };
    });
    rows.sort((a, b) => (a.plan?.payDate ?? '9999').localeCompare(b.plan?.payDate ?? '9999') || a.dueDate.localeCompare(b.dueDate));
    const accounts = (await this.banking.listAccounts(org)).filter((a) => a.isActive);
    const cash = accounts.reduce((s, a) => s.plus(dec(a.ledgerBalance)), dec('0'));
    const plannedRows = rows.filter((r) => r.plan);
    const sum = (xs: string[]) => xs.reduce((s, x) => s.plus(dec(x)), dec('0')).toFixed(scale);
    return {
      today,
      currency: c,
      bills: rows,
      cash: { total: cash.toFixed(scale), accounts: accounts.map((a) => ({ id: a.id, code: a.code, name: a.name, balance: a.ledgerBalance })) },
      weeks: scheduleWeeks(plannedRows.map((r) => ({ payDate: r.plan!.payDate, amount: r.plan!.amount })), cash.toFixed(scale), today, weeks, c),
      totals: {
        open: sum(rows.map((r) => r.due)),
        planned: sum(plannedRows.map((r) => r.plan!.amount)),
        unplanned: rows.filter((r) => !r.plan).length,
        overdueUnplanned: rows.filter((r) => !r.plan && r.overdue).length,
        late: plannedRows.filter((r) => r.plan!.late).length,
        missed: plannedRows.filter((r) => r.plan!.missed).length,
      },
      can: { plan: hasPermission(org.role, 'purchases.manage'), prepareBatch: hasPermission(org.role, 'purchases.manage') },
    };
  }

  /** Plan (or re-plan) one bill's payment. */
  async plan(org: ScheduleOrg, actor: Actor, documentId: string, input: { payDate: string; amount?: string | null; note?: string | null }) {
    const bill = (await this.batches.payableBills(org)).find((b) => b.id === documentId);
    if (!bill) {
      const exists = await this.prisma.document.findFirst({ where: { id: documentId, orgId: org.id, kind: 'BILL' }, select: { status: true, currency: true } });
      if (!exists) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Bill not found' });
      throw new DomainError('NOT_PAYABLE', exists.status !== 'POSTED' ? 'Only a posted bill can be planned for payment' : exists.currency !== org.functionalCurrency ? `Only bills in ${org.functionalCurrency} can be planned for now` : 'This bill has nothing left to pay', HttpStatus.CONFLICT);
    }
    const issues = planIssues({ payDate: input.payDate, amount: input.amount, issueDate: bill.issueDate, due: bill.due, currency: bill.currency, today: todayIst() });
    if (issues.length) throw new DomainError('PLAN_INVALID', issues[0]!, HttpStatus.UNPROCESSABLE_ENTITY, { issues });
    const amount = input.amount ? dec(input.amount).toFixed() : null;
    await this.prisma.$transaction(async (tx) => {
      const data = { payDate: toDbDate(input.payDate), amount, note: input.note?.trim() || null, updatedById: actor.id };
      await tx.billPaymentPlan.upsert({ where: { documentId }, create: { ...data, orgId: org.id, documentId }, update: data });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'bill_payment.planned', entityType: 'document', entityId: documentId, data: { number: bill.number, payDate: input.payDate, amount } });
    });
    return this.get(org);
  }

  async unplan(org: ScheduleOrg, actor: Actor, documentId: string) {
    await this.prisma.$transaction(async (tx) => {
      const p = await tx.billPaymentPlan.findFirst({ where: { documentId, orgId: org.id } });
      if (!p) throw new NotFoundException({ error: 'NOT_FOUND', message: 'This bill has no payment plan' });
      await tx.billPaymentPlan.delete({ where: { id: p.id } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'bill_payment.unplanned', entityType: 'document', entityId: documentId, data: { payDate: fromDbDate(p.payDate) } });
    });
    return this.get(org);
  }

  /**
   * Plan every open bill that has no plan (or only `documentIds`) for its suggested date: its due
   * date, or the last pay day before it when `payWeekday` is given, never before today.
   */
  async autoPlan(org: ScheduleOrg, actor: Actor, input: { payWeekday?: number | null; documentIds?: string[] }) {
    const today = todayIst();
    const bills = await this.batches.payableBills(org);
    const planned = new Set((await this.prisma.billPaymentPlan.findMany({ where: { orgId: org.id, documentId: { in: bills.map((b) => b.id) } }, select: { documentId: true } })).map((p) => p.documentId));
    const want = input.documentIds ? new Set(input.documentIds) : null;
    const todo = bills.filter((b) => !planned.has(b.id) && (!want || want.has(b.id)));
    await this.prisma.$transaction(async (tx) => {
      for (const b of todo) {
        const payDate = suggestPayDate(b.dueDate ?? b.issueDate, today, input.payWeekday);
        await tx.billPaymentPlan.create({ data: { orgId: org.id, documentId: b.id, payDate: toDbDate(payDate < b.issueDate ? b.issueDate : payDate), updatedById: actor.id } });
      }
      if (todo.length) await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'bill_payment.auto_planned', entityType: 'organization', entityId: org.id, data: { bills: todo.length, payWeekday: input.payWeekday ?? null } });
    });
    return { planned: todo.length, schedule: await this.get(org, { payWeekday: input.payWeekday }) };
  }

  private async names(ids: string[]) {
    const list = [...new Set(ids)];
    const users = list.length ? await this.prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true, email: true } }) : [];
    return new Map(users.map((u) => [u.id, u.name || u.email]));
  }
}
