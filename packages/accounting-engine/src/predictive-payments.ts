import { addDays, daysBetween } from './documents';
import { D, Dec } from './money';
import { formatDateText } from './workflows';

/**
 * Predictive payment scheduling (AP-034): a suggested payment date for each open bill over the next weeks,
 * from the cash in the bank and the receipts expected from customers (AR-033 payment predictions),
 * keeping the balance above a buffer every day. Deterministic and explained; nothing is paid here,
 * and the dates become AP-007 payment plans only when someone applies them.
 *
 * - The cash starts at the bank balances today. Bills already in an open payment batch come off
 *   today. Each open invoice's outstanding amount comes in on its predicted payment date (today, if
 *   that date has passed).
 * - Bills are taken by due date (overdue ones first), then by priority score (AP-030). Each is
 *   paid on its due date (today, if overdue) when the balance stays at or above the buffer on that
 *   day and every day after it once the bill is paid; otherwise on the first later day when it
 *   does, waiting for receipts. A bill no day in the period can cover is not covered.
 * - Bills due after the period, and bills whose vendor has no verified bank details, are listed
 *   but not scheduled.
 */

export const PREDICTED_PAYMENT_STATUSES = ['ON_DUE', 'OVERDUE_NOW', 'DELAYED', 'NOT_COVERED', 'IN_BATCH', 'BLOCKED', 'AFTER_PERIOD'] as const;
export type PredictedPaymentStatus = (typeof PREDICTED_PAYMENT_STATUSES)[number];
export const PREDICTED_PAYMENT_LABEL: Record<PredictedPaymentStatus, string> = {
  ON_DUE: 'Pay on the due date',
  OVERDUE_NOW: 'Overdue: pay today',
  DELAYED: 'Pay later, when cash comes in',
  NOT_COVERED: 'Not covered in the period',
  IN_BATCH: 'Already in a payment batch',
  BLOCKED: 'Blocked: bank details not verified',
  AFTER_PERIOD: 'Due after the period',
};
export const PREDICTED_PAYMENT_DAYS = [30, 60, 90] as const;

export interface BillToPredict {
  id: string;
  number: string;
  vendor: string;
  dueDate: string;
  /** Left to pay. */
  due: string;
  /** AP-030 priority score, 0 to 100. */
  score: number;
  inBatch: string | null;
  blocked: boolean;
}

export interface ExpectedCustomerReceipt {
  id: string;
  number: string;
  customer: string;
  /** Predicted payment date. */
  date: string;
  amount: string;
}

export interface PredictedBill extends BillToPredict {
  status: PredictedPaymentStatus;
  /** The proposed payment date, or null when not scheduled. */
  payOn: string | null;
  /** Days after the due date it is paid; 0 when on time or not scheduled. */
  daysLate: number;
  reason: string;
}

export interface PredictedPaymentWeek {
  from: string;
  to: string;
  receipts: string;
  payments: string;
  closing: string;
}

