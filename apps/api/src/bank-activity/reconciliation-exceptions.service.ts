import { Injectable, NotFoundException } from '@nestjs/common';
import { RECON_EXCEPTION_KINDS, reconciliationExceptions } from '@talk2tax/accounting-engine';
import { BankingService } from '../banking/banking.service';
import { todayIso } from '../common/dates';

/**
 * Reconciliation exception analysis (BANK-020): for each active bank account, why statement lines
 * and entries in the books are still unmatched (amounts that differ, splits, reversals, bank
 * charges, money not in the books, entries in transit, outstanding or stale) and what to do about
 * each. Read-only; amounts in each account's currency.
 */
@Injectable()
export class ReconciliationExceptionsService {
  constructor(private readonly banking: BankingService) {}

  async analyse(org: Parameters<BankingService['listAccounts']>[0], q: { accountId?: string }, today = todayIso()) {
    let accounts = (await this.banking.listAccounts(org)).filter((a) => a.isActive);
    if (q.accountId) {
      accounts = accounts.filter((a) => a.id === q.accountId);
      if (!accounts.length) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Bank account not found' });
    }
    const out = await Promise.all(
      accounts.map(async (a) => {
        const u = await this.banking.unmatchedItems(org, a.id, today);
        const r = reconciliationExceptions(u.statement, u.book, u.lastStatementDate, today, u.scale);
        return {
          account: { id: a.id, code: a.code, name: a.name, currency: u.currency },
          lastStatementDate: u.lastStatementDate,
          lastReconciled: a.lastReconciled?.date ?? null,
          since: u.since,
          unmatched: r.unmatched,
          summary: r.summary,
          ageing: r.ageing,
          exceptions: r.exceptions.map((e) => ({ ...e, book: e.book.map((b) => ({ ...b, entryId: u.book.find((x) => x.id === b.id)?.entryId ?? null })) })),
        };
      }),
    );
    const withWork = out.filter((x) => x.exceptions.length);
    return {
      asOf: today,
      summary: {
        accounts: out.length,
        accountsWithExceptions: withWork.length,
        exceptions: out.reduce((s, x) => s + x.exceptions.length, 0),
        byKind: Object.fromEntries(RECON_EXCEPTION_KINDS.map((k) => [k, out.reduce((s, x) => s + x.summary.find((y) => y.kind === k)!.count, 0)])),
        needsAction: out.reduce((s, x) => s + x.exceptions.filter((e) => e.kind !== 'IN_TRANSIT').length, 0),
      },
      accounts: out.sort((a, b) => b.exceptions.length - a.exceptions.length || a.account.code.localeCompare(b.account.code)),
    };
  }
}
