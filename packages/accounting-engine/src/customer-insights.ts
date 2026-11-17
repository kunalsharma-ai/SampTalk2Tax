import { addDays, daysBetween } from './documents';
import { D } from './money';

/**
 * Customer 360 (CRM slice 4): what a customer is worth, how they pay, and how risky it is to give
 * them credit. Every figure is worked out here from the books, so the server and the web agree:
 *
 * - Profitability: revenue is what posted invoices charged before tax, less posted credit notes.
 *   Direct costs are expenses posted to the customer's projects (a project is linked to a
 *   customer). Gross profit is the difference.
 * - Payment behaviour: an invoice is paid on the day the receipt or credit that clears it is
 *   applied. Days to pay and days late are weighted by the invoice total.
 * - Lifetime value: gross profit earned to date, plus a year's gross profit (the larger of the last
 *   twelve months' revenue and the yearly value of active contracts, at the customer's margin)
 *   for each year the customer is expected to stay. Expected years come from the organisation's
 *   own retention: of the customers billed in the twelve months before last, the share billed
 *   again in the last twelve months (r), giving r / (1 − r) years, at most five. With fewer than
 *   five such customers, three years is assumed and the result says so.
 * - Credit risk: a score from 0 (safe) to 100 from five factors, each with the points it adds and
 *   why, and a suggested credit limit for customers who are not high risk.
 */

export type Money = InstanceType<typeof D>;

export interface InvoiceFact {
  issueDate: string;
  dueDate: string;
  total: string;
  /** What is still owed on it today. */
  outstanding: string;
  /** The date it was cleared, when nothing is left owing; otherwise null. */
  paidOn: string | null;
}

export interface PaymentBehaviour {
  invoices: number;
  paidInvoices: number;
  /** Paid invoices weighted by total; null with none paid. */
  averageDaysToPay: number | null;
  averageDaysLate: number | null;
  /** Share of paid invoices (by count) cleared on or before the due date, 0..1. */
  onTimeShare: number | null;
  /** Paid in the last 90 days, and before that: average days late, to spot a change. */
  recentDaysLate: number | null;
  earlierDaysLate: number | null;
  open: string;
  overdue: string;
  /** Days the oldest overdue invoice is past its due date (0 when nothing is overdue). */
  oldestOverdueDays: number;
}

const weighted = (rows: { w: Money; v: number }[]): number | null => {
  const total = rows.reduce((s, r) => s.plus(r.w), new D(0));
  if (total.lte(0)) return rows.length ? Math.round(rows.reduce((s, r) => s + r.v, 0) / rows.length) : null;
  return Math.round(rows.reduce((s, r) => s.plus(r.w.times(r.v)), new D(0)).div(total).toNumber());
};

export function paymentBehaviour(invoices: InvoiceFact[], today: string): PaymentBehaviour {
  const paid = invoices.filter((i) => i.paidOn);
  const toPay = paid.map((i) => ({ w: new D(i.total), v: Math.max(0, daysBetween(i.issueDate, i.paidOn!)) }));
  const late = paid.map((i) => ({ w: new D(i.total), v: Math.max(0, daysBetween(i.dueDate, i.paidOn!)), paidOn: i.paidOn! }));
  const cut = addDays(today, -90);
  let open = new D(0);
  let overdue = new D(0);
  let oldest = 0;
  for (const i of invoices) {
    const o = new D(i.outstanding);
    if (o.lte(0)) continue;
    open = open.plus(o);
    if (i.dueDate < today) {
      overdue = overdue.plus(o);
      oldest = Math.max(oldest, daysBetween(i.dueDate, today));
    }
  }
  return {
    invoices: invoices.length,
    paidInvoices: paid.length,
    averageDaysToPay: weighted(toPay),
    averageDaysLate: weighted(late),
    onTimeShare: paid.length ? late.filter((l) => l.v === 0).length / paid.length : null,
    recentDaysLate: weighted(late.filter((l) => l.paidOn >= cut)),
    earlierDaysLate: weighted(late.filter((l) => l.paidOn < cut)),
    open: open.toFixed(),
    overdue: overdue.toFixed(),
    oldestOverdueDays: oldest,
  };
}

