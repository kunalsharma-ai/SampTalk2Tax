import { describe, expect, it } from 'vitest';
import { accuracy, addMonths, backtest, forecastAhead, forecastValue, LAB_MODELS } from '../src/forecast-lab';
import { D } from '../src/money';

const d = (xs: (number | string)[]) => xs.map((x) => new D(x));
const months = (n: number, start = '2025-01') => Array.from({ length: n }, (_, i) => addMonths(start, i));

describe('forecast evaluation lab', () => {
  it('forecasts with each model from the history it is given', () => {
    const h = d([100, 110, 120, 130, 140, 150]);
    expect(forecastValue('NAIVE', h, 1)!.toFixed(2)).toBe('150.00');
    expect(forecastValue('MEAN_3', h, 2)!.toFixed(2)).toBe('140.00');
    expect(forecastValue('MEAN_6', h, 1)!.toFixed(2)).toBe('125.00');
    expect(forecastValue('MEAN_12', h, 1)).toBeNull();
    expect(forecastValue('SEASONAL', h, 1)).toBeNull();
    // Drift: last + average change (10) × months ahead.
    expect(forecastValue('DRIFT', h, 3)!.toFixed(2)).toBe('180.00');
    // A straight line through a straight line extends it exactly.
    expect(forecastValue('LINEAR', h, 2)!.toFixed(2)).toBe('170.00');
    // α = 0.3 smoothing of a constant series stays at the constant.
    expect(forecastValue('SMOOTHING', d([50, 50, 50]), 1)!.toFixed(2)).toBe('50.00');
    expect(forecastValue('SMOOTHING', d([0, 100, 100]), 1)!.toFixed(2)).toBe('51.00');
    const year = d(Array.from({ length: 13 }, (_, i) => i * 10));
    // 13 months 0..120: one month ahead is the same month a year before it, the 2nd value.
    expect(forecastValue('SEASONAL', year, 1)!.toFixed(0)).toBe('10');
    expect(forecastValue('SEASONAL', year, 3)!.toFixed(0)).toBe('30');
  });

  it('measures errors: MAE, WAPE, bias and share within 10%', () => {
    const a = accuracy([
      { month: '2026-01', horizon: 1, forecast: new D(110), actual: new D(100) },
      { month: '2026-02', horizon: 1, forecast: new D(80), actual: new D(100) },
      { month: '2026-03', horizon: 1, forecast: new D(105), actual: new D(100) },
    ]);
    expect(a).toEqual({ count: 3, mae: '11.67', wape: '11.7', bias: '-1.67', within10: '66.7' });
    expect(accuracy([])).toEqual({ count: 0, mae: null, wape: null, bias: null, within10: null });
    expect(accuracy([{ month: '2026-01', horizon: 1, forecast: new D(5), actual: new D(0) }]).wape).toBeNull();
  });

  it('backtests without letting a model see the month it forecasts, and ranks the models', () => {
    // A steady upward trend: trend models should win, the 12-month average should lose.
    const hist = months(24).map((month, i) => ({ month, value: new D(1000 + i * 100) }));
    const bt = backtest('revenue', hist, 6);
    expect(bt.months).toEqual(months(6, '2026-07'));
    const linear = bt.models.find((m) => m.model === 'LINEAR')!;
    expect(linear.stats.wape).toBe('0.0');
    expect(linear.stats.count).toBe(18); // 6 months × 3 horizons
    expect(bt.models.find((m) => m.model === 'SEASONAL')!.rank).toBe(8); // a year behind a trend is furthest off
    expect(bt.models.find((m) => m.model === 'MEAN_12')!.rank).toBe(7);
    expect(['LINEAR', 'DRIFT']).toContain(bt.best);
    expect(bt.summary).toMatch(/^Over the last 6 months, (straight-line trend|last month plus trend) forecast revenue best, with an error of 0\.0% of the actual figures/);
    // The naive forecast of the first checked month, 1 ahead, is the month before it.
    const naive = bt.models.find((m) => m.model === 'NAIVE')!;
    expect(naive.points.find((p) => p.month === '2026-07' && p.horizon === 1)).toEqual({ month: '2026-07', horizon: 1, forecast: '2700.00', actual: '2800.00' });
    expect(naive.byHorizon.map((x) => x.stats.mae)).toEqual(['100.00', '200.00', '300.00']);
  });

  it('says when there is not enough history and forecasts ahead', () => {
    const short = backtest('netIncome', months(2).map((month) => ({ month, value: new D(5) })), 6);
    expect(short.models.find((m) => m.model === 'MEAN_12')!.note).toBe('Needs at least 12 months of history before the first month checked');
    expect(short.models.find((m) => m.model === 'MEAN_12')!.rank).toBeNull();
    expect(backtest('netIncome', [{ month: '2026-01', value: new D(1) }], 6).summary).toBe('Not enough history to test any model on net income.');
    const ahead = forecastAhead(d([100, 200, 300]), '2026-10');
    expect(ahead.filter((x) => x.model === 'NAIVE')).toEqual([
      { model: 'NAIVE', month: '2026-11', horizon: 1, value: '300.00' },
      { model: 'NAIVE', month: '2026-12', horizon: 2, value: '300.00' },
      { model: 'NAIVE', month: '2027-01', horizon: 3, value: '300.00' },
    ]);
    expect(new Set(ahead.map((x) => x.model)).size).toBe(LAB_MODELS.filter((m) => m.minHistory <= 3).length);
  });

  it('does not rank a method checked on far fewer forecasts than the others', () => {
    // 7 months, checking the last 6: the trend methods can make only one forecast.
    const r = backtest('revenue', months(7).map((month, i) => ({ month, value: new D(100 + (i % 2) * 50) })), 6);
    const linear = r.models.find((m) => m.model === 'LINEAR')!;
    expect(linear.stats.count).toBe(1);
    expect(linear.rank).toBeNull();
    expect(linear.note).toBe('Only 1 of 15 forecasts could be checked (it needs 6 months of history), too few to rank fairly');
    expect(r.models.find((m) => m.model === 'NAIVE')!.rank).not.toBeNull();
  });
});
