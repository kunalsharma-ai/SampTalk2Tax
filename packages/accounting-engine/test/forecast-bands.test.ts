import { describe, expect, it } from 'vitest';
import { forecastConfidenceBands, forecastErrors, type ForecastMonth } from '../src';

const month = (m: string, committed: string, expected: string, best: string): ForecastMonth => ({ month: m, contracts: committed, orders: '0', pipelineWeighted: '0', pipelineFull: '0', otherSales: '0', committed, expected, best });
const MONTHS = [month('2026-11', '50000', '80000', '100000'), month('2026-12', '40000', '60000', '90000')];

describe('forecast confidence bands', () => {
  it('falls back to committed and best case without enough history', () => {
    const r = forecastConfidenceBands(MONTHS, [{ horizon: 0, absPct: '0.1' }], 2);
    expect(r).toMatchObject({ method: 'SCENARIOS', level: 80, samples: 1 });
    expect(r.bands[0]).toEqual({ month: '2026-11', low: '50000.00', high: '100000.00', errorPct: null, basis: 0 });
  });

  it('uses the 80th percentile of past errors at each distance, or all of them', () => {
    const errors = [
      { horizon: 0, absPct: '0.05' }, { horizon: 0, absPct: '0.10' }, { horizon: 0, absPct: '0.20' }, { horizon: 0, absPct: '0.08' }, { horizon: 0, absPct: '0.12' },
      { horizon: 1, absPct: '0.40' },
    ];
    const r = forecastConfidenceBands(MONTHS, errors, 2);
    expect(r).toMatchObject({ method: 'HISTORY', samples: 6 });
    // Horizon 0: sorted 0.05 0.08 0.10 0.12 0.20 → rank ceil(0.8×5)=4 → 0.12.
    expect(r.bands[0]).toEqual({ month: '2026-11', low: '70400.00', high: '89600.00', errorPct: '12', basis: 5 });
    // Horizon 1 has one error, so all six are used: rank ceil(4.8)=5 → 0.20.
    expect(r.bands[1]).toEqual({ month: '2026-12', low: '48000.00', high: '72000.00', errorPct: '20', basis: 6 });
  });

  it('never goes below zero', () => {
    const r = forecastConfidenceBands([month('2026-11', '0', '100', '200')], [{ horizon: 0, absPct: '1.5' }, { horizon: 0, absPct: '2' }, { horizon: 0, absPct: '3' }], 2);
    expect(r.bands[0]!.low).toBe('0.00');
    expect(r.bands[0]!.high).toBe('400.00');
  });

  it('reads errors from saved forecasts by months ahead', () => {
    expect(forecastErrors([{ asOf: '2026-09-15', accuracy: { months: [{ month: '2026-09', variancePct: '-0.1' }, { month: '2026-10', variancePct: null }, { month: '2026-11', variancePct: '0.25' }] } }])).toEqual([
      { horizon: 0, absPct: '0.1' },
      { horizon: 2, absPct: '0.25' },
    ]);
  });
});
