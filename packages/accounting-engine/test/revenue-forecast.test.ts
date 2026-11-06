import { describe, expect, it } from 'vitest';
import { revenueForecastAccuracy, forecastMonths, revenueForecast } from '../src/revenue-forecast';

const TODAY = '2026-11-06';
const base = { today: TODAY, months: 6, contracts: [], orders: [], deals: [], otherRunRate: '0', otherSoFar: '0', actualSoFar: '0', scale: 2 };

describe('revenue forecast', () => {
  it('lists months from the current one', () => {
    expect(forecastMonths(TODAY, 3)).toEqual(['2026-11', '2026-12', '2027-01']);
  });

  it('places contract periods by invoice date, late ones now, and stops at the end unless auto-renewing', () => {
    const c = { id: 'c', reference: 'CT-0001', title: 'AMC', customer: 'Asha', start: '2026-09-01', end: '2026-12-31', frequency: 'MONTHLY' as const, timing: 'ADVANCE' as const, nextNo: 2, autoRenew: false, perPeriod: '10000' };
    const r = revenueForecast({ ...base, contracts: [c] });
    // Periods 2 (Oct, late) and 3 (Nov) both fall in November, then December; none after the end.
    expect(r.months.map((m) => m.contracts)).toEqual(['20000.00', '10000.00', '0.00', '0.00', '0.00', '0.00']);
    const renew = revenueForecast({ ...base, contracts: [{ ...c, autoRenew: true }] });
    expect(renew.totals.contracts).toBe('70000.00');
    const q = revenueForecast({ ...base, contracts: [{ ...c, frequency: 'QUARTERLY', timing: 'ARREARS', start: '2026-10-01', end: null, nextNo: 1 }] });
    expect(q.months.map((m) => m.contracts)).toEqual(['0.00', '10000.00', '0.00', '0.00', '10000.00', '0.00']);
  });

  it('adds orders now, deals at their close month, and other sales, into three scenarios', () => {
    const r = revenueForecast({
      ...base,
      orders: [{ id: 'o', reference: 'SO-0001', customer: 'Asha', remaining: '30000' }],
      deals: [
        { id: 'd1', reference: 'DL-0001', name: 'Racking', customer: 'Banyan', amount: '100000', probability: 50, expectedClose: '2026-10-15' },
        { id: 'd2', reference: 'DL-0002', name: 'Vans', customer: 'Cedar', amount: '80000', probability: 25, expectedClose: '2027-01-20' },
        { id: 'd3', reference: 'DL-0003', name: 'Later', customer: 'Deodar', amount: '90000', probability: 75, expectedClose: '2027-09-01' },
      ],
      otherRunRate: '12000',
      otherSoFar: '5000',
      actualSoFar: '41000',
    });
    expect(r.months[0]).toEqual({ month: '2026-11', contracts: '0.00', orders: '30000.00', pipelineWeighted: '50000.00', pipelineFull: '100000.00', otherSales: '7000.00', committed: '30000.00', expected: '87000.00', best: '137000.00' });
    expect(r.months[2]).toMatchObject({ month: '2027-01', pipelineWeighted: '20000.00', otherSales: '12000.00', expected: '32000.00', best: '92000.00' });
    expect(r.totals.expected).toBe(String(87000 + 12000 + 32000 + 12000 * 3) + '.00');
    expect(r.items.map((i) => i.reference)).toEqual(['SO-0001', 'DL-0001', 'DL-0002']);
    expect(r.actualSoFar).toBe('41000.00');
  });

  it('compares a saved forecast with what was invoiced in months that are over', () => {
    const saved = [
      { month: '2026-09', expected: '60000', committed: '40000' },
      { month: '2026-10', expected: '100000', committed: '80000' },
      { month: '2026-11', expected: '90000', committed: '90000' },
    ];
    const a = revenueForecastAccuracy(saved, '40000', new Map([['2026-09', '110000'], ['2026-10', '90000']]), '2026-11', 2);
    expect(a.months).toEqual([
      { month: '2026-09', forecast: '100000.00', committed: '80000.00', actual: '110000.00', variance: '10000.00', variancePct: '0.1' },
      { month: '2026-10', forecast: '100000.00', committed: '80000.00', actual: '90000.00', variance: '-10000.00', variancePct: '-0.1' },
    ]);
    expect(a.wape).toBe('0.1');
    expect(revenueForecastAccuracy(saved, '0', new Map(), '2026-09', 2)).toEqual({ months: [], wape: null });
  });
});
