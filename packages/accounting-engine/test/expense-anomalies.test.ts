import { describe, expect, it } from 'vitest';
import { expenseAnomalies, median, robustZ } from '../src/expense-anomalies';
import { dec } from '../src/money';

const MEALS = 'acc-meals';
const TRAVEL = 'acc-travel';
const line = (lineNo: number, amount: string, extra: Partial<{ date: string; accountId: string; accountLabel: string; isAllowance: boolean }> = {}) => ({ lineNo, date: '2026-11-10', accountId: MEALS, accountLabel: '6600 · Meals', amount, ...extra });
const usual = (n: number, around: number) => Array.from({ length: n }, (_, i) => String(around - 200 + ((i * 53) % 400)));

describe('the statistics', () => {
  it('takes the median and a robust z-score', () => {
    expect(median([dec('1'), dec('9'), dec('3')]).toFixed()).toBe('3');
    expect(median([dec('1'), dec('2'), dec('3'), dec('4')]).toFixed()).toBe('2.5');
    expect(robustZ(dec('10'), [dec('5'), dec('5'), dec('5')])).toBeNull();
    expect(robustZ(dec('20'), [dec('8'), dec('10'), dec('12')])).toBeCloseTo(3.3725, 4);
  });
});

describe('expense anomalies', () => {
  it('flags a line far above the usual for its category, and not a normal one', () => {
    const h = new Map([[MEALS, usual(24, 3000)]]);
    const a = expenseAnomalies([line(1, '2800'), line(2, '18000')], h, [], 'INR');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ code: 'UNUSUAL_AMOUNT', lineNo: 2 });
    expect(a[0]!.message).toMatch(/^Line 2: INR 18000\.00 is about 6 times the usual for 6600 · Meals \(median INR 2995\.00 across 24 approved lines/);
  });
  it('needs enough history, and ignores mileage and per diem lines', () => {
    expect(expenseAnomalies([line(1, '18000')], new Map([[MEALS, usual(7, 3000)]]), [], 'INR')).toEqual([]);
    expect(expenseAnomalies([line(1, '18000', { isAllowance: true })], new Map([[MEALS, usual(24, 3000)]]), [], 'INR')).toEqual([]);
  });
  it('uses the multiple alone when past amounts never vary', () => {
    const h = new Map([[MEALS, Array(10).fill('500')]]);
    expect(expenseAnomalies([line(1, '1400')], h, [], 'INR')).toEqual([]);
    expect(expenseAnomalies([line(1, '1600')], h, [], 'INR')[0]?.code).toBe('UNUSUAL_AMOUNT');
  });
  it('flags a line just under a per-receipt limit for its category', () => {
    const limits = [{ accountId: MEALS, amount: '5000' }, { accountId: null, amount: '20000' }];
    const a = expenseAnomalies([line(1, '4900'), line(2, '4700', { date: '2026-11-12' }), line(3, '19500', { accountId: TRAVEL, accountLabel: '6500 · Travel', date: '2026-11-11' })], new Map(), limits, 'INR');
    expect(a.map((x) => [x.code, x.lineNo])).toEqual([['JUST_UNDER_LIMIT', 1], ['JUST_UNDER_LIMIT', 3]]);
    expect(a[0]!.message).toBe('Line 1: INR 4900.00 is just under the limit of INR 5000.00 per receipt for 6600 · Meals');
  });
  it('flags receipts on one day and category that each stay under the limit but together exceed it', () => {
    const limits = [{ accountId: MEALS, amount: '5000' }];
    const a = expenseAnomalies([line(1, '3000'), line(2, '1000', { date: '2026-11-11' }), line(3, '2600')], new Map(), limits, 'INR');
    expect(a).toEqual([{ code: 'SPLIT_UNDER_LIMIT', lineNo: 1, lineNos: [1, 3], message: 'Lines 1, 3: 2 6600 · Meals receipts on 2026-11-10 total INR 5600.00, over the limit of INR 5000.00 per receipt, though each is under it. Check it is not one bill split up' }]);
    expect(expenseAnomalies([line(1, '3000'), line(2, '1000')], new Map(), limits, 'INR')).toEqual([]);
    expect(expenseAnomalies([line(1, '6000'), line(2, '1000')], new Map(), limits, 'INR').map((x) => x.code)).toEqual([]);
  });
});
