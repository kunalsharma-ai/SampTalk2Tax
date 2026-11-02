import Decimal from 'decimal.js';
import { dec, type Dec } from './money';
import { addMonth, monthEnd, monthsBetween } from './fixed-assets';

/**
 * Prepaid expenses and deferred revenue: an amount paid or received for a period, released to
 * the income statement over that period, month by month.
 *
 * Conventions (documented in docs/PREPAID_AND_DEFERRED.md):
 * - EVEN: the same amount each calendar month, starting in the month of the start date, for the
 *   number of months given; the last month takes what rounding left, so the total is exact.
 * - DAILY: the amount is spread over the days from the start date to the end date (the start date
 *   plus the number of months, less one day), so a part month gets its share of days. Each
 *   month's release is the rounded cumulative share less what was released before, so rounding
 *   never adds up.
 * - A month already posted keeps the amount that was posted; the next month catches up any
 *   difference, and the last month always brings the total to the full amount.
 * - A schedule ended early stops: months after the end are dropped, and the end entry releases
 *   whatever is still left in one go.
 */
export type DeferralKind = 'PREPAID_EXPENSE' | 'DEFERRED_REVENUE';
export type DeferralMethod = 'EVEN' | 'DAILY';

export interface DeferralTerms {
  amount: string;
  /** YYYY-MM-DD: the first day the amount covers. */
  startDate: string;
  months: number;
  method: DeferralMethod;
  /** YYYY-MM-DD: when the schedule was ended early. */
  endedOn?: string | null;
}

export interface DeferralRow {
  month: string;
  amount: string;
  released: string;
  remaining: string;
  posted: boolean;
}

const DAY = 86_400_000;
const toTime = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const fromTime = (t: number) => new Date(t).toISOString().slice(0, 10);

/** The last day a schedule covers: the start date plus `months` months, less a day (31 Jan + 1 month runs to 27 Feb, as 28 Feb is the same day a month on). */
export function deferralEndDate(t: Pick<DeferralTerms, 'startDate' | 'months'>): string {
  const y = +t.startDate.slice(0, 4);
  const m = +t.startDate.slice(5, 7) - 1 + t.months;
  const d = +t.startDate.slice(8, 10);
  const ty = y + Math.floor(m / 12);
  const tm = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return fromTime(Date.UTC(ty, tm, Math.min(d, last)) - DAY);
}

/** The months that get a release, first and last (YYYY-MM). */
export function deferralMonths(t: Pick<DeferralTerms, 'startDate' | 'months' | 'method'>): { first: string; last: string } {
  const first = t.startDate.slice(0, 7);
  return { first, last: t.method === 'EVEN' ? addMonth(first, t.months - 1) : deferralEndDate(t).slice(0, 7) };
}

/** Problems with a schedule's terms, as sentences; empty when they are usable. */
export function checkDeferralTerms(t: DeferralTerms, scale = 2): string[] {
  const errors: string[] = [];
  try {
    const a = dec(t.amount);
    if (a.lte(0)) errors.push('The amount must be more than zero');
    if (a.decimalPlaces() > scale) errors.push(`The amount has more than ${scale} decimal places`);
  } catch {
    errors.push('The amount is not an amount');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.startDate) || fromTime(toTime(t.startDate)) !== t.startDate) errors.push('The start date is not a date');
  if (!Number.isInteger(t.months) || t.months < 1 || t.months > 120) errors.push('The period must be 1 to 120 months');
  if (t.method !== 'EVEN' && t.method !== 'DAILY') errors.push('Release evenly by month or by days');
  return errors;
}

/** What should have been released by the end of `month`, in total. */
function targetThrough(t: DeferralTerms, month: string, total: Dec, round: (x: Dec) => Dec): Dec {
  const { first, last } = deferralMonths(t);
  if (month < first) return dec('0');
  if (month >= last) return total;
  if (t.method === 'EVEN') {
    const per = round(total.div(t.months));
    return Decimal.min(per.times(monthsBetween(first, month) + 1), total);
  }
  const start = toTime(t.startDate);
  const totalDays = (toTime(deferralEndDate(t)) - start) / DAY + 1;
  const days = (toTime(monthEnd(month)) - start) / DAY + 1;
  return round(total.times(days).div(totalDays));
}

/**
 * The release schedule from the first month through `through` (inclusive). `posted` holds the
 * amounts already posted by month; those are used as they are.
 */
export function deferralSchedule(t: DeferralTerms, through: string, posted: Record<string, string> = {}, scale = 2): DeferralRow[] {
  const total = dec(t.amount);
  const round = (x: Dec) => x.toDecimalPlaces(scale, Decimal.ROUND_HALF_EVEN);
  const { first, last } = deferralMonths(t);
  const endMonth = t.endedOn ? t.endedOn.slice(0, 7) : null;
  const lastPosted = Object.keys(posted).sort().at(-1) ?? null;
  const stop = [through, lastPosted && lastPosted > last ? lastPosted : last].sort()[0]!;
  const rows: DeferralRow[] = [];
  let released = dec('0');
  for (let m = first; m <= stop; m = addMonth(m, 1)) {
    if (endMonth && m > endMonth) break;
    const isPosted = posted[m] !== undefined;
    if (endMonth && m === endMonth && !isPosted) break;
    const amount = isPosted ? dec(posted[m]!) : Decimal.max(targetThrough(t, m, total, round).minus(released), new Decimal(0));
    released = released.plus(amount);
    rows.push({ month: m, amount: amount.toFixed(scale), released: released.toFixed(scale), remaining: total.minus(released).toFixed(scale), posted: isPosted });
  }
  return rows;
}

/** The released total so far (posted amounts) and what is left in the balance sheet account. */
export function deferralBalance(amount: string, posted: Record<string, string>, scale = 2): { released: string; remaining: string } {
  const released = Object.values(posted).reduce((s, v) => s.plus(v), dec('0'));
  return { released: released.toFixed(scale), remaining: dec(amount).minus(released).toFixed(scale) };
}

/**
 * The lines of a release: a prepaid expense moves from the asset to the expense account, deferred
 * revenue from the liability to the revenue account.
 */
export function releaseLines(kind: DeferralKind, amount: string): { role: 'BALANCE' | 'PNL'; debit?: string; credit?: string }[] {
  return kind === 'PREPAID_EXPENSE'
    ? [
        { role: 'PNL', debit: amount },
        { role: 'BALANCE', credit: amount },
      ]
    : [
        { role: 'BALANCE', debit: amount },
        { role: 'PNL', credit: amount },
      ];
}

/** The first day of the month after `month` (where an accrual's automatic reversal goes). */
export function firstOfNextMonth(month: string): string {
  return `${addMonth(month, 1)}-01`;
}
