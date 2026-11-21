/**
 * Customer financial behaviour analysis (AR-038): how each customer pays and buys, and how that is
 * changing, from the books alone. Deterministic and explainable: every signal says what it was
 * raised on. Amounts are decimal strings; days and shares are plain numbers.
 *
 * Paying (invoices paid in the last 12 months; days late = days after the due date, never below 0):
 * - Days late, weighted by invoice total, over the 12 months, the last 6 and the 6 before.
 * - Spread: the standard deviation of days late, unweighted.
 * - Partial payer: the share of those invoices cleared by more than one payment.
 * - Usual pay day: the day of the month around which (±3 days) at least 60% of the last 12 months'
 *   receipts fall, with at least 4 receipts (the closest-fitting day when several qualify).
 * Profile: NEW (first invoice under 90 days ago), LITTLE_HISTORY (under 3 paid), ERRATIC (spread
 * over 20 days), PROMPT (5 days late or less), otherwise SLOW.
 *
 * Buying (invoice totals, last 12 months against the 12 before): growing at +20% or more,
 * shrinking at −20% or less, otherwise steady. Lapsed: at least 3 invoices in the last 24 months
 * and nothing for longer than twice the usual gap between invoices, and over 60 days.
 *
 * Signals: PAYING_SLOWER (risk) and PAYING_FASTER (good) at 7 days' change between the two halves
 * of the year, each half with at least 2 paid invoices; LAPSED (risk); BUYING_LESS (watch);
 * BUYING_MORE (good); PARTIAL_PAYER (watch) at 30% or more of at least 3 paid invoices; PAY_DAY.
 */
import { addDays, daysBetween } from './documents';
import { D } from './money';

export const BEHAVIOUR_PROFILES = ['PROMPT', 'SLOW', 'ERRATIC', 'NEW', 'LITTLE_HISTORY'] as const;
export type BehaviourProfile = (typeof BEHAVIOUR_PROFILES)[number];
export const BEHAVIOUR_PROFILE_LABEL: Record<BehaviourProfile, string> = {
  PROMPT: 'Pays on time',
  SLOW: 'Pays late, steadily',
  ERRATIC: 'Unpredictable payer',
  NEW: 'New customer',
  LITTLE_HISTORY: 'Too little history',
};

export const BEHAVIOUR_SIGNALS = ['PAYING_SLOWER', 'LAPSED', 'BUYING_LESS', 'PARTIAL_PAYER', 'PAYING_FASTER', 'BUYING_MORE', 'PAY_DAY'] as const;
export type BehaviourSignalCode = (typeof BEHAVIOUR_SIGNALS)[number];
export type BehaviourTone = 'RISK' | 'WATCH' | 'GOOD' | 'INFO';
export const BEHAVIOUR_SIGNAL_TONE: Record<BehaviourSignalCode, BehaviourTone> = {
  PAYING_SLOWER: 'RISK',
  LAPSED: 'RISK',
  BUYING_LESS: 'WATCH',
  PARTIAL_PAYER: 'WATCH',
  PAYING_FASTER: 'GOOD',
  BUYING_MORE: 'GOOD',
  PAY_DAY: 'INFO',
};
export const BEHAVIOUR_SIGNAL_LABEL: Record<BehaviourSignalCode, string> = {
  PAYING_SLOWER: 'Paying slower',
  LAPSED: 'Stopped buying',
  BUYING_LESS: 'Buying less',
  PARTIAL_PAYER: 'Pays in parts',
  PAYING_FASTER: 'Paying faster',
  BUYING_MORE: 'Buying more',
  PAY_DAY: 'Usual pay day',
};

export const BEHAVIOUR_ON_TIME_DAYS = 5;
export const BEHAVIOUR_ERRATIC_SPREAD = 20;
export const BEHAVIOUR_TREND_DAYS = 7;
export const BEHAVIOUR_BUYING_CHANGE = 20;
export const BEHAVIOUR_NEW_DAYS = 90;
export const BEHAVIOUR_PARTIAL_SHARE = 30;

export interface BehaviourInvoice {
  issueDate: string;
  dueDate: string;
  /** Functional currency. */
  total: string;
  /** The day it was cleared, when nothing is left owing. */
  paidOn: string | null;
  /** Receipts and credits applied to it. */
  payments: number;
}

