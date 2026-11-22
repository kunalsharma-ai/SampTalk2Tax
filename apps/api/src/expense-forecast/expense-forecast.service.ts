import { Injectable } from '@nestjs/common';
import { addDays, EXPENSE_FORECAST_HISTORY_MONTHS, expenseForecast, minorUnits } from '@talk2tax/accounting-engine';
import type { OrgContext } from '../auth/decorators';
import { fromDbDate, todayIso, toDbDate } from '../common/dates';
import { PrismaService } from '../common/prisma.service';

/**
 * Expense forecasting (EXP-025): the spending expense claims are likely to bring in the coming
 * months, by expense account, from approved claims in the last year; and what is owed to
 * employees now (approved, not yet paid back) and waiting for approval. Read-only.
 */
@Injectable()
export class ExpenseForecastService {
  constructor(private readonly prisma: PrismaService) {}

  async forecast(org: OrgContext, months: number, today = todayIso()) {
    const currency = org.functionalCurrency;
    const from = `${today.slice(0, 7)}-01`;
    const since = addDays(from, -(EXPENSE_FORECAST_HISTORY_MONTHS * 31 + 1));
    const [lines, open] = await Promise.all([
      this.prisma.expenseClaimLine.findMany({
        where: { orgId: org.id, date: { gte: toDbDate(since) }, claim: { status: { in: ['APPROVED', 'REIMBURSED'] }, currency } },
        select: { date: true, accountId: true, amount: true, account: { select: { code: true, name: true } } },
      }),
      this.prisma.expenseClaim.findMany({ where: { orgId: org.id, status: { in: ['SUBMITTED', 'APPROVED'] }, currency }, select: { status: true, total: true } }),
    ]);
    const scale = minorUnits(currency);
    const f = expenseForecast({
      asOf: today,
      months,
      scale,
      lines: lines.map((l) => ({ date: fromDbDate(l.date), accountId: l.accountId, accountLabel: `${l.account.code} · ${l.account.name}`, amount: l.amount.toFixed(scale) })),
      approvedNotPaid: open.filter((c) => c.status === 'APPROVED').map((c) => c.total.toFixed(scale)),
      waitingApproval: open.filter((c) => c.status === 'SUBMITTED').map((c) => c.total.toFixed(scale)),
    });
    return { ...f, currency };
  }
}
