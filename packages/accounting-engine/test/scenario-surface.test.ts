import { describe, expect, it } from 'vitest';
import { axisValues, scenarioSurface, surfaceIssues, TwinError, type TwinActualMonth, type TwinBaseline } from '../src';

const month = (m: string, over: Partial<TwinActualMonth> = {}): TwinActualMonth => ({
  month: m,
  revenue: '100000.00',
  otherIncome: '0.00',
  costOfSales: '40000.00',
  payroll: '30000.00',
  otherOperating: '10000.00',
  depreciation: '0.00',
  interest: '0.00',
  incomeTax: '0.00',
  otherExpenses: '0.00',
  cash: '500000.00',
  receivables: '100000.00',
  payables: '50000.00',
  ...over,
});
const base: TwinBaseline = { months: [month('2026-07'), month('2026-08'), month('2026-09')], currency: 'INR', scale: 2 };

describe('Scenario surface (DASH-027)', () => {
  it('steps evenly along an axis', () => {
    expect(axisValues({ axis: 'PRICE', min: -10, max: 10, steps: 5 })).toEqual(['-10', '-5', '0', '5', '10']);
    expect(axisValues({ axis: 'PRICE', min: 0, max: 10, steps: 4 })).toEqual(['0', '3.33', '6.67', '10']);
  });

  it('re-runs the twin at every point and keeps each month’s running profit', () => {
    const s = scenarioSurface({ baseline: base, horizonMonths: 2, measure: 'NET_PROFIT', x: { axis: 'PRICE', min: -10, max: 10, steps: 3 }, y: { axis: 'PAYROLL', min: -10, max: 10, steps: 3 } });
    expect(s.x).toEqual({ axis: 'PRICE', label: 'Price change', unit: '%', values: ['-10', '0', '10'] });
    expect(s.y.values).toEqual(['-10', '0', '10']);
    expect(s.runs).toBe(9);
    expect(s.frames.map((f) => f.month)).toEqual(['2026-10', '2026-11']);
    // Profit is 20,000 a month; price moves revenue by 10,000 (cost of sales follows volume, not
    // price) and payroll moves by 3,000.
    expect(s.frames[0].values).toEqual([
      ['13000.00', '23000.00', '33000.00'],
      ['10000.00', '20000.00', '30000.00'],
      ['7000.00', '17000.00', '27000.00'],
    ]);
    expect(s.frames[1].values[2]).toEqual(['14000.00', '34000.00', '54000.00']);
    expect(s.frames[1]).toMatchObject({ min: '14000.00', max: '66000.00' });
    expect(s.current).toBe('40000.00');
    expect(s.best).toEqual({ x: '10', y: '-10', value: '66000.00' });
    expect(s.worst).toEqual({ x: '-10', y: '10', value: '14000.00' });
    expect(s.cashNegativeCells).toBe(0);
  });

  it('measures the lowest cash so far, and counts the points where cash runs out', () => {
    const thin = { ...base, months: [month('2026-09', { cash: '10000.00' })] };
    const s = scenarioSurface({
      baseline: thin,
      horizonMonths: 3,
      measure: 'MINIMUM_CASH',
      x: { axis: 'PRICE', min: -50, max: 0, steps: 3 },
      y: { axis: 'COLLECTION_DAYS', min: 0, max: 30, steps: 3 },
    });
    // The lowest cash never rises from one month to the next.
    for (let yi = 0; yi < 3; yi++) for (let xi = 0; xi < 3; xi++) expect(Number(s.frames[2].values[yi][xi])).toBeLessThanOrEqual(Number(s.frames[0].values[yi][xi]));
    expect(s.cashNegativeCells).toBeGreaterThan(0);
    expect(Number(s.worst.value)).toBeLessThan(0);
    expect(s.worst.x).toBe('-50');
    expect(s.current).toBe(s.frames[2].values[0][2]);
  });

  it('leaves out the current point when zero is not on the grid', () => {
    const s = scenarioSurface({ baseline: base, horizonMonths: 1, measure: 'CLOSING_CASH', x: { axis: 'PRICE', min: 5, max: 15, steps: 3 }, y: { axis: 'CHURN', min: 1, max: 3, steps: 3 } });
    expect(s.current).toBeNull();
  });

  it('refuses a surface that cannot be drawn', () => {
    expect(surfaceIssues({ horizonMonths: 25, x: { axis: 'PRICE', min: 10, max: 10, steps: 2 }, y: { axis: 'PRICE', min: -90, max: 0, steps: 3 } })).toEqual([
      'Choose two different changes',
      'Choose a horizon from 1 to 24 months',
      'Across: use 3 to 11 points',
      'Across: the lowest value must be below the highest',
      'Up: Price change must stay between -50 and 50 %',
    ]);
    expect(surfaceIssues({ horizonMonths: 12, x: { axis: 'COLLECTION_DAYS', min: 0, max: 10, steps: 4 }, y: { axis: 'PRICE', min: 0, max: 10, steps: 3 } })).toEqual([
      'Across: days must come in whole steps',
    ]);
    expect(() => scenarioSurface({ baseline: base, horizonMonths: 1, measure: 'EBITDA', x: { axis: 'PRICE', min: 0, max: 1, steps: 3 }, y: { axis: 'PRICE', min: 0, max: 1, steps: 3 } })).toThrow(
      TwinError,
    );
  });
});
