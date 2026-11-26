import { HttpStatus, Injectable } from '@nestjs/common';
import { financialLandscape, minorUnits, type LandscapeView, type VisualAccount, type VisualAmount } from '@talk2tax/accounting-engine';
import type { OrgContext } from '../auth/decorators';
import { todayIso, toDbDate } from '../common/dates';
import { DocumentStoreService } from '../common/document-store.service';
import { DomainError } from '../common/errors';
import { accounts } from '../db/collections/chart';
import { lineSums, postedBetween } from '../db/ledger-queries';

const MAX_MONTHS = 24; // not money
const shift = (month: string, by: number) => {
  const m = Number(month.slice(5, 7)) - 1 + by; // not money
  const y = Number(month.slice(0, 4)) + Math.floor(m / 12); // not money
  return `${y}-${String((((m % 12) + 12) % 12) + 1).padStart(2, '0')}`; // not money
};
const lastDay = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10); // not money

/**
 * Financial landscape (DASH-023): income or spending by account and month as a 3D landscape of
 * towers, from posted journals (closing entries left out). Read only; reports.read.
 */
@Injectable()
export class FinancialLandscapeService {
  constructor(private readonly store: DocumentStoreService) {}

  async landscape(org: OrgContext, q: { from?: string; to?: string; view?: LandscapeView }) {
    const to = q.to ?? todayIso().slice(0, 7);
    const from = q.from ?? shift(to, -11);
    if (from > to) throw new DomainError('INVALID_PERIOD', 'The first month must not be after the last');
    const months: string[] = [];
    for (let m = from; m <= to; m = shift(m, 1)) {
      months.push(m);
      if (months.length > MAX_MONTHS) throw new DomainError('PERIOD_TOO_LONG', `Choose at most ${MAX_MONTHS} months`, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const view = q.view ?? 'EXPENSES';
    const type = view === 'REVENUE' ? 'REVENUE' : 'EXPENSE';
    const chart = (await this.store.collection(accounts).find({ type })).map((a) => ({ id: a.id, code: a.code, name: a.name, type: a.type, subtype: a.subtype }) as VisualAccount);
    const byId = new Map(chart.map((a) => [a.id, a]));
    const sums = chart.length
      ? await lineSums(this.store, org.id, {
          entry: postedBetween(toDbDate(`${from}-01`), toDbDate(lastDay(to)), { excludeClosing: true }),
          line: { accountId: { $in: chart.map((a) => a.id) } },
          by: { month: { $dateToString: { date: '$date', format: '%Y-%m' } }, accountId: 'lines.accountId' },
        })
      : [];
    const amounts: VisualAmount[] = [];
    for (const r of sums) {
      const a = byId.get(r.key.accountId as string);
      if (!a) continue;
      const v = type === 'REVENUE' ? r.credit.minus(r.debit) : r.debit.minus(r.credit);
      if (!v.isZero()) amounts.push({ accountId: a.id, month: r.key.month as string, amount: v.toFixed() });
    }
    const l = financialLandscape({ accounts: chart, amounts, months, view, scale: minorUnits(org.functionalCurrency) });
    return { currency: org.functionalCurrency, from, to, fromDate: `${from}-01`, toDate: lastDay(to), ...l };
  }
}
