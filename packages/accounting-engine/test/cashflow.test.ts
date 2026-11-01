import { describe, expect, it } from 'vitest';
import { buildCashForecast, CashFlowError, delayStats, expectedDates, forecastAccuracy, plannedDates } from '../src';

describe('payment behaviour', () => {
  it('takes nearest-rank percentiles of delays, with enough history only', () => {
    expect(delayStats([0, 10, 5, 20, -2])).toEqual({ count: 5, p25: 0, median: 5, p75: 10 });
    expect(delayStats([3, 3, 3])).toEqual({ count: 3, p25: 3, median: 3, p75: 3 });
    expect(delayStats([1, 2])).toBeNull();
    expect(() => delayStats([1.5, 2, 3])).toThrow(CashFlowError);
  });

  it('expects payment after the usual delay, never before tomorrow, and flags doubtful invoices', () => {
    const s = { count: 5, p25: 0, median: 5, p75: 10 };
    expect(expectedDates('2026-11-20', '2026-11-01', s)).toEqual({ early: '2026-11-20', base: '2026-11-25', late: '2026-11-30', pastTypical: false, doubtful: false });
    // Already later than usual: tomorrow at the earliest
    expect(expectedDates('2026-10-20', '2026-11-01', s)).toMatchObject({ early: '2026-11-02', base: '2026-11-02', late: '2026-11-02', pastTypical: true, doubtful: false });
    expect(expectedDates('2026-07-01', '2026-11-01', null)).toMatchObject({ base: '2026-11-02', pastTypical: true, doubtful: true });
    // No history: the due date
    expect(expectedDates('2026-11-15', '2026-11-01', null)).toMatchObject({ early: '2026-11-15', base: '2026-11-15', late: '2026-11-15' });
  });
});

describe('planned items', () => {
  it('repeats weekly, monthly (keeping the day, clamped to month end), quarterly and yearly', () => {
    expect(plannedDates({ startDate: '2026-11-05', frequency: 'ONCE' }, '2026-11-01', '2026-12-31')).toEqual(['2026-11-05']);
    expect(plannedDates({ startDate: '2026-10-29', frequency: 'WEEKLY' }, '2026-11-01', '2026-11-20')).toEqual(['2026-11-05', '2026-11-12', '2026-11-19']);
    expect(plannedDates({ startDate: '2026-01-31', frequency: 'MONTHLY' }, '2026-01-01', '2026-04-30')).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
    expect(plannedDates({ startDate: '2026-04-15', frequency: 'QUARTERLY', endDate: '2027-01-14' }, '2026-05-01', '2027-12-31')).toEqual(['2026-07-15', '2026-10-15']);
    expect(plannedDates({ startDate: '2024-02-29', frequency: 'YEARLY' }, '2025-01-01', '2028-12-31')).toEqual(['2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']);
    expect(plannedDates({ startDate: '2027-01-01', frequency: 'MONTHLY' }, '2026-11-01', '2026-12-31')).toEqual([]);
  });
});

