import { addDays } from './documents';
import { D } from './money';

/**
 * Customer contracts with recurring billing (CRM slice 3). A contract bills the same lines every
 * period (monthly, quarterly, half-yearly or yearly) from its start date, in advance (the invoice
 * is dated the first day of the period) or in arrears (dated the last day). It runs to an end date
 * that falls on a period end, or rolls on until cancelled. These are the rules the server applies
 * and the web shows.
 *
 * DRAFT (editable, nothing billed) → ACTIVE (bills each period as it falls due) ⇄ PAUSED (periods
 * falling due while paused are skipped) → ENDED (every period to the end date billed) or CANCELLED
 * (with a reason; nothing more is billed). With auto-renew, an ACTIVE contract reaching its end
 * date runs on for another renewal term instead of ending.
 */

export const CONTRACT_FREQUENCIES = ['MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY'] as const;
export type ContractFrequency = (typeof CONTRACT_FREQUENCIES)[number];
export const FREQUENCY_MONTHS: Record<ContractFrequency, number> = { MONTHLY: 1, QUARTERLY: 3, HALF_YEARLY: 6, YEARLY: 12 };
export const FREQUENCY_LABEL: Record<ContractFrequency, string> = { MONTHLY: 'Monthly', QUARTERLY: 'Quarterly', HALF_YEARLY: 'Half-yearly', YEARLY: 'Yearly' };

export const CONTRACT_STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'ENDED', 'CANCELLED'] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];
export const CONTRACT_STATUS_LABEL: Record<ContractStatus, string> = { DRAFT: 'Draft', ACTIVE: 'Active', PAUSED: 'Paused', ENDED: 'Ended', CANCELLED: 'Cancelled' };

export type BillingTiming = 'ADVANCE' | 'ARREARS';

export class ContractError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/**
 * The date `months` months after `start`, on the start's day of the month, or the month's last day
 * when it is shorter (31 Jan + 1 month = 28/29 Feb; + 2 months = 31 Mar).
 */
