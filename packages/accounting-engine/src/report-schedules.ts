/**
 * Scheduled reports by email (RPT-031, RPT-032): a report, a period it covers, how often it goes
 * out, and which members receive it. Pure rules: which dates a run covers, when the next run is,
 * and whether a schedule is valid. The API renders the report with the same export as the
 * screens and emails it as an attachment.
 */
import { addDays } from './documents';
import { addMonth, monthEnd } from './fixed-assets';

export const SCHEDULED_REPORTS = ['income-statement', 'balance-sheet', 'trial-balance', 'receivables-ageing', 'payables-ageing'] as const;
export type ScheduledReport = (typeof SCHEDULED_REPORTS)[number];
export const SCHEDULED_REPORT_LABEL: Record<ScheduledReport, string> = {
  'income-statement': 'Profit and loss',
  'balance-sheet': 'Balance sheet',
  'trial-balance': 'Trial balance',
  'receivables-ageing': 'Receivables ageing',
  'payables-ageing': 'Payables ageing',
};

export const SCHEDULE_FORMATS = ['pdf', 'xlsx', 'csv'] as const;
export type ScheduleFormat = (typeof SCHEDULE_FORMATS)[number];

/** The period a run covers, counted back from the day it runs. */
export const SCHEDULE_PERIODS = ['LAST_MONTH', 'MONTH_TO_DATE', 'YEAR_TO_DATE', 'TODAY'] as const;
export type SchedulePeriod = (typeof SCHEDULE_PERIODS)[number];
export const SCHEDULE_PERIOD_LABEL: Record<SchedulePeriod, string> = {
  LAST_MONTH: 'Last full month',
  MONTH_TO_DATE: 'This month to the day before',
  YEAR_TO_DATE: 'Financial year to the day before',
  TODAY: 'As at the day before',
};

export const REPORT_SCHEDULE_FREQUENCIES = ['WEEKLY', 'MONTHLY'] as const;
export type ReportScheduleFrequency = (typeof REPORT_SCHEDULE_FREQUENCIES)[number];

export const MAX_SCHEDULE_RECIPIENTS = 10;

export interface ScheduleTiming {
  frequency: ReportScheduleFrequency;
  /** WEEKLY: 1 (Monday) to 7 (Sunday). */
  weekday: number | null;
  /** MONTHLY: 1 to 28, so every month has the day. */
  dayOfMonth: number | null;
}

export interface ScheduleInput extends ScheduleTiming {
  name: string;
  report: string;
  format: string;
  period: string;
  recipientIds: string[];
}

/** Problems with a schedule, in words a person can act on. Empty when it is valid. */
export function scheduleIssues(s: ScheduleInput, members: ReadonlySet<string>): string[] {
  const issues: string[] = [];
  if (!s.name.trim()) issues.push('Give the schedule a name');
  if (s.name.trim().length > 80) issues.push('Keep the name to 80 characters');
  if (!(SCHEDULED_REPORTS as readonly string[]).includes(s.report)) issues.push(`Pick a report: ${SCHEDULED_REPORTS.join(', ')}`);
  if (!(SCHEDULE_FORMATS as readonly string[]).includes(s.format)) issues.push('Pick PDF, Excel or CSV');
  if (!(SCHEDULE_PERIODS as readonly string[]).includes(s.period)) issues.push('Pick the period the report covers');
  if (s.report === 'balance-sheet' || s.report === 'receivables-ageing' || s.report === 'payables-ageing') {
    if (s.period === 'MONTH_TO_DATE' || s.period === 'YEAR_TO_DATE') issues.push('This report is at a date: pick "Last full month" (its last day) or "As at the day before"');
  }
  if (s.frequency === 'WEEKLY') {
    if (!Number.isInteger(s.weekday) || s.weekday! < 1 || s.weekday! > 7) issues.push('Pick the day of the week');
  } else if (s.frequency === 'MONTHLY') {
    if (!Number.isInteger(s.dayOfMonth) || s.dayOfMonth! < 1 || s.dayOfMonth! > 28) issues.push('Pick a day of the month from 1 to 28');
  } else issues.push('Pick weekly or monthly');
  const ids = new Set(s.recipientIds);
  if (!ids.size) issues.push('Add at least one recipient');
  if (ids.size > MAX_SCHEDULE_RECIPIENTS) issues.push(`At most ${MAX_SCHEDULE_RECIPIENTS} recipients`);
  if (ids.size !== s.recipientIds.length) issues.push('A recipient is listed twice');
  for (const id of ids) if (!members.has(id)) issues.push('Recipients must be members of this organisation who can read reports');
  return [...new Set(issues)];
}

/** ISO weekday of a date: 1 Monday to 7 Sunday. */
export function isoWeekday(date: string): number {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** The first run date strictly after `after`. */
export function nextScheduleRun(t: ScheduleTiming, after: string): string {
  if (t.frequency === 'WEEKLY') {
    const gap = ((t.weekday! - isoWeekday(after) + 6) % 7) + 1;
    return addDays(after, gap);
  }
  const day = String(t.dayOfMonth!).padStart(2, '0');
  const thisMonth = `${after.slice(0, 7)}-${day}`;
  return thisMonth > after ? thisMonth : `${addMonth(after.slice(0, 7), 1)}-${day}`;
}

/** The first day of the financial year that contains `date`. */
export function fiscalYearStartFor(date: string, startMonth: number): string {
  const y = +date.slice(0, 4);
  const m = +date.slice(5, 7);
  return `${m >= startMonth ? y : y - 1}-${String(startMonth).padStart(2, '0')}-01`;
}

/**
 * The report parameters for a run on `runOn`. Runs report up to the day before, so a run never
 * shows a day that is still going on.
 */
export function scheduleParams(report: ScheduledReport, period: SchedulePeriod, runOn: string, fiscalYearStartMonth: number): Record<string, string> {
  const yesterday = addDays(runOn, -1);
  const lastMonth = addMonth(runOn.slice(0, 7), -1);
  const atDate = report === 'balance-sheet' || report === 'receivables-ageing' || report === 'payables-ageing';
  if (atDate) return { asOf: period === 'LAST_MONTH' ? monthEnd(lastMonth) : yesterday };
  let range: { from: string; to: string };
  switch (period) {
    case 'LAST_MONTH':
      range = { from: `${lastMonth}-01`, to: monthEnd(lastMonth) };
      break;
    case 'MONTH_TO_DATE':
      range = { from: `${yesterday.slice(0, 7)}-01`, to: yesterday };
      break;
    case 'YEAR_TO_DATE':
      range = { from: fiscalYearStartFor(yesterday, fiscalYearStartMonth), to: yesterday };
      break;
    case 'TODAY':
      range = { from: yesterday, to: yesterday };
      break;
  }
  return report === 'trial-balance' ? { from: range.from, asOf: range.to } : range;
}