export const RISK_RATINGS = ['LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH', 'NO_HISTORY'] as const;
export type RiskRating = (typeof RISK_RATINGS)[number];
export const RISK_LABEL: Record<RiskRating, string> = { LOW: 'Low risk', MEDIUM: 'Medium risk', HIGH: 'High risk', VERY_HIGH: 'Very high risk', NO_HISTORY: 'Not enough history' };

export interface RiskFactor {
  key: 'OVERDUE_SHARE' | 'OLDEST_OVERDUE' | 'DAYS_LATE' | 'LIMIT_USAGE' | 'SLOWING';
  label: string;
  points: number;
  max: number;
  detail: string;
}

export interface CreditRisk {
  score: number | null;
  rating: RiskRating;
  factors: RiskFactor[];
  /** A credit limit that covers a typical month and the payment terms, rounded up; null when high risk or no history. */
  suggestedLimit: string | null;
}

const pct = (x: Money) => `${x.times(100).toDecimalPlaces(0).toFixed()}%`;

/**
 * Credit risk. Points: overdue share of what is open (up to 30), age of the oldest overdue invoice
 * (25), average days paid late (20), use of the credit limit (15) and paying slower lately (10).
 * Under 25 is low, under 50 medium, under 75 high, otherwise very high. A customer with no posted
 * invoices has no rating.
 */
export function creditRisk(input: { behaviour: PaymentBehaviour; creditLimit: string | null; averageMonthlyBilling: string; paymentTermsDays: number; minorUnits: number }): CreditRisk {
  const b = input.behaviour;
  if (b.invoices === 0) return { score: null, rating: 'NO_HISTORY', factors: [], suggestedLimit: null };
  const open = new D(b.open);
  const overdue = new D(b.overdue);
  const factors: RiskFactor[] = [];

  const share = open.gt(0) ? overdue.div(open) : new D(0);
  const sharePts = share.gte(0.5) ? 30 : share.gte(0.25) ? 20 : share.gt(0) ? 10 : 0;
  factors.push({ key: 'OVERDUE_SHARE', label: 'Overdue share of what is owed', points: sharePts, max: 30, detail: open.gt(0) ? `${pct(share)} of the open balance is past due` : 'Nothing is owed' });

  const d = b.oldestOverdueDays;
  const agePts = d > 90 ? 25 : d > 60 ? 18 : d > 30 ? 10 : d > 0 ? 5 : 0;
  factors.push({ key: 'OLDEST_OVERDUE', label: 'Oldest overdue invoice', points: agePts, max: 25, detail: d > 0 ? `${d} days past due` : 'Nothing is overdue' });

  const late = b.averageDaysLate;
  const latePts = late == null ? 0 : late > 30 ? 20 : late > 14 ? 12 : late > 0 ? 6 : 0;
  factors.push({ key: 'DAYS_LATE', label: 'How late invoices are paid', points: latePts, max: 20, detail: late == null ? 'No invoice paid yet' : late === 0 ? 'Paid on time on average' : `${late} days after the due date on average` });

  let limitPts = 0;
  let limitDetail = 'No credit limit set';
  if (input.creditLimit && new D(input.creditLimit).gt(0)) {
    const use = open.div(input.creditLimit);
    limitPts = use.gt(1) ? 15 : use.gt(0.8) ? 10 : use.gt(0.5) ? 5 : 0;
    limitDetail = `${pct(use)} of the credit limit is used`;
  }
  factors.push({ key: 'LIMIT_USAGE', label: 'Credit limit used', points: limitPts, max: 15, detail: limitDetail });

  const r = b.recentDaysLate;
  const e = b.earlierDaysLate;
  const slowing = r != null && e != null && r - e >= 7;
  factors.push({ key: 'SLOWING', label: 'Paying slower lately', points: slowing ? 10 : 0, max: 10, detail: r == null || e == null ? 'Not enough payments to compare' : slowing ? `${r} days late in the last 90 days, against ${e} before` : 'No slowdown in the last 90 days' });

  const score = factors.reduce((s, f) => s + f.points, 0);
  const rating: RiskRating = score < 25 ? 'LOW' : score < 50 ? 'MEDIUM' : score < 75 ? 'HIGH' : 'VERY_HIGH';
  let suggestedLimit: string | null = null;
  const monthly = new D(input.averageMonthlyBilling);
  if ((rating === 'LOW' || rating === 'MEDIUM') && monthly.gt(0)) {
    // A month of billing plus the terms it takes to be paid; halved for medium risk; rounded up to a 1,000.
    const months = new D(1).plus(new D(input.paymentTermsDays).div(30));
    const raw = monthly.times(months).times(rating === 'MEDIUM' ? 0.5 : 1);
    suggestedLimit = raw.div(1000).ceil().times(1000).toFixed(input.minorUnits);
  }
  return { score, rating, factors, suggestedLimit };
}

