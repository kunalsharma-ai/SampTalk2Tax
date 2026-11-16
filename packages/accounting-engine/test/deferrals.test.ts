import { describe, expect, it } from 'vitest';
import { checkDeferralTerms, deferralBalance, deferralEndDate, deferralMonths, deferralSchedule, firstOfNextMonth, releaseLines, type DeferralTerms } from '../src';

const even: DeferralTerms = { amount: '120000.00', startDate: '2026-04-01', months: 12, method: 'EVEN' };

describe('prepaid and deferred schedules', () => {
  it('end dates and months covered', () => {
    expect(deferralEndDate({ startDate: '2026-04-01', months: 12 })).toBe('2027-03-31');
    expect(deferralEndDate({ startDate: '2026-04-15', months: 12 })).toBe('2027-04-14');
    expect(deferralEndDate({ startDate: '2026-01-31', months: 1 })).toBe('2026-02-27');
    expect(deferralEndDate({ startDate: '2027-12-01', months: 2 })).toBe('2028-01-31');
    expect(deferralMonths({ ...even, startDate: '2026-04-15' })).toEqual({ first: '2026-04', last: '2027-03' });
    expect(deferralMonths({ ...even, startDate: '2026-04-15', method: 'DAILY' })).toEqual({ first: '2026-04', last: '2027-04' });
    expect(firstOfNextMonth('2026-12')).toBe('2027-01-01');
  });

  it('even releases the same each month and nothing outside the period', () => {
    const rows = deferralSchedule(even, '2030-01');
    expect(rows).toHaveLength(12);
    expect(rows.every((r) => r.amount === '10000.00')).toBe(true);
    expect(rows.at(-1)).toMatchObject({ month: '2027-03', released: '120000.00', remaining: '0.00' });
    expect(deferralSchedule(even, '2026-06').map((r) => r.month)).toEqual(['2026-04', '2026-05', '2026-06']);
  });

  it('puts rounding into the last month', () => {
    const rows = deferralSchedule({ ...even, amount: '1000.00', months: 3 }, '2027-01');
    expect(rows.map((r) => r.amount)).toEqual(['333.33', '333.33', '333.34']);
  });

  it('daily spreads by days, so a part month gets its share and the total is exact', () => {
    // 15 Apr 2026 to 14 Apr 2027: 365 days. April has 16 of them.
    const t: DeferralTerms = { amount: '36500.00', startDate: '2026-04-15', months: 12, method: 'DAILY' };
    const rows = deferralSchedule(t, '2030-01');
    expect(rows).toHaveLength(13);
    expect(rows[0]).toMatchObject({ month: '2026-04', amount: '1600.00' });
    expect(rows[1]).toMatchObject({ month: '2026-05', amount: '3100.00' });
    expect(rows.find((r) => r.month === '2027-02')!.amount).toBe('2800.00');
    expect(rows.at(-1)).toMatchObject({ month: '2027-04', amount: '1400.00', remaining: '0.00' });
  });

  it('daily rounding never drifts', () => {
    const rows = deferralSchedule({ amount: '1000.00', startDate: '2026-01-10', months: 7, method: 'DAILY' }, '2030-01');
    expect(rows.reduce((s, r) => s + Math.round(+r.amount * 100), 0)).toBe(100000);
    expect(rows.at(-1)!.remaining).toBe('0.00');
  });

  it('keeps posted amounts and the next month catches up', () => {
    const rows = deferralSchedule(even, '2026-07', { '2026-04': '10000.00', '2026-05': '9000.00' });
    expect(rows.map((r) => [r.month, r.amount, r.posted])).toEqual([
      ['2026-04', '10000.00', true],
      ['2026-05', '9000.00', true],
      ['2026-06', '11000.00', false],
      ['2026-07', '10000.00', false],
    ]);
  });

  it('a schedule ended early stops at the end month', () => {
    const t = { ...even, endedOn: '2026-07-10' };
    expect(deferralSchedule(t, '2030-01', { '2026-04': '10000.00', '2026-05': '10000.00', '2026-06': '10000.00' }).map((r) => r.month)).toEqual(['2026-04', '2026-05', '2026-06']);
    expect(deferralSchedule(t, '2030-01', { '2026-04': '10000.00', '2026-05': '10000.00', '2026-06': '10000.00', '2026-07': '10000.00' }).map((r) => r.month)).toEqual(['2026-04', '2026-05', '2026-06', '2026-07']);
    expect(deferralBalance('120000.00', { '2026-04': '10000.00', '2026-05': '10000.00', '2026-06': '10000.00' })).toEqual({ released: '30000.00', remaining: '90000.00' });
  });

  it('release lines move the amount the right way for each kind', () => {
    expect(releaseLines('PREPAID_EXPENSE', '500.00')).toEqual([{ role: 'PNL', debit: '500.00' }, { role: 'BALANCE', credit: '500.00' }]);
    expect(releaseLines('DEFERRED_REVENUE', '500.00')).toEqual([{ role: 'BALANCE', debit: '500.00' }, { role: 'PNL', credit: '500.00' }]);
  });

  it('checks the terms', () => {
    expect(checkDeferralTerms(even)).toEqual([]);
    expect(checkDeferralTerms({ ...even, amount: '0' })).toContain('The amount must be more than zero');
    expect(checkDeferralTerms({ ...even, amount: '1.005' })).toContain('The amount has more than 2 decimal places');
    expect(checkDeferralTerms({ ...even, months: 0 })).toContain('The period must be 1 to 120 months');
    expect(checkDeferralTerms({ ...even, startDate: '2026-02-30' })).toContain('The start date is not a date');
  });
});
