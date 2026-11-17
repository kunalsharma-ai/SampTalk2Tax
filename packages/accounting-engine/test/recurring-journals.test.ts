import { describe, expect, it } from 'vitest';
import { checkTemplateLines, describeSchedule, dueRuns, fillPlaceholders, fiscalYearLabel, runCount, runDate, scheduleFinished, upcomingRuns } from '../src/recurring-journals';

const monthly = { start: '2026-01-31', end: null, frequency: 'MONTHLY' as const, monthEnd: false, nextNo: 1 };

describe('recurring journal schedules', () => {
  it('keeps the start day, or moves every run to the month end', () => {
    expect([1, 2, 3].map((n) => runDate(monthly, n))).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
    const mid = { start: '2026-04-15', frequency: 'MONTHLY' as const, monthEnd: true };
    expect([1, 2, 11].map((n) => runDate(mid, n))).toEqual(['2026-04-30', '2026-05-31', '2027-02-28']);
    expect(runDate({ start: '2026-04-01', frequency: 'QUARTERLY', monthEnd: false }, 4)).toBe('2027-01-01');
    expect(() => runDate(monthly, 0)).toThrow(/count from 1/);
  });

  it('makes every run that has fallen due, and none past the end date', () => {
    expect(dueRuns(monthly, '2026-03-30')).toEqual([{ no: 1, date: '2026-01-31' }, { no: 2, date: '2026-02-28' }]);
    expect(dueRuns({ ...monthly, nextNo: 3 }, '2026-03-30')).toEqual([]);
    const ending = { ...monthly, end: '2026-02-28' };
    expect(dueRuns(ending, '2026-12-31').map((r) => r.no)).toEqual([1, 2]);
    expect(scheduleFinished({ ...ending, nextNo: 3 })).toBe(true);
    expect(scheduleFinished({ ...ending, nextNo: 2 })).toBe(false);
    expect(scheduleFinished({ ...monthly, nextNo: 99 })).toBe(false);
    expect(dueRuns(monthly, '2030-01-01', 5)).toHaveLength(5);
    expect(upcomingRuns({ ...ending, nextNo: 2 }, 5)).toEqual([{ no: 2, date: '2026-02-28' }]);
  });

  it('counts the runs to the end date', () => {
    expect(runCount({ start: '2026-04-01', end: '2027-03-31', frequency: 'MONTHLY', monthEnd: true })).toBe(12);
    expect(runCount({ start: '2026-04-01', end: '2027-03-31', frequency: 'QUARTERLY', monthEnd: false })).toBe(4);
    expect(runCount({ start: '2026-04-01', end: null, frequency: 'YEARLY', monthEnd: false })).toBeNull();
    expect(() => runCount({ start: '2026-04-10', end: '2026-04-20', frequency: 'MONTHLY', monthEnd: true })).toThrow(/first is 2026-04-30/);
    expect(() => runCount({ start: '2026-04-10', end: '2026-03-20', frequency: 'MONTHLY', monthEnd: false })).toThrow(/before the start/);
    expect(describeSchedule({ start: '2026-04-01', end: '2027-03-31', frequency: 'MONTHLY', monthEnd: true })).toBe("Monthly from 2026-04-01 on the month's last day, until 2027-03-31 (12 runs)");
  });
});

describe('placeholders', () => {
  it('names the run month, quarter and fiscal year', () => {
    expect(fillPlaceholders('Rent for {month} ({period}), {quarter}', '2026-11-30', 4)).toBe('Rent for November 2026 (2026-11), Q3 FY 2026-27');
    expect(fillPlaceholders('{fy} {year} {date} {other}', '2027-03-31', 4)).toBe('FY 2026-27 2027 2027-03-31 {other}');
    expect(fiscalYearLabel('2026-11-30', 1)).toBe('FY 2026');
    expect(fillPlaceholders('{quarter}', '2026-01-15', 1)).toBe('Q1 FY 2026');
  });
});

describe('template lines', () => {
  it('needs balanced debits and credits in each currency', () => {
    expect(checkTemplateLines([{ accountId: 'a', debit: '50000' }, { accountId: 'b', credit: '50000.00' }], 'INR')).toEqual({
      issues: [],
      totals: [{ currency: 'INR', debit: '50000', credit: '50000' }],
    });
    const bad = checkTemplateLines([{ accountId: 'a', debit: '10', credit: '5' }, { accountId: 'b' }, { accountId: 'c', credit: '-1' }], 'INR');
    expect(bad.issues).toEqual([
      'Line 1: enter a debit or a credit, not both',
      'Line 2: enter a debit or a credit',
      'Line 3: amounts cannot be negative',
      'Debits (10) and credits (4) in INR must be equal',
    ]);
    const fx = checkTemplateLines([{ accountId: 'a', debit: '100', currency: 'USD' }, { accountId: 'b', credit: '100' }], 'INR');
    expect(fx.issues).toEqual(['Debits (100) and credits (0) in USD must be equal', 'Debits (0) and credits (100) in INR must be equal']);
    expect(checkTemplateLines([{ accountId: 'a', debit: '1' }], 'INR').issues[0]).toMatch(/at least two/);
  });
});
