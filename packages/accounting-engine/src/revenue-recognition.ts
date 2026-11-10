import { addMonth } from './fixed-assets';
import { dec } from './money';
import { checkDeferralTerms, deferralEndDate, deferralSchedule, type DeferralMethod } from './deferrals';

/**
 * Revenue recognition (AR-028). An invoice line for a service delivered over time (an annual
 * support plan, a year's subscription billed up front) can be recognised over its service period
 * instead of when it is invoiced: on posting, its net amount is credited to deferred revenue and a
 * deferred revenue schedule releases it to the line's revenue account month by month (by days or
 * evenly), through the organisation's monthly release run.
 */

export interface RecognitionTerms {
  /** YYYY-MM-DD: the first day of the service. */
  startDate: string;
  months: number;
  method: DeferralMethod;
}

/** What is wrong with a line's recognition terms. */
export function recognitionIssues(t: RecognitionTerms, line: { no: number; accountType: string | null; net: string }): string[] {
  const out: string[] = [];
  if (line.accountType !== 'REVENUE') out.push(`Line ${line.no}: only a line to a revenue account can be recognised over time`);
  if (dec(line.net).lte(0)) out.push(`Line ${line.no}: only a line with a positive amount can be recognised over time`);
  const terms = checkDeferralTerms({ amount: dec(line.net).gt(0) ? line.net : '1', startDate: t.startDate, months: t.months, method: t.method });
  for (const e of terms) out.push(`Line ${line.no}: ${e.charAt(0).toLowerCase()}${e.slice(1)}`);
  return out;
}

/** The last day of the service period. */
export const recognitionEnd = (t: Pick<RecognitionTerms, 'startDate' | 'months'>) => deferralEndDate(t);

/** A line's net amount in the functional currency, as the invoice's journal records it. */
export function functionalNet(net: string, exchangeRate: string, scale = 2): string {
  return dec(net).times(exchangeRate).toDecimalPlaces(scale).toFixed(scale);
}

export interface WaterfallSchedule {
  amount: string;
  startDate: string;
  months: number;
  method: DeferralMethod;
  endedOn?: string | null;
  /** Amounts released so far, by month (YYYY-MM). */
  posted: Record<string, string>;
}

/**
 * The revenue waterfall: for each of `count` months from `from` (YYYY-MM), what the schedules
 * recognise (posted months as posted, later months as scheduled), plus what was recognised
 * before `from` and what is still deferred after the last month shown.
 */
export function revenueWaterfall(schedules: WaterfallSchedule[], from: string, count: number, scale = 2) {
  const months = Array.from({ length: count }, (_, i) => addMonth(from, i));
  const last = months[months.length - 1]!;
  const byMonth = new Map(months.map((m) => [m, dec('0')]));
  let before = dec('0');
  let after = dec('0');
  let total = dec('0');
  for (const s of schedules) {
    const rows = deferralSchedule({ amount: s.amount, startDate: s.startDate, months: s.months, method: s.method, endedOn: s.endedOn ?? null }, '9999-12', s.posted, scale);
    total = total.plus(s.amount);
    for (const r of rows) {
      if (r.month < from) before = before.plus(r.amount);
      else if (r.month > last) after = after.plus(r.amount);
      else byMonth.set(r.month, byMonth.get(r.month)!.plus(r.amount));
    }
  }
  return {
    months: months.map((m) => ({ month: m, amount: byMonth.get(m)!.toFixed(scale) })),
    before: before.toFixed(scale),
    after: after.toFixed(scale),
    total: total.toFixed(scale),
  };
}
