import { DOUBTFUL_AFTER_DAYS } from './cashflow';
import { addDays, daysBetween } from './documents';
import { D } from './money';

/**
 * Cash collection forecasting (AR-039): money expected from customers week by week, from the
 * open invoices and when each is predicted to be paid (AR-033), beside what the due dates alone
 * would say. Deterministic: the same books always give the same forecast.
 *
 * - Each open invoice's outstanding amount falls in the week of its predicted payment date.
 * - Invoices over 90 days past due are shown apart as doubtful, not in any week: they are the
 *   ones bad-debt provisions are made for (the same cut-off as the cash-flow forecast).
 * - Predicted after the last week shown: "later".
 * - "By due date" puts each amount in the week it falls due (overdue amounts in the first week),
 *   to show how much the forecast differs from the terms.
 */

export const MAX_FORECAST_WEEKS = 26;

export interface ForecastInvoice {
  dueDate: string;
  predictedPayDate: string;
  outstanding: string;
  daysPastDue: number;
}

export interface ForecastWeek {
  /** First and last day of the week. */
  from: string;
  to: string;
  expected: string;
  byDueDate: string;
  invoices: number;
  /** Running total of expected collections. */
  cumulative: string;
}

export interface CollectionForecast {
  weeks: ForecastWeek[];
  later: { expected: string; byDueDate: string; invoices: number };
  doubtful: { amount: string; invoices: number };
  total: string;
  /** Expected within the weeks shown. */
  inHorizon: string;
}

export function collectionForecast(invoices: ForecastInvoice[], asOf: string, weeks: number, minorUnits: number): CollectionForecast {
  const n = Math.max(1, Math.min(MAX_FORECAST_WEEKS, Math.floor(weeks)));
  const buckets = Array.from({ length: n }, (_, k) => ({ from: addDays(asOf, k * 7), to: addDays(asOf, k * 7 + 6), expected: new D(0), byDueDate: new D(0), invoices: 0 }));
  const later = { expected: new D(0), byDueDate: new D(0), invoices: 0 };
  const doubtful = { amount: new D(0), invoices: 0 };
  let total = new D(0);
  const week = (date: string) => Math.floor(Math.max(0, daysBetween(asOf, date)) / 7);
  for (const i of invoices) {
    const o = new D(i.outstanding);
    if (o.lte(0)) continue;
    total = total.plus(o);
    if (i.daysPastDue > DOUBTFUL_AFTER_DAYS) {
      doubtful.amount = doubtful.amount.plus(o);
      doubtful.invoices++;
      continue;
    }
    const w = week(i.predictedPayDate);
    if (w < n) {
      buckets[w]!.expected = buckets[w]!.expected.plus(o);
      buckets[w]!.invoices++;
    } else {
      later.expected = later.expected.plus(o);
      later.invoices++;
    }
    const dw = week(i.dueDate);
    if (dw < n) buckets[dw]!.byDueDate = buckets[dw]!.byDueDate.plus(o);
    else later.byDueDate = later.byDueDate.plus(o);
  }
  let run = new D(0);
  const out = buckets.map((b) => {
    run = run.plus(b.expected);
    return { from: b.from, to: b.to, expected: b.expected.toFixed(minorUnits), byDueDate: b.byDueDate.toFixed(minorUnits), invoices: b.invoices, cumulative: run.toFixed(minorUnits) };
  });
  return {
    weeks: out,
    later: { expected: later.expected.toFixed(minorUnits), byDueDate: later.byDueDate.toFixed(minorUnits), invoices: later.invoices },
    doubtful: { amount: doubtful.amount.toFixed(minorUnits), invoices: doubtful.invoices },
    total: total.toFixed(minorUnits),
    inHorizon: run.toFixed(minorUnits),
  };
}
