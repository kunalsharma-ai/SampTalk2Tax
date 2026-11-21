/**
 * Internal controls register (AUDIT-008 control testing, AUDIT-013 control ownership): each
 * control has an owner and a frequency; each period it is tested, by someone other than its owner
 * where there is someone else, and the result is kept with its evidence. Some controls can be
 * checked against the books automatically; the evidence is then worked out by the server, never
 * typed in.
 */
import { addDays } from './documents';
import { addMonth, monthEnd } from './fixed-assets';
import { fiscalYearStartFor } from './report-schedules';

export const CONTROL_FREQUENCIES = ['MONTHLY', 'QUARTERLY', 'YEARLY'] as const;
export type ControlFrequency = (typeof CONTROL_FREQUENCIES)[number];
export const CONTROL_AREAS = ['CASH', 'PAYABLES', 'RECEIVABLES', 'LEDGER', 'ACCESS', 'TAX', 'PAYROLL', 'OTHER'] as const;
export type ControlArea = (typeof CONTROL_AREAS)[number];

/** Checks the server can run against the books for a period. */
export const AUTOMATIC_CHECKS = {
  BANKS_RECONCILED: 'Every bank account with postings is reconciled to the end of the period',
  JOURNALS_SEGREGATED: 'Every manual journal in the period was posted by someone other than its author, or the exception was reviewed',
  VENDOR_BANK_DETAILS_VERIFIED: 'Every vendor bank detail change is verified by a second person',
  PERIODS_LOCKED: 'Every accounting period that ended by the end of the period is locked or closed',
} as const;
export type AutomaticCheck = keyof typeof AUTOMATIC_CHECKS;
export const AUTOMATIC_CHECK_KEYS = Object.keys(AUTOMATIC_CHECKS) as AutomaticCheck[];

export interface ControlTemplate {
  id: string;
  title: string;
  objective: string;
  area: ControlArea;
  frequency: ControlFrequency;
  check: AutomaticCheck | null;
}

/** Starter controls for a small finance team; each is added and owned like any other. */
export const CONTROL_LIBRARY: readonly ControlTemplate[] = [
  { id: 'BANK_RECONCILIATION', title: 'Bank accounts reconciled monthly', objective: 'Every payment and receipt in the books is on the bank statement, and the other way round.', area: 'CASH', frequency: 'MONTHLY', check: 'BANKS_RECONCILED' },
  { id: 'JOURNAL_REVIEW', title: 'Manual journals posted by a second person', objective: 'No one can move amounts between accounts on their own.', area: 'LEDGER', frequency: 'MONTHLY', check: 'JOURNALS_SEGREGATED' },
  { id: 'VENDOR_BANK_CHANGES', title: 'Vendor bank detail changes verified', objective: 'Payments go only to bank accounts confirmed with the vendor.', area: 'PAYABLES', frequency: 'MONTHLY', check: 'VENDOR_BANK_DETAILS_VERIFIED' },
  { id: 'PERIOD_LOCK', title: 'Closed months locked', objective: 'Figures already reported cannot change without reopening the period.', area: 'LEDGER', frequency: 'MONTHLY', check: 'PERIODS_LOCKED' },
  { id: 'RECEIVABLES_REVIEW', title: 'Overdue receivables reviewed', objective: 'Overdue customers are chased and doubtful debts provided for.', area: 'RECEIVABLES', frequency: 'MONTHLY', check: null },
  { id: 'ACCESS_REVIEW', title: 'Member access reviewed', objective: 'Only current staff have access, with the role their job needs.', area: 'ACCESS', frequency: 'QUARTERLY', check: null },
  { id: 'TAX_RETURNS_REVIEW', title: 'Tax returns reviewed before filing', objective: 'Returns agree to the books and are checked by someone who did not prepare them.', area: 'TAX', frequency: 'MONTHLY', check: null },
];

