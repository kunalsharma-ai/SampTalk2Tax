import { describe, expect, it } from 'vitest';
import { expenseForecast, type ForecastExpenseLine } from '../src/expense-forecast';

const line = (date: string, accountId: string, amount: string): ForecastExpenseLine => ({ date, accountId, accountLabel: accountId === 'travel' ? '6700 · Travel' : accountId === 'meals' ? '6710 · Meals' : '6800 · Training', amount });

describe('expense forecasting', () => {
  it('forecasts from the last three months, with a range from how much the account moves', () => {
    const lines = [
      line('2026-05-10', 'travel', '3000.00'),
      line('2026-06-10', 'travel', '3000.00'),
      line('2026-07-10', 'travel', '3000.00'),
      line('2026-08-10', 'travel', '4000.00'),
      line('2026-09-05', 'travel', '5000.00'),
      line('2026-10-12', 'travel', '6000.00'),
      line('2026-11-03', 'travel', '1200.00'),
    ];
    const f = expenseForecast({ asOf: '2026-11-22', months: 3, lines, approvedNotPaid: ['1200.00', '800.50'], waitingApproval: ['300.00'] });
    expect(f.months).toEqual(['2026-11', '2026-12', '2027-01']);
    const t = f.accounts[0]!;
    expect(t).toMatchObject({ accountId: 'travel', method: 'RECENT_AVERAGE', thisMonthSoFar: '1200.00', trendPercent: '66.7' });
    // Last three full months: 4000, 5000, 6000 → 5000. Last six: 3000, 3000, 3000, 4000, 5000, 6000; spread ≈ 1154.70.
    expect(t.months[0]).toEqual({ month: '2026-11', forecast: '5000.00', low: '3845.30', high: '6154.70' });
    expect(t.history).toHaveLength(12);
    expect(t.history.at(-1)).toEqual({ month: '2026-10', amount: '6000.00' });
    expect(f.totals[2]).toEqual({ month: '2027-01', forecast: '5000.00', low: '3845.30', high: '6154.70' });
    expect(f.thisMonthSoFar).toBe('1200.00');
    expect(f.owed).toEqual({ approvedNotPaid: '2000.50', approvedClaims: 2, waitingApproval: '300.00', waitingClaims: 1 });
  });

  it('follows the season when there is a year of history', () => {
    const lines: ForecastExpenseLine[] = [];
    // Meals: 1000 a month, but 3000 last December.
    for (const m of ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']) lines.push(line(`${m}-15`, 'meals', m === '2025-12' ? '3000.00' : '1000.00'));
    const f = expenseForecast({ asOf: '2026-11-22', months: 2, lines });
    const m = f.accounts[0]!;
    expect(m.method).toBe('SEASONAL');
    // Year average 14000 / 12; November last year was 1000 → factor 0.857; December was 3000 → 2.57, capped at 2.
    expect(m.months.map((x) => x.forecast)).toEqual(['857.14', '2000.00']);
    expect(m.basis).toContain('adjusted for how each month compared');
  });

  it('lists accounts spent on only now and then, and ignores the future and old lines', () => {
    const f = expenseForecast({ asOf: '2026-11-22', months: 9, lines: [line('2026-03-01', 'training', '25000.00'), line('2026-11-30', 'travel', '500.00'), line('2024-01-01', 'travel', '9.00')] });
    expect(f.months).toHaveLength(6);
    expect(f.accounts).toEqual([]);
    expect(f.occasional).toEqual([{ accountId: 'training', accountLabel: '6800 · Training', lastSpent: '2026-03-01', total12Months: '25000.00' }]);
    expect(f.totals[0]).toEqual({ month: '2026-11', forecast: '0.00', low: '0.00', high: '0.00' });
  });
});
