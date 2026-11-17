import { addMonthsAnchored, ContractFrequency, FREQUENCY_LABEL, FREQUENCY_MONTHS } from './contracts';
import { D, dec, Dec } from './money';

/**
 * Journal templates and recurring journals (GL-007, GL-012). A template holds the lines of a
 * journal that is entered again and again (rent, an accrual, a management charge). A member uses it
 * to start a journal, or posts it straight away on a chosen date; a template with a schedule posts
 * itself every month, quarter, half-year or year from its start date, either on the same day of
 * the month as the start (the month's last day when shorter) or always on the month's last day.
 *
 * Each run is a normal journal (balanced, in an open period, checked like any other), dated the
 * run date; the memo can name the run's month with placeholders, e.g. "Rent for {month}".
 * These are the rules the server applies and the web shows.
 */

export const RECURRING_FREQUENCIES = ['MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY'] as const satisfies readonly ContractFrequency[];
export type RecurringFrequency = ContractFrequency;
export { FREQUENCY_LABEL as RECURRING_FREQUENCY_LABEL };

/** What a run makes: a draft for someone to review and post, or a posted journal. */
export const RECURRING_POST_MODES = ['DRAFT', 'POST'] as const;
export type RecurringPostMode = (typeof RECURRING_POST_MODES)[number];

export const SCHEDULE_STATUSES = ['ACTIVE', 'PAUSED', 'ENDED'] as const;
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];