export interface BehaviourSignal {
  code: BehaviourSignalCode;
  tone: BehaviourTone;
  label: string;
  detail: string;
}

export interface CustomerBehaviour {
  profile: BehaviourProfile;
  profileLabel: string;
  paying: {
    paidInvoices: number;
    daysLate: number | null;
    daysLateRecent: number | null;
    daysLatePrior: number | null;
    trend: 'FASTER' | 'STEADY' | 'SLOWER' | null;
    spread: number | null;
    partialShare: number | null;
    payDay: number | null;
  };
  buying: {
    last12: { invoices: number; amount: string };
    prior12: { invoices: number; amount: string };
    /** Percentage change in amount, or null with nothing in the 12 months before. */
    change: number | null;
    trend: 'GROWING' | 'STEADY' | 'SHRINKING' | 'LAPSED' | 'NEW' | null;
    firstInvoiceOn: string | null;
    lastInvoiceOn: string | null;
    daysSinceLast: number | null;
    averageGap: number | null;
  };
  signals: BehaviourSignal[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;
const late = (i: BehaviourInvoice) => Math.max(0, daysBetween(i.dueDate, i.paidOn!));

/** Days late weighted by invoice total, to whole days, or null with none. */
function weightedLate(paid: BehaviourInvoice[]): number | null {
  const weight = paid.reduce((s, i) => s.plus(i.total), new D(0));
  if (!paid.length || weight.lte(0)) return null;
  return paid.reduce((s, i) => s.plus(new D(i.total).times(late(i))), new D(0)).div(weight).toDecimalPlaces(0).toNumber(); // not money: days
}

/** The day of the month around which (±3 days) at least 60% of receipts fall, or null. */
export function usualPayDay(receiptDates: string[]): number | null {
  if (receiptDates.length < 4) return null;
  const days = receiptDates.map((d) => Number(d.slice(8, 10))); // not money: day of the month
  const gap = (x: number, day: number) => Math.min(Math.abs(x - day), 31 - Math.abs(x - day));
  let best = { day: 0, count: 0, distance: 0 };
  for (let day = 1; day <= 31; day++) {
    const near = days.filter((x) => gap(x, day) <= 3);
    const distance = near.reduce((s, x) => s + gap(x, day), 0);
    if (near.length > best.count || (near.length === best.count && distance < best.distance)) best = { day, count: near.length, distance };
  }
  return best.count * 100 >= receiptDates.length * 60 ? best.day : null;
}

export function customerBehaviour(invoices: BehaviourInvoice[], receiptDates: string[], asOf: string, minorUnits: number): CustomerBehaviour {
  const yearAgo = addDays(asOf, -365);
  const halfAgo = addDays(asOf, -182);
  const twoYearsAgo = addDays(asOf, -730);
  const paid = invoices.filter((i) => i.paidOn && i.paidOn > yearAgo && i.paidOn <= asOf);
  const recent = paid.filter((i) => i.paidOn! > halfAgo);
  const prior = paid.filter((i) => i.paidOn! <= halfAgo);
  const daysLate = weightedLate(paid);
  const daysLateRecent = weightedLate(recent);
  const daysLatePrior = weightedLate(prior);
  const trend = recent.length >= 2 && prior.length >= 2 && daysLateRecent != null && daysLatePrior != null ? (daysLateRecent - daysLatePrior >= BEHAVIOUR_TREND_DAYS ? 'SLOWER' : daysLatePrior - daysLateRecent >= BEHAVIOUR_TREND_DAYS ? 'FASTER' : 'STEADY') : null;
  let spread: number | null = null;
  if (paid.length >= 3) {
    const xs = paid.map(late);
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    spread = Math.round(Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length));
  }
  const partialShare = paid.length ? Math.round((paid.filter((i) => i.payments > 1).length * 100) / paid.length) : null;
  const payDay = usualPayDay(receiptDates.filter((d) => d > yearAgo && d <= asOf));

  const issued = invoices.filter((i) => i.issueDate <= asOf).sort((a, b) => a.issueDate.localeCompare(b.issueDate));
  const sum = (xs: BehaviourInvoice[]) => xs.reduce((s, i) => s.plus(i.total), new D(0));
  const last12 = issued.filter((i) => i.issueDate > yearAgo);
  const prior12 = issued.filter((i) => i.issueDate > twoYearsAgo && i.issueDate <= yearAgo);
  const lastAmt = sum(last12);
  const priorAmt = sum(prior12);
  const change = priorAmt.gt(0) ? lastAmt.minus(priorAmt).div(priorAmt).times(100).toDecimalPlaces(0).toNumber() : null; // not money: a percentage
  const firstInvoiceOn = issued[0]?.issueDate ?? null;
  const lastInvoiceOn = issued[issued.length - 1]?.issueDate ?? null;
  const daysSinceLast = lastInvoiceOn ? daysBetween(lastInvoiceOn, asOf) : null;
  const recentIssued = issued.filter((i) => i.issueDate > twoYearsAgo);
  const averageGap = recentIssued.length >= 2 ? Math.round(daysBetween(recentIssued[0]!.issueDate, recentIssued[recentIssued.length - 1]!.issueDate) / (recentIssued.length - 1)) : null;
  const lapsed = recentIssued.length >= 3 && averageGap != null && daysSinceLast != null && daysSinceLast > Math.max(60, 2 * averageGap);
  const isNew = firstInvoiceOn != null && daysBetween(firstInvoiceOn, asOf) < BEHAVIOUR_NEW_DAYS;
  const buyingTrend = lapsed ? 'LAPSED' : isNew || (priorAmt.lte(0) && lastAmt.gt(0)) ? 'NEW' : change == null ? null : change >= BEHAVIOUR_BUYING_CHANGE ? 'GROWING' : change <= -BEHAVIOUR_BUYING_CHANGE ? 'SHRINKING' : 'STEADY';

  const profile: BehaviourProfile = isNew ? 'NEW' : paid.length < 3 ? 'LITTLE_HISTORY' : spread! > BEHAVIOUR_ERRATIC_SPREAD ? 'ERRATIC' : daysLate! <= BEHAVIOUR_ON_TIME_DAYS ? 'PROMPT' : 'SLOW';

  const signals: BehaviourSignal[] = [];
  const add = (code: BehaviourSignalCode, detail: string) => signals.push({ code, tone: BEHAVIOUR_SIGNAL_TONE[code], label: BEHAVIOUR_SIGNAL_LABEL[code], detail });
  if (trend === 'SLOWER') add('PAYING_SLOWER', `Paying ${plural(daysLateRecent! - daysLatePrior!, 'day')} later than six months before: ${daysLateRecent} days late on average, was ${daysLatePrior}`);
  if (lapsed) add('LAPSED', `No invoice for ${daysSinceLast} days; usually one every ${plural(averageGap!, 'day')}`);
  if (!lapsed && buyingTrend === 'SHRINKING') add('BUYING_LESS', `Bought ${-change!}% less in the last 12 months than the 12 before (${lastAmt.toFixed(minorUnits)} against ${priorAmt.toFixed(minorUnits)})`);
  if (paid.length >= 3 && partialShare! >= BEHAVIOUR_PARTIAL_SHARE) add('PARTIAL_PAYER', `${partialShare}% of invoices paid in the last 12 months were paid in more than one part`);
  if (trend === 'FASTER') add('PAYING_FASTER', `Paying ${plural(daysLatePrior! - daysLateRecent!, 'day')} sooner than six months before: ${daysLateRecent} days late on average, was ${daysLatePrior}`);
  if (buyingTrend === 'GROWING') add('BUYING_MORE', `Bought ${change}% more in the last 12 months than the 12 before (${lastAmt.toFixed(minorUnits)} against ${priorAmt.toFixed(minorUnits)})`);
  if (payDay != null) add('PAY_DAY', `Usually pays around the ${ordinal(payDay)} of the month: time reminders a few days before`);

  return {
    profile,
    profileLabel: BEHAVIOUR_PROFILE_LABEL[profile],
    paying: { paidInvoices: paid.length, daysLate, daysLateRecent, daysLatePrior, trend, spread, partialShare, payDay },
    buying: {
      last12: { invoices: last12.length, amount: lastAmt.toFixed(minorUnits) },
      prior12: { invoices: prior12.length, amount: priorAmt.toFixed(minorUnits) },
      change,
      trend: buyingTrend,
      firstInvoiceOn,
      lastInvoiceOn,
      daysSinceLast,
      averageGap,
    },
    signals,
  };
}
