import { daysBetween } from './documents';
import { D } from './money';

/**
 * Vendor performance (AP-021): a scorecard per vendor, worked out from what actually happened on
 * their purchase orders, goods receipts and bills, plus the team's own reviews. Every figure is
 * computed here so the server and the web agree:
 *
 * - Delivery: an order with an expected date is delivered on the day its accepted quantity first
 *   covers every line (goods receipts that are not cancelled). On time = delivered on or before the
 *   expected date. An order still short after its expected date counts as late (it is overdue).
 *   Orders with no expected date, cancelled orders, and orders not yet due are left out.
 * - Quality: rejected goods as a share of everything received, by value at the order price.
 * - Price: what posted bills charged per unit against the order price, on bill lines linked to an
 *   order line. Overcharge = the extra paid where the bill price was higher (functional currency).
 * - Billing accuracy: of the posted bills linked to an order, the share that matched without
 *   anyone having to accept differences.
 * - Reviews: the average of the team's 1 to 5 ratings in the period.
 *
 * Score (0 to 100): delivery (on-time %) weighs 40, quality (100 − 10 × rejected %) 30, billing
 * accuracy (%) 20 and reviews ((average − 1) × 25) 10. A part with nothing to measure is left out
 * and the rest are reweighted; with nothing at all there is no score. Grades: A from 90, B from 75,
 * C from 60, otherwise D.
 */

export interface PerfOrderLine {
  id: string;
  quantity: string;
  unitPrice: string;
}

export interface PerfReceiptLine {
  orderLineId: string;
  date: string;
  /** Accepted. */
  quantity: string;
  rejected: string;
}

export interface PerfOrder {
  id: string;
  ref: string;
  orderDate: string;
  expectedDate: string | null;
  status: string;
  lines: PerfOrderLine[];
  receipts: PerfReceiptLine[];
}

export interface PerfBillLine {
  documentId: string;
  orderLineId: string;
  quantity: string;
  unitPrice: string;
  /** Functional currency per unit of the bill's currency (1 when the same). */
  rate?: string;
}

export interface PerfBill {
  id: string;
  issueDate: string;
  /** Before tax, in the functional currency. */
  subtotal: string;
  linkedToOrder: boolean;
  differencesAccepted: boolean;
}

export interface PerfReview {
  rating: number;
}

export type DeliveryOutcome = 'ON_TIME' | 'LATE' | 'OVERDUE';

export interface OrderDelivery {
  orderId: string;
  ref: string;
  expectedDate: string;
  deliveredOn: string | null;
  outcome: DeliveryOutcome;
  daysLate: number;
}

export type Grade = 'A' | 'B' | 'C' | 'D';

export interface VendorScorecard {
  orders: number;
  delivery: { measured: number; onTime: number; late: number; overdue: number; onTimePercent: string | null; averageDaysLate: string | null; detail: OrderDelivery[] };
  quality: { receivedValue: string; rejectedValue: string; rejectedPercent: string | null };
  price: { billedLines: number; linesAbovePrice: number; overcharge: string; variancePercent: string | null };
  billing: { bills: number; spend: string; linkedBills: number; withAcceptedDifferences: number; accuracyPercent: string | null; vendorCredits: number; vendorCreditValue: string };
  reviews: { count: number; average: string | null };
  parts: { key: 'DELIVERY' | 'QUALITY' | 'BILLING' | 'REVIEWS'; label: string; score: string; weight: number }[];
  score: string | null;
  grade: Grade | null;
}

export const PERFORMANCE_WEIGHTS = { DELIVERY: 40, QUALITY: 30, BILLING: 20, REVIEWS: 10 } as const;
export const PERFORMANCE_PART_LABEL = { DELIVERY: 'On-time delivery', QUALITY: 'Quality of goods', BILLING: 'Billing accuracy', REVIEWS: 'Team reviews' } as const;

export function gradeFor(score: InstanceType<typeof D>): Grade {
  if (score.gte(90)) return 'A';
  if (score.gte(75)) return 'B';
  if (score.gte(60)) return 'C';
  return 'D';
}

