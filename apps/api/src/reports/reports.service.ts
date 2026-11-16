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

  private async movements(orgId: string, from: string | null, to: string): Promise<AccountMovement[]> {
    const fromDate = from ? toDbDate(from) : null;
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

  async incomeStatement(orgId: string, q: { from: string; to: string }) {
    const ccy = await this.currency(orgId);
    const f = (d: Dec) => d.toFixed(minorUnits(ccy));
    const is = buildIncomeStatement(await this.movements(orgId, q.from, q.to));
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
}
