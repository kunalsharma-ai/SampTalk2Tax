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
}

/** Period `no` (from 1) of a contract starting on `start`. */
export function contractPeriod(start: string, frequency: ContractFrequency, no: number, timing: BillingTiming = 'ADVANCE'): ContractPeriod {
  if (!Number.isInteger(no) || no < 1) throw new ContractError('CONTRACT_PERIOD', 'Periods count from 1');
  const m = FREQUENCY_MONTHS[frequency];
  const s = addMonthsAnchored(start, (no - 1) * m);
  const e = addDays(addMonthsAnchored(start, no * m), -1);
  return { no, start: s, end: e, billDate: timing === 'ADVANCE' ? s : e };
}

/** How many whole periods run from `start` to `end`, or a CONTRACT_END error naming the nearest valid end dates. */
export function periodCount(start: string, end: string, frequency: ContractFrequency): number {
  if (end < start) throw new ContractError('CONTRACT_END', 'The end date cannot be before the start date');
  for (let n = 1; n <= 1200; n++) {
    const p = contractPeriod(start, frequency, n);
    if (p.end === end) return n;
    if (p.end > end) {
      const before = n > 1 ? contractPeriod(start, frequency, n - 1).end : null;
      throw new ContractError('CONTRACT_END', `The end date must be the last day of a ${FREQUENCY_LABEL[frequency].toLowerCase()} period: ${before ? `${before} or ` : ''}${p.end}`);
    }
  }
  throw new ContractError('CONTRACT_END', 'The contract is too long');
}

/**
 * The periods to bill now: from period `nextNo`, every one whose invoice date has come (on or
 * before `today`) and that is within the end date (none after it; all of them for a rolling
 * contract), at most `limit` at a time.
 */
export function duePeriods(c: { start: string; end: string | null; frequency: ContractFrequency; timing: BillingTiming; nextNo: number }, today: string, limit = 24): ContractPeriod[] {
  const out: ContractPeriod[] = [];
  for (let n = c.nextNo; out.length < limit; n++) {
    const p = contractPeriod(c.start, c.frequency, n, c.timing);
    if ((c.end && p.start > c.end) || p.billDate > today) break;
    out.push(p);
  }
  return out;
}

/** The next `count` periods from `nextNo` that are still to come within the end date. */
export function upcomingPeriods(c: { start: string; end: string | null; frequency: ContractFrequency; timing: BillingTiming; nextNo: number }, count: number): ContractPeriod[] {
  const out: ContractPeriod[] = [];
  for (let n = c.nextNo; out.length < count; n++) {
    const p = contractPeriod(c.start, c.frequency, n, c.timing);
    if (c.end && p.start > c.end) break;
    out.push(p);
  }
  return out;
}

/** True when every period up to the end date has been billed or skipped. */
export function fullyBilled(c: { start: string; end: string | null; frequency: ContractFrequency; nextNo: number }): boolean {
  return !!c.end && contractPeriod(c.start, c.frequency, c.nextNo).start > c.end;
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

/** The end date after renewing for `months` more months (a whole number of periods). */
export function renewedEnd(start: string, end: string, frequency: ContractFrequency, months: number): string {
  const m = FREQUENCY_MONTHS[frequency];
  if (!Number.isInteger(months) || months < m || months % m !== 0) throw new ContractError('CONTRACT_RENEWAL', `Renew for a whole number of ${FREQUENCY_LABEL[frequency].toLowerCase()} periods (${m} months each)`);
  return contractPeriod(start, frequency, periodCount(start, end, frequency) + months / m).end;
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
