import { Injectable } from '@nestjs/common';
import { addDays, BANK_ACTIVITY_INDICATORS, D, BANK_ACTIVITY_THRESHOLD, formatAmountText, minorUnits, unusualBankActivity } from '@talk2tax/accounting-engine';
import { BankingService } from '../banking/banking.service';
import { fromDbDate, todayIso, toDbDate } from '../common/dates';
import { PrismaService } from '../common/prisma.service';

export interface ActivityQuery {
  days: number;
  threshold?: string;
}

/**
 * Unusual bank activity (BANK-019, BANK-023): imported statement lines from the last `days` with
 * warning signs (possible duplicates, splitting just under a threshold, money straight in and
 * out, unusually large movements, large payments to a new payee, money out not in the books, large
 * round amounts), compared with the year before on the same account. Read-only; amounts in each
 * account's currency. The alert check of the same name uses the same findings.
 */
@Injectable()
export class BankActivityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly banking: BankingService,
  ) {}

  async findings(org: Parameters<BankingService['listAccounts']>[0], q: ActivityQuery, today = todayIso()) {
    const accounts = (await this.banking.listAccounts(org)).filter((a) => a.isActive);
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const lines = accounts.length
      ? await this.prisma.bankStatementLine.findMany({
          where: { orgId: org.id, accountId: { in: accounts.map((a) => a.id) }, status: { not: 'EXCLUDED' }, date: { gte: toDbDate(addDays(today, -365 - q.days)), lte: toDbDate(today) } },
          select: { id: true, accountId: true, date: true, amount: true, description: true, reference: true, status: true },
        })
      : [];
    const ref = new Map(lines.map((l) => [l.id, l.reference]));
    const found = unusualBankActivity(
      lines.map((l) => ({ id: l.id, accountId: l.accountId, date: fromDbDate(l.date), amount: l.amount.toFixed(minorUnits(byId.get(l.accountId)!.currency)), description: l.description, matched: l.status === 'MATCHED' })),
      today,
      (amount, accountId) => {
        const currency = byId.get(accountId)!.currency;
        return formatAmountText(new D(amount).toFixed(minorUnits(currency)), currency);
      },
      { days: q.days, threshold: q.threshold },
    );
    const items = found.map((f) => {
      const a = byId.get(f.line.accountId)!;
      return {
        lineId: f.line.id,
        account: { id: a.id, code: a.code, name: a.name, currency: a.currency },
        date: f.line.date,
        amount: f.line.amount,
        description: f.line.description,
        reference: ref.get(f.line.id) ?? null,
        matched: f.line.matched,
        level: f.level,
        indicators: f.indicators,
      };
    });
    return {
      asOf: today,
      days: q.days,
      threshold: q.threshold ?? BANK_ACTIVITY_THRESHOLD,
      summary: {
        lines: items.length,
        high: items.filter((i) => i.level === 'HIGH').length,
        medium: items.filter((i) => i.level === 'MEDIUM').length,
        low: items.filter((i) => i.level === 'LOW').length,
        accounts: new Set(items.map((i) => i.account.id)).size,
        byIndicator: Object.fromEntries(BANK_ACTIVITY_INDICATORS.map((c) => [c, items.filter((i) => i.indicators.some((x) => x.code === c)).length])),
      },
      items,
    };
  }
}
