import { HttpStatus, Injectable } from '@nestjs/common';
import { cashFlowNetwork, minorUnits } from '@talk2tax/accounting-engine';
import type { OrgContext } from '../auth/decorators';
import { todayIso, toDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { runInOrg } from '../common/tenant-context';
import { journalEntries } from '../db/collections/ledger';

const MAX_MONTHS = 24; // not money
const shift = (month: string, by: number) => {
  const m = Number(month.slice(5, 7)) - 1 + by; // not money
  const y = Number(month.slice(0, 4)) + Math.floor(m / 12); // not money
  return `${y}-${String((((m % 12) + 12) % 12) + 1).padStart(2, '0')}`; // not money
};
const lastDay = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10); // not money

/**
 * Cash-flow network (DASH-024): month by month, where cash came from and went to for each cash
 * and bank account, read from posted journal entries that move them. Read only; reports.read.
 */
@Injectable()
export class CashFlowNetworkService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
  ) {}

  async network(org: OrgContext, q: { from?: string; to?: string }) {
    const to = q.to ?? todayIso().slice(0, 7);
    const from = q.from ?? shift(to, -11);
    if (from > to) throw new DomainError('INVALID_PERIOD', 'The first month must not be after the last');
    const months = [from];
    while (months[months.length - 1] < to) {
      months.push(shift(months[months.length - 1], 1));
      if (months.length > MAX_MONTHS) throw new DomainError('PERIOD_TOO_LONG', `Choose at most ${MAX_MONTHS} months`, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const fromDate = `${from}-01`;
    const toDate = lastDay(to);
    const accounts = await this.prisma.account.findMany({ where: { orgId: org.id }, select: { id: true, code: true, name: true, type: true, subtype: true }, orderBy: { code: 'asc' } });
    const cash = accounts.filter((a) => a.subtype === 'CASH' || a.subtype === 'BANK');
    const entries = cash.length
      ? await runInOrg(org.id, () =>
          this.store
            .collection(journalEntries)
            .find({ status: 'POSTED', date: { $gte: toDbDate(fromDate), $lte: toDbDate(toDate) }, 'lines.accountId': { $in: cash.map((c) => c.id) } }, { projection: { id: 1, date: 1, lines: 1 } }),
        )
      : [];
    const r = cashFlowNetwork({
      cash: cash.map((c) => ({ id: c.id, name: `${c.code} · ${c.name}` })),
      accounts: accounts.map((a) => ({ id: a.id, type: a.type, subtype: a.subtype })),
      entries: entries.map((e) => ({
        month: new Date(e.date).toISOString().slice(0, 7),
        lines: e.lines.map((l) => ({ accountId: l.accountId, debit: String(l.functionalDebit), credit: String(l.functionalCredit) })),
      })),
      months,
      scale: minorUnits(org.functionalCurrency),
    });
    return { currency: org.functionalCurrency, from, to, fromDate, toDate, entries: entries.length, ...r };
  }
}
