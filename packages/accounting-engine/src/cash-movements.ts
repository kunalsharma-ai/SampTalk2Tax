/**
 * Cash movement forecasting (BANK-022): the bank balance over the next weeks, from what the bank
 * statements show. Deterministic and explainable; no model or outside data is used, and amounts
 * are decimal strings.
 *
 * - Recurring movements: lines in the year before with the same narration (case, numbers and
 *   punctuation ignored) and direction, at least 3 of them, every 5 to 9 days (weekly), 25 to 35
 *   (monthly) or 85 to 97 (quarterly), each within 25% of their median amount. One is still running
 *   when its last line is no older than one and a half of its periods; it is projected forward from
 *   its last line at its median amount. An occurrence that is due but not seen yet is put on the
 *   first day of the forecast.
 * - Everything else: the other lines of the last 13 weeks, as weekly money in and money out. Each
 *   week ahead adds the average week; the range adds the 25th and 75th percentile weeks instead
 *   (or the average, when it lies outside them).
 *   The range is how the weeks have varied, not a statistical confidence interval.
 * - The forecast starts from the account's balance in the books.
 */
import { addMonthsAnchored } from './contracts';
import { addDays, daysBetween } from './documents';
import { D, Dec } from './money';
import { normaliseNarration } from './bank-activity';

export const CASH_MOVEMENT_HORIZONS = [30, 60, 90] as const;
export const CASH_MOVEMENT_FREQUENCIES = ['WEEKLY', 'MONTHLY', 'QUARTERLY'] as const;
export type CashMovementFrequency = (typeof CASH_MOVEMENT_FREQUENCIES)[number];
export const CASH_MOVEMENT_FREQUENCY_LABEL: Record<CashMovementFrequency, string> = { WEEKLY: 'Weekly', MONTHLY: 'Monthly', QUARTERLY: 'Quarterly' };
const GAP: Record<CashMovementFrequency, [number, number]> = { WEEKLY: [5, 9], MONTHLY: [25, 35], QUARTERLY: [85, 97] };
const PERIOD_DAYS: Record<CashMovementFrequency, number> = { WEEKLY: 7, MONTHLY: 30, QUARTERLY: 91 };
export const CASH_MOVEMENT_MIN_COUNT = 3;
export const CASH_MOVEMENT_AMOUNT_SPREAD = '0.25';
export const CASH_MOVEMENT_HISTORY_DAYS = 365;
export const CASH_MOVEMENT_OTHER_WEEKS = 13;

export interface CashMovementLine {
  id: string;
  date: string;
  /** Positive is money in. */
  amount: string;
  description: string;
}

export interface RecurringMovement {
  /** A narration as it last appeared. */
  narration: string;
  direction: 'IN' | 'OUT';
  frequency: CashMovementFrequency;
  /** Median, signed: negative for money out. */
  amount: string;
  /** Largest difference from the median, as a whole percentage. */
  spreadPercent: number;
  count: number;
  firstDate: string;
  lastDate: string;
  running: boolean;
  /** Projected dates in the forecast, each with the amount. */
  next: { date: string; amount: string; late: boolean }[];
  lineIds: string[];
}

export interface CashMovementWeek {
  from: string;
  to: string;
  recurringIn: string;
  recurringOut: string;
  otherIn: string;
  otherOut: string;
  net: string;
  balance: string;
  low: string;
  high: string;
}

export interface CashMovementForecast {
  asOf: string;
  days: number;
  startBalance: string;
  /** Statement lines used, and the dates they span. */
  basis: { lines: number; from: string | null; to: string | null; otherWeeks: number };
  recurring: RecurringMovement[];
  other: { weeklyIn: string; weeklyOut: string; lowNet: string; highNet: string };
  weeks: CashMovementWeek[];
  endBalance: string;
  lowest: { balance: string; weekTo: string };
  /** Less than 13 weeks of statements: the rest of the movements are a rough guide. */
  thin: boolean;
}

