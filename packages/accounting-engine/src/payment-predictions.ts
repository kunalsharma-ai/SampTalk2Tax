import { addDays, daysBetween } from './documents';
import { D } from './money';

/**
 * Predictive payment-delay scoring (AR-033). For every open invoice: how many days after its due
 * date it is likely to be paid, the chance it is paid late, the date the money is likely to
 * arrive, and the reasons. Worked out only from the organisation's own books, so it needs no AI
 * model and gives the same answer every time:
 *
 * - The customer's paid invoices: days paid after the due date (0 when paid on time; up to five
 *   days after counts as on time), with recent payments counting more (a payment half a year
 *   old counts half). Payments over two years old are left out.
 * - Customers with little history lean on the organisation's average: it counts as three paid
 *   invoices, blended with the customer's own.
 * - A customer paying a week or more slower (or faster) in the last 90 days than before moves the
 *   estimate by half the change.
 * - An invoice already past due is late for certain, and is expected at least a week from today.
 *   Other invoices of the same customer more than 30 days overdue raise the chance to at least 80%.
 *
 * `backtestPredictions` checks the method against invoices already paid: each one is predicted from what was
 * known on its issue date and compared with what happened.
 */

export interface PaidInvoiceForPrediction {
  contactId: string;
  issueDate: string;
  dueDate: string;
  /** The day the last receipt or credit that cleared it was applied. */
  paidOn: string;
  total: string;
}

export interface OpenInvoiceForPrediction {
  id: string;
  contactId: string;
  issueDate: string;
  dueDate: string;
  total: string;
  outstanding: string;
}