export interface PredictedPayments {
  bills: PredictedBill[];
  weeks: PredictedPaymentWeek[];
  summary: {
    cash: string;
    buffer: string;
    receipts: string;
    onTime: { count: number; amount: string };
    delayed: { count: number; amount: string; averageDaysLate: number };
    notCovered: { count: number; amount: string };
    inBatches: string;
    blocked: { count: number; amount: string };
    afterPeriod: { count: number; amount: string };
    endBalance: string;
    lowest: { balance: string; date: string };
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const STATUS_ORDER: Record<PredictedPaymentStatus, number> = { OVERDUE_NOW: 0, ON_DUE: 1, DELAYED: 2, NOT_COVERED: 3, IN_BATCH: 4, BLOCKED: 5, AFTER_PERIOD: 6 };

/** A payment date for each open bill in the `days` after `asOf`, keeping the balance at or above `buffer`. */
export function predictPaymentDates(input: { bills: BillToPredict[]; receipts: ExpectedCustomerReceipt[]; cash: string; buffer: string; asOf: string; days: number; scale: number; money: (amount: string) => string }): PredictedPayments {
  const { asOf, days, scale, money } = input;
  const end = addDays(asOf, days);
  const buffer = new D(input.buffer);
  const n = days + 1;
  const dayOf = (iso: string) => Math.max(0, daysBetween(asOf, iso)); // not money: a day index
  // Money in and out on each day, index 0 = today.
  const flows: Dec[] = Array.from({ length: n }, () => new D(0));
  const receipts = input.receipts.filter((r) => r.date <= end && new D(r.amount).gt(0));
  for (const r of receipts) flows[dayOf(r.date)] = flows[dayOf(r.date)]!.plus(r.amount);
  const inBatch = input.bills.filter((b) => b.inBatch);
  const batchTotal = inBatch.reduce((s, b) => s.plus(b.due), new D(0));
  flows[0] = flows[0]!.minus(batchTotal);
  const paid: Dec[] = Array.from({ length: n }, () => new D(0));

  const balances = () => {
    const out: Dec[] = [];
    let b = new D(input.cash);
    for (let i = 0; i < n; i++) {
      b = b.plus(flows[i]!).minus(paid[i]!);
      out.push(b);
    }
    return out;
  };

  const out: PredictedBill[] = [];
  for (const b of inBatch) out.push({ ...b, status: 'IN_BATCH', payOn: null, daysLate: 0, reason: `In payment batch ${b.inBatch}; taken off the cash today` });
  for (const b of input.bills.filter((x) => !x.inBatch && x.blocked)) out.push({ ...b, status: 'BLOCKED', payOn: null, daysLate: 0, reason: 'Verify the vendor\'s bank details before it can be paid' });
  for (const b of input.bills.filter((x) => !x.inBatch && !x.blocked && x.dueDate > end)) out.push({ ...b, status: 'AFTER_PERIOD', payOn: null, daysLate: 0, reason: `Due after ${formatDateText(end)}` });

  const toPlan = input.bills
    .filter((x) => !x.inBatch && !x.blocked && x.dueDate <= end)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || b.score - a.score || a.number.localeCompare(b.number));
  for (const b of toPlan) {
    const amount = new D(b.due);
    const t = dayOf(b.dueDate);
    const bal = balances();
    // Lowest balance from each day to the end of the period.
    const floor: Dec[] = new Array(n);
    for (let i = n - 1; i >= 0; i--) floor[i] = i === n - 1 ? bal[i]! : D.min(bal[i]!, floor[i + 1]!);
    let d = -1;
    for (let i = t; i < n; i++)
      if (floor[i]!.minus(amount).gte(buffer)) {
        d = i;
        break;
      }
    if (d < 0) {
      out.push({ ...b, status: 'NOT_COVERED', payOn: null, daysLate: 0, reason: `The cash expected in the next ${days} days does not cover ${money(amount.toFixed(scale))} and keep ${money(buffer.toFixed(scale))} in the bank` });
      continue;
    }
    paid[d] = paid[d]!.plus(amount);
    const payOn = addDays(asOf, d);
    const late = Math.max(0, daysBetween(b.dueDate, payOn));
    if (d === t) {
      const overdue = b.dueDate < asOf;
      out.push({ ...b, status: overdue ? 'OVERDUE_NOW' : 'ON_DUE', payOn, daysLate: overdue ? daysBetween(b.dueDate, asOf) : 0, reason: overdue ? `${plural(daysBetween(b.dueDate, asOf), 'day')} overdue; the cash covers it today` : 'The cash covers it on its due date' });
    } else {
      const waitedFor = receipts.filter((r) => dayOf(r.date) > t && dayOf(r.date) <= d).sort((x, y) => new D(y.amount).comparedTo(new D(x.amount)) || x.date.localeCompare(y.date));
      const main = waitedFor[0];
      out.push({
        ...b,
        status: 'DELAYED',
        payOn,
        daysLate: late,
        reason: main
          ? `Waits ${plural(late, 'day')} past its due date for ${plural(waitedFor.length, 'expected receipt')}, the largest ${money(new D(main.amount).toFixed(scale))} from ${main.customer} (${main.number}) by ${formatDateText(main.date)}`
          : `Waits ${plural(late, 'day')} past its due date for the balance to allow it`,
      });
    }
  }

  const bal = balances();
  const weeks: PredictedPaymentWeek[] = [];
  for (let i = 0; i < n; i += 7) {
    const j = Math.min(n - 1, i + 6);
    let rIn = new D(0);
    let pOut = new D(0);
    for (let k = i; k <= j; k++) {
      rIn = rIn.plus(receipts.filter((r) => dayOf(r.date) === k).reduce((s, r) => s.plus(r.amount), new D(0)));
      pOut = pOut.plus(paid[k]!);
    }
    if (i === 0) pOut = pOut.plus(batchTotal);
    weeks.push({ from: addDays(asOf, i), to: addDays(asOf, j), receipts: rIn.toFixed(scale), payments: pOut.neg().toFixed(scale), closing: bal[j]!.toFixed(scale) });
  }
  let lowest = { balance: bal[0]!, date: asOf };
  bal.forEach((x, i) => {
    if (x.lt(lowest.balance)) lowest = { balance: x, date: addDays(asOf, i) };
  });

  const total = (xs: PredictedBill[]) => xs.reduce((s, x) => s.plus(x.due), new D(0)).toFixed(scale);
  const of = (...st: PredictedPaymentStatus[]) => out.filter((x) => st.includes(x.status));
  const delayed = of('DELAYED');
  out.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (a.payOn ?? a.dueDate).localeCompare(b.payOn ?? b.dueDate) || b.score - a.score || a.number.localeCompare(b.number));
  return {
    bills: out,
    weeks,
    summary: {
      cash: new D(input.cash).toFixed(scale),
      buffer: buffer.toFixed(scale),
      receipts: receipts.reduce((s, r) => s.plus(r.amount), new D(0)).toFixed(scale),
      onTime: { count: of('ON_DUE', 'OVERDUE_NOW').length, amount: total(of('ON_DUE', 'OVERDUE_NOW')) },
      delayed: { count: delayed.length, amount: total(delayed), averageDaysLate: delayed.length ? Math.round(delayed.reduce((s, x) => s + x.daysLate, 0) / delayed.length) : 0 },
      notCovered: { count: of('NOT_COVERED').length, amount: total(of('NOT_COVERED')) },
      inBatches: batchTotal.toFixed(scale),
      blocked: { count: of('BLOCKED').length, amount: total(of('BLOCKED')) },
      afterPeriod: { count: of('AFTER_PERIOD').length, amount: total(of('AFTER_PERIOD')) },
      endBalance: bal[n - 1]!.toFixed(scale),
      lowest: { balance: lowest.balance.toFixed(scale), date: lowest.date },
    },
  };
}
