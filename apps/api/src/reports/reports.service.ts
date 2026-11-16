import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AccountMovement,
  AccountType,
  buildAccountLedger,
  buildBalanceSheet,
  buildIncomeStatement,
  buildTrialBalance,
  D,
  Dec,
  minorUnits,
} from '@talk2tax/accounting-engine';
import { Prisma } from '@talk2tax/database';
import { fromDbDate, toDbDate } from '../common/dates';
import { PrismaService } from '../common/prisma.service';

interface MovementRow {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: string | null;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
}

/** All reports read only POSTED entries; drafts never affect balances. */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  private async movements(orgId: string, from: string | null, to: string, dims: { departmentId?: string | null; projectId?: string | null } = {}): Promise<AccountMovement[]> {
    const fromDate = from ? toDbDate(from) : null;
    const dept = dims.departmentId ?? null;
    const project = dims.projectId ?? null;
    const rows = await this.prisma.$queryRaw<MovementRow[]>`
      SELECT a.id, a.code, a.name, a.type::text AS type, a.subtype,
             COALESCE(m.debit, 0) AS debit, COALESCE(m.credit, 0) AS credit
      FROM accounts a
      LEFT JOIN (
        SELECT l.account_id, SUM(l.functional_debit) AS debit, SUM(l.functional_credit) AS credit
        FROM journal_lines l
        JOIN journal_entries e ON e.id = l.entry_id AND e.org_id = l.org_id
        WHERE l.org_id = ${orgId}::uuid
          AND e.status = 'POSTED'
          AND e.date <= ${toDbDate(to)}::date
          AND (${fromDate}::date IS NULL OR e.date >= ${fromDate}::date)
          AND (${dept}::uuid IS NULL OR l.department_id = ${dept}::uuid)
          AND (${project}::uuid IS NULL OR l.project_id = ${project}::uuid)
        GROUP BY l.account_id
      ) m ON m.account_id = a.id
      WHERE a.org_id = ${orgId}::uuid`;
    return rows.map((r) => ({
      accountId: r.id,
      code: r.code,
      name: r.name,
      type: r.type,
      subtype: r.subtype,
      debit: new D(r.debit.toFixed()),
      credit: new D(r.credit.toFixed()),
    }));
  }

  private async currency(orgId: string): Promise<string> {
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { functionalCurrency: true } });
    return org.functionalCurrency;
  }

  async trialBalance(orgId: string, q: { from?: string; asOf: string; includeZero?: boolean }) {
    const ccy = await this.currency(orgId);
    const f = (d: Dec) => d.toFixed(minorUnits(ccy));
    const tb = buildTrialBalance(await this.movements(orgId, q.from ?? null, q.asOf), { includeZero: q.includeZero });
    return {
      currency: ccy,
      from: q.from ?? null,
      asOf: q.asOf,
      balanced: tb.balanced,
      totals: { debit: f(tb.totalDebit), credit: f(tb.totalCredit), netDebit: f(tb.totalNetDebit), netCredit: f(tb.totalNetCredit) },
      rows: tb.rows.map((r) => ({
        accountId: r.accountId,
        code: r.code,
        name: r.name,
        type: r.type,
        subtype: r.subtype,
        debit: f(r.debit),
        credit: f(r.credit),
        netDebit: f(r.netDebit),
        netCredit: f(r.netCredit),
        balance: f(r.balance),
      })),
    };
  }

  async incomeStatement(orgId: string, q: { from: string; to: string; departmentId?: string; projectId?: string }) {
    const ccy = await this.currency(orgId);
    const f = (d: Dec) => d.toFixed(minorUnits(ccy));
    const is = buildIncomeStatement(await this.movements(orgId, q.from, q.to, q));
    const line = (l: { accountId: string; code: string; name: string; subtype?: string | null; amount: Dec }) => ({ ...l, subtype: l.subtype ?? null, amount: f(l.amount) });
    return {
      currency: ccy,
      from: q.from,
      to: q.to,
      revenue: is.revenue.map(line),
      expenses: is.expenses.map(line),
      totalRevenue: f(is.totalRevenue),
      totalExpenses: f(is.totalExpenses),
      netIncome: f(is.netIncome),
    };
  }

  async balanceSheet(orgId: string, q: { asOf: string }) {
    const ccy = await this.currency(orgId);
    const f = (d: Dec) => d.toFixed(minorUnits(ccy));
    const bs = buildBalanceSheet(await this.movements(orgId, null, q.asOf));
    const line = (l: { accountId: string; code: string; name: string; subtype?: string | null; amount: Dec }) => ({ ...l, subtype: l.subtype ?? null, amount: f(l.amount) });
    return {
      currency: ccy,
      asOf: q.asOf,
      balanced: bs.balanced,
      assets: bs.assets.map(line),
      liabilities: bs.liabilities.map(line),
      equity: bs.equity.map(line),
      unclosedEarnings: f(bs.unclosedEarnings),
      totalAssets: f(bs.totalAssets),
      totalLiabilities: f(bs.totalLiabilities),
      totalEquity: f(bs.totalEquity),
    };
  }

  async accountLedger(orgId: string, q: { accountId: string; from: string; to: string }) {
    const account = await this.prisma.account.findFirst({ where: { id: q.accountId, orgId } });
    if (!account) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Account not found' });
    const ccy = await this.currency(orgId);
    const f = (d: Dec) => d.toFixed(minorUnits(ccy));
    const opening = await this.prisma.journalLine.aggregate({
      where: { orgId, accountId: q.accountId, entry: { status: 'POSTED', date: { lt: toDbDate(q.from) } } },
      _sum: { functionalDebit: true, functionalCredit: true },
    });
    const od = new D(opening._sum.functionalDebit?.toFixed() ?? '0');
    const oc = new D(opening._sum.functionalCredit?.toFixed() ?? '0');
    const sign = account.type === 'ASSET' || account.type === 'EXPENSE' ? 1 : -1;
    const openingBalance = od.minus(oc).times(sign);
    const lines = await this.prisma.journalLine.findMany({
      where: { orgId, accountId: q.accountId, entry: { status: 'POSTED', date: { gte: toDbDate(q.from), lte: toDbDate(q.to) } } },
      include: { entry: { select: { id: true, date: true, entryNumber: true, memo: true } } },
    });
    const rows = buildAccountLedger(
      account.type,
      openingBalance,
      lines.map((l) => ({
        date: fromDbDate(l.entry.date),
        entryNumber: l.entry.entryNumber ?? 0,
        journalId: l.entry.id,
        memo: l.entry.memo,
        description: l.description,
        debit: l.functionalDebit.toFixed(),
        credit: l.functionalCredit.toFixed(),
      })),
    );
    return {
      currency: ccy,
      account: { id: account.id, code: account.code, name: account.name, type: account.type },
      from: q.from,
      to: q.to,
      openingBalance: f(openingBalance),
      closingBalance: f(rows.length ? rows[rows.length - 1].runningBalance : openingBalance),
      rows: rows.map((r) => ({ ...r, debit: f(r.debit), credit: f(r.credit), runningBalance: f(r.runningBalance) })),
    };
  }

  /**
   * Owner dashboard figures for the fiscal year containing `asOf`, all derived from posted entries:
   * cash, receivables and payables balances (by account subtype), year-to-date P&L, and a
   * per-period series of revenue, expenses, net income and closing cash.
   */
  async dashboard(orgId: string, q: { asOf: string }) {
    const ccy = await this.currency(orgId);
    const f = (d: Dec) => d.toFixed(minorUnits(ccy));
    const asOf = toDbDate(q.asOf);
    const period = await this.prisma.fiscalPeriod.findFirst({ where: { orgId, startDate: { lte: asOf }, endDate: { gte: asOf } } });
    if (!period) throw new NotFoundException({ error: 'NO_FISCAL_PERIOD', message: `No fiscal period covers ${q.asOf}` });
    const periods = await this.prisma.fiscalPeriod.findMany({ where: { orgId, fiscalYear: period.fiscalYear }, orderBy: { periodNo: 'asc' } });

    const rows = await this.prisma.$queryRaw<{ period_id: string | null; bucket: string; debit: Prisma.Decimal; credit: Prisma.Decimal }[]>`
      SELECT CASE WHEN e.date >= ${periods[0].startDate}::date THEN e.period_id ELSE NULL END AS period_id,
             CASE
               WHEN a.type = 'REVENUE' THEN 'REVENUE'
               WHEN a.type = 'EXPENSE' THEN 'EXPENSE'
               WHEN a.subtype IN ('CASH', 'BANK') THEN 'CASH'
               WHEN a.subtype = 'ACCOUNTS_RECEIVABLE' THEN 'AR'
               WHEN a.subtype = 'ACCOUNTS_PAYABLE' THEN 'AP'
               ELSE 'OTHER'
             END AS bucket,
             SUM(l.functional_debit) AS debit, SUM(l.functional_credit) AS credit
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l.entry_id AND e.org_id = l.org_id
      JOIN accounts a ON a.id = l.account_id AND a.org_id = l.org_id
      WHERE l.org_id = ${orgId}::uuid AND e.status = 'POSTED' AND e.date <= ${asOf}::date
      GROUP BY 1, 2`;

    const zero = () => new D(0);
    const net = (r: { debit: Prisma.Decimal; credit: Prisma.Decimal }) => new D(r.debit.toFixed()).minus(r.credit.toFixed());
    let cash = zero(), ar = zero(), ap = zero();
    let openingCash = zero();
    const perPeriod = new Map<string, { revenue: Dec; expenses: Dec; cash: Dec }>();
    for (const p of periods) perPeriod.set(p.id, { revenue: zero(), expenses: zero(), cash: zero() });
    for (const r of rows) {
      const n = net(r);
      if (r.bucket === 'CASH') {
        cash = cash.plus(n);
        if (r.period_id && perPeriod.has(r.period_id)) perPeriod.get(r.period_id)!.cash = perPeriod.get(r.period_id)!.cash.plus(n);
        else openingCash = openingCash.plus(n);
      }
      if (r.bucket === 'AR') ar = ar.plus(n);
      if (r.bucket === 'AP') ap = ap.minus(n);
      if (r.period_id && perPeriod.has(r.period_id)) {
        const b = perPeriod.get(r.period_id)!;
        if (r.bucket === 'REVENUE') b.revenue = b.revenue.minus(n);
        if (r.bucket === 'EXPENSE') b.expenses = b.expenses.plus(n);
      }
    }
    let running = openingCash;
    let ytdRevenue = zero(), ytdExpenses = zero();
    const months = periods
      .filter((p) => p.startDate <= asOf)
      .map((p) => {
        const b = perPeriod.get(p.id)!;
        running = running.plus(b.cash);
        ytdRevenue = ytdRevenue.plus(b.revenue);
        ytdExpenses = ytdExpenses.plus(b.expenses);
        return {
          periodId: p.id,
          name: p.name,
          startDate: fromDbDate(p.startDate),
          endDate: fromDbDate(p.endDate),
          status: p.status,
          revenue: f(b.revenue),
          expenses: f(b.expenses),
          netIncome: f(b.revenue.minus(b.expenses)),
          closingCash: f(running),
        };
      });
    const draftCount = await this.prisma.journalEntry.count({ where: { orgId, status: 'DRAFT' } });
    return {
      currency: ccy,
      asOf: q.asOf,
      fiscalYear: period.fiscalYear,
      fiscalYearStart: fromDbDate(periods[0].startDate),
      balances: { cash: f(cash), receivables: f(ar), payables: f(ap) },
      yearToDate: { revenue: f(ytdRevenue), expenses: f(ytdExpenses), netIncome: f(ytdRevenue.minus(ytdExpenses)) },
      periods: months,
      draftJournals: draftCount,
    };
  }
}