function median(xs: Dec[]): Dec {
  const s = [...xs].sort((a, b) => a.comparedTo(b));
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : s[m - 1]!.plus(s[m]!).div(2);
}

/** Nearest-rank percentile of decimals; zero for none. */
function pct(xs: Dec[], p: number): Dec {
  if (!xs.length) return new D(0);
  const s = [...xs].sort((a, b) => a.comparedTo(b));
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

function frequencyOf(dates: string[]): CashMovementFrequency | null {
  const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i]!, d));
  return CASH_MOVEMENT_FREQUENCIES.find((f) => gaps.every((g) => g >= GAP[f][0] && g <= GAP[f][1])) ?? null;
}

const step = (from: string, f: CashMovementFrequency, k: number) => (f === 'WEEKLY' ? addDays(from, 7 * k) : addMonthsAnchored(from, (f === 'MONTHLY' ? 1 : 3) * k));

/** Movements that repeat on the statement, found in `lines` up to `asOf`. */
export function recurringMovements(lines: CashMovementLine[], asOf: string, days: number, scale: number): RecurringMovement[] {
  const end = addDays(asOf, days);
  const since = addDays(asOf, -CASH_MOVEMENT_HISTORY_DAYS);
  const groups = new Map<string, CashMovementLine[]>();
  for (const l of lines) {
    if (l.date <= since || l.date > asOf) continue;
    const name = normaliseNarration(l.description);
    if (!name || new D(l.amount).isZero()) continue;
    const key = `${new D(l.amount).isNeg() ? 'OUT' : 'IN'}|${name}`;
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }
  const out: RecurringMovement[] = [];
  for (const [key, g] of groups) {
    if (g.length < CASH_MOVEMENT_MIN_COUNT) continue;
    g.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    const f = frequencyOf(g.map((l) => l.date));
    if (!f) continue;
    const sizes = g.map((l) => new D(l.amount).abs());
    const m = median(sizes);
    const worst = sizes.reduce((w, s) => D.max(w, s.minus(m).abs()), new D(0));
    if (worst.gt(m.times(CASH_MOVEMENT_AMOUNT_SPREAD))) continue;
    const direction = key.startsWith('OUT') ? 'OUT' : 'IN';
    const signed = (direction === 'OUT' ? m.neg() : m).toFixed(scale);
    const last = g[g.length - 1]!;
    const running = daysBetween(last.date, asOf) <= Math.ceil(PERIOD_DAYS[f] * 1.5);
    const next: RecurringMovement['next'] = [];
    if (running)
      for (let k = 1; ; k++) {
        const d = step(last.date, f, k);
        if (d > end) break;
        if (d <= asOf) next.push({ date: addDays(asOf, 1), amount: signed, late: true });
        else next.push({ date: d, amount: signed, late: false });
      }
    out.push({
      narration: last.description,
      direction,
      frequency: f,
      amount: signed,
      spreadPercent: m.isZero() ? 0 : worst.div(m).times(100).toDecimalPlaces(0, D.ROUND_HALF_UP).toNumber(), // not money: a percentage
      count: g.length,
      firstDate: g[0]!.date,
      lastDate: last.date,
      running,
      next,
      lineIds: g.map((l) => l.id),
    });
  }
  // not money: running ones first
  return out.sort((a, b) => Number(b.running) - Number(a.running) || new D(b.amount).abs().comparedTo(new D(a.amount).abs()) || a.narration.localeCompare(b.narration));
}

/**
 * The account's balance week by week for `days` after `asOf`, from its statement `lines` (the
 * year before is enough) and its balance in the books.
 */
