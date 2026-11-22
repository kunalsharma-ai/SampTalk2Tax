import { Injectable, NotFoundException } from '@nestjs/common';
import { addDays, CASH_MOVEMENT_HISTORY_DAYS, forecastCashMovements, minorUnits } from '@talk2tax/accounting-engine';
import { BankingService } from '../banking/banking.service';
import { fromDbDate, todayIso, toDbDate } from '../common/dates';
import { PrismaService } from '../common/prisma.service';

/**
 * Cash movement forecasting (BANK-022): each active bank account's balance week by week for the
 * next 30, 60 or 90 days, from the movements that repeat on its imported statements and the rest of
 * its recent movements, starting from its balance in the books. Read-only; amounts in each
 * account's currency; excluded statement lines are left out.
 */
@Injectable()
export class CashMovementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly banking: BankingService,
  ) {}

  async forecast(org: Parameters<BankingService['listAccounts']>[0], q: { accountId?: string; days: number }, today = todayIso()) {
    let accounts = (await this.banking.listAccounts(org)).filter((a) => a.isActive);
    if (q.accountId) {
      accounts = accounts.filter((a) => a.id === q.accountId);
      if (!accounts.length) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Bank account not found' });
    } else accounts = accounts.filter((a) => a.statementLines > 0);
    const lines = accounts.length
      ? await this.prisma.bankStatementLine.findMany({
          where: { orgId: org.id, accountId: { in: accounts.map((a) => a.id) }, status: { not: 'EXCLUDED' }, date: { gt: toDbDate(addDays(today, -CASH_MOVEMENT_HISTORY_DAYS)), lte: toDbDate(today) } },
          select: { id: true, accountId: true, date: true, amount: true, description: true },
        })
      : [];
    const out = accounts.map((a) => {
      const scale = minorUnits(a.currency);
      const mine = lines.filter((l) => l.accountId === a.id).map((l) => ({ id: l.id, date: fromDbDate(l.date), amount: l.amount.toFixed(scale), description: l.description }));
      const f = forecastCashMovements(mine, a.ledgerBalance, today, q.days, scale);
      return { account: { id: a.id, code: a.code, name: a.name, currency: a.currency, lastStatementDate: a.lastStatementDate }, ...f, recurring: f.recurring.map(({ lineIds, ...r }) => r) };
    });
    return {
      asOf: today,
      days: q.days,
      summary: {
        accounts: out.length,
        recurring: out.reduce((n, a) => n + a.recurring.filter((r) => r.running).length, 0),
        belowZero: out.filter((a) => a.lowest.balance.startsWith('-')).length,
      },
      accounts: out,
    };
  }
}
