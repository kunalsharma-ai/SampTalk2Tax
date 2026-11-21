/**
 * Suggested payment plans (AR-040): for a customer behind on paying, a schedule of monthly
 * instalments that clears what is overdue, sized to what the customer has actually been paying,
 * and, once a plan is agreed, how it is going. Deterministic and explainable: every suggestion says
 * why it has that many instalments, and amounts are decimal strings, never JS numbers.
 *
 * Suggestion:
 * - It covers invoices past their due date that are not in dispute. Disputed invoices are left out
 *   (settle the dispute first).
 * - The number of instalments is what overdue amount ÷ the customer's average monthly receipts over
 *   the last 6 months comes to, rounded up, between 2 and 12. With no receipts in that time it is 3.
 *   With anything more than 90 days overdue it is at most 6, so old debt is not stretched further.
 * - The first instalment is due in 7 days (or a chosen date in the next 60 days), the rest on the
 *   same day of each following month. Instalments are equal; the last takes the rounding.
 *
 * Progress: money received against the plan's invoices since it was agreed pays instalments in
 * order. A plan is on track, behind (an instalment past its date not fully paid), broken (one more
 * than 7 days past its date), completed or cancelled.
 */
import { addMonthsAnchored } from './contracts';
import { addDays, daysBetween } from './documents';
import { D } from './money';

export const PAYMENT_PLAN_MIN_INSTALMENTS = 1;
export const PAYMENT_PLAN_MAX_INSTALMENTS = 12;
export const PAYMENT_PLAN_DEFAULT_INSTALMENTS = 3;
export const PAYMENT_PLAN_HISTORY_MONTHS = 6;
export const PAYMENT_PLAN_FIRST_IN_DAYS = 7;
export const PAYMENT_PLAN_FIRST_WITHIN_DAYS = 60;
export const PAYMENT_PLAN_GRACE_DAYS = 7;
export const PAYMENT_PLAN_OLD_DEBT_DAYS = 90;
export const PAYMENT_PLAN_OLD_DEBT_MAX = 6;

export interface PlanInvoiceInput {
  id: string;
  number: string;
  dueDate: string;
  outstanding: string;
  /** An open dispute on the invoice. */
  disputed: boolean;
}

export interface PlanInstalment {
  no: number;
  dueDate: string;
  amount: string;
}

export interface PlanOption {
  instalments: number;
  amount: string;
  lastDueDate: string;
  recommended: boolean;
}

export interface PaymentPlanSuggestion {
  /** Invoices the plan covers: overdue, not disputed. */
  invoices: { id: string; number: string; dueDate: string; outstanding: string; daysOverdue: number }[];
  /** Overdue invoices left out because they are disputed. */
  leftOut: { id: string; number: string; outstanding: string }[];
  total: string;
  /** Average received a month over the last 6 months, or null with nothing received. */
  monthlyReceipts: string | null;
  oldestOverdueDays: number;
  recommended: number;
  instalments: number;
  firstDueDate: string;
  schedule: PlanInstalment[];
  options: PlanOption[];
  reasons: string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Why a plan cannot be set up with these choices, or null. */
export function paymentPlanIssue(instalments: number, firstDueDate: string, asOf: string): string | null {
  if (!Number.isInteger(instalments) || instalments < PAYMENT_PLAN_MIN_INSTALMENTS || instalments > PAYMENT_PLAN_MAX_INSTALMENTS) return `A plan has 1 to ${PAYMENT_PLAN_MAX_INSTALMENTS} instalments`;
  const d = daysBetween(asOf, firstDueDate);
  if (d < 0) return 'The first instalment cannot be due in the past';
  if (d > PAYMENT_PLAN_FIRST_WITHIN_DAYS) return `The first instalment is due within ${PAYMENT_PLAN_FIRST_WITHIN_DAYS} days`;
  return null;
}

/** Equal monthly instalments of `total`, the last taking the rounding. */
export function planSchedule(total: string, instalments: number, firstDueDate: string, minorUnits: number): PlanInstalment[] {
  const t = new D(total);
  const each = t.div(instalments).toDecimalPlaces(minorUnits, D.ROUND_DOWN);
  const last = t.minus(each.times(instalments - 1));
  return Array.from({ length: instalments }, (_, k) => ({
    no: k + 1,
    dueDate: addMonthsAnchored(firstDueDate, k),
    amount: (k === instalments - 1 ? last : each).toFixed(minorUnits),
  }));
}

/**
 * A suggested plan for one customer, or null when nothing overdue can go on a plan. `receipts` are
 * the customer's receipts in the last 6 months (functional currency); `choose` overrides the number
 * of instalments and the first due date, checked with paymentPlanIssue first.
 */
export function suggestPaymentPlan(
  invoices: PlanInvoiceInput[],
  receipts: { date: string; amount: string }[],
  asOf: string,
  minorUnits: number,
  choose: { instalments?: number; firstDueDate?: string } = {},
): PaymentPlanSuggestion | null {
  const overdue = invoices.filter((i) => i.dueDate < asOf && new D(i.outstanding).gt(0)).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.number.localeCompare(b.number));
  const covered = overdue.filter((i) => !i.disputed);
  if (!covered.length) return null;
  const total = covered.reduce((s, i) => s.plus(i.outstanding), new D(0));
  const oldest = Math.max(...covered.map((i) => daysBetween(i.dueDate, asOf)));

