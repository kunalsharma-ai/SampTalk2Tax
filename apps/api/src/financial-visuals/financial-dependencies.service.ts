import { HttpStatus, Injectable } from '@nestjs/common';
import { D, financialDependencies, minorUnits } from '@talk2tax/accounting-engine';
import type { OrgContext } from '../auth/decorators';
import { todayIso, toDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { lineSums, postedBetween } from '../db/ledger-queries';
import { KpisService } from '../kpis/kpis.service';
import { ReportsService } from '../reports/reports.service';

const MAX_MONTHS = 24; // not money
const shift = (month: string, by: number) => {
  const m = Number(month.slice(5, 7)) - 1 + by; // not money
  const y = Number(month.slice(0, 4)) + Math.floor(m / 12); // not money
  return `${y}-${String((((m % 12) + 12) % 12) + 1).padStart(2, '0')}`; // not money
};
const lastDay = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10); // not money

/**
 * Financial dependencies (DASH-037): who the business depends on for its money over a range of
 * months: revenue by customer (posted invoices less credit notes), spending by vendor (posted
 * bills less vendor credits, before tax), and at the end of the range the cash held in each cash
 * and bank account and what is owed on each loan and card account. Read only; reports.read.
 */
@Injectable()
export class FinancialDependenciesService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly kpis: KpisService,
    private readonly reports: ReportsService,
  ) {}

  async dependencies(org: OrgContext, q: { from?: string; to?: string }) {
    const to = q.to ?? todayIso().slice(0, 7);
    const from = q.from ?? shift(to, -11);
    if (from > to) throw new DomainError('INVALID_PERIOD', 'The first month must not be after the last');
    let n = 1; // not money
    for (let m = from; m < to; m = shift(m, 1)) if (++n > MAX_MONTHS) throw new DomainError('PERIOD_TOO_LONG', `Choose at most ${MAX_MONTHS} months`, HttpStatus.UNPROCESSABLE_ENTITY);
    const fromDate = `${from}-01`;
    const toDate = lastDay(to);
    const s = minorUnits(org.functionalCurrency);
    const loanAccounts = await this.prisma.loan.findMany({ where: { orgId: org.id }, select: { liabilityAccountId: true, name: true, lender: true } });
    const accounts = await this.prisma.account.findMany({
      where: { orgId: org.id, OR: [{ subtype: { in: ['CASH', 'BANK', 'LONG_TERM_DEBT', 'CREDIT_CARD'] } }, { id: { in: loanAccounts.map((l) => l.liabilityAccountId) } }] },
      select: { id: true, code: true, name: true, subtype: true },
    });
    const [customers, vendors, balances] = await Promise.all([
      this.kpis.customerRevenue(org.id, fromDate, toDate, s, 10_000),
      this.reports.vendorSpend(org.id, { from: fromDate, to: toDate }),
      accounts.length ? lineSums(this.store, org.id, { entry: postedBetween(null, toDbDate(toDate)), line: { accountId: { $in: accounts.map((a) => a.id) } }, by: { accountId: 'lines.accountId' } }) : Promise.resolve([]),
    ]);
    const balance = new Map(balances.map((b) => [b.key.accountId as string, b.debit.minus(b.credit)]));
    const loanName = new Map(loanAccounts.map((l) => [l.liabilityAccountId, l.lender ? `${l.lender} · ${l.name}` : l.name]));
    const label = (a: (typeof accounts)[number]) => loanName.get(a.id) ?? `${a.code} · ${a.name}`;
    const isCash = (a: (typeof accounts)[number]) => a.subtype === 'CASH' || a.subtype === 'BANK';
    const r = financialDependencies({
      customers: customers.top.map((c) => ({ id: c.id, name: c.name, amount: c.revenue })),
      vendors: vendors.vendors.map((v) => ({ id: v.id, name: v.name, amount: v.amount })),
      cash: accounts.filter(isCash).map((a) => ({ id: a.id, name: label(a), amount: (balance.get(a.id) ?? new D(0)).toFixed() })),
      borrowing: accounts.filter((a) => !isCash(a)).map((a) => ({ id: a.id, name: label(a), amount: (balance.get(a.id) ?? new D(0)).negated().toFixed() })),
      scale: s,
    });
    return { currency: org.functionalCurrency, from, to, fromDate, toDate, ...r };
  }
}