const pct = (a: InstanceType<typeof D>, b: InstanceType<typeof D>) => (b.isZero() ? null : a.div(b).times(100));
const clamp = (x: InstanceType<typeof D>) => D.max(0, D.min(100, x));

/** When (if ever) an order's accepted quantity first covered every line. */
export function deliveredOn(order: PerfOrder): string | null {
  if (!order.lines.length) return null;
  const dates = [...new Set(order.receipts.map((r) => r.date))].sort();
  const got = new Map<string, InstanceType<typeof D>>();
  for (const d of dates) {
    for (const r of order.receipts.filter((x) => x.date === d)) got.set(r.orderLineId, (got.get(r.orderLineId) ?? new D(0)).plus(r.quantity));
    if (order.lines.every((l) => (got.get(l.id) ?? new D(0)).gte(l.quantity))) return d;
  }
  return null;
}

/** The delivery outcome of one order on `today`, or null when it is not measured. */
export function orderDelivery(order: PerfOrder, today: string): OrderDelivery | null {
  if (!order.expectedDate || order.status === 'CANCELLED' || order.status === 'DRAFT') return null;
  const on = deliveredOn(order);
  if (on) {
    const late = Math.max(0, daysBetween(order.expectedDate, on));
    return { orderId: order.id, ref: order.ref, expectedDate: order.expectedDate, deliveredOn: on, outcome: late > 0 ? 'LATE' : 'ON_TIME', daysLate: late };
  }
  // Closed short without everything arriving: judged on the last delivery, if any.
  if (order.status === 'CLOSED') {
    const last = order.receipts.map((r) => r.date).sort().pop();
    if (!last) return null;
    const late = Math.max(0, daysBetween(order.expectedDate, last));
    return { orderId: order.id, ref: order.ref, expectedDate: order.expectedDate, deliveredOn: last, outcome: late > 0 ? 'LATE' : 'ON_TIME', daysLate: late };
  }
  if (today <= order.expectedDate) return null;
  return { orderId: order.id, ref: order.ref, expectedDate: order.expectedDate, deliveredOn: null, outcome: 'OVERDUE', daysLate: daysBetween(order.expectedDate, today) };
}