  const since = addDays(asOf, -PAYMENT_PLAN_HISTORY_MONTHS * 30);
  const received = receipts.filter((r) => r.date >= since && r.date <= asOf).reduce((s, r) => s.plus(r.amount), new D(0));
  const monthly = received.gt(0) ? received.div(PAYMENT_PLAN_HISTORY_MONTHS) : null;

  const reasons: string[] = [];
  let recommended: number;
  if (monthly) {
    const n = total.div(monthly).ceil().toNumber(); // not money: a count of instalments
    recommended = Math.min(PAYMENT_PLAN_MAX_INSTALMENTS, Math.max(2, n));
    reasons.push(`They paid about ${monthly.toFixed(minorUnits)} a month over the last ${PAYMENT_PLAN_HISTORY_MONTHS} months, so ${plural(recommended, 'instalment')} keeps each one close to that`);
    if (n > PAYMENT_PLAN_MAX_INSTALMENTS) reasons.push(`That would take more than ${PAYMENT_PLAN_MAX_INSTALMENTS} months, so it is held to ${PAYMENT_PLAN_MAX_INSTALMENTS}: each instalment is more than they usually pay`);
  } else {
    recommended = PAYMENT_PLAN_DEFAULT_INSTALMENTS;
    reasons.push(`Nothing received from them in the last ${PAYMENT_PLAN_HISTORY_MONTHS} months to size the plan by, so ${PAYMENT_PLAN_DEFAULT_INSTALMENTS} monthly instalments`);
  }
  if (oldest > PAYMENT_PLAN_OLD_DEBT_DAYS && recommended > PAYMENT_PLAN_OLD_DEBT_MAX) {
    recommended = PAYMENT_PLAN_OLD_DEBT_MAX;
    reasons.push(`An invoice is over ${PAYMENT_PLAN_OLD_DEBT_DAYS} days overdue, so the plan is kept to ${PAYMENT_PLAN_OLD_DEBT_MAX} months`);
  }
  const leftOut = overdue.filter((i) => i.disputed);
  if (leftOut.length) reasons.push(`${plural(leftOut.length, 'disputed invoice')} left out: settle the dispute first`);

