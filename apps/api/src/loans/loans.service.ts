import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import {
  checkLoanTerms,
  D,
  LoanError,
  loanInstallment,
  loanMaturity,
  loanTotals,
  minorUnits,
  projectLoan,
  type LoanMethod,
  type LoanRow,
} from '@talk2tax/accounting-engine';
import { Loan, LoanEvent, Prisma } from '@talk2tax/database';
import { hasPermission, RoleName } from '@talk2tax/security';
import { AuditService } from '../audit/audit.service';
import { fromDbDate, toDbDate } from '../common/dates';
import { DomainError } from '../common/errors';
import { DocumentStoreService } from '../common/document-store.service';
import { lineSums, postedBetween } from '../db/ledger-queries';
import { byCode } from '../db/subledger-queries';
import { PrismaService, Tx } from '../common/prisma.service';
import { JournalsService } from '../journals/journals.service';
import { addDays, todayIst } from '../tasks/tasks.service';
import { nextCounter } from '../db/counters';

export interface LoanOrg {
  id: string;
  role: RoleName;
  functionalCurrency: string;
  fiscalYearStartMonth: number;
}
type Actor = { id: string };

export interface LoanInput {
  name: string;
  lender?: string | null;
  accountNumber?: string | null;
  method: LoanMethod;
  principal: string;
  annualRate: string;
  months: number;
  disbursementDate: string;
  firstDueDate: string;
  liabilityAccountId: string;
  interestAccountId: string;
  bankAccountId: string;
  /** Post the money received (debit the bank, credit the loan). Off for a loan already in the books. */
  recordDisbursement: boolean;
  notes?: string | null;
}

export interface LoanUpdate {
  name: string;
  lender?: string | null;
  accountNumber?: string | null;
  bankAccountId: string;
  notes?: string | null;
}

export interface RepaymentInput {
  date: string;
  bankAccountId?: string | null;
  /** Defaults to the scheduled split; give both to record what the lender actually charged. */
  principal?: string | null;
  interest?: string | null;
  note?: string | null;
}

export interface PrepaymentInput {
  date: string;
  amount: string;
  mode: 'REDUCE_TENURE' | 'REDUCE_INSTALLMENT';
  charges?: string | null;
  chargesAccountId?: string | null;
  bankAccountId?: string | null;
  note?: string | null;
}

export interface RateChangeInput {
  date: string;
  annualRate: string;
  mode: 'KEEP_INSTALLMENT' | 'KEEP_TENURE';
  note?: string | null;
}

type Acc = { id: string; code: string; name: string; type: string; subtype: string | null; isPostable: boolean; isActive: boolean };

const ref = (n: number) => `LN-${String(n).padStart(4, '0')}`;
const RATE = /^\d{1,2}(\.\d{1,4})?$/;

/** Which accounts fit each role. */
const RULES = {
  liability: (a: Acc) => a.type === 'LIABILITY' && ['LONG_TERM_DEBT', 'OTHER_NON_CURRENT_LIABILITY', 'OTHER_CURRENT_LIABILITY'].includes(a.subtype ?? ''),
  expense: (a: Acc) => a.type === 'EXPENSE' && a.subtype !== 'DEPRECIATION',
  bank: (a: Acc) => a.type === 'ASSET' && ['BANK', 'CASH'].includes(a.subtype ?? ''),
};

/** A loan's position now, worked out from its posted events. */
interface LoanState {
  balance: InstanceType<typeof D>;
  paidCount: number;
  rows: LoanRow[];
  posted: LoanEvent[];
}

