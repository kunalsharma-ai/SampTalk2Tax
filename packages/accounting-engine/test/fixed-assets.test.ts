import { describe, expect, it } from 'vitest';
import { addMonth, checkAssetTerms, chargeFor, depreciationSchedule, disposalEntry, firstChargeMonth, fullyDepreciatedIn, monthEnd, monthsBetween, type AssetTerms } from '../src';

const slm: AssetTerms = { cost: '100000.00', residualValue: '10000.00', inServiceDate: '2026-04-20', method: 'STRAIGHT_LINE', usefulLifeMonths: 36, openingAccumulated: '0', depreciatedThrough: null };

describe('fixed asset depreciation', () => {
  it('month helpers', () => {
    expect(addMonth('2026-11', 3)).toBe('2027-02');
    expect(addMonth('2026-01', -1)).toBe('2025-12');
    expect(monthsBetween('2025-11', '2026-02')).toBe(3);
    expect(monthEnd('2028-02')).toBe('2028-02-29');
  });

  it('straight line charges a full month from the month put to use and ends exactly at residual value', () => {
    const rows = depreciationSchedule(slm, '2030-12');
    expect(rows[0]).toEqual({ month: '2026-04', charge: '2500.00', accumulated: '2500.00', netBookValue: '97500.00', posted: false });
    expect(rows).toHaveLength(36);
    expect(rows.at(-1)).toMatchObject({ month: '2029-03', netBookValue: '10000.00', accumulated: '90000.00' });
    expect(fullyDepreciatedIn(slm)).toBe('2029-03');
  });

  it('puts rounding into the last month', () => {
    const t = { ...slm, cost: '1000.00', residualValue: '0.00', usefulLifeMonths: 3 };
    expect(depreciationSchedule(t, '2027-01').map((r) => r.charge)).toEqual(['333.33', '333.33', '333.34']);
  });

  it('continues from opening accumulated depreciation brought in', () => {
    const t = { ...slm, openingAccumulated: '15000.00', depreciatedThrough: '2026-09' };
    expect(firstChargeMonth(t)).toBe('2026-10');
    const rows = depreciationSchedule(t, '2030-12');
    expect(rows[0]).toMatchObject({ month: '2026-10', charge: '2500.00', accumulated: '17500.00' });
    expect(rows.at(-1)).toMatchObject({ month: '2029-03', netBookValue: '10000.00' });
  });

  it('uses posted amounts as they are', () => {
    const rows = depreciationSchedule(slm, '2026-06', { '2026-04': '2400.00' });
    expect(rows.map((r) => [r.charge, r.posted])).toEqual([['2400.00', true], ['2500.00', false], ['2500.00', false]]);
  });

  it('written-down value: annual rate on the value at the start of each fiscal year, in twelve parts', () => {
    const t: AssetTerms = { cost: '120000.00', residualValue: '5000.00', inServiceDate: '2026-10-01', method: 'WRITTEN_DOWN_VALUE', annualRate: '40', openingAccumulated: '0', depreciatedThrough: null };
    const rows = depreciationSchedule(t, '2027-05', {}, 4);
    // Oct 2026 to Mar 2027: 120,000 × 40% ÷ 12 = 4,000 a month.
    expect(rows.slice(0, 6).every((r) => r.charge === '4000.00')).toBe(true);
    // From April 2027 the base is 120,000 − 24,000 = 96,000: 3,200 a month.
    expect(rows[6]).toMatchObject({ month: '2027-04', charge: '3200.00', netBookValue: '92800.00' });
    expect(chargeFor(t, '2027-05', {}, 4)).toBe('3200.00');
  });

  it('written-down value never goes below the residual value', () => {
    const t: AssetTerms = { cost: '10000.00', residualValue: '9000.00', inServiceDate: '2026-04-01', method: 'WRITTEN_DOWN_VALUE', annualRate: '100', openingAccumulated: '0', depreciatedThrough: null };
    const rows = depreciationSchedule(t, '2027-03');
    expect(rows.map((r) => r.charge)).toEqual(['833.33', '166.67']);
    expect(rows.at(-1)!.netBookValue).toBe('9000.00');
  });

  it('charges through the month of disposal and nothing after', () => {
    const rows = depreciationSchedule({ ...slm, disposedOn: '2026-07-15' }, '2027-12');
    expect(rows.map((r) => r.month)).toEqual(['2026-04', '2026-05', '2026-06', '2026-07']);
    expect(chargeFor({ ...slm, disposedOn: '2026-07-15' }, '2026-08')).toBe('0.00');
  });

  it('works out the disposal entry with a gain or a loss', () => {
    expect(disposalEntry('100000.00', '30000.00', '75000.00')).toEqual({
      netBookValue: '70000.00',
      gain: '5000.00',
      lines: [{ role: 'PROCEEDS', debit: '75000.00' }, { role: 'ACCUMULATED', debit: '30000.00' }, { role: 'COST', credit: '100000.00' }, { role: 'GAIN_LOSS', credit: '5000.00' }],
    });
    const scrapped = disposalEntry('50000.00', '20000.00', '0.00');
    expect(scrapped.lines).toEqual([{ role: 'ACCUMULATED', debit: '20000.00' }, { role: 'COST', credit: '50000.00' }, { role: 'GAIN_LOSS', debit: '30000.00' }]);
  });

  it('checks terms', () => {
    const ok = { ...slm, acquisitionDate: '2026-04-01' };
    expect(checkAssetTerms(ok)).toEqual([]);
    expect(checkAssetTerms({ ...ok, residualValue: '100000.00' })).toContain('Residual value must be less than cost');
    expect(checkAssetTerms({ ...ok, usefulLifeMonths: 0 })).toContain('Useful life must be 1 to 1,200 months');
    expect(checkAssetTerms({ ...ok, method: 'WRITTEN_DOWN_VALUE', annualRate: '150' })).toContain('Annual rate must be more than 0% and at most 100%');
    expect(checkAssetTerms({ ...ok, inServiceDate: '2026-03-01' })).toContain('An asset cannot be put to use before it was acquired');
    expect(checkAssetTerms({ ...ok, openingAccumulated: '5000.00' })).toContain('Say which month the opening accumulated depreciation runs to');
    expect(checkAssetTerms({ ...ok, openingAccumulated: '95000.00', depreciatedThrough: '2026-06' })).toContain('Opening accumulated depreciation cannot be more than cost less residual value');
    expect(checkAssetTerms({ ...ok, cost: '10.001' })).toContain('Cost has more than 2 decimal places');
  });
});