export function addMonthsAnchored(start: string, months: number): string {
  if (!ISO.test(start)) throw new ContractError('CONTRACT_DATE', `Not a date: ${start}`);
  const [y, m, d] = start.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const day = Math.min(d, lastDay(ny, nm));
  return `${String(ny).padStart(4, '0')}-${String(nm + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export interface ContractPeriod {
  /** 1 for the first period. */
  no: number;
  start: string;
  end: string;
  /** The invoice date: the period's first day in advance, its last day in arrears. */
  billDate: string;
  /** A part period, billed for `days` of the `of` days in the full period; null for a full one. */
  part: { days: number; of: number } | null;
}

/**
 * Billing on a fixed day of the month (1 to 28). The periods then run from that day, and the part
 * periods before the first one and after the last full one (to an end date that is not a period
 * end) are billed for their share of days. Without it, periods run from the start date and the
 * end date must be a period end.
 */
export interface ScheduleOpts {
  billingDay?: number | null;
  /** The contract's end date: with a billing day, a period running past it is cut short there. */
  end?: string | null;
}

const dayNo = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
const daysIn = (a: string, b: string) => Math.round(dayNo(b) - dayNo(a)) + 1;

/** The first date on or after `start` that falls on the billing day. */
export function firstBillingDate(start: string, billingDay?: number | null): string {
  if (!ISO.test(start)) throw new ContractError('CONTRACT_DATE', `Not a date: ${start}`);
  if (!billingDay) return start;
  if (!Number.isInteger(billingDay) || billingDay < 1 || billingDay > 28) throw new ContractError('CONTRACT_BILLING_DAY', 'The billing day must be a day from 1 to 28');
  const d = +start.slice(8, 10);
  if (d === billingDay) return start;
  const same = `${start.slice(0, 8)}${String(billingDay).padStart(2, '0')}`;
  return d < billingDay ? same : addMonthsAnchored(same, 1);
}

/** Period `no` (from 1) of a contract starting on `start`. */
export function contractPeriod(start: string, frequency: ContractFrequency, no: number, timing: BillingTiming = 'ADVANCE', opts: ScheduleOpts = {}): ContractPeriod {
  if (!Number.isInteger(no) || no < 1) throw new ContractError('CONTRACT_PERIOD', 'Periods count from 1');
  const m = FREQUENCY_MONTHS[frequency];
  const anchor = firstBillingDate(start, opts.billingDay);
  let s: string;
  let e: string;
  let full: number;
  if (anchor !== start && no === 1) {
    // The part period before the first billing date, as a share of the full period it ends.
    s = start;
    e = addDays(anchor, -1);
    full = daysIn(addMonthsAnchored(anchor, -m), e);
  } else {
    const k = anchor !== start ? no - 1 : no;
    s = addMonthsAnchored(anchor, (k - 1) * m);
    e = addDays(addMonthsAnchored(anchor, k * m), -1);
    full = daysIn(s, e);
  }
  if (opts.billingDay && opts.end && s <= opts.end && e > opts.end) e = opts.end;
  const days = daysIn(s, e);
  return { no, start: s, end: e, billDate: timing === 'ADVANCE' ? s : e, part: days === full ? null : { days, of: full } };
}

/** How many periods run from `start` to `end`, or a CONTRACT_END error naming the nearest valid end dates. */
export function periodCount(start: string, end: string, frequency: ContractFrequency, billingDay?: number | null): number {
  if (end < start) throw new ContractError('CONTRACT_END', 'The end date cannot be before the start date');
  for (let n = 1; n <= 1200; n++) {
    const p = contractPeriod(start, frequency, n, 'ADVANCE', { billingDay, end });
    if (p.end === end) return n;
    if (p.end > end) {
      const before = n > 1 ? contractPeriod(start, frequency, n - 1).end : null;
      throw new ContractError('CONTRACT_END', `The end date must be the last day of a ${FREQUENCY_LABEL[frequency].toLowerCase()} period: ${before ? `${before} or ` : ''}${p.end}`);
    }
  }
  throw new ContractError('CONTRACT_END', 'The contract is too long');
}

type Sched = { start: string; end: string | null; frequency: ContractFrequency; timing: BillingTiming; nextNo: number; billingDay?: number | null };
const optsOf = (c: { end: string | null; billingDay?: number | null }): ScheduleOpts => ({ billingDay: c.billingDay ?? null, end: c.end });

/**
 * The periods to bill now: from period `nextNo`, every one whose invoice date has come (on or
 * before `today`) and that is within the end date (none after it; all of them for a rolling
 * contract), at most `limit` at a time.
 */
export function duePeriods(c: Sched, today: string, limit = 24): ContractPeriod[] {
  const out: ContractPeriod[] = [];
  for (let n = c.nextNo; out.length < limit; n++) {
    const p = contractPeriod(c.start, c.frequency, n, c.timing, optsOf(c));
    if ((c.end && p.start > c.end) || p.billDate > today) break;
    out.push(p);
  }
  return out;
}

/** The next `count` periods from `nextNo` that are still to come within the end date. */
export function upcomingPeriods(c: Sched, count: number): ContractPeriod[] {
  const out: ContractPeriod[] = [];
  for (let n = c.nextNo; out.length < count; n++) {
    const p = contractPeriod(c.start, c.frequency, n, c.timing, optsOf(c));
    if (c.end && p.start > c.end) break;
    out.push(p);
  }
  return out;
}

/** True when every period up to the end date has been billed or skipped. */
export function fullyBilled(c: { start: string; end: string | null; frequency: ContractFrequency; nextNo: number; billingDay?: number | null }): boolean {
  return !!c.end && contractPeriod(c.start, c.frequency, c.nextNo, 'ADVANCE', optsOf(c)).start > c.end;
}

/** Monthly recurring revenue from a period's value (excluding tax), to the currency's minor unit. */
export function monthlyValue(periodNet: string, frequency: ContractFrequency, scale = 2): string {
  return new D(periodNet).div(FREQUENCY_MONTHS[frequency]).toDecimalPlaces(scale, D.ROUND_HALF_EVEN).toFixed(scale);
}

export type RenewalState = 'ROLLING' | 'RUNNING' | 'RENEWAL_DUE' | 'PAST_END';

/** Where a contract stands against its end date: renewal is due from `noticeDays` before it. */
export function renewalState(end: string | null, noticeDays: number, today: string): RenewalState {
  if (!end) return 'ROLLING';
  if (today > end) return 'PAST_END';
  return addDays(end, -noticeDays) <= today ? 'RENEWAL_DUE' : 'RUNNING';
}

/** True when `end` falls part-way through a period, so the last period is a part period. */
export function endsInPart(start: string, end: string, frequency: ContractFrequency, billingDay?: number | null): boolean {
  const n = periodCount(start, end, frequency, billingDay);
  return contractPeriod(start, frequency, n, 'ADVANCE', { billingDay }).end !== end;
}

/** The end date after renewing for `months` more months (a whole number of periods). */
export function renewedEnd(start: string, end: string, frequency: ContractFrequency, months: number, billingDay?: number | null): string {
  const m = FREQUENCY_MONTHS[frequency];
  if (!Number.isInteger(months) || months < m || months % m !== 0) throw new ContractError('CONTRACT_RENEWAL', `Renew for a whole number of ${FREQUENCY_LABEL[frequency].toLowerCase()} periods (${m} months each)`);
  if (endsInPart(start, end, frequency, billingDay)) throw new ContractError('CONTRACT_RENEWAL', 'A contract that ends part-way through a period cannot be renewed; change its end date to a period end first');
  return contractPeriod(start, frequency, periodCount(start, end, frequency, billingDay) + months / m, 'ADVANCE', { billingDay }).end;
}

/** A unit price for a part period: its share of days, rounded half up to `scale` decimal places. */
export function proratedPrice(unitPrice: string, part: { days: number; of: number }, scale = 2): string {
  return new D(unitPrice).times(part.days).div(part.of).toDecimalPlaces(scale, D.ROUND_HALF_UP).toFixed(scale);
}

/**
 * The days of a billed period left unused when a contract is cancelled on `cancelOn` (the
 * customer is served to the end of that day), as a share of the full period the price was set
 * for: a part period keeps its full-period length, so the credit never exceeds what was billed.
 * Null when nothing of the period is left.
 */
export function unusedShare(p: Pick<ContractPeriod, 'start' | 'end' | 'part'>, cancelOn: string): { from: string; days: number; of: number } | null {
  if (!ISO.test(cancelOn)) throw new ContractError('CONTRACT_DATE', 'Use a date as YYYY-MM-DD');
  const from = cancelOn < p.start ? p.start : addDays(cancelOn, 1);
  if (from > p.end) return null;
  return { from, days: daysIn(from, p.end), of: p.part ? p.part.of : daysIn(p.start, p.end) };
}

/** A unit price raised by `percent` (for a price rise at renewal), rounded to 2 decimal places. */
export function upliftPrice(unitPrice: string, percent: string): string {
  const p = new D(percent);
  if (p.lt(-100) || p.gt(1000)) throw new ContractError('CONTRACT_UPLIFT', 'The price change must be between -100% and 1000%');
  return new D(unitPrice).times(p.plus(100)).div(100).toDecimalPlaces(2, D.ROUND_HALF_UP).toFixed(2);
}

/** "1 Nov 2026 to 30 Nov 2026": the period named on its invoice. */
export function periodLabel(p: Pick<ContractPeriod, 'start' | 'end'>): string {
  const f = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return `${f(p.start)} to ${f(p.end)}`;
}