@Injectable()
export class LoansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly journals: JournalsService,
    private readonly audit: AuditService,
    private readonly store: DocumentStoreService,
  ) {}

  private invalid(errors: string[], code = 'LOAN_INVALID'): never {
    throw new DomainError(code, errors[0]!, HttpStatus.UNPROCESSABLE_ENTITY, { errors });
  }

  private scale(org: LoanOrg) {
    return minorUnits(org.functionalCurrency);
  }

  private can(org: LoanOrg) {
    return { manage: hasPermission(org.role, 'loans.manage') };
  }

  private async account(db: Tx | PrismaService, orgId: string, id: string | null | undefined): Promise<Acc | null> {
    if (!id) return null;
    return db.account.findFirst({ where: { orgId, id }, select: { id: true, code: true, name: true, type: true, subtype: true, isPostable: true, isActive: true } });
  }

  private async checkAccount(db: Tx | PrismaService, orgId: string, id: string | null | undefined, ok: (a: Acc) => boolean, label: string, errors: string[]) {
    const a = await this.account(db, orgId, id);
    if (!a || !ok(a)) errors.push(label);
    else if (!a.isPostable || !a.isActive) errors.push(`${a.code} ${a.name} is not an active posting account`);
  }

  private async nextNumber(tx: Tx, orgId: string) {
    const [{ value }] = [{ value: await nextCounter(tx, orgId, 'loan') }];
    return value;
  }

  private async lockLoan(tx: Tx, orgId: string, id: string) {
    await tx.$queryRaw`SELECT id FROM loans WHERE id = ${id}::uuid AND org_id = ${orgId}::uuid FOR UPDATE`;
    const loan = await tx.loan.findFirst({ where: { id, orgId } });
    if (!loan) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Loan not found' });
    return loan;
  }

  /** Where a loan stands: the balance, installments paid and the rows still to pay. */
  private state(loan: Loan, events: LoanEvent[], scale: number): LoanState {
    const posted = events.filter((e) => e.status === 'POSTED').sort((a, b) => a.seq - b.seq);
    const balance = posted.reduce((b, e) => b.minus(e.principal.toString()), new D(loan.principal.toString()));
    const paidCount = posted.filter((e) => e.kind === 'REPAYMENT').length;
    const rows =
      loan.status === 'ACTIVE' && balance.gt(0)
        ? projectLoan({
            balance: balance.toFixed(scale),
            annualRate: new D(loan.annualRate.toString()).toFixed(),
            method: loan.method,
            installment: new D(loan.installment.toString()).toFixed(),
            startNo: paidCount + 1,
            firstDueDate: fromDbDate(loan.firstDueDate),
            lastNo: loan.lastNo,
            scale,
          })
        : [];
    return { balance, paidCount, rows, posted };
  }

  /** How many installments are left: to the fixed last one, or as many as the projection runs. */
  private remainingCount(loan: Loan, s: LoanState) {
    return loan.lastNo != null ? Math.max(loan.lastNo - s.paidCount, 1) : Math.max(s.rows.length, 1);
  }

  private project(input: Parameters<typeof projectLoan>[0]) {
    try {
      return projectLoan(input);
    } catch (e) {
      if (e instanceof LoanError) this.invalid([e.message]);
      throw e;
    }
  }

  private async lastEventDate(tx: Tx, loan: Loan) {
    const last = await tx.loanEvent.findFirst({ where: { loanId: loan.id, status: 'POSTED' }, orderBy: { seq: 'desc' } });
    return last ? fromDbDate(last.date) : fromDbDate(loan.disbursementDate);
  }

  private async nextSeq(tx: Tx, loanId: string) {
    const last = await tx.loanEvent.findFirst({ where: { loanId }, orderBy: { seq: 'desc' }, select: { seq: true } });
    return (last?.seq ?? 0) + 1;
  }

  private async checkOrder(tx: Tx, loan: Loan, date: string) {
    const after = await this.lastEventDate(tx, loan);
    if (date < after) this.invalid([`Use a date on or after ${after}: the loan's last entry is dated then`], 'LOAN_DATE');
    if (date > todayIst()) this.invalid(['The date cannot be in the future'], 'LOAN_DATE');
  }

  private amount(v: string | null | undefined, label: string) {
    if (v == null || v === '') return null;
    if (!/^\d{1,15}(\.\d{1,6})?$/.test(v)) this.invalid([`${label} must be an amount like 12500.00`]);
    return new D(v);
  }

  // ------------------------------------------------------------------ loans

  async create(org: LoanOrg, actor: Actor, input: LoanInput) {
    const errors = checkLoanTerms(input);
    if (!input.name.trim()) errors.unshift('Give the loan a name');
    if (input.recordDisbursement && input.disbursementDate > todayIst()) errors.push('The loan cannot be received in the future');
    if (errors.length) this.invalid(errors);
    const scale = this.scale(org);
    const principal = new D(input.principal).toDecimalPlaces(scale);
    if (!principal.eq(input.principal)) this.invalid([`Give the amount to ${scale} decimal places`]);
    const installment = loanInstallment(input.method, input.principal, input.annualRate, input.months, scale);
    // The schedule must work out: an EMI always covers its interest, but check anyway.
    this.project({ balance: principal.toFixed(scale), annualRate: input.annualRate, method: input.method, installment: installment.toFixed(scale), startNo: 1, firstDueDate: input.firstDueDate, lastNo: input.months, scale });
    const id = await this.prisma.$transaction(async (tx) => {
      const acc: string[] = [];
      await this.checkAccount(tx, org.id, input.liabilityAccountId, RULES.liability, 'The loan account must be a long-term debt or other liability account', acc);
      await this.checkAccount(tx, org.id, input.interestAccountId, RULES.expense, 'Interest goes to an expense account', acc);
      await this.checkAccount(tx, org.id, input.bankAccountId, RULES.bank, 'Installments are paid from a bank or cash account', acc);
      if (acc.length) this.invalid(acc);
      const number = await this.nextNumber(tx, org.id);
      const reference = ref(number);
      let disbursementEntryId: string | null = null;
      if (input.recordDisbursement) {
        const je = await this.journals.postSystemEntry(tx, org, actor, {
          date: input.disbursementDate,
          source: 'LOAN',
          memo: `Loan received: ${input.name.trim()} (${reference})`,
          reference,
          lines: [
            { accountId: input.bankAccountId, debit: principal.toFixed(scale), description: input.name.trim() },
            { accountId: input.liabilityAccountId, credit: principal.toFixed(scale), description: input.name.trim() },
          ],
        });
        disbursementEntryId = je.id;
      }
      const loan = await tx.loan.create({
        data: {
          orgId: org.id,
          number,
          name: input.name.trim(),
          lender: input.lender?.trim() || null,
          accountNumber: input.accountNumber?.trim() || null,
          method: input.method,
          principal: principal.toFixed(scale),
          originalRate: input.annualRate,
          months: input.months,
          disbursementDate: toDbDate(input.disbursementDate),
          firstDueDate: toDbDate(input.firstDueDate),
          liabilityAccountId: input.liabilityAccountId,
          interestAccountId: input.interestAccountId,
          bankAccountId: input.bankAccountId,
          disbursementEntryId,
          annualRate: input.annualRate,
          installment: installment.toFixed(scale),
          lastNo: input.months,
          notes: input.notes?.trim() || null,
          createdById: actor.id,
        },
      });
      await this.audit.append(tx, {
        orgId: org.id,
        actorId: actor.id,
        action: 'loan.created',
        entityType: 'loan',
        entityId: loan.id,
        data: { reference, principal: principal.toFixed(scale), annualRate: input.annualRate, months: input.months, method: input.method, installment: installment.toFixed(scale), disbursementEntryId },
      });
      return loan.id;
    });
    return this.get(org, id);
  }

  async update(org: LoanOrg, actor: Actor, id: string, input: LoanUpdate) {
    if (!input.name.trim()) this.invalid(['Give the loan a name']);
    await this.prisma.$transaction(async (tx) => {
      const loan = await this.lockLoan(tx, org.id, id);
      const errors: string[] = [];
      await this.checkAccount(tx, org.id, input.bankAccountId, RULES.bank, 'Installments are paid from a bank or cash account', errors);
      if (errors.length) this.invalid(errors);
      if (input.bankAccountId === loan.liabilityAccountId) this.invalid(['Installments are paid from a bank or cash account']);
      await tx.loan.update({ where: { id }, data: { name: input.name.trim(), lender: input.lender?.trim() || null, accountNumber: input.accountNumber?.trim() || null, bankAccountId: input.bankAccountId, notes: input.notes?.trim() || null } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'loan.updated', entityType: 'loan', entityId: id, data: { name: input.name.trim(), bankAccountId: input.bankAccountId } });
    });
    return this.get(org, id);
  }

  // ------------------------------------------------------------------ events

  async repay(org: LoanOrg, actor: Actor, id: string, input: RepaymentInput) {
    const scale = this.scale(org);
    await this.prisma.$transaction(async (tx) => {
      const loan = await this.lockLoan(tx, org.id, id);
      if (loan.status === 'CLOSED') this.invalid(['This loan is repaid and closed'], 'LOAN_CLOSED');
      const events = await tx.loanEvent.findMany({ where: { loanId: id } });
      const s = this.state(loan, events, scale);
      const row = s.rows[0];
      if (!row) this.invalid(['Nothing is left to repay'], 'LOAN_CLOSED');
      await this.checkOrder(tx, loan, input.date);
      const givenP = this.amount(input.principal, 'The principal');
      const givenI = this.amount(input.interest, 'The interest');
      if ((givenP === null) !== (givenI === null)) this.invalid(['Give both the principal and the interest, or neither to use the schedule']);
      const principal = (givenP ?? new D(row.principal)).toDecimalPlaces(scale);
      const interest = (givenI ?? new D(row.interest)).toDecimalPlaces(scale);
      if (principal.gt(s.balance)) this.invalid([`The principal cannot be more than the ${s.balance.toFixed(scale)} owed`]);
      if (!principal.plus(interest).gt(0)) this.invalid(['The installment must be more than zero']);
      const bankId = input.bankAccountId || loan.bankAccountId;
      const errors: string[] = [];
      await this.checkAccount(tx, org.id, bankId, RULES.bank, 'Pay installments from a bank or cash account', errors);
      if (errors.length) this.invalid(errors);
      const reference = ref(loan.number);
      const total = principal.plus(interest);
      const lines = [
        ...(principal.gt(0) ? [{ accountId: loan.liabilityAccountId, debit: principal.toFixed(scale), description: `Principal, installment ${row.no}` }] : []),
        ...(interest.gt(0) ? [{ accountId: loan.interestAccountId, debit: interest.toFixed(scale), description: `Interest, installment ${row.no}` }] : []),
        { accountId: bankId, credit: total.toFixed(scale), description: `${loan.name}, installment ${row.no}` },
      ];
      const je = await this.journals.postSystemEntry(tx, org, actor, { date: input.date, source: 'LOAN', memo: `Installment ${row.no} of ${reference}: ${loan.name}`, reference, lines });
      const after = s.balance.minus(principal);
      const closed = after.isZero();
      await tx.loanEvent.create({
        data: {
          orgId: org.id,
          loanId: id,
          seq: await this.nextSeq(tx, id),
          kind: 'REPAYMENT',
          date: toDbDate(input.date),
          installmentNo: row.no,
          principal: principal.toFixed(scale),
          interest: interest.toFixed(scale),
          bankAccountId: bankId,
          entryId: je.id,
          balanceBefore: s.balance.toFixed(scale),
          balanceAfter: after.toFixed(scale),
          rateBefore: loan.annualRate,
          rateAfter: loan.annualRate,
          installmentBefore: loan.installment,
          installmentAfter: loan.installment,
          lastNoBefore: loan.lastNo,
          lastNoAfter: loan.lastNo,
          note: input.note?.trim() || null,
          createdById: actor.id,
        },
      });
      if (closed) await tx.loan.update({ where: { id }, data: { status: 'CLOSED', closedOn: toDbDate(input.date) } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'loan.repaid', entityType: 'loan', entityId: id, data: { reference, installment: row.no, date: input.date, principal: principal.toFixed(scale), interest: interest.toFixed(scale), entryNumber: je.entryNumber, closed } });
    });
    return this.get(org, id);
  }

  async prepay(org: LoanOrg, actor: Actor, id: string, input: PrepaymentInput) {
    const scale = this.scale(org);
    await this.prisma.$transaction(async (tx) => {
      const loan = await this.lockLoan(tx, org.id, id);
      if (loan.status === 'CLOSED') this.invalid(['This loan is repaid and closed'], 'LOAN_CLOSED');
      const events = await tx.loanEvent.findMany({ where: { loanId: id } });
      const s = this.state(loan, events, scale);
      await this.checkOrder(tx, loan, input.date);
      const amount = this.amount(input.amount, 'The prepayment')!.toDecimalPlaces(scale);
      const charges = (this.amount(input.charges, 'The charges') ?? new D(0)).toDecimalPlaces(scale);
      if (!amount.gt(0)) this.invalid(['The prepayment must be more than zero']);
      if (amount.gt(s.balance)) this.invalid([`The prepayment cannot be more than the ${s.balance.toFixed(scale)} owed`]);
      const bankId = input.bankAccountId || loan.bankAccountId;
      const chargesId = charges.gt(0) ? input.chargesAccountId || loan.interestAccountId : null;
      const errors: string[] = [];
      await this.checkAccount(tx, org.id, bankId, RULES.bank, 'Pay from a bank or cash account', errors);
      if (chargesId) await this.checkAccount(tx, org.id, chargesId, RULES.expense, 'Prepayment charges go to an expense account', errors);
      if (errors.length) this.invalid(errors);
      const after = s.balance.minus(amount);
      const closed = after.isZero();
      let installment = new D(loan.installment.toString());
      let lastNo = loan.lastNo;
      if (!closed) {
        if (input.mode === 'REDUCE_TENURE') {
          lastNo = null;
        } else {
          const n = this.remainingCount(loan, s);
          installment = loanInstallment(loan.method, after, loan.annualRate.toString(), n, scale);
          lastNo = s.paidCount + n;
        }
        this.project({ balance: after.toFixed(scale), annualRate: loan.annualRate.toString(), method: loan.method, installment: installment.toFixed(scale), startNo: s.paidCount + 1, firstDueDate: fromDbDate(loan.firstDueDate), lastNo, scale });
      }
      const reference = ref(loan.number);
      const lines = [
        { accountId: loan.liabilityAccountId, debit: amount.toFixed(scale), description: 'Prepayment of principal' },
        ...(charges.gt(0) ? [{ accountId: chargesId!, debit: charges.toFixed(scale), description: 'Prepayment charges' }] : []),
        { accountId: bankId, credit: amount.plus(charges).toFixed(scale), description: `${loan.name}, prepayment` },
      ];
      const je = await this.journals.postSystemEntry(tx, org, actor, { date: input.date, source: 'LOAN', memo: `${closed ? 'Loan closed' : 'Prepayment'}: ${reference} ${loan.name}`, reference, lines });
      await tx.loanEvent.create({
        data: {
          orgId: org.id,
          loanId: id,
          seq: await this.nextSeq(tx, id),
          kind: 'PREPAYMENT',
          date: toDbDate(input.date),
          principal: amount.toFixed(scale),
          charges: charges.toFixed(scale),
          bankAccountId: bankId,
          chargesAccountId: chargesId,
          entryId: je.id,
          mode: input.mode,
          balanceBefore: s.balance.toFixed(scale),
          balanceAfter: after.toFixed(scale),
          rateBefore: loan.annualRate,
          rateAfter: loan.annualRate,
          installmentBefore: loan.installment,
          installmentAfter: installment.toFixed(scale),
          lastNoBefore: loan.lastNo,
          lastNoAfter: lastNo,
          note: input.note?.trim() || null,
          createdById: actor.id,
        },
      });
      await tx.loan.update({ where: { id }, data: { installment: installment.toFixed(scale), lastNo, ...(closed ? { status: 'CLOSED' as const, closedOn: toDbDate(input.date) } : {}) } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'loan.prepaid', entityType: 'loan', entityId: id, data: { reference, date: input.date, amount: amount.toFixed(scale), charges: charges.toFixed(scale), mode: input.mode, installment: installment.toFixed(scale), lastNo, entryNumber: je.entryNumber, closed } });
    });
    return this.get(org, id);
  }

  async changeRate(org: LoanOrg, actor: Actor, id: string, input: RateChangeInput) {
    if (!RATE.test(input.annualRate)) this.invalid(['Give the annual interest rate as a percentage below 100, up to 4 decimal places']);
    const scale = this.scale(org);
    await this.prisma.$transaction(async (tx) => {
      const loan = await this.lockLoan(tx, org.id, id);
      if (loan.status === 'CLOSED') this.invalid(['This loan is repaid and closed'], 'LOAN_CLOSED');
      if (new D(loan.annualRate.toString()).eq(input.annualRate)) this.invalid([`The rate is already ${input.annualRate}%`]);
      const events = await tx.loanEvent.findMany({ where: { loanId: id } });
      const s = this.state(loan, events, scale);
      await this.checkOrder(tx, loan, input.date);
      let installment = new D(loan.installment.toString());
      let lastNo = loan.lastNo;
      if (input.mode === 'KEEP_TENURE') {
        const n = this.remainingCount(loan, s);
        installment = loanInstallment(loan.method, s.balance, input.annualRate, n, scale);
        lastNo = s.paidCount + n;
      } else if (loan.method === 'EMI') {
        lastNo = null;
      }
      this.project({ balance: s.balance.toFixed(scale), annualRate: input.annualRate, method: loan.method, installment: installment.toFixed(scale), startNo: s.paidCount + 1, firstDueDate: fromDbDate(loan.firstDueDate), lastNo, scale });
      await tx.loanEvent.create({
        data: {
          orgId: org.id,
          loanId: id,
          seq: await this.nextSeq(tx, id),
          kind: 'RATE_CHANGE',
          date: toDbDate(input.date),
          mode: input.mode,
          balanceBefore: s.balance.toFixed(scale),
          balanceAfter: s.balance.toFixed(scale),
          rateBefore: loan.annualRate,
          rateAfter: input.annualRate,
          installmentBefore: loan.installment,
          installmentAfter: installment.toFixed(scale),
          lastNoBefore: loan.lastNo,
          lastNoAfter: lastNo,
          note: input.note?.trim() || null,
          createdById: actor.id,
        },
      });
      await tx.loan.update({ where: { id }, data: { annualRate: input.annualRate, installment: installment.toFixed(scale), lastNo } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'loan.rate_changed', entityType: 'loan', entityId: id, data: { reference: ref(loan.number), date: input.date, from: loan.annualRate.toString(), to: input.annualRate, mode: input.mode, installment: installment.toFixed(scale), lastNo } });
    });
    return this.get(org, id);
  }

  /** Undo the latest repayment, prepayment or rate change: its journal is reversed and the terms go back. */
  async reverseEvent(org: LoanOrg, actor: Actor, id: string, eventId: string) {
    await this.prisma.$transaction(async (tx) => {
      const loan = await this.lockLoan(tx, org.id, id);
      const event = await tx.loanEvent.findFirst({ where: { id: eventId, loanId: id, orgId: org.id } });
      if (!event) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Loan entry not found' });
      if (event.status !== 'POSTED') throw new DomainError('EVENT_REVERSED', 'This is already reversed', HttpStatus.CONFLICT);
      const latest = await tx.loanEvent.findFirst({ where: { loanId: id, status: 'POSTED' }, orderBy: { seq: 'desc' } });
      if (latest!.id !== event.id) throw new DomainError('NOT_LATEST_EVENT', 'Reverse the latest entry on the loan first', HttpStatus.CONFLICT);
      let reversalEntryId: string | null = null;
      if (event.entryId) {
        const rev = await this.journals.reverseSystemEntry(tx, org, actor, event.entryId, { date: fromDbDate(event.date), memo: `Reversal: ${event.kind === 'REPAYMENT' ? `installment ${event.installmentNo}` : 'prepayment'} of ${ref(loan.number)}` });
        reversalEntryId = rev.id;
      }
      await tx.loanEvent.update({ where: { id: eventId }, data: { status: 'REVERSED', reversalEntryId, reversedById: actor.id, reversedAt: new Date() } });
      await tx.loan.update({ where: { id }, data: { annualRate: event.rateBefore, installment: event.installmentBefore, lastNo: event.lastNoBefore, status: 'ACTIVE', closedOn: null } });
      await this.audit.append(tx, { orgId: org.id, actorId: actor.id, action: 'loan.event_reversed', entityType: 'loan', entityId: id, data: { reference: ref(loan.number), kind: event.kind, seq: event.seq, reversalEntryId } });
    });
    return this.get(org, id);
  }

  // ------------------------------------------------------------------ reading

  private async refs(orgId: string, accountIds: (string | null)[], entryIds: (string | null)[], userIds: (string | null)[]) {
    const ids = (l: (string | null)[]) => [...new Set(l.filter((x): x is string => !!x))];
    const [accounts, entries, users] = await Promise.all([
      this.prisma.account.findMany({ where: { orgId, id: { in: ids(accountIds) } }, select: { id: true, code: true, name: true } }),
      this.prisma.journalEntry.findMany({ where: { orgId, id: { in: ids(entryIds) } }, select: { id: true, entryNumber: true, date: true } }),
      this.prisma.user.findMany({ where: { id: { in: ids(userIds) } }, select: { id: true, name: true } }),
    ]);
    return {
      acct: (id: string | null) => accounts.find((a) => a.id === id) ?? null,
      entry: (id: string | null) => {
        const e = id ? entries.find((x) => x.id === id) : null;
        return e ? { id: e.id, entryNumber: e.entryNumber, date: fromDbDate(e.date) } : null;
      },
      user: (id: string | null) => users.find((u) => u.id === id)?.name ?? null,
    };
  }

  private summary(loan: Loan, s: LoanState, scale: number, today: string) {
    const overdue = s.rows.filter((r) => r.dueDate < today);
    const paid = s.posted.reduce((t, e) => ({ principal: t.principal.plus(e.principal.toString()), interest: t.interest.plus(e.interest.toString()), charges: t.charges.plus(e.charges.toString()) }), { principal: new D(0), interest: new D(0), charges: new D(0) });
    return {
      id: loan.id,
      reference: ref(loan.number),
      name: loan.name,
      lender: loan.lender,
      method: loan.method,
      status: loan.status,
      principal: new D(loan.principal.toString()).toFixed(scale),
      annualRate: new D(loan.annualRate.toString()).toFixed(),
      installment: new D(loan.installment.toString()).toFixed(scale),
      balance: s.balance.toFixed(scale),
      paid: { principal: paid.principal.toFixed(scale), interest: paid.interest.toFixed(scale), charges: paid.charges.toFixed(scale), installments: s.paidCount },
      next: s.rows[0] ?? null,
      overdue: { count: overdue.length, amount: overdue.reduce((t, r) => t.plus(r.payment), new D(0)).toFixed(scale) },
      remaining: loanTotals(s.rows, scale),
      maturity: loanMaturity(s.rows, today, scale),
      endsOn: s.rows.at(-1)?.dueDate ?? (loan.closedOn ? fromDbDate(loan.closedOn) : null),
      closedOn: loan.closedOn ? fromDbDate(loan.closedOn) : null,
      liabilityAccountId: loan.liabilityAccountId,
    };
  }

  async list(org: LoanOrg) {
    const scale = this.scale(org);
    const today = todayIst();
    const loans = await this.prisma.loan.findMany({ where: { orgId: org.id }, orderBy: { number: 'asc' } });
    const events = await this.prisma.loanEvent.findMany({ where: { orgId: org.id } });
    const rows = loans.map((l) => this.summary(l, this.state(l, events.filter((e) => e.loanId === l.id), scale), scale, today));
    const sum = (f: (r: (typeof rows)[number]) => string) => rows.reduce((t, r) => t.plus(f(r)), new D(0)).toFixed(scale);
    const r = await this.refs(org.id, rows.map((x) => x.liabilityAccountId), [], []);
    return {
      loans: rows.map((x) => ({ ...x, liabilityAccount: r.acct(x.liabilityAccountId) })),
      totals: { balance: sum((x) => x.balance), current: sum((x) => x.maturity.current), nonCurrent: sum((x) => x.maturity.nonCurrent), overdue: sum((x) => x.overdue.amount), active: rows.filter((x) => x.status === 'ACTIVE').length },
      can: this.can(org),
    };
  }

  async get(org: LoanOrg, id: string) {
    const scale = this.scale(org);
    const today = todayIst();
    const loan = await this.prisma.loan.findFirst({ where: { id, orgId: org.id } });
    if (!loan) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Loan not found' });
    const events = await this.prisma.loanEvent.findMany({ where: { loanId: id }, orderBy: { seq: 'asc' } });
    const s = this.state(loan, events, scale);
    const r = await this.refs(
      org.id,
      [loan.liabilityAccountId, loan.interestAccountId, loan.bankAccountId, ...events.flatMap((e) => [e.bankAccountId, e.chargesAccountId])],
      [loan.disbursementEntryId, ...events.flatMap((e) => [e.entryId, e.reversalEntryId])],
      [loan.createdById, ...events.flatMap((e) => [e.createdById, e.reversedById])],
    );
    const latest = s.posted.at(-1)?.id ?? null;
    const fx = (v: Prisma.Decimal | null) => (v == null ? null : new D(v.toString()).toFixed(scale));
    const paidRows = s.posted
      .filter((e) => e.kind === 'REPAYMENT')
      .map((e) => ({ no: e.installmentNo!, date: fromDbDate(e.date), opening: fx(e.balanceBefore)!, interest: fx(e.interest)!, principal: fx(e.principal)!, payment: new D(e.principal.toString()).plus(e.interest.toString()).toFixed(scale), closing: fx(e.balanceAfter)!, entry: r.entry(e.entryId) }));
    return {
      ...this.summary(loan, s, scale, today),
      accountNumber: loan.accountNumber,
      originalRate: new D(loan.originalRate.toString()).toFixed(),
      months: loan.months,
      lastNo: loan.lastNo,
      disbursementDate: fromDbDate(loan.disbursementDate),
      firstDueDate: fromDbDate(loan.firstDueDate),
      notes: loan.notes,
      accounts: { liability: r.acct(loan.liabilityAccountId), interest: r.acct(loan.interestAccountId), bank: r.acct(loan.bankAccountId) },
      disbursementEntry: r.entry(loan.disbursementEntryId),
      createdBy: r.user(loan.createdById),
      events: events.map((e) => ({
        id: e.id,
        seq: e.seq,
        kind: e.kind,
        date: fromDbDate(e.date),
        installmentNo: e.installmentNo,
        principal: fx(e.principal)!,
        interest: fx(e.interest)!,
        charges: fx(e.charges)!,
        mode: e.mode,
        balanceAfter: fx(e.balanceAfter)!,
        rateBefore: new D(e.rateBefore.toString()).toFixed(),
        rateAfter: new D(e.rateAfter.toString()).toFixed(),
        installmentBefore: fx(e.installmentBefore)!,
        installmentAfter: fx(e.installmentAfter)!,
        note: e.note,
        bankAccount: r.acct(e.bankAccountId),
        entry: r.entry(e.entryId),
        status: e.status,
        reversal: e.status === 'REVERSED' ? { entry: r.entry(e.reversalEntryId), by: r.user(e.reversedById), at: e.reversedAt!.toISOString() } : null,
        createdBy: r.user(e.createdById),
        canReverse: e.id === latest,
      })),
      paidRows,
      rows: s.rows,
      can: this.can(org),
    };
  }

  /** Accounts the forms offer, by role. */
  async accounts(org: LoanOrg) {
    const all = await this.prisma.account.findMany({ where: { orgId: org.id, isPostable: true, isActive: true }, orderBy: { code: 'asc' }, select: { id: true, code: true, name: true, type: true, subtype: true, isPostable: true, isActive: true } });
    const pick = (ok: (a: Acc) => boolean) => all.filter(ok).map(({ id, code, name }) => ({ id, code, name }));
    return { liability: pick(RULES.liability), interest: pick(RULES.expense), bank: pick(RULES.bank) };
  }

  /**
   * The treasury position: cash and bank balances, what is borrowed (due within a year and later),
   * net cash, installments due soon or overdue, the repayments of the next twelve months,
   * interest paid this financial year, and a check that each loan account in the ledger agrees with the loans.
   */
  async treasury(org: LoanOrg) {
    const scale = this.scale(org);
    const today = todayIst();
    const loanAccounts = (await this.prisma.loan.findMany({ where: { orgId: org.id }, select: { liabilityAccountId: true } })).map((l) => l.liabilityAccountId);
    const accounts = (await this.prisma.account.findMany({ where: { orgId: org.id, OR: [{ subtype: { in: ['BANK', 'CASH'] } }, { id: { in: loanAccounts } }] }, select: { id: true, code: true, name: true, subtype: true } })).sort(byCode);
    const sums = accounts.length ? await lineSums(this.store, org.id, { entry: postedBetween(null, toDbDate(today)), line: { accountId: { $in: accounts.map((a) => a.id) } }, by: { accountId: 'lines.accountId' } }) : [];
    const net = new Map(sums.map((r) => [r.key.accountId as string, new Prisma.Decimal(r.debit.minus(r.credit).toFixed())]));
    const balances = accounts.map((a) => ({ id: a.id, code: a.code, name: a.name, subtype: a.subtype as string | null, balance: net.get(a.id) ?? null }));
    const bal = (b: Prisma.Decimal | null) => new D(b?.toString() ?? '0');
    const cashAccounts = balances.filter((b) => b.subtype === 'BANK' || b.subtype === 'CASH').map((b) => ({ id: b.id, code: b.code, name: b.name, kind: b.subtype as 'BANK' | 'CASH', balance: bal(b.balance).toFixed(scale) }));
    const cash = cashAccounts.reduce((t, a) => t.plus(a.balance), new D(0));
    const list = await this.list(org);
    const borrowed = new D(list.totals.balance);
    const loans = await this.prisma.loan.findMany({ where: { orgId: org.id, status: 'ACTIVE' }, orderBy: { number: 'asc' } });
    const events = await this.prisma.loanEvent.findMany({ where: { orgId: org.id } });
    const soon = addDays(today, 30);
    const upcoming: (LoanRow & { loanId: string; reference: string; name: string; overdue: boolean })[] = [];
    const byMonth = new Map<string, { principal: InstanceType<typeof D>; interest: InstanceType<typeof D> }>();
    const horizon = `${+today.slice(0, 4) + 1}${today.slice(4, 7)}`;
    for (const l of loans) {
      const s = this.state(l, events.filter((e) => e.loanId === l.id), scale);
      for (const row of s.rows) {
        if (row.dueDate <= soon) upcoming.push({ ...row, loanId: l.id, reference: ref(l.number), name: l.name, overdue: row.dueDate < today });
        const m = row.dueDate.slice(0, 7);
        if (m < horizon) {
          const key = m < today.slice(0, 7) ? today.slice(0, 7) : m;
          const t = byMonth.get(key) ?? { principal: new D(0), interest: new D(0) };
          byMonth.set(key, { principal: t.principal.plus(row.principal), interest: t.interest.plus(row.interest) });
        }
      }
    }
    upcoming.sort((a, b) => (a.dueDate === b.dueDate ? a.reference.localeCompare(b.reference) : a.dueDate.localeCompare(b.dueDate)));
    const sm = org.fiscalYearStartMonth;
    const y = +today.slice(0, 4);
    const fyStart = `${+today.slice(5, 7) >= sm ? y : y - 1}-${String(sm).padStart(2, '0')}-01`;
    const interest = events.filter((e) => e.status === 'POSTED' && fromDbDate(e.date) >= fyStart && fromDbDate(e.date) <= today).reduce((t, e) => t.plus(e.interest.toString()), new D(0));
    const ledger = balances
      .filter((b) => list.loans.some((l) => l.liabilityAccountId === b.id))
      .map((b) => {
        const inLedger = bal(b.balance).negated();
        const inLoans = list.loans.filter((l) => l.liabilityAccountId === b.id).reduce((t, l) => t.plus(l.balance), new D(0));
        return { account: { id: b.id, code: b.code, name: b.name }, ledger: inLedger.toFixed(scale), loans: inLoans.toFixed(scale), difference: inLedger.minus(inLoans).toFixed(scale) };
      });
    return {
      asOf: today,
      cash: { total: cash.toFixed(scale), accounts: cashAccounts },
      borrowings: list.totals,
      netCash: cash.minus(borrowed).toFixed(scale),
      upcoming,
      byMonth: [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, t]) => ({ month, principal: t.principal.toFixed(scale), interest: t.interest.toFixed(scale), total: t.principal.plus(t.interest).toFixed(scale) })),
      interestThisYear: { from: fyStart, amount: interest.toFixed(scale) },
      ledger,
      loans: list.loans.filter((l) => l.status === 'ACTIVE'),
      can: list.can,
    };
  }
}
