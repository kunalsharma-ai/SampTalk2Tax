import { describe, expect, it } from 'vitest';
import { addMonthsAnchored, contractPeriod, duePeriods, fullyBilled, monthlyValue, periodCount, renewalState, renewedEnd, upcomingPeriods, upliftPrice } from '../src/contracts';

describe('contract periods', () => {
  it('keeps the start day, or the month end when the month is shorter', () => {
    expect(addMonthsAnchored('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsAnchored('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonthsAnchored('2026-01-31', 2)).toBe('2026-03-31');
    expect(addMonthsAnchored('2026-11-15', 3)).toBe('2027-02-15');
    expect(contractPeriod('2026-01-31', 'MONTHLY', 2)).toEqual({ no: 2, start: '2026-02-28', end: '2026-03-30', billDate: '2026-02-28' });
    expect(contractPeriod('2026-04-01', 'QUARTERLY', 4, 'ARREARS')).toEqual({ no: 4, start: '2027-01-01', end: '2027-03-31', billDate: '2027-03-31' });
  });

  it('counts whole periods to the end date and names valid end dates otherwise', () => {
    expect(periodCount('2026-04-01', '2027-03-31', 'MONTHLY')).toBe(12);
    expect(periodCount('2026-04-01', '2027-03-31', 'YEARLY')).toBe(1);
    expect(() => periodCount('2026-04-01', '2027-02-15', 'QUARTERLY')).toThrow(/2026-12-31 or 2027-03-31/);
    expect(() => periodCount('2026-04-01', '2026-03-01', 'MONTHLY')).toThrow(/before the start/);
  });

  it('bills every period that has fallen due, and none past the end date', () => {
    const c = { start: '2026-08-01', end: '2026-12-31', frequency: 'MONTHLY' as const, timing: 'ADVANCE' as const, nextNo: 1 };
    expect(duePeriods(c, '2026-07-31')).toEqual([]);
    expect(duePeriods(c, '2026-10-01').map((p) => p.start)).toEqual(['2026-08-01', '2026-09-01', '2026-10-01']);
    expect(duePeriods({ ...c, nextNo: 4 }, '2027-06-01').map((p) => p.no)).toEqual([4, 5]);
    expect(duePeriods({ ...c, timing: 'ARREARS' }, '2026-10-01').map((p) => p.billDate)).toEqual(['2026-08-31', '2026-09-30']);
    expect(duePeriods({ ...c, end: null }, '2027-01-01', 3).length).toBe(3);
    expect(upcomingPeriods({ ...c, nextNo: 5 }, 6).map((p) => p.no)).toEqual([5]);
    expect(fullyBilled({ ...c, nextNo: 5 })).toBe(false);
    expect(fullyBilled({ ...c, nextNo: 6 })).toBe(true);
    expect(fullyBilled({ ...c, end: null, nextNo: 60 })).toBe(false);
  });

  it('works out MRR, renewal timing, renewal end dates and price rises', () => {
    expect(monthlyValue('90000.00', 'QUARTERLY')).toBe('30000.00');
    expect(monthlyValue('100000.00', 'YEARLY')).toBe('8333.33');
    expect(renewalState(null, 30, '2026-11-06')).toBe('ROLLING');
    expect(renewalState('2027-03-31', 30, '2026-11-06')).toBe('RUNNING');
    expect(renewalState('2026-11-30', 30, '2026-11-06')).toBe('RENEWAL_DUE');
    expect(renewalState('2026-10-31', 30, '2026-11-06')).toBe('PAST_END');
    expect(renewedEnd('2026-04-01', '2027-03-31', 'MONTHLY', 12)).toBe('2028-03-31');
    expect(renewedEnd('2026-01-31', '2026-03-30', 'MONTHLY', 1)).toBe('2026-04-29');
    expect(() => renewedEnd('2026-04-01', '2027-03-31', 'QUARTERLY', 4)).toThrow(/whole number/);
    expect(upliftPrice('40000', '5')).toBe('42000.00');
    expect(upliftPrice('333.33', '7.5')).toBe('358.33');
    expect(() => upliftPrice('1', '-150')).toThrow();
  });
});