describe('the forecast', () => {
  const asOf = '2026-11-01';
  const flows = [
    { amount: '1000.00', category: 'RECEIVABLE' as const, dates: { early: '2026-11-03', base: '2026-11-05', late: '2026-11-10' } },
    { amount: '500.00', category: 'RECEIVABLE' as const, dates: { early: '2026-11-02', base: '2026-11-02', late: '2026-11-02' }, doubtful: true },
    { amount: '-1500.00', category: 'PAYABLE' as const, dates: { early: '2026-11-04', base: '2026-11-04', late: '2026-11-04' } },
    { amount: '-200.00', category: 'PLANNED_OUT' as const, dates: { early: '2026-11-08', base: '2026-11-08', late: '2026-11-08' } },
    { amount: '300.00', category: 'PLANNED_IN' as const, dates: { early: '2026-12-15', base: '2026-12-15', late: '2026-12-15' } },
  ];

  it('runs a daily balance in three cases and finds the lowest point and the buffer breach', () => {
    const f = buildCashForecast({ asOf, horizonDays: 14, opening: '1000', flows, buffer: '0' });
    expect(f).toMatchObject({ start: '2026-11-02', end: '2026-11-15', opening: '1000.00' });
    expect(f.days).toHaveLength(14);
    const day = (d: string) => f.days.find((x) => x.date === d)!;
    // base: −1500 on the 4th, +1000 on the 5th, −200 on the 8th; the doubtful 500 is left out
    expect(day('2026-11-04')).toEqual({ date: '2026-11-04', base: '-500.00', low: '-500.00', high: '1000.00' });
    expect(day('2026-11-05').base).toBe('500.00');
    expect(day('2026-11-09')).toMatchObject({ base: '300.00', low: '-700.00', high: '800.00' });
    expect(f.closing).toEqual({ base: '300.00', low: '300.00', high: '800.00' });
    expect(f.lowest).toEqual({ base: { date: '2026-11-04', amount: '-500.00' }, low: { date: '2026-11-08', amount: '-700.00' } });
    expect(f.belowBuffer).toEqual({ base: '2026-11-04', low: '2026-11-04' });
    expect(f.totals).toEqual({ RECEIVABLE: '1000.00', PAYABLE: '1500.00', PLANNED_IN: '0.00', PLANNED_OUT: '200.00' });
    // weekly buckets that chain
    expect(f.buckets.map((b) => [b.from, b.to])).toEqual([['2026-11-02', '2026-11-08'], ['2026-11-09', '2026-11-15']]);
    expect(f.buckets[0]).toMatchObject({ opening: '1000.00', inflows: { RECEIVABLE: '1000.00' }, outflows: { PAYABLE: '1500.00', PLANNED_OUT: '200.00' }, net: '-700.00', closing: '300.00' });
    expect(f.buckets[1].opening).toBe(f.buckets[0].closing);
  });

  it('uses calendar months beyond 90 days and leaves out flows after the horizon', () => {
    const f = buildCashForecast({ asOf, horizonDays: 180, opening: '0', flows });
    expect(f.buckets[0]).toMatchObject({ from: '2026-11-02', to: '2026-11-30' });
    expect(f.buckets[1]).toMatchObject({ from: '2026-12-01', to: '2026-12-31', inflows: { PLANNED_IN: '300.00' } });
    expect(f.buckets.at(-1)!.to).toBe('2027-04-30');
    expect(buildCashForecast({ asOf, horizonDays: 30, opening: '0', flows }).totals.PLANNED_IN).toBe('0.00');
    expect(f.belowBuffer).toEqual({ base: null, low: null });
    expect(() => buildCashForecast({ asOf, horizonDays: 0, opening: '0', flows: [] })).toThrow(CashFlowError);
    expect(() => buildCashForecast({ asOf, horizonDays: 5, opening: '0', flows: [{ ...flows[2], doubtful: true }] })).toThrow(CashFlowError);
  });

  it('measures a saved forecast against actual balances', () => {
    const f = buildCashForecast({ asOf, horizonDays: 7, opening: '1000', flows });
    const actual = new Map([
      ['2026-11-02', '1000.00'],
      ['2026-11-03', '1100.00'],
      ['2026-11-04', '-200.00'],
    ]);
    const a = forecastAccuracy(f.days, actual);
    expect(a.days).toBe(3);
    // errors: 0, +100, +300 → MAE 133.33, bias 133.33
    expect(a.meanAbsoluteError).toBe('133.33');
    expect(a.bias).toBe('133.33');
    expect(a.withinRange).toBe('100.0');
    expect(a.largestMiss).toEqual({ date: '2026-11-04', forecast: '-500.00', actual: '-200.00', error: '300.00' });
    expect(forecastAccuracy(f.days, new Map())).toMatchObject({ days: 0, largestMiss: null });
  });
});
