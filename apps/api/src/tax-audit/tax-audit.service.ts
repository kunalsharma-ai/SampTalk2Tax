import { HttpStatus, Injectable } from '@nestjs/common';
import { D } from '@talk2tax/accounting-engine';
import { cashPaymentDisallowances, cashReceiptBreaches, gstExpenditureBreakup, taxAuditApplicability, taxYearOf, tdsLateDeposits, type CashFact, type TdsFact } from '@talk2tax/tax-engine';
import type { OrgContext } from '../auth/decorators';
import { toDbDate, todayIso } from '../common/dates';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { WithholdingService } from '../withholding/withholding.service';

const fromDb = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Tax audit support (TAX-026): working papers for Form 3CD for one financial year, from posted
 * documents, payments and the TDS register: whether a tax audit is needed (44AB(a)), cash
 * expenditure over 10,000 a day to one person (40A(3), clause 21(d)), cash received of 2 lakh or
 * more a day from one person (269ST, clause 31), late TDS with interest (clause 34) and expenditure
 * by the supplier's GST registration (clause 44: the GSTIN on the bill, else the supplier's). Cash means a payment from or into an account with
 * the CASH subtype. Indian organisations only; read-only.
 */
@Injectable()
export class TaxAuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly withholding: WithholdingService,
  ) {}

  async report(org: OrgContext, year?: string, today = todayIso()) {
    const o = await this.prisma.organization.findUniqueOrThrow({ where: { id: org.id }, select: { countryCode: true } });
    if (o.countryCode !== 'IN') throw new DomainError('NOT_INDIA', 'Tax audit support covers the Indian Income-tax Act (Form 3CD)', HttpStatus.UNPROCESSABLE_ENTITY);
    const current = taxYearOf(today);
    const ty = year ? taxYearOf(`${year.slice(0, 4)}-04-01`) : taxYearOf(`${Number(current.from.slice(0, 4)) - 1}-04-01`);
    if (year && ty.label !== year) throw new DomainError('INVALID_TAX_YEAR', 'Give the financial year as 2025-26', HttpStatus.BAD_REQUEST);
    if (ty.from > today) throw new DomainError('FUTURE_YEAR', `The financial year ${ty.label} has not started`, HttpStatus.UNPROCESSABLE_ENTITY);
    const range = { gte: toDbDate(ty.from), lte: toDbDate(ty.to) };
    const [docs, payments, cashAccounts] = await Promise.all([
      this.prisma.document.findMany({ where: { orgId: org.id, status: 'POSTED', issueDate: range }, select: { kind: true, subtotal: true, exchangeRate: true, counterpartyGstin: true, contact: { select: { gstin: true } } } }),
      this.prisma.payment.findMany({ where: { orgId: org.id, status: 'POSTED', date: range }, select: { id: true, kind: true, number: true, date: true, amount: true, exchangeRate: true, bankAccountId: true, contactId: true, contact: { select: { name: true } } } }),
      this.prisma.account.findMany({ where: { orgId: org.id, subtype: 'CASH' }, select: { id: true } }),
    ]);
    const fn = (amount: { toString(): string }, rate: { toString(): string }) => new D(amount.toString()).times(rate.toString());
    const sum = (xs: InstanceType<typeof D>[]) => xs.reduce((s, x) => s.plus(x), new D(0));
    const turnover = sum(docs.filter((d) => d.kind === 'INVOICE' || d.kind === 'CREDIT_NOTE').map((d) => fn(d.subtotal, d.exchangeRate).times(d.kind === 'CREDIT_NOTE' ? -1 : 1)));
    const cash = new Set(cashAccounts.map((a) => a.id));
    const fact = (p: (typeof payments)[number]): CashFact => ({ id: p.id, date: fromDb(p.date), contactId: p.contactId, contactName: p.contact.name, amount: fn(p.amount, p.exchangeRate).toFixed(2), number: p.number });
    const receipts = payments.filter((p) => p.kind === 'RECEIPT');
    const paid = payments.filter((p) => p.kind !== 'RECEIPT');
    const total = (ps: typeof payments) => sum(ps.map((p) => fn(p.amount, p.exchangeRate))).toFixed(2);
    const cashIn = receipts.filter((p) => cash.has(p.bankAccountId));
    const cashOut = paid.filter((p) => cash.has(p.bankAccountId));
    const applicability = taxAuditApplicability({ turnover: turnover.toFixed(2), totalReceipts: total(receipts), cashReceipts: total(cashIn), totalPayments: total(paid), cashPayments: total(cashOut) });
    const disallowed = cashPaymentDisallowances(cashOut.map(fact));
    const breaches = cashReceiptBreaches(cashIn.map(fact));
    const expenditure = gstExpenditureBreakup(docs.filter((d) => d.kind === 'BILL' || d.kind === 'VENDOR_CREDIT').map((d) => ({ amount: fn(d.subtotal, d.exchangeRate).times(d.kind === 'VENDOR_CREDIT' ? -1 : 1).toFixed(2), registered: !!(d.counterpartyGstin ?? d.contact.gstin) })));
    let tds: (ReturnType<typeof tdsLateDeposits> & { configured: true }) | { configured: false } = { configured: false };
    try {
      const reg = await this.withholding.register(org, 'TDS', ty.from, ty.to);
      const rows: TdsFact[] = reg.rows.filter((r) => r.status === 'POSTED' && new D(r.amount).gt(0)).map((r) => ({ number: r.number ?? '', section: r.section.code, contactName: r.contact.name, date: r.date, dueDate: r.dueDate, amount: r.amount, depositDate: r.deposit?.date ?? null }));
      tds = { configured: true, ...tdsLateDeposits(rows, today) };
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
    }
    return {
      year: ty.label,
      from: ty.from,
      to: ty.to,
      asOf: today,
      yearEnded: ty.to < today,
      applicability: { ...applicability, turnover: turnover.toFixed(2), totalReceipts: total(receipts), cashReceipts: total(cashIn), totalPayments: total(paid), cashPayments: total(cashOut) },
      cashPayments: { limit: '10000', days: disallowed, disallowed: sum(disallowed.map((d) => new D(d.amount))).toFixed(2) },
      cashReceipts: { limit: '200000', days: breaches, total: sum(breaches.map((d) => new D(d.amount))).toFixed(2) },
      tds,
      expenditure,
      hasCashAccount: cash.size > 0,
    };
  }
}