export const PREDICTION_HALF_LIFE_DAYS = 180;
export const PREDICTION_HISTORY_DAYS = 730;
export const PREDICTION_PRIOR_INVOICES = 3;
export const PREDICTION_BANDS = ['ON_TIME', 'LATE', 'VERY_LATE'] as const;
export type PredictionBand = (typeof PREDICTION_BANDS)[number];
export const PREDICTION_BAND_LABEL: Record<PredictionBand, string> = { ON_TIME: 'On time', LATE: 'Late', VERY_LATE: 'Very late' };
export const PREDICTION_CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW', 'ORG_AVERAGE'] as const;
export type PredictionConfidence = (typeof PREDICTION_CONFIDENCES)[number];
export const PREDICTION_CONFIDENCE_LABEL: Record<PredictionConfidence, string> = { HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low', ORG_AVERAGE: 'Organisation average' };

/** Up to 5 days after the due date counts as on time; over 30 days is very late. */
export const ON_TIME_GRACE_DAYS = 5;
export function delayBand(daysLate: number): PredictionBand {
  return daysLate <= ON_TIME_GRACE_DAYS ? 'ON_TIME' : daysLate <= 30 ? 'LATE' : 'VERY_LATE';
}

export interface DelayProfile {
  invoices: number;
  /** Sum of recency weights. */
  weight: number;
  daysLate: number;
  lateShare: number;
}

const lateBy = (p: PaidInvoiceForPrediction) => Math.max(0, daysBetween(p.dueDate, p.paidOn));

/** Recency-weighted days late and share paid late, from payments made on or before `asOf`. */
export function delayProfile(history: PaidInvoiceForPrediction[], asOf: string): DelayProfile | null {
  let weight = 0;
  let late = 0;
  let lateCount = 0;
  let invoices = 0;
  for (const p of history) {
    if (p.paidOn > asOf) continue;
    const age = daysBetween(p.paidOn, asOf);
    if (age > PREDICTION_HISTORY_DAYS) continue;
    const w = Math.pow(0.5, age / PREDICTION_HALF_LIFE_DAYS);
    const d = lateBy(p);
    weight += w;
    late += w * d;
    if (d > ON_TIME_GRACE_DAYS) lateCount += w;
    invoices++;
  }
  if (!invoices) return null;
  return { invoices, weight, daysLate: late / weight, lateShare: lateCount / weight };
}

export interface DelayPrediction {
  invoiceId: string;
  contactId: string;
  /** Whole days after the due date. */
  expectedDaysLate: number;
  predictedPayDate: string;
  /** 0..100. */
  lateChance: number;
  band: PredictionBand;
  confidence: PredictionConfidence;
  /** The customer's own paid invoices the prediction used. */
  basedOn: number;
  daysPastDue: number;
  reasons: string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * One invoice. `customerHistory` is the customer's paid invoices, `orgHistory` every customer's;
 * only payments made on or before `asOf` are used. Null when nothing has ever been paid.
 */
export function predictDelay(input: { invoice: Pick<OpenInvoiceForPrediction, 'id' | 'contactId' | 'dueDate'>; customerHistory: PaidInvoiceForPrediction[]; orgHistory: PaidInvoiceForPrediction[]; asOf: string; otherOverdueDays?: number }): DelayPrediction | null {
  const { invoice, asOf } = input;
  const own = delayProfile(input.customerHistory, asOf);
  const org = delayProfile(input.orgHistory, asOf);
  if (!own && !org) return null;
  const reasons: string[] = [];
  // The organisation's average counts as three paid invoices beside the customer's own.
  const priorW = org ? PREDICTION_PRIOR_INVOICES : 0;
  const ownW = own?.invoices ?? 0;
  let days = ((own?.daysLate ?? 0) * ownW + (org?.daysLate ?? 0) * priorW) / (ownW + priorW);
  let chance = ((own?.lateShare ?? 0) * ownW + (org?.lateShare ?? 0) * priorW) / (ownW + priorW);
  if (own) {
    const avg = Math.round(own.daysLate);
    reasons.push(avg === 0 ? `Paid ${plural(own.invoices, 'invoice')} on time on average` : `Paid ${plural(own.invoices, 'invoice')} ${plural(avg, 'day')} late on average`);
    if (own.invoices < 6 && org) reasons.push(`Little history, so the organisation's average (${plural(Math.round(org.daysLate), 'day')} late) counts too`);
  } else if (org) {
    reasons.push(`No paid invoices from this customer yet: uses the organisation's average of ${plural(Math.round(org.daysLate), 'day')} late`);
  }

  // A change in the last 90 days.
  const cut = addDays(asOf, -90);
  const recent = delayProfile(input.customerHistory.filter((p) => p.paidOn > cut), asOf);
  const earlier = delayProfile(input.customerHistory.filter((p) => p.paidOn <= cut), asOf);
  if (recent && earlier) {
    const change = recent.daysLate - earlier.daysLate;
    if (change >= 7) {
      days += change / 2;
      chance = Math.max(chance, recent.lateShare);
      reasons.push(`Paying slower lately: ${plural(Math.round(recent.daysLate), 'day')} late in the last 90 days, against ${Math.round(earlier.daysLate)} before`);
    } else if (change <= -7) {
      days = Math.max(0, days + change / 2);
      reasons.push(`Paying faster lately: ${plural(Math.round(recent.daysLate), 'day')} late in the last 90 days, against ${Math.round(earlier.daysLate)} before`);
    }
  }

  if ((input.otherOverdueDays ?? 0) > 30) {
    chance = Math.max(chance, 0.8);
    reasons.push(`Another invoice to this customer is ${plural(input.otherOverdueDays!, 'day')} overdue`);
  }

  let expected = Math.round(days);
  const pastDue = Math.max(0, daysBetween(invoice.dueDate, asOf));
  if (pastDue > 0) {
    chance = 1;
    expected = Math.max(expected, pastDue + 7);
    reasons.push(`Already ${plural(pastDue, 'day')} past due`);
  }
  const n = own?.invoices ?? 0;
  return {
    invoiceId: invoice.id,
    contactId: invoice.contactId,
    expectedDaysLate: expected,
    predictedPayDate: addDays(invoice.dueDate, expected),
    lateChance: Math.round(Math.min(1, Math.max(0, chance)) * 100),
    band: delayBand(expected),
    confidence: n >= 6 ? 'HIGH' : n >= 3 ? 'MEDIUM' : n >= 1 ? 'LOW' : 'ORG_AVERAGE',
    basedOn: n,
    daysPastDue: pastDue,
    reasons,
  };
}

/** Every open invoice, with the days the customer's oldest other overdue invoice is late. */
export function predictOpenInvoices(open: OpenInvoiceForPrediction[], paid: PaidInvoiceForPrediction[], asOf: string): DelayPrediction[] {
  const byCustomer = new Map<string, PaidInvoiceForPrediction[]>();
  for (const p of paid) byCustomer.set(p.contactId, [...(byCustomer.get(p.contactId) ?? []), p]);
  const out: DelayPrediction[] = [];
  for (const inv of open) {
    if (new D(inv.outstanding).lte(0)) continue;
    const others = open.filter((o) => o.contactId === inv.contactId && o.id !== inv.id && o.dueDate < asOf && new D(o.outstanding).gt(0));
    const otherOverdueDays = others.reduce((m, o) => Math.max(m, daysBetween(o.dueDate, asOf)), 0);
    const p = predictDelay({ invoice: inv, customerHistory: byCustomer.get(inv.contactId) ?? [], orgHistory: paid, asOf, otherOverdueDays });
    if (p) out.push(p);
  }
  return out;
}

export interface PredictionSummary {
  invoices: number;
  outstanding: string;
  byBand: Record<PredictionBand, { invoices: number; outstanding: string }>;
  /** Outstanding expected to arrive in the next 30 days (including today). */
  expectedIn30Days: string;
  /** Outstanding weighted by each invoice's chance of being late. */
  atRisk: string;
}

export function predictionSummary(rows: { prediction: DelayPrediction; outstanding: string }[], asOf: string, minorUnits: number): PredictionSummary {
  const zero = () => ({ invoices: 0, outstanding: new D(0) });
  const by = { ON_TIME: zero(), LATE: zero(), VERY_LATE: zero() };
  let total = new D(0);
  let soon = new D(0);
  let risk = new D(0);
  const horizon = addDays(asOf, 30);
  for (const r of rows) {
    const o = new D(r.outstanding);
    total = total.plus(o);
    by[r.prediction.band].invoices++;
    by[r.prediction.band].outstanding = by[r.prediction.band].outstanding.plus(o);
    if (r.prediction.predictedPayDate <= horizon) soon = soon.plus(o);
    risk = risk.plus(o.times(r.prediction.lateChance).div(100));
  }
  const fmt = (b: { invoices: number; outstanding: InstanceType<typeof D> }) => ({ invoices: b.invoices, outstanding: b.outstanding.toFixed(minorUnits) });
  return {
    invoices: rows.length,
    outstanding: total.toFixed(minorUnits),
    byBand: { ON_TIME: fmt(by.ON_TIME), LATE: fmt(by.LATE), VERY_LATE: fmt(by.VERY_LATE) },
    expectedIn30Days: soon.toFixed(minorUnits),
    atRisk: risk.toDecimalPlaces(minorUnits).toFixed(minorUnits),
  };
}

export interface BacktestResult {
  /** Paid invoices predicted from what was known on their issue date. */
  tested: number;
  /** Mean of |predicted − actual| days late; null with nothing tested. */
  meanErrorDays: number | null;
  /** Share predicted within 7 days of what happened, 0..1. */
  withinWeekShare: number | null;
  /** Share whose band (on time, late, very late) was right, 0..1. */
  rightBandShare: number | null;
}

/** Invoices paid in the last year (at most the latest 500), each predicted as of its issue date. */
export function backtestPredictions(paid: PaidInvoiceForPrediction[], asOf: string): BacktestResult {
  const from = addDays(asOf, -365);
  const cases = paid
    .filter((p) => p.paidOn > from && p.paidOn <= asOf)
    .sort((a, b) => b.paidOn.localeCompare(a.paidOn))
    .slice(0, 500);
  let tested = 0;
  let err = 0;
  let week = 0;
  let band = 0;
  for (const c of cases) {
    const known = paid.filter((p) => p.paidOn < c.issueDate);
    const p = predictDelay({ invoice: { id: '', contactId: c.contactId, dueDate: c.dueDate }, customerHistory: known.filter((k) => k.contactId === c.contactId), orgHistory: known, asOf: c.issueDate });
    if (!p) continue;
    const actual = lateBy(c);
    const e = Math.abs(p.expectedDaysLate - actual);
    tested++;
    err += e;
    if (e <= 7) week++;
    if (p.band === delayBand(actual)) band++;
  }
  if (!tested) return { tested: 0, meanErrorDays: null, withinWeekShare: null, rightBandShare: null };
  return { tested, meanErrorDays: Math.round((err / tested) * 10) / 10, withinWeekShare: week / tested, rightBandShare: band / tested };
}
