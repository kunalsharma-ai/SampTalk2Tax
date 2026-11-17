import { describe, expect, it } from 'vitest';
import { planIssues, planTiming, scheduleWeeks, suggestPayDate, weekStart } from '../src/payment-schedule';

// 2026-11-09 is a Monday; 2026-11-13 a Friday.
describe('payment scheduling', () => {
  it('suggests the due date, or the last pay day before it, never the past', () => {
    expect(suggestPayDate('2026-11-20', '2026-11-09')).toBe('2026-11-20');
    expect(suggestPayDate('2026-11-01', '2026-11-09')).toBe('2026-11-09');
    // Pay on Fridays (5): the Friday on or before the due date.
    expect(suggestPayDate('2026-11-18', '2026-11-09', 5)).toBe('2026-11-13');
    expect(suggestPayDate('2026-11-13', '2026-11-09', 5)).toBe('2026-11-13');
    // Due before this week's pay day: today.
    expect(suggestPayDate('2026-11-11', '2026-11-09', 5)).toBe('2026-11-09');
    // Already overdue: the next pay day.
    expect(suggestPayDate('2026-11-02', '2026-11-09', 5)).toBe('2026-11-13');
    expect(suggestPayDate('2026-11-02', '2026-11-13', 5)).toBe('2026-11-13');
    expect(() => suggestPayDate('2026-11-02', '2026-11-13', 7)).toThrow(/0 \(Sunday\)/);
  });

  it('says whether a plan pays on time', () => {
    expect(planTiming('2026-11-13', '2026-11-20', '2026-11-09')).toBe('ON_TIME');
    expect(planTiming('2026-11-20', '2026-11-20', '2026-11-09')).toBe('ON_TIME');
    expect(planTiming('2026-11-21', '2026-11-20', '2026-11-09')).toBe('LATE');
    expect(planTiming('2026-11-10', '2026-11-05', '2026-11-09')).toBe('OVERDUE');
  });

  it('checks the date and the amount', () => {
    const base = { issueDate: '2026-11-01', due: '1000.00', currency: 'INR', today: '2026-11-09' };
    expect(planIssues({ ...base, payDate: '2026-11-10' })).toEqual([]);
    expect(planIssues({ ...base, payDate: '2026-11-10', amount: '400.50' })).toEqual([]);
    expect(planIssues({ ...base, payDate: '2026-11-08' })[0]).toMatch(/past/);
    expect(planIssues({ ...base, today: '2026-10-01', payDate: '2026-10-15' })[0]).toMatch(/before the bill date/);
    expect(planIssues({ ...base, payDate: '2026-11-10', amount: '1000.01' })[0]).toMatch(/more than the 1000.00 left/);
    expect(planIssues({ ...base, payDate: '2026-11-10', amount: '0' })[0]).toMatch(/more than zero/);
    expect(planIssues({ ...base, payDate: '2026-11-10', amount: '1.001' })[0]).toMatch(/decimals/);
    expect(planIssues({ ...base, payDate: '2026-11-10', amount: 'abc' })[0]).toMatch(/not an amount/);
  });

  it('adds up the planned payments week by week against the cash', () => {
    expect(weekStart('2026-11-15')).toBe('2026-11-09');
    expect(weekStart('2026-11-09')).toBe('2026-11-09');
    const weeks = scheduleWeeks(
      [
        { payDate: '2026-11-05', amount: '100.00' }, // overdue plan: counts in the first week
        { payDate: '2026-11-13', amount: '250.25' },
        { payDate: '2026-11-17', amount: '600' },
        { payDate: '2027-03-01', amount: '9' }, // beyond the window
      ],
      '800.00',
      '2026-11-10',
      3,
      'INR',
    );
    expect(weeks).toEqual([
      { week: '2026-11-09', payments: 2, amount: '350.25', balanceAfter: '449.75', short: false },
      { week: '2026-11-16', payments: 1, amount: '600.00', balanceAfter: '-150.25', short: true },
      { week: '2026-11-23', payments: 0, amount: '0.00', balanceAfter: '-150.25', short: true },
    ]);
  });
});
