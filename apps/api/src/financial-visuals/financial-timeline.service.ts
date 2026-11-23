import { HttpStatus, Injectable } from '@nestjs/common';
import { addDays, D, daysBetween, financialTimeline, minorUnits, type TimelineBucketSize } from '@talk2tax/accounting-engine';
import type { OrgContext } from '../auth/decorators';
import { fromDbDate, todayIso, toDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { runInOrg } from '../common/tenant-context';
import { ComplianceService } from '../compliance/compliance.service';
import { journalEntries } from '../db/collections/ledger';
import { lineSums, postedBetween } from '../db/ledger-queries';

const MAX_DAYS = 400; // not money

/**
 * Financial timeline (DASH-033): posted journal entries and the cash they moved through cash and
 * bank accounts, bucketed by day, week or month, with the cash balance carried through, and the
 * compliance deadlines in the same range. By default the last 90 days and the next 30. Closing
 * entries are left out. Read only; reports.read.
 */
@Injectable()
export class FinancialTimelineService {
  constructor(
    private readonly store: DocumentStoreService,
    private readonly prisma: PrismaService,
    private readonly compliance: ComplianceService,
  ) {}

  async timeline(org: OrgContext, q: { from?: string; to?: string; size?: TimelineBucketSize }) {
    const today = todayIso();
    const from = q.from ?? addDays(today, -90);
    const to = q.to ?? addDays(today, 30);
    if (from > to) throw new DomainError('INVALID_PERIOD', 'The first day must not be after the last');
    if (daysBetween(from, to) + 1 > MAX_DAYS) throw new DomainError('PERIOD_TOO_LONG', `Choose at most ${MAX_DAYS} days`, HttpStatus.UNPROCESSABLE_ENTITY); // not money
    const s = minorUnits(org.functionalCurrency);
    const cashAccounts = await this.prisma.account.findMany({ where: { orgId: org.id, subtype: { in: ['CASH', 'BANK'] } }, select: { id: true } });
    const cash = new Set(cashAccounts.map((a) => a.id));
    const [opening, docs, calendar] = await Promise.all([
      cash.size ? lineSums(this.store, org.id, { entry: postedBetween(null, toDbDate(addDays(from, -1))), line: { accountId: { $in: [...cash] } }, by: {} }) : Promise.resolve([]),
      runInOrg(org.id, () => this.store.collection(journalEntries).find({ ...postedBetween(toDbDate(from), toDbDate(to), { excludeClosing: true }) }, { sort: { date: 1, entryNumber: 1 } })),
      this.compliance.calendar(org.id, from, to),
    ]);
    const openingCash = opening.reduce((t, r) => t.plus(r.debit).minus(r.credit), new D(0));
    const entries = docs.map((j) => {
      let cashIn = new D(0);
      let cashOut = new D(0);
      for (const l of j.lines) {
        if (!cash.has(l.accountId)) continue;
        cashIn = cashIn.plus(l.functionalDebit);
        cashOut = cashOut.plus(l.functionalCredit);
      }
      // A transfer between two cash or bank accounts moves no cash in or out of the business.
      const both = D.min(cashIn, cashOut);
      return { id: j.id, entryNumber: j.entryNumber ?? null, date: fromDbDate(j.date), source: j.source, reference: j.reference ?? null, memo: j.memo ?? null, amount: new D(j.totalDebit).toFixed(s), cashIn: cashIn.minus(both).toFixed(s), cashOut: cashOut.minus(both).toFixed(s) };
    });
    const deadlines = calendar.items.filter((i) => i.status !== 'NOTHING_DUE').map((i) => ({ key: i.key, date: i.dueDate, name: `${i.name} · ${i.periodLabel}`, status: i.status }));
    return {
      currency: org.functionalCurrency,
      today,
      complianceConfigured: calendar.configured,
      ...financialTimeline({ from, to, today, size: q.size, openingCash: openingCash.toFixed(), entries, deadlines, scale: s }),
    };
  }
}