/** Org-level retention for lifetime value: customer ids billed in each window. */
export function retention(previousWindow: Set<string>, lastWindow: Set<string>): { rate: number | null; customers: number; retained: number } {
  const customers = previousWindow.size;
  const retained = [...previousWindow].filter((c) => lastWindow.has(c)).length;
  return { rate: customers >= 5 ? retained / customers : null, customers, retained };
}

export const DEFAULT_EXPECTED_YEARS = 3;
export const MAX_EXPECTED_YEARS = 5;

export interface LifetimeValue {
  value: string;
  earnedToDate: string;
  annualRevenue: string;
  annualProfit: string;
  /** Gross margin used for the years ahead, 0..1. */
  margin: string;
  expectedYears: string;
  /** True when there were too few customers to measure retention and three years was assumed. */
  assumedYears: boolean;
  retentionRate: number | null;
}

export function lifetimeValue(input: {
  revenueToDate: string;
  profitToDate: string;
  trailingRevenue: string;
  trailingProfit: string;
  /** Yearly value of active contracts, before tax. */
  contractArr: string;
  retentionRate: number | null;
  /** False when the customer has not been billed in the last twelve months and has no active contract: nothing more is expected. */
  active: boolean;
  minorUnits: number;
}): LifetimeValue {
  const tr = new D(input.trailingRevenue);
  const rev = new D(input.revenueToDate);
  const margin = tr.gt(0) ? new D(input.trailingProfit).div(tr) : rev.gt(0) ? new D(input.profitToDate).div(rev) : new D(1);
  const annualRevenue = input.active ? D.max(tr, new D(input.contractArr)) : new D(0);
  const annualProfit = annualRevenue.times(margin);
  const r = input.retentionRate;
  const years = r == null ? new D(DEFAULT_EXPECTED_YEARS) : r >= 1 ? new D(MAX_EXPECTED_YEARS) : D.min(new D(r).div(1 - r), MAX_EXPECTED_YEARS);
  const value = new D(input.profitToDate).plus(annualProfit.times(years));
  const s = input.minorUnits;
  return {
    value: value.toFixed(s),
    earnedToDate: new D(input.profitToDate).toFixed(s),
    annualRevenue: annualRevenue.toFixed(s),
    annualProfit: annualProfit.toFixed(s),
    margin: margin.toDecimalPlaces(4).toFixed(),
    expectedYears: years.toDecimalPlaces(1).toFixed(1),
    assumedYears: r == null,
    retentionRate: r,
  };
}

/** Months from `from` to `to` (inclusive), as YYYY-MM. */
export function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number) as [number, number];
  const end = to.slice(0, 7);
  for (let guard = 0; guard < 600; guard++) {
    const k = `${y}-${String(m).padStart(2, '0')}`;
    if (k > end) break;
    out.push(k);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

/** Gross profit and margin from revenue and direct cost. */
export function grossProfit(revenue: string, cost: string): { profit: string; margin: string | null } {
  const r = new D(revenue);
  const p = r.minus(cost);
  return { profit: p.toFixed(), margin: r.gt(0) ? p.div(r).toDecimalPlaces(4).toFixed() : null };
}