export class TemplateError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const lastDayOfMonth = (iso: string) => {
  const [y, m] = iso.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${iso.slice(0, 7)}-${String(d).padStart(2, '0')}`;
};

export interface RecurringSchedule {
  start: string;
  /** The last date a run may fall on; null runs on until paused or ended. */
  end: string | null;
  frequency: RecurringFrequency;
  /** True: every run falls on its month's last day (month-end accruals). */
  monthEnd: boolean;
  /** The next run to make (1 for the first). */
  nextNo: number;
}

export interface RecurringRun {
  no: number;
  date: string;
}

/** The date of run `no` (from 1). */
export function runDate(s: Pick<RecurringSchedule, 'start' | 'frequency' | 'monthEnd'>, no: number): string {
  if (!Number.isInteger(no) || no < 1) throw new TemplateError('TEMPLATE_RUN', 'Runs count from 1');
  const d = addMonthsAnchored(s.start, (no - 1) * FREQUENCY_MONTHS[s.frequency]);
  return s.monthEnd ? lastDayOfMonth(d) : d;
}

/** The runs to make now: from `nextNo`, every one dated on or before `today` and on or before the end date, at most `limit`. */
export function dueRuns(s: RecurringSchedule, today: string, limit = 24): RecurringRun[] {
  const out: RecurringRun[] = [];
  for (let n = s.nextNo; out.length < limit; n++) {
    const date = runDate(s, n);
    if ((s.end && date > s.end) || date > today) break;
    out.push({ no: n, date });
  }
  return out;
}

/** The next `count` runs from `nextNo` still to come within the end date. */
export function upcomingRuns(s: RecurringSchedule, count: number): RecurringRun[] {
  const out: RecurringRun[] = [];
  for (let n = s.nextNo; out.length < count; n++) {
    const date = runDate(s, n);
    if (s.end && date > s.end) break;
    out.push({ no: n, date });
  }
  return out;
}

/** True when the schedule has no run left on or before its end date. */
export function scheduleFinished(s: RecurringSchedule): boolean {
  return !!s.end && runDate(s, s.nextNo) > s.end;
}

/** How many runs fall between the start and the end date (null when it runs on). */
export function runCount(s: Pick<RecurringSchedule, 'start' | 'end' | 'frequency' | 'monthEnd'>): number | null {
  if (!s.end) return null;
  if (s.end < s.start) throw new TemplateError('TEMPLATE_END', 'The end date cannot be before the start date');
  let n = 0;
  while (runDate(s, n + 1) <= s.end) {
    n++;
    if (n > 1200) throw new TemplateError('TEMPLATE_END', 'The schedule is too long');
  }
  if (n === 0) throw new TemplateError('TEMPLATE_END', `No run falls on or before the end date (the first is ${runDate(s, 1)})`);
  return n;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The placeholders a memo, reference or line description can use, with what they become for a run dated 2026-11-30 (fiscal year from April). */
export const TEMPLATE_PLACEHOLDERS: { key: string; meaning: string; example: string }[] = [
  { key: '{date}', meaning: 'The journal date', example: '2026-11-30' },
  { key: '{month}', meaning: 'The month and year', example: 'November 2026' },
  { key: '{period}', meaning: 'The year and month', example: '2026-11' },
  { key: '{quarter}', meaning: 'The fiscal quarter', example: 'Q3 FY 2026-27' },
  { key: '{fy}', meaning: 'The fiscal year', example: 'FY 2026-27' },
  { key: '{year}', meaning: 'The calendar year', example: '2026' },
];

/** The fiscal year label of `date` for a year starting in month `fyStartMonth` (1-12): "FY 2026-27", or "FY 2026" for a calendar year. */
export function fiscalYearLabel(date: string, fyStartMonth: number): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const startYear = m >= fyStartMonth ? y : y - 1;
  return fyStartMonth === 1 ? `FY ${startYear}` : `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** Replaces the placeholders in `text` for a run dated `date`. Unknown braces are left as typed. */
export function fillPlaceholders(text: string, date: string, fyStartMonth: number): string {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const fyMonth = (m - fyStartMonth + 12) % 12;
  const fy = fiscalYearLabel(date, fyStartMonth);
  const values: Record<string, string> = {
    '{date}': date,
    '{month}': `${MONTHS[m - 1]} ${y}`,
    '{period}': date.slice(0, 7),
    '{quarter}': `Q${Math.floor(fyMonth / 3) + 1} ${fy}`,
    '{fy}': fy,
    '{year}': String(y),
  };
  return text.replace(/\{(date|month|period|quarter|fy|year)\}/g, (k) => values[k] ?? k);
}

export interface TemplateLine {
  accountId: string;
  debit?: string | null;
  credit?: string | null;
  /** Null: the functional currency. */
  currency?: string | null;
}

export interface TemplateTotals {
  currency: string;
  debit: string;
  credit: string;
}

/**
 * The checks a template's lines pass before they are saved: two lines or more, each line a debit
 * or a credit (one of them above zero), and debits equal to credits in each currency. A template
 * in a foreign currency is converted at the rate recorded for each run's date when it is posted.
 */
export function checkTemplateLines(lines: TemplateLine[], functionalCurrency: string): { issues: string[]; totals: TemplateTotals[] } {
  const issues: string[] = [];
  if (lines.length < 2) issues.push('A template needs at least two lines');
  const by = new Map<string, { debit: Dec; credit: Dec }>();
  lines.forEach((l, i) => {
    const n = i + 1;
    let debit: Dec = new D(0);
    let credit: Dec = new D(0);
    try {
      debit = l.debit ? dec(l.debit) : new D(0);
      credit = l.credit ? dec(l.credit) : new D(0);
    } catch {
      issues.push(`Line ${n}: the amount is not a number`);
      return;
    }
    if (debit.isNegative() || credit.isNegative()) issues.push(`Line ${n}: amounts cannot be negative`);
    else if (debit.gt(0) && credit.gt(0)) issues.push(`Line ${n}: enter a debit or a credit, not both`);
    else if (debit.isZero() && credit.isZero()) issues.push(`Line ${n}: enter a debit or a credit`);
    const cur = l.currency || functionalCurrency;
    const t = by.get(cur) ?? { debit: new D(0), credit: new D(0) };
    by.set(cur, { debit: t.debit.plus(debit), credit: t.credit.plus(credit) });
  });
  const totals = [...by.entries()].map(([currency, t]) => ({ currency, debit: t.debit.toFixed(), credit: t.credit.toFixed() }));
  for (const [currency, t] of by) {
    if (!t.debit.eq(t.credit)) issues.push(`Debits (${t.debit.toFixed()}) and credits (${t.credit.toFixed()}) in ${currency} must be equal`);
  }
  return { issues, totals };
}

/** A plain description of a schedule: "Monthly from 2026-04-01 on the month's last day, until 2027-03-31 (12 runs)". */
export function describeSchedule(s: Pick<RecurringSchedule, 'start' | 'end' | 'frequency' | 'monthEnd'>): string {
  const count = s.end ? runCount(s) : null;
  return `${FREQUENCY_LABEL[s.frequency]} from ${s.start}${s.monthEnd ? " on the month's last day" : ''}${s.end ? `, until ${s.end} (${count} run${count === 1 ? '' : 's'})` : ', until stopped'}`;
}
