import { HttpStatus, Injectable } from '@nestjs/common';
import { D, expenseHeatmap, expenseTreemap, incomeSankey, plWaterfall, type VisualAccount, type VisualAmount } from '@talk2tax/accounting-engine';
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
 * Financial visuals (DASH-028/029/030/031/034): the profit and loss of a range of months as a
 * waterfall, a Sankey of where income went, a heatmap of spending by account and month, and a
 * treemap of spending, all from posted journals (closing entries left out). Each figure names its
 * accounts so the page can open their general ledger for the same months. Read only; reports.read.
 */
@Injectable()
export class FinancialVisualsService {
  constructor(private readonly store: DocumentStoreService) {}

  async visuals(org: OrgContext, q: { from?: string; to?: string }) {
    const to = q.to ?? todayIso().slice(0, 7);
    const from = q.from ?? shift(to, -11);
    if (from > to) throw new DomainError('INVALID_PERIOD', 'The first month must not be after the last');
    const months: string[] = [];
    for (let m = from; m <= to; m = shift(m, 1)) {
      months.push(m);
      if (months.length > MAX_MONTHS) throw new DomainError('PERIOD_TOO_LONG', `Choose at most ${MAX_MONTHS} months`, HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const chart = (await this.store.collection(accounts).find({ type: { $in: ['REVENUE', 'EXPENSE'] } })).map((a) => ({ id: a.id, code: a.code, name: a.name, type: a.type, subtype: a.subtype }) as VisualAccount);
    const byId = new Map(chart.map((a) => [a.id, a]));
    const sums = await lineSums(this.store, org.id, {
      entry: postedBetween(toDbDate(`${from}-01`), toDbDate(lastDay(to)), { excludeClosing: true }),
      by: { month: { $dateToString: { date: '$date', format: '%Y-%m' } }, accountId: 'lines.accountId' },
    });
    const amounts: VisualAmount[] = [];
    for (const r of sums) {
      const a = byId.get(r.key.accountId as string);
      if (!a) continue;
      const v = a.type === 'REVENUE' ? r.credit.minus(r.debit) : r.debit.minus(r.credit);
      if (!v.isZero()) amounts.push({ accountId: a.id, month: r.key.month as string, amount: v.toFixed() });
    }
    const used = [...new Set(amounts.map((x) => x.accountId))].map((id) => byId.get(id)!);
    return {
      from,
      to,
      fromDate: `${from}-01`,
      toDate: lastDay(to),
      months,
      currency: org.functionalCurrency,
      empty: amounts.length === 0,
      accounts: used
        .map((a) => ({ id: a.id, code: a.code, name: a.name, type: a.type, total: amounts.filter((x) => x.accountId === a.id).reduce((t, x) => t.plus(x.amount), new D(0)).toFixed(2) }))
        .sort((x, y) => x.code.localeCompare(y.code)),
      waterfall: plWaterfall(chart, amounts),
      sankey: incomeSankey(chart, amounts),
      heatmap: expenseHeatmap(chart, amounts, months),
      treemap: expenseTreemap(chart, amounts),
    };
  }
}
