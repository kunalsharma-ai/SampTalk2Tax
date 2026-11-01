/**
 * Cash-flow forecasting: when open invoices are likely to be paid (from each customer's own
 * payment history), when bills fall due, planned recurring receipts and payments, and the
 * day-by-day cash balance that results, with a likely range. Also how a saved forecast
 * compared with what actually happened.
 *
 * The range is not a statistical confidence interval. It comes from the spread of past
 * payment delays (the 25th and 75th percentiles) and from treating long-overdue invoices as
 * doubtful, and it is described that way to users.
 */
import { D, Dec, dec, sum } from './money';
import { addDays, daysBetween } from './documents';

export const FORECAST_HORIZONS = [30, 60, 90, 180, 365] as const;
export type ForecastHorizon = (typeof FORECAST_HORIZONS)[number];
/** Invoices overdue by more than this many days count only in the optimistic case. */
export const DOUBTFUL_AFTER_DAYS = 90;
/** Fewer paid invoices than this and a contact's own history is not used. */
export const MIN_DELAY_SAMPLES = 3;
export type PlannedFrequency = 'ONCE' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY';

export class CashFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CashFlowError';
  }
}

export interface DelayStats {
  count: number;
  p25: number;
  median: number;
  p75: number;
}

/** Nearest-rank percentile of whole days. */
function percentile(sorted: number[], p: number): number {
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

/**
 * Spread of payment delays in days after the due date (negative = paid early). Returns null
 * with fewer than `min` samples.
 */
export function delayStats(samples: readonly number[], min = MIN_DELAY_SAMPLES): DelayStats | null {
  if (samples.some((s) => !Number.isInteger(s))) throw new CashFlowError('Delays are whole days');
  if (samples.length < min) return null;
  const s = [...samples].sort((a, b) => a - b);
  return { count: s.length, p25: percentile(s, 25), median: percentile(s, 50), p75: percentile(s, 75) };
}

export interface ExpectedDates {
  /** Earliest likely date (the 25th percentile delay). */
  early: string;
  base: string;
  /** Latest likely date (the 75th percentile delay). */
  late: string;
  /** Already later than the contact usually pays. */
  pastTypical: boolean;
  /** Overdue by more than DOUBTFUL_AFTER_DAYS: counted only in the optimistic case. */
  doubtful: boolean;
}

/**
 * When an open item is likely to be settled: its due date plus the usual delay, never before
 * the day after `asOf`. Without history the due date is used for all three.
 */
export function expectedDates(dueDate: string, asOf: string, stats: DelayStats | null): ExpectedDates {
  const first = addDays(asOf, 1);
  const at = (delay: number) => {
    const d = addDays(dueDate, delay);
    return d < first ? first : d;
  };
  const s = stats ?? { count: 0, p25: 0, median: 0, p75: 0 };
  const overdue = daysBetween(dueDate, asOf);
  return {
    early: at(s.p25),
    base: at(s.median),
    late: at(s.p75),
    pastTypical: addDays(dueDate, s.median) <= asOf,
    doubtful: overdue > DOUBTFUL_AFTER_DAYS,
  };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
function addMonthsClamped(iso: string, months: number, day: number): string {
  const y = +iso.slice(0, 4);
  const m = +iso.slice(5, 7) - 1 + months;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  return `${yy}-${String(mm + 1).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

/**
 * Dates of a planned item from `from` to `to` (inclusive). Monthly items keep their day of the
 * month, using the last day in shorter months (31 Jan → 28 Feb → 31 Mar).
 */
export function plannedDates(item: { startDate: string; endDate?: string | null; frequency: PlannedFrequency }, from: string, to: string): string[] {
  if (!ISO.test(item.startDate) || (item.endDate && !ISO.test(item.endDate))) throw new CashFlowError('Dates are YYYY-MM-DD');
  const stop = item.endDate && item.endDate < to ? item.endDate : to;
  const out: string[] = [];
  const day = +item.startDate.slice(8, 10);
  const months = { MONTHLY: 1, QUARTERLY: 3, YEARLY: 12 } as const;
  for (let i = 0; i < 5000; i++) {
    let d: string;
    if (item.frequency === 'ONCE') {
      if (i > 0) break;
      d = item.startDate;
    } else if (item.frequency === 'WEEKLY') d = addDays(item.startDate, 7 * i);
    else d = addMonthsClamped(item.startDate, months[item.frequency] * i, day);
    if (d > stop) break;
    if (d >= from) out.push(d);
  }
  return out;
}

export type FlowCategory = 'RECEIVABLE' | 'PAYABLE' | 'PLANNED_IN' | 'PLANNED_OUT';

export interface CashFlowInput {
  /** Positive = cash in, negative = cash out. */
  amount: string | Dec;
  category: FlowCategory;
  dates: { early: string; base: string; late: string };
  /** Counted only in the optimistic case. */
  doubtful?: boolean;
  ref?: string;
}

export interface ForecastDay {
  date: string;
  base: string;
  /** The lower of the two other cases: money in late, money out early, doubtful invoices left out. */
  low: string;
  /** Money in early, money out late, doubtful invoices included. */
  high: string;
}

export interface ForecastBucket {
  from: string;
  to: string;
  opening: string;
  inflows: Record<'RECEIVABLE' | 'PLANNED_IN', string>;
  outflows: Record<'PAYABLE' | 'PLANNED_OUT', string>;
  net: string;
  closing: string;
  low: string;
  high: string;
}

export interface CashForecast {
  asOf: string;
  start: string;
  end: string;
  opening: string;
  days: ForecastDay[];
  buckets: ForecastBucket[];
  closing: { base: string; low: string; high: string };
  lowest: { base: { date: string; amount: string }; low: { date: string; amount: string } };
  /** First day the balance falls below the buffer, in the base and the low case. */
  belowBuffer: { base: string | null; low: string | null };
  totals: Record<FlowCategory, string>;
}

/**
 * The daily balance from the day after `asOf` for `horizonDays` days, in three cases, and its
 * weekly (up to 90 days) or monthly buckets in the base case.
 */
export function buildCashForecast(input: { asOf: string; horizonDays: number; opening: string | Dec; flows: readonly CashFlowInput[]; buffer?: string | Dec | null; scale?: number }): CashForecast {
  const scale = input.scale ?? 2;
  if (!Number.isInteger(input.horizonDays) || input.horizonDays < 1 || input.horizonDays > 400) throw new CashFlowError('The horizon is 1 to 400 days');
  const start = addDays(input.asOf, 1);
  const end = addDays(input.asOf, input.horizonDays);
  const opening = dec(input.opening);
  const index = (date: string) => daysBetween(start, date);
  const n = input.horizonDays;
  const zeros = () => Array.from({ length: n }, () => new D(0));
  const base = zeros();
  const low = zeros();
  const high = zeros();
  const cat: Record<FlowCategory, Dec[]> = { RECEIVABLE: zeros(), PAYABLE: zeros(), PLANNED_IN: zeros(), PLANNED_OUT: zeros() };
  const put = (arr: Dec[], date: string, amt: Dec) => {
    const i = index(date);
    if (i >= 0 && i < n) arr[i] = arr[i].plus(amt);
  };
  for (const f of input.flows) {
    const amt = dec(f.amount);
    const inflow = amt.greaterThan(0);
    if (!f.doubtful) {
      put(base, f.dates.base, amt);
      put(cat[f.category], f.dates.base, amt);
      put(low, inflow ? f.dates.late : f.dates.early, amt);
    }
    if (f.doubtful && !inflow) throw new CashFlowError('Only money coming in can be doubtful');
    put(high, inflow ? f.dates.early : f.dates.late, amt);
  }
  const running = (moves: Dec[]) => {
    let bal = opening;
    return moves.map((m) => (bal = bal.plus(m)));
  };
  const b = running(base);
  const l = running(low);
  const h = running(high);
  const dates = Array.from({ length: n }, (_, i) => addDays(start, i));
  const days: ForecastDay[] = dates.map((date, i) => {
    const lo = D.min(l[i], b[i], h[i]);
    const hi = D.max(l[i], b[i], h[i]);
    return { date, base: b[i].toFixed(scale), low: lo.toFixed(scale), high: hi.toFixed(scale) };
  });
  const minOf = (arr: Dec[]) => arr.reduce((m, x, i) => (x.lessThan(m.v) ? { v: x, i } : m), { v: arr[0], i: 0 });
  const lb = minOf(b);
  const ll = minOf(days.map((d) => new D(d.low)));
  const buffer = input.buffer === undefined || input.buffer === null ? null : dec(input.buffer);
  const firstBelow = (arr: Dec[]) => {
    if (!buffer) return null;
    const i = arr.findIndex((x) => x.lessThan(buffer));
    return i < 0 ? null : dates[i];
  };

  // Buckets: weeks up to 90 days, months beyond.
  const ranges: { from: number; to: number }[] = [];
  if (n <= 90) for (let i = 0; i < n; i += 7) ranges.push({ from: i, to: Math.min(i + 6, n - 1) });
  else {
    let i = 0;
    while (i < n) {
      const d = dates[i];
      const nextMonth = addMonthsClamped(`${d.slice(0, 7)}-01`, 1, 1);
      const j = Math.min(n - 1, index(nextMonth) - 1);
      ranges.push({ from: i, to: j });
      i = j + 1;
    }
  }
  const sumRange = (arr: Dec[], r: { from: number; to: number }) => sum(arr.slice(r.from, r.to + 1));
  const buckets: ForecastBucket[] = ranges.map((r) => {
    const openingBal = r.from === 0 ? opening : b[r.from - 1];
    const net = sumRange(base, r);
    return {
      from: dates[r.from],
      to: dates[r.to],
      opening: openingBal.toFixed(scale),
      inflows: { RECEIVABLE: sumRange(cat.RECEIVABLE, r).toFixed(scale), PLANNED_IN: sumRange(cat.PLANNED_IN, r).toFixed(scale) },
      outflows: { PAYABLE: sumRange(cat.PAYABLE, r).negated().toFixed(scale), PLANNED_OUT: sumRange(cat.PLANNED_OUT, r).negated().toFixed(scale) },
      net: net.toFixed(scale),
      closing: b[r.to].toFixed(scale),
      low: days[r.to].low,
      high: days[r.to].high,
    };
  });
  return {
    asOf: input.asOf,
    start,
    end,
    opening: opening.toFixed(scale),
    days,
    buckets,
    closing: { base: days[n - 1].base, low: days[n - 1].low, high: days[n - 1].high },
    lowest: { base: { date: dates[lb.i], amount: lb.v.toFixed(scale) }, low: { date: dates[ll.i], amount: ll.v.toFixed(scale) } },
    belowBuffer: { base: firstBelow(b), low: firstBelow(days.map((d) => new D(d.low))) },
    totals: {
      RECEIVABLE: sum(cat.RECEIVABLE).toFixed(scale),
      PAYABLE: sum(cat.PAYABLE).negated().toFixed(scale),
      PLANNED_IN: sum(cat.PLANNED_IN).toFixed(scale),
      PLANNED_OUT: sum(cat.PLANNED_OUT).negated().toFixed(scale),
    },
  };
}

export interface ForecastAccuracy {
  /** Days with both a forecast and an actual balance. */
  days: number;
  /** Mean of |actual − base|. */
  meanAbsoluteError: string;
  /** Mean of (actual − base): positive means the forecast was too low. */
  bias: string;
  /** Share of days the actual was inside the forecast range, as a percentage with one decimal. */
  withinRange: string;
  largestMiss: { date: string; forecast: string; actual: string; error: string } | null;
  series: { date: string; base: string; low: string; high: string; actual: string; error: string }[];
}

/** How a saved forecast compares with the actual closing cash balance of each day so far. */
export function forecastAccuracy(forecast: readonly ForecastDay[], actual: ReadonlyMap<string, string | Dec>, scale = 2): ForecastAccuracy {
  const series = forecast
    .filter((d) => actual.has(d.date))
    .map((d) => {
      const a = dec(actual.get(d.date)!);
      const e = a.minus(d.base);
      return { date: d.date, base: d.base, low: d.low, high: d.high, actual: a.toFixed(scale), error: e.toFixed(scale), inside: !a.lessThan(d.low) && !a.greaterThan(d.high), e };
    });
  if (!series.length) return { days: 0, meanAbsoluteError: (0).toFixed(scale), bias: (0).toFixed(scale), withinRange: '0.0', largestMiss: null, series: [] };
  const k = new D(series.length);
  const worst = series.reduce((w, s) => (s.e.abs().greaterThan(w.e.abs()) ? s : w), series[0]);
  return {
    days: series.length,
    meanAbsoluteError: sum(series.map((s) => s.e.abs())).dividedBy(k).toFixed(scale),
    bias: sum(series.map((s) => s.e)).dividedBy(k).toFixed(scale),
    withinRange: new D(series.filter((s) => s.inside).length).dividedBy(k).times(100).toFixed(1),
    largestMiss: { date: worst.date, forecast: worst.base, actual: worst.actual, error: worst.error },
    series: series.map(({ inside: _i, e: _e, ...rest }) => rest),
  };
}
