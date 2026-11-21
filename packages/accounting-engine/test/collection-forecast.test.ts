import { describe, expect, it } from 'vitest';
import { addDays } from '../src/documents';
import { collectionForecast } from '../src/collection-forecast';

const T = '2026-11-21';
const inv = (dueIn: number, payIn: number, outstanding: string, daysPastDue = Math.max(0, -dueIn)) => ({ dueDate: addDays(T, dueIn), predictedPayDate: addDays(T, payIn), outstanding, daysPastDue });

describe('collection forecast (AR-039)', () => {
  it('puts each invoice in the week of its predicted payment, beside the week it falls due', () => {
    const f = collectionForecast([inv(3, 3, '1000.10'), inv(5, 12, '2000.00'), inv(-10, 7, '500.00'), inv(20, 40, '300.00'), inv(-120, 7, '9999.99'), inv(1, 1, '0.00')], T, 4, 2);
    expect(f.weeks.map((w) => [w.from, w.to, w.expected, w.byDueDate, w.invoices, w.cumulative])).toEqual([
      [T, addDays(T, 6), '1000.10', '3500.10', 1, '1000.10'],
      [addDays(T, 7), addDays(T, 13), '2500.00', '0.00', 2, '3500.10'],
      [addDays(T, 14), addDays(T, 20), '0.00', '300.00', 0, '3500.10'],
      [addDays(T, 21), addDays(T, 27), '0.00', '0.00', 0, '3500.10'],
    ]);
    expect(f.later).toEqual({ expected: '300.00', byDueDate: '0.00', invoices: 1 });
    expect(f.doubtful).toEqual({ amount: '9999.99', invoices: 1 });
    expect(f.total).toBe('13800.09');
    expect(f.inHorizon).toBe('3500.10');
  });

  it('keeps the number of weeks between 1 and 26', () => {
    expect(collectionForecast([], T, 0, 2).weeks).toHaveLength(1);
    expect(collectionForecast([], T, 99, 2).weeks).toHaveLength(26);
    expect(collectionForecast([], T, 13, 0)).toMatchObject({ total: '0', inHorizon: '0', later: { expected: '0' } });
  });
});