export function vendorScorecard(input: { orders: PerfOrder[]; bills: PerfBill[]; billLines: PerfBillLine[]; vendorCredits: { subtotal: string }[]; reviews: PerfReview[]; today: string }): VendorScorecard {
  const { orders, bills, billLines, vendorCredits, reviews, today } = input;

  const detail = orders.map((o) => orderDelivery(o, today)).filter((x): x is OrderDelivery => !!x);
  const onTime = detail.filter((d) => d.outcome === 'ON_TIME').length;
  const lateOnes = detail.filter((d) => d.outcome !== 'ON_TIME');
  const onTimePct = pct(new D(onTime), new D(detail.length));
  const avgLate = lateOnes.length ? new D(lateOnes.reduce((s, d) => s + d.daysLate, 0)).div(lateOnes.length) : null;

  const price = new Map<string, InstanceType<typeof D>>();
  for (const o of orders) for (const l of o.lines) price.set(l.id, new D(l.unitPrice));
  let received = new D(0);
  let rejected = new D(0);
  for (const o of orders) {
    for (const r of o.receipts) {
      const p = price.get(r.orderLineId) ?? new D(0);
      received = received.plus(new D(r.quantity).plus(r.rejected).times(p));
      rejected = rejected.plus(new D(r.rejected).times(p));
    }
  }
  const rejectedPct = pct(rejected, received);

  let atOrder = new D(0);
  let variance = new D(0);
  let over = new D(0);
  let above = 0;
  for (const b of billLines) {
    const p = price.get(b.orderLineId);
    if (!p) continue;
    const q = new D(b.quantity).times(b.rate ?? 1);
    const diff = new D(b.unitPrice).minus(p).times(q);
    atOrder = atOrder.plus(p.times(q));
    variance = variance.plus(diff);
    if (diff.gt(0)) {
      over = over.plus(diff);
      above++;
    }
  }
  const counted = billLines.filter((b) => price.has(b.orderLineId)).length;

  const linked = bills.filter((b) => b.linkedToOrder);
  const accepted = linked.filter((b) => b.differencesAccepted).length;
  const accuracy = pct(new D(linked.length - accepted), new D(linked.length));
  const avgRating = reviews.length ? new D(reviews.reduce((s, r) => s + r.rating, 0)).div(reviews.length) : null;

  const parts: VendorScorecard['parts'] = [];
  if (onTimePct) parts.push({ key: 'DELIVERY', label: PERFORMANCE_PART_LABEL.DELIVERY, score: onTimePct.toFixed(1), weight: PERFORMANCE_WEIGHTS.DELIVERY });
  if (rejectedPct) parts.push({ key: 'QUALITY', label: PERFORMANCE_PART_LABEL.QUALITY, score: clamp(new D(100).minus(rejectedPct.times(10))).toFixed(1), weight: PERFORMANCE_WEIGHTS.QUALITY });
  if (accuracy) parts.push({ key: 'BILLING', label: PERFORMANCE_PART_LABEL.BILLING, score: accuracy.toFixed(1), weight: PERFORMANCE_WEIGHTS.BILLING });
  if (avgRating) parts.push({ key: 'REVIEWS', label: PERFORMANCE_PART_LABEL.REVIEWS, score: clamp(avgRating.minus(1).times(25)).toFixed(1), weight: PERFORMANCE_WEIGHTS.REVIEWS });
  const totalWeight = parts.reduce((s, p) => s + p.weight, 0);
  const score = totalWeight ? parts.reduce((s, p) => s.plus(new D(p.score).times(p.weight)), new D(0)).div(totalWeight) : null;

  return {
    orders: orders.filter((o) => o.status !== 'DRAFT').length,
    delivery: { measured: detail.length, onTime, late: detail.filter((d) => d.outcome === 'LATE').length, overdue: detail.filter((d) => d.outcome === 'OVERDUE').length, onTimePercent: onTimePct?.toFixed(1) ?? null, averageDaysLate: avgLate?.toFixed(1) ?? null, detail },
    quality: { receivedValue: received.toFixed(2), rejectedValue: rejected.toFixed(2), rejectedPercent: rejectedPct?.toFixed(2) ?? null },
    price: { billedLines: counted, linesAbovePrice: above, overcharge: over.toFixed(2), variancePercent: pct(variance, atOrder)?.toFixed(2) ?? null },
    billing: {
      bills: bills.length,
      spend: bills.reduce((s, b) => s.plus(b.subtotal), new D(0)).toFixed(2),
      linkedBills: linked.length,
      withAcceptedDifferences: accepted,
      accuracyPercent: accuracy?.toFixed(1) ?? null,
      vendorCredits: vendorCredits.length,
      vendorCreditValue: vendorCredits.reduce((s, c) => s.plus(c.subtotal), new D(0)).toFixed(2),
    },
    reviews: { count: reviews.length, average: avgRating?.toFixed(1) ?? null },
    parts,
    score: score?.toFixed(1) ?? null,
    grade: score ? gradeFor(score) : null,
  };
}

export const REVIEW_ASPECTS = ['Quality', 'Delivery', 'Communication', 'Pricing', 'Overall'] as const;

/** Problems with a review before it is saved. */
export function reviewIssues(r: { rating: number; aspect: string; note: string | null }): string[] {
  const out: string[] = [];
  if (!Number.isInteger(r.rating) || r.rating < 1 || r.rating > 5) out.push('A rating is a whole number from 1 to 5');
  if (!(REVIEW_ASPECTS as readonly string[]).includes(r.aspect)) out.push(`Choose what the rating is about: ${REVIEW_ASPECTS.join(', ')}`);
  if (r.rating <= 2 && !r.note?.trim()) out.push('Say what went wrong when rating 1 or 2');
  return out;
}
