import { describe, expect, it } from 'vitest';
import { fiscalYearStartFor, isoWeekday, nextScheduleRun, scheduleIssues, scheduleParams, type ScheduleInput } from '../src';

const members = new Set(['u1', 'u2']);
const ok: ScheduleInput = { name: 'Monthly P&L', report: 'income-statement', format: 'pdf', period: 'LAST_MONTH', frequency: 'MONTHLY', weekday: null, dayOfMonth: 3, recipientIds: ['u1'] };

describe('report schedules (RPT-031, RPT-032)', () => {
  it('accepts a valid schedule and explains what is wrong with others', () => {
    expect(scheduleIssues(ok, members)).toEqual([]);
    expect(scheduleIssues({ ...ok, name: ' ', report: 'cash', format: 'doc', recipientIds: [] }, members)).toEqual(['Give the schedule a name', 'Pick a report: income-statement, balance-sheet, trial-balance, receivables-ageing, payables-ageing', 'Pick PDF, Excel or CSV', 'Add at least one recipient']);
    expect(scheduleIssues({ ...ok, dayOfMonth: 31 }, members)).toEqual(['Pick a day of the month from 1 to 28']);
    expect(scheduleIssues({ ...ok, frequency: 'WEEKLY', weekday: 8 }, members)).toEqual(['Pick the day of the week']);
    expect(scheduleIssues({ ...ok, recipientIds: ['u1', 'stranger'] }, members)).toEqual(['Recipients must be members of this organisation who can read reports']);
    expect(scheduleIssues({ ...ok, recipientIds: ['u1', 'u1'] }, members)).toEqual(['A recipient is listed twice']);
    expect(scheduleIssues({ ...ok, report: 'balance-sheet', period: 'YEAR_TO_DATE' }, members)[0]).toMatch(/at a date/);
  });

  it('finds the next run strictly after a date', () => {
    expect(isoWeekday('2026-11-23')).toBe(1); // a Monday
    expect(isoWeekday('2026-11-22')).toBe(7);
    const weekly = { frequency: 'WEEKLY' as const, weekday: 1, dayOfMonth: null };
    expect(nextScheduleRun(weekly, '2026-11-21')).toBe('2026-11-23');
    expect(nextScheduleRun(weekly, '2026-11-23')).toBe('2026-11-30');
    const monthly = { frequency: 'MONTHLY' as const, weekday: null, dayOfMonth: 3 };
    expect(nextScheduleRun(monthly, '2026-11-02')).toBe('2026-11-03');
    expect(nextScheduleRun(monthly, '2026-11-03')).toBe('2026-12-03');
    expect(nextScheduleRun(monthly, '2026-12-21')).toBe('2027-01-03');
  });

  it('covers the right dates, always up to the day before the run', () => {
    expect(scheduleParams('income-statement', 'LAST_MONTH', '2026-03-03', 4)).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(scheduleParams('income-statement', 'MONTH_TO_DATE', '2026-11-21', 4)).toEqual({ from: '2026-11-01', to: '2026-11-20' });
    expect(scheduleParams('income-statement', 'MONTH_TO_DATE', '2026-12-01', 4)).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(scheduleParams('income-statement', 'YEAR_TO_DATE', '2026-11-21', 4)).toEqual({ from: '2026-04-01', to: '2026-11-20' });
    expect(scheduleParams('income-statement', 'YEAR_TO_DATE', '2026-02-10', 4)).toEqual({ from: '2025-04-01', to: '2026-02-09' });
    expect(scheduleParams('trial-balance', 'LAST_MONTH', '2026-01-05', 1)).toEqual({ from: '2025-12-01', asOf: '2025-12-31' });
    expect(scheduleParams('balance-sheet', 'LAST_MONTH', '2026-01-05', 4)).toEqual({ asOf: '2025-12-31' });
    expect(scheduleParams('receivables-ageing', 'TODAY', '2026-01-05', 4)).toEqual({ asOf: '2026-01-04' });
    expect(fiscalYearStartFor('2026-03-31', 4)).toBe('2025-04-01');
    expect(fiscalYearStartFor('2026-01-01', 1)).toBe('2026-01-01');
  });
});
