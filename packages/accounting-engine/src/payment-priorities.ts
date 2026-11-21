import { daysBetween } from './documents';
import { D } from './money';

/**
 * Intelligent payment prioritisation (AP-030) and dynamic discount recommendations (AP-029): which
 * open bills to pay now with the cash in the bank, which can wait for their due date, which the
 * cash will not cover, and which vendors to offer early payment in return for a discount, using
 * cash that is left over. Deterministic and explained; nothing is paid or planned here.
 *
 * Priority score (0 to 100), from three factors:
 * - Urgency (up to 50): over 30 days past due 50, past due 40, due within 7 days 30, within 14
 *   days 15.
 * - Vendor importance (up to 30): the vendor's share of purchases in the last twelve months:
 *   25% or more 30, 10% 20, 3% 10.
 * - Age of the bill (up to 20): issued over 60 days ago 20, over 30 days 10.
 *
 * Bills already in an open payment batch are left as they are; bills whose vendor has no verified
 * bank details are blocked (a batch cannot pay them). Of the rest, bills past due or due within 7
 * days are paid now, highest score first, while cash above the buffer lasts; the others are set
 * aside for their due date while it lasts; what is not covered is marked short.
 *
 * Discount offers: when the cash covers every bill (nothing short), each bill set aside for a due
 * date at least 10 days away can be offered early payment, for a discount worth the
 * organisation's target annual return over the days paid early (amount × rate × days early ÷ 365,
 * rounded down to the paisa), largest discount first. The cash is already set aside for it, so
 * paying it early leaves every other bill covered.
 */

export const PAYMENT_ACTIONS = ['PAY_NOW', 'PAY_ON_DUE', 'CASH_SHORT', 'IN_BATCH', 'BLOCKED'] as const;
export type PaymentAction = (typeof PAYMENT_ACTIONS)[number];
export const PAYMENT_ACTION_LABEL: Record<PaymentAction, string> = {
  PAY_NOW: 'Pay now',
  PAY_ON_DUE: 'Pay on the due date',
  CASH_SHORT: 'Cash will not cover it',
  IN_BATCH: 'Already in a payment batch',
  BLOCKED: 'Blocked: bank details not verified',
};
export const DISCOUNT_MIN_DAYS = 10;
export const URGENT_WITHIN_DAYS = 7;

export interface BillToPrioritise {
  id: string;
  number: string;
  vendorId: string;
  vendor: string;
  issueDate: string;
  dueDate: string;
  /** Left to pay. */
  due: string;
  inBatch: string | null;
  bankVerified: boolean;
  /** Vendor's share of purchases in the last twelve months, percent as a decimal string, or null. */
  spendShare: string | null;
}

export interface PriorityFactorPoints {
  key: 'URGENCY' | 'IMPORTANCE' | 'AGE';
  label: string;
  points: number;
  max: number;
  detail: string;
}

export interface DiscountOffer {
  daysEarly: number;
  /** Percent, two decimals. */
  percent: string;
  discount: string;
  /** What would be paid now. */
  pay: string;
}

export interface PrioritisedBill extends BillToPrioritise {
  score: number;
  action: PaymentAction;
  factors: PriorityFactorPoints[];
  daysToDue: number;
  offer: DiscountOffer | null;
}