  const instalments = choose.instalments ?? recommended;
  const firstDueDate = choose.firstDueDate ?? addDays(asOf, PAYMENT_PLAN_FIRST_IN_DAYS);
  const t = total.toFixed(minorUnits);
  const counts = [...new Set([2, 3, 6, recommended, instalments])].filter((n) => n >= PAYMENT_PLAN_MIN_INSTALMENTS && n <= PAYMENT_PLAN_MAX_INSTALMENTS).sort((a, b) => a - b);
  const options = counts.map((n) => {
    const s = planSchedule(t, n, firstDueDate, minorUnits);
    return { instalments: n, amount: s[0]!.amount, lastDueDate: s[s.length - 1]!.dueDate, recommended: n === recommended };
  });
  return {
    invoices: covered.map((i) => ({ id: i.id, number: i.number, dueDate: i.dueDate, outstanding: new D(i.outstanding).toFixed(minorUnits), daysOverdue: daysBetween(i.dueDate, asOf) })),
    leftOut: leftOut.map((i) => ({ id: i.id, number: i.number, outstanding: new D(i.outstanding).toFixed(minorUnits) })),
    total: t,
    monthlyReceipts: monthly ? monthly.toFixed(minorUnits) : null,
    oldestOverdueDays: oldest,
    recommended,
    instalments,
    firstDueDate,
    schedule: planSchedule(t, instalments, firstDueDate, minorUnits),
    options,
    reasons,
  };
}

export const PLAN_PROGRESS_STATUSES = ['ON_TRACK', 'BEHIND', 'BROKEN', 'COMPLETED', 'CANCELLED'] as const;
export type PlanProgressStatus = (typeof PLAN_PROGRESS_STATUSES)[number];
export const PLAN_PROGRESS_LABEL: Record<PlanProgressStatus, string> = {
  ON_TRACK: 'On track',
  BEHIND: 'Behind',
  BROKEN: 'Broken',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};
export type InstalmentStatus = 'PAID' | 'PART_PAID' | 'LATE' | 'DUE' | 'UPCOMING';

export interface PlanProgress {
  status: PlanProgressStatus;
  paid: string;
  remaining: string;
  /** Due by today and not yet paid. */
  behindBy: string;
  instalments: (PlanInstalment & { paid: string; status: InstalmentStatus })[];
  next: { no: number; dueDate: string; amount: string } | null;
}

/** How an agreed plan is going, from what has been received against its invoices since it was agreed. */
export function planProgress(schedule: PlanInstalment[], paid: string, asOf: string, minorUnits: number, cancelled = false): PlanProgress {
  const total = schedule.reduce((s, i) => s.plus(i.amount), new D(0));
  const got = D.min(D.max(new D(paid), new D(0)), total);
  let left = got;
  let dueByNow = new D(0);
  const instalments = schedule.map((i) => {
    const amount = new D(i.amount);
    const p = D.min(left, amount);
    left = left.minus(p);
    if (i.dueDate < asOf) dueByNow = dueByNow.plus(amount);
    const status: InstalmentStatus = p.gte(amount) ? 'PAID' : i.dueDate < asOf ? 'LATE' : p.gt(0) ? 'PART_PAID' : daysBetween(asOf, i.dueDate) <= PAYMENT_PLAN_GRACE_DAYS ? 'DUE' : 'UPCOMING';
    return { ...i, paid: p.toFixed(minorUnits), status };
  });
  const late = instalments.filter((i) => i.status === 'LATE');
  const status: PlanProgressStatus = cancelled
    ? 'CANCELLED'
    : got.gte(total)
      ? 'COMPLETED'
      : late.some((i) => daysBetween(i.dueDate, asOf) > PAYMENT_PLAN_GRACE_DAYS)
        ? 'BROKEN'
        : late.length
          ? 'BEHIND'
          : 'ON_TRACK';
  const n = instalments.find((i) => i.status !== 'PAID');
  return {
    status,
    paid: got.toFixed(minorUnits),
    remaining: total.minus(got).toFixed(minorUnits),
    behindBy: D.max(dueByNow.minus(got), new D(0)).toFixed(minorUnits),
    instalments,
    next: n && !cancelled ? { no: n.no, dueDate: n.dueDate, amount: new D(n.amount).minus(n.paid).toFixed(minorUnits) } : null,
  };
}
