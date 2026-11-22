/**
 * Business trips (EXP-007): a trip is requested with an estimate, approved before travel, and the
 * traveller's expense claims are linked to it. This works out what the trip cost:
 *
 * - Spent: lines of approved and reimbursed claims. Pending: lines of claims not yet approved
 *   (draft, submitted, rejected). Void claims are left out.
 * - By category (the expense account), with spent and pending.
 * - Against the estimate: the total estimate, what is left, and an overrun when spent and pending
 *   together pass it (OVER_ESTIMATE), with the percent.
 * - Per day: spent ÷ the trip's days (start and end both counted).
 * - Lines dated more than a day before the trip starts or after it ends (OUTSIDE_DATES).
 */
import Decimal from 'decimal.js';
import { D, type Dec, dec, sum } from './money';

export const TRIP_ESTIMATE_KEYS = ['transport', 'lodging', 'meals', 'other'] as const;
export type TripEstimateKey = (typeof TRIP_ESTIMATE_KEYS)[number];
export const TRIP_ESTIMATE_LABEL: Record<TripEstimateKey, string> = { transport: 'Travel and transport', lodging: 'Hotels and lodging', meals: 'Meals and daily allowance', other: 'Other' };
/** Days of grace either side of the trip for a line's date. */
export const TRIP_DATE_GRACE_DAYS = 1;

const SPENT = new Set(['APPROVED', 'REIMBURSED']);
const PENDING = new Set(['DRAFT', 'SUBMITTED', 'REJECTED']);

export interface TripCostClaim {
  id: string;
  number: string;
  status: string;
  lines: { lineNo: number; date: string; account: string; merchant: string | null; amount: string }[];
}

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10); // not money
const dayCount = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1; // not money

export function tripCosts(trip: { startDate: string; endDate: string; estimate: Record<TripEstimateKey, string> }, claims: readonly TripCostClaim[], scale = 2) {
  const f = (x: Dec) => x.toDecimalPlaces(scale, Decimal.ROUND_HALF_EVEN).toFixed(scale);
  const days = dayCount(trip.startDate, trip.endDate);
  const estimate = sum(TRIP_ESTIMATE_KEYS.map((k) => dec(trip.estimate[k])));
  const byAccount = new Map<string, { spent: Dec; pending: Dec }>();
  let spent = new D(0);
  let pending = new D(0);
  const outside: { claimId: string; number: string; lineNo: number; date: string; amount: string }[] = [];
  const first = addDays(trip.startDate, -TRIP_DATE_GRACE_DAYS);
  const last = addDays(trip.endDate, TRIP_DATE_GRACE_DAYS);
  for (const c of claims) {
    const isSpent = SPENT.has(c.status);
    if (!isSpent && !PENDING.has(c.status)) continue;
    for (const l of c.lines) {
      const amount = dec(l.amount);
      const row = byAccount.get(l.account) ?? { spent: new D(0), pending: new D(0) };
      if (isSpent) {
        row.spent = row.spent.plus(amount);
        spent = spent.plus(amount);
      } else {
        row.pending = row.pending.plus(amount);
        pending = pending.plus(amount);
      }
      byAccount.set(l.account, row);
      if (l.date < first || l.date > last) outside.push({ claimId: c.id, number: c.number, lineNo: l.lineNo, date: l.date, amount: f(amount) });
    }
  }
  const expected = spent.plus(pending);
  const over = expected.minus(estimate);
  const flags: { code: 'OVER_ESTIMATE' | 'OUTSIDE_DATES'; message: string }[] = [];
  if (over.greaterThan(0)) {
    const pct = estimate.isZero() ? null : over.dividedBy(estimate).times(100).toDecimalPlaces(1, Decimal.ROUND_HALF_EVEN).toFixed(1);
    flags.push({ code: 'OVER_ESTIMATE', message: pct ? `Claims come to ${f(over)} (${pct}%) more than the estimate` : `Claims come to ${f(over)} with no estimate` });
  }
  if (outside.length) flags.push({ code: 'OUTSIDE_DATES', message: `${outside.length} ${outside.length === 1 ? 'line is' : 'lines are'} dated outside the trip` });
  return {
    days,
    estimate: { total: f(estimate), lines: TRIP_ESTIMATE_KEYS.map((k) => ({ key: k, label: TRIP_ESTIMATE_LABEL[k], amount: f(dec(trip.estimate[k])) })) },
    spent: f(spent),
    pending: f(pending),
    remaining: f(estimate.minus(expected)),
    perDay: f(spent.dividedBy(days)),
    byCategory: [...byAccount.entries()].map(([account, v]) => ({ account, spent: f(v.spent), pending: f(v.pending) })).sort((a, b) => dec(b.spent).plus(b.pending).comparedTo(dec(a.spent).plus(a.pending)) || a.account.localeCompare(b.account)),
    outsideDates: outside,
    flags,
  };
}

export type TripCosts = ReturnType<typeof tripCosts>;
