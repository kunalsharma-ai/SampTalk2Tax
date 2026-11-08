import { addDays } from './documents';
import { D, dec, Dec, minorUnits } from './money';

/**
 * Payment scheduling (AP-007). Each open bill can be given the date it is planned to be paid (and
 * how much, for part of it). The schedule shows the planned payments week by week against the cash
 * in the bank accounts, so a week that would overdraw is seen before it comes. A payment batch can
 * then be prepared from the bills planned for a date. Planning moves no money.
 */

export type PlanTiming = 'OVERDUE' | 'LATE' | 'ON_TIME';

const weekday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

/**
 * The date to plan a bill's payment for: its due date, or the last pay day (0 Sunday .. 6 Saturday)
 * on or before it when the organisation pays on a fixed weekday. Never before today: a bill already
 * due, or due before the next pay day, is planned for today (or the next pay day if `weekday` is set
 * and the bill is already overdue).
 */
export function suggestPayDate(dueDate: string, today: string, payWeekday?: number | null): string {
  if (payWeekday == null) return dueDate < today ? today : dueDate;
  if (!Number.isInteger(payWeekday) || payWeekday < 0 || payWeekday > 6) throw new RangeError('Pay day must be 0 (Sunday) to 6 (Saturday)');
  if (dueDate < today) return addDays(today, (payWeekday - weekday(today) + 7) % 7);
  const before = addDays(dueDate, -((weekday(dueDate) - payWeekday + 7) % 7));
  return before < today ? today : before;
}

/** Whether a planned date pays the bill on time. OVERDUE: the bill is already past due today. */
export function planTiming(payDate: string, dueDate: string, today: string): PlanTiming {
  if (dueDate < today) return 'OVERDUE';
  return payDate > dueDate ? 'LATE' : 'ON_TIME';
}

/** Problems with a planned payment, or an empty list. */
export function planIssues(p: { payDate: string; amount?: string | null; issueDate: string; due: string; currency: string; today: string }): string[] {
  const issues: string[] = [];
  if (p.payDate < p.today) issues.push('The planned date cannot be in the past');
  if (p.payDate < p.issueDate) issues.push('The planned date cannot be before the bill date');
  if (p.amount != null && p.amount !== '') {
    let a: Dec;
    try {
      a = dec(p.amount);
    } catch {
      return [...issues, `${p.amount} is not an amount`];
    }
    if (a.lte(0)) issues.push('The amount to pay must be more than zero');
    else if (a.gt(dec(p.due))) issues.push(`The amount to pay is more than the ${dec(p.due).toFixed(minorUnits(p.currency))} left on the bill`);
    else if (a.decimalPlaces() > minorUnits(p.currency)) issues.push(`${p.amount} has more decimals than ${p.currency} allows`);
  }
  return issues;
}

/** The Monday of the week a date falls in. */
export function weekStart(iso: string): string {
  return addDays(iso, -((weekday(iso) + 6) % 7));
}

export interface PlannedOutflow {
  payDate: string;
  amount: string;
}

export interface ScheduleWeek {
  /** Monday of the week; the first row also carries everything planned before it (overdue plans). */
  week: string;
  payments: number;
  amount: string;
  /** Cash left after this week's planned payments. */
  balanceAfter: string;
  short: boolean;
}

/**
 * Planned payments by week from `from`, against `cash` (the bank balances now). Plans dated before
 * `from` count in the first week. Only outflows are counted: receipts are not forecast here.
 */
export function scheduleWeeks(plans: PlannedOutflow[], cash: string, from: string, weeks: number, currency: string): ScheduleWeek[] {
  const scale = minorUnits(currency);
  const first = weekStart(from);
  const rows = Array.from({ length: weeks }, (_, i) => ({ week: addDays(first, i * 7), payments: 0, amount: new D(0) }));
  for (const p of plans) {
    const w = weekStart(p.payDate < first ? first : p.payDate);
    const i = Math.round((Date.parse(`${w}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / (7 * 86_400_000));
    if (i >= weeks) continue;
    rows[i]!.payments++;
    rows[i]!.amount = rows[i]!.amount.plus(dec(p.amount));
  }
  let balance = dec(cash);
  return rows.map((r) => {
    balance = balance.minus(r.amount);
    return { week: r.week, payments: r.payments, amount: r.amount.toFixed(scale), balanceAfter: balance.toFixed(scale), short: balance.lt(0) };
  });
}