export interface ControlPeriod {
  /** 2026-10, 2026-Q2 (fiscal quarter, by the fiscal year it starts in) or FY2026. */
  key: string;
  label: string;
  from: string;
  to: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = (m: string) => `${MONTHS[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;

/** The period of the given frequency that `date` falls in. */
export function controlPeriodFor(frequency: ControlFrequency, date: string, fyStartMonth: number): ControlPeriod {
  const month = date.slice(0, 7);
  if (frequency === 'MONTHLY') return { key: month, label: monthName(month), from: `${month}-01`, to: monthEnd(month) };
  const fy = fiscalYearStartFor(date, fyStartMonth).slice(0, 7);
  const fyYear = +fy.slice(0, 4);
  if (frequency === 'YEARLY') {
    const last = addMonth(fy, 11);
    return { key: `FY${fyYear}`, label: `Year ${monthName(fy)} to ${monthName(last)}`, from: `${fy}-01`, to: monthEnd(last) };
  }
  let q = 0;
  while (addMonth(fy, 3 * (q + 1)) <= month) q++;
  const start = addMonth(fy, 3 * q);
  const end = addMonth(start, 2);
  return { key: `${fyYear}-Q${q + 1}`, label: `Q${q + 1}: ${monthName(start)} to ${monthName(end)}`, from: `${start}-01`, to: monthEnd(end) };
}

/** The latest period that has ended on `today`: the one a control should be tested for now. */
export function dueControlPeriod(frequency: ControlFrequency, today: string, fyStartMonth: number): ControlPeriod {
  const current = controlPeriodFor(frequency, today, fyStartMonth);
  return controlPeriodFor(frequency, addDays(current.from, -1), fyStartMonth);
}

/** Days after a period ends in which its test is due; after that it is overdue. */
export const CONTROL_TEST_GRACE_DAYS = 15;

export type ControlStatus = 'PASSED' | 'FAILED' | 'DUE' | 'OVERDUE' | 'INACTIVE';

/** Where a control stands on `today`, from the result recorded for its due period, if any. */
export function controlStatus(c: { active: boolean; frequency: ControlFrequency }, tested: 'PASS' | 'FAIL' | null, today: string, fyStartMonth: number): ControlStatus {
  if (!c.active) return 'INACTIVE';
  if (tested === 'PASS') return 'PASSED';
  if (tested === 'FAIL') return 'FAILED';
  return addDays(dueControlPeriod(c.frequency, today, fyStartMonth).to, CONTROL_TEST_GRACE_DAYS) < today ? 'OVERDUE' : 'DUE';
}

/** Whether a period key is a real period of the frequency, and that period. */
export function parseControlPeriod(frequency: ControlFrequency, key: string, fyStartMonth: number): ControlPeriod | null {
  let date: string | null = null;
  if (frequency === 'MONTHLY' && /^\d{4}-(0[1-9]|1[0-2])$/.test(key)) date = `${key}-01`;
  const q = /^(\d{4})-Q([1-4])$/.exec(key);
  if (frequency === 'QUARTERLY' && q) date = `${addMonth(`${q[1]}-${String(fyStartMonth).padStart(2, '0')}`, 3 * (+q[2]! - 1))}-01`;
  const y = /^FY(\d{4})$/.exec(key);
  if (frequency === 'YEARLY' && y) date = `${y[1]}-${String(fyStartMonth).padStart(2, '0')}-01`;
  if (!date) return null;
  const p = controlPeriodFor(frequency, date, fyStartMonth);
  return p.key === key ? p : null;
}

export interface CheckOutcome {
  result: 'PASS' | 'FAIL';
  /** What was looked at, in words, for the evidence kept with the test. */
  summary: string;
  /** Each exception found, in words. */
  exceptions: string[];
}

/** The outcome of an automatic check from the facts the server gathered for the period. */
export function automaticCheckOutcome(check: AutomaticCheck, facts: { items: number; exceptions: string[] }): CheckOutcome {
  const what: Record<AutomaticCheck, string> = {
    BANKS_RECONCILED: 'bank accounts with postings',
    JOURNALS_SEGREGATED: 'manual journals posted in the period',
    VENDOR_BANK_DETAILS_VERIFIED: 'vendors with bank details',
    PERIODS_LOCKED: 'accounting periods that had ended',
  };
  const n = facts.exceptions.length;
  return {
    result: n ? 'FAIL' : 'PASS',
    summary: `${facts.items} ${what[check]} checked; ${n ? `${n} exception${n === 1 ? '' : 's'}` : 'no exceptions'}.`,
    exceptions: facts.exceptions,
  };
}