export function forecastCashMovements(lines: CashMovementLine[], startBalance: string, asOf: string, days: number, scale: number): CashMovementForecast {
  const used = lines.filter((l) => l.date <= asOf && l.date > addDays(asOf, -CASH_MOVEMENT_HISTORY_DAYS)).sort((a, b) => a.date.localeCompare(b.date));
  const recurring = recurringMovements(used, asOf, days, scale);
  const inRecurring = new Set(recurring.flatMap((r) => r.lineIds));

  // The rest of the last 13 weeks, week by week (weeks end on asOf).
  const firstLine = used[0]?.date ?? null;
  const weeksSeen = firstLine ? Math.min(CASH_MOVEMENT_OTHER_WEEKS, Math.max(1, Math.ceil((daysBetween(firstLine, asOf) + 1) / 7))) : 0;
  const weekIn: Dec[] = [];
  const weekOut: Dec[] = [];
  for (let w = 0; w < weeksSeen; w++) {
    const to = addDays(asOf, -7 * w);
    const from = addDays(to, -6);
    const xs = used.filter((l) => !inRecurring.has(l.id) && l.date >= from && l.date <= to).map((l) => new D(l.amount));
    weekIn.push(xs.filter((x) => x.gt(0)).reduce((s, x) => s.plus(x), new D(0)));
    weekOut.push(xs.filter((x) => x.lt(0)).reduce((s, x) => s.plus(x), new D(0)));
  }
  const mean = (xs: Dec[]) => (xs.length ? xs.reduce((s, x) => s.plus(x), new D(0)).div(xs.length) : new D(0));
  const avgIn = mean(weekIn);
  const avgOut = mean(weekOut);
  const nets = weekIn.map((x, i) => x.plus(weekOut[i]!));
  // The range never leaves out the average week, which a few large weeks can pull outside it.
  const avgNet = avgIn.plus(avgOut);
  const lowNet = D.min(pct(nets, 25), avgNet);
  const highNet = D.max(pct(nets, 75), avgNet);

  const weeks: CashMovementWeek[] = [];
  let balance = new D(startBalance);
  let low = balance;
  let high = balance;
  // The lowest week-end balance ahead (today's when there are no weeks).
  let lowest: { balance: Dec; weekTo: string } | null = null;
  for (let from = addDays(asOf, 1); from <= addDays(asOf, days); from = addDays(from, 7)) {
    const to = [addDays(from, 6), addDays(asOf, days)].sort()[0]!;
    // A part week takes its share of the average week.
    const share = new D(daysBetween(from, to) + 1).div(7);
    const due = recurring.flatMap((r) => r.next).filter((n) => n.date >= from && n.date <= to).map((n) => new D(n.amount));
    const rIn = due.filter((x) => x.gt(0)).reduce((s, x) => s.plus(x), new D(0));
    const rOut = due.filter((x) => x.lt(0)).reduce((s, x) => s.plus(x), new D(0));
    const oIn = avgIn.times(share);
    const oOut = avgOut.times(share);
    const net = rIn.plus(rOut).plus(oIn).plus(oOut);
    balance = balance.plus(net);
    low = low.plus(rIn).plus(rOut).plus(lowNet.times(share));
    high = high.plus(rIn).plus(rOut).plus(highNet.times(share));
    if (!lowest || balance.lt(lowest.balance)) lowest = { balance, weekTo: to };
    weeks.push({ from, to, recurringIn: rIn.toFixed(scale), recurringOut: rOut.toFixed(scale), otherIn: oIn.toFixed(scale), otherOut: oOut.toFixed(scale), net: net.toFixed(scale), balance: balance.toFixed(scale), low: low.toFixed(scale), high: high.toFixed(scale) });
  }
  lowest ??= { balance, weekTo: asOf };
  return {
    asOf,
    days,
    startBalance: new D(startBalance).toFixed(scale),
    basis: { lines: used.length, from: firstLine, to: used[used.length - 1]?.date ?? null, otherWeeks: weeksSeen },
    recurring,
    other: { weeklyIn: avgIn.toFixed(scale), weeklyOut: avgOut.toFixed(scale), lowNet: lowNet.toFixed(scale), highNet: highNet.toFixed(scale) },
    weeks,
    endBalance: balance.toFixed(scale),
    lowest: { balance: lowest.balance.toFixed(scale), weekTo: lowest.weekTo },
    thin: weeksSeen < CASH_MOVEMENT_OTHER_WEEKS,
  };
}