export interface PaymentPriorities {
  bills: PrioritisedBill[];
  summary: { cash: string; buffer: string; inBatches: string; available: string; payNow: string; onDue: string; short: string; blocked: string; leftOver: string; offers: number; offerSavings: string; offerPay: string };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function factors(b: BillToPrioritise, asOf: string): PriorityFactorPoints[] {
  const toDue = daysBetween(asOf, b.dueDate);
  const urgency = toDue < -30 ? 50 : toDue < 0 ? 40 : toDue <= URGENT_WITHIN_DAYS ? 30 : toDue <= 14 ? 15 : 0;
  const share = b.spendShare == null ? null : new D(b.spendShare);
  const importance = share == null ? 0 : share.gte(25) ? 30 : share.gte(10) ? 20 : share.gte(3) ? 10 : 0;
  const age = daysBetween(b.issueDate, asOf);
  return [
    { key: 'URGENCY', label: 'Urgency', points: urgency, max: 50, detail: toDue < 0 ? `${plural(-toDue, 'day')} past due` : toDue === 0 ? 'Due today' : `Due in ${plural(toDue, 'day')}` },
    { key: 'IMPORTANCE', label: 'Vendor importance', points: importance, max: 30, detail: share == null ? 'No purchases in the last twelve months' : `${share.toDecimalPlaces(1).toFixed()}% of purchases in the last twelve months` },
    { key: 'AGE', label: 'Age of the bill', points: age > 60 ? 20 : age > 30 ? 10 : 0, max: 20, detail: `Issued ${plural(Math.max(0, age), 'day')} ago` },
  ];
}

export function prioritisePayments(input: { bills: BillToPrioritise[]; cash: string; buffer: string; annualRatePercent: string; asOf: string; minorUnits: number }): PaymentPriorities {
  const s = input.minorUnits;
  const rows: PrioritisedBill[] = input.bills.map((b) => {
    const f = factors(b, input.asOf);
    return { ...b, factors: f, score: f.reduce((t, x) => t + x.points, 0), daysToDue: daysBetween(input.asOf, b.dueDate), action: 'PAY_ON_DUE', offer: null };
  });
  const inBatches = rows.filter((r) => r.inBatch).reduce((t, r) => t.plus(r.due), new D(0));
  let left = D.max(0, new D(input.cash).minus(input.buffer).minus(inBatches));
  const available = left;
  const order = (a: PrioritisedBill, b: PrioritisedBill) => b.score - a.score || a.dueDate.localeCompare(b.dueDate) || a.number.localeCompare(b.number);
  for (const r of rows) {
    if (r.inBatch) r.action = 'IN_BATCH';
    else if (!r.bankVerified) r.action = 'BLOCKED';
  }
  const open = rows.filter((r) => !r.inBatch && r.bankVerified);
  const urgent = open.filter((r) => r.daysToDue <= URGENT_WITHIN_DAYS).sort(order);
  const later = open.filter((r) => r.daysToDue > URGENT_WITHIN_DAYS).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || order(a, b));
  for (const r of urgent) {
    if (left.gte(r.due)) {
      r.action = 'PAY_NOW';
      left = left.minus(r.due);
    } else r.action = 'CASH_SHORT';
  }
  for (const r of later) {
    if (left.gte(r.due)) {
      r.action = 'PAY_ON_DUE';
      left = left.minus(r.due);
    } else r.action = 'CASH_SHORT';
  }
  // Discount offers: only when nothing is short, so moving set-aside cash earlier harms no bill.
  const anyShort = rows.some((r) => r.action === 'CASH_SHORT');
  const rate = new D(input.annualRatePercent).div(100);
  const candidates = later
    .filter((r) => !anyShort && r.action === 'PAY_ON_DUE' && r.daysToDue >= DISCOUNT_MIN_DAYS)
    .map((r) => ({ r, discount: new D(r.due).times(rate).times(r.daysToDue).div(365).toDecimalPlaces(s, D.ROUND_DOWN) }))
    .filter((x) => x.discount.gt(0))
    .sort((a, b) => b.discount.cmp(a.discount) || a.r.dueDate.localeCompare(b.r.dueDate));
  let offers = 0;
  let savings = new D(0);
  let offerPay = new D(0);
  for (const { r, discount } of candidates) {
    r.offer = { daysEarly: r.daysToDue, percent: discount.div(r.due).times(100).toDecimalPlaces(2, D.ROUND_DOWN).toFixed(2), discount: discount.toFixed(s), pay: new D(r.due).minus(discount).toFixed(s) };
    offers++;
    savings = savings.plus(discount);
    offerPay = offerPay.plus(r.offer.pay);
  }
  const sum = (a: PaymentAction) => rows.filter((r) => r.action === a).reduce((t, r) => t.plus(r.due), new D(0)).toFixed(s);
  const rank: Record<PaymentAction, number> = { PAY_NOW: 0, CASH_SHORT: 1, BLOCKED: 2, PAY_ON_DUE: 3, IN_BATCH: 4 };
  rows.sort((a, b) => rank[a.action] - rank[b.action] || order(a, b));
  return {
    bills: rows,
    summary: {
      cash: new D(input.cash).toFixed(s),
      buffer: new D(input.buffer).toFixed(s),
      inBatches: inBatches.toFixed(s),
      available: available.toFixed(s),
      payNow: sum('PAY_NOW'),
      onDue: sum('PAY_ON_DUE'),
      short: sum('CASH_SHORT'),
      blocked: sum('BLOCKED'),
      leftOver: left.toFixed(s),
      offers,
      offerSavings: savings.toFixed(s),
      offerPay: offerPay.toFixed(s),
    },
  };
}

