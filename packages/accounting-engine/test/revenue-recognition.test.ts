import { describe, expect, it } from 'vitest';
import { functionalNet, recognitionEnd, recognitionIssues, revenueWaterfall } from '../src';

describe('revenue recognition', () => {
  it('checks a line can be recognised over time', () => {
    expect(recognitionIssues({ startDate: '2026-11-01', months: 12, method: 'DAILY' }, { no: 1, accountType: 'REVENUE', net: '120000' })).toEqual([]);
    expect(recognitionIssues({ startDate: '2026-11-31', months: 0, method: 'DAILY' }, { no: 2, accountType: 'ASSET', net: '0' })).toEqual([
      'Line 2: only a line to a revenue account can be recognised over time',
      'Line 2: only a line with a positive amount can be recognised over time',
      'Line 2: the start date is not a date',
      'Line 2: the period must be 1 to 120 months',
    ]);
    expect(recognitionEnd({ startDate: '2026-11-15', months: 12 })).toBe('2027-11-14');
    expect(functionalNet('1200', '83.4567')).toBe('100148.04');
  });

  it('builds the waterfall from posted and scheduled months', () => {
    const w = revenueWaterfall(
      [
        { amount: '120000', startDate: '2026-10-01', months: 12, method: 'EVEN', posted: { '2026-10': '10000' } },
        { amount: '36500', startDate: '2026-11-15', months: 12, method: 'DAILY', posted: {} },
      ],
      '2026-11',
      3,
    );
    expect(w.before).toBe('10000.00');
    expect(w.months).toEqual([
      { month: '2026-11', amount: '11600.00' },
      { month: '2026-12', amount: '13100.00' },
      { month: '2027-01', amount: '13100.00' },
    ]);
    expect(w.total).toBe('156500.00');
    expect(Number(w.before) + w.months.reduce((s, m) => s + Number(m.amount), 0) + Number(w.after)).toBe(156500);
  });
});
