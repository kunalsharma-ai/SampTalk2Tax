import { describe, expect, it } from 'vitest';
import { assertIsoDate, canPostToPeriod, fiscalYearForDate, generateFiscalYear } from '../src';

describe('fiscal periods', () => {
  it('generates an April-March fiscal year labelled by end year', () => {
    const p = generateFiscalYear(2027, 4);
    expect(p).toHaveLength(12);
    expect(p[0]).toMatchObject({ periodNo: 1, startDate: '2026-04-01', endDate: '2026-04-30' });
    expect(p[10]).toMatchObject({ startDate: '2027-02-01', endDate: '2027-02-28' });
    expect(p[11]).toMatchObject({ startDate: '2027-03-01', endDate: '2027-03-31' });
  });

  it('handles leap years and calendar years', () => {
    const p = generateFiscalYear(2028, 1);
    expect(p[1].endDate).toBe('2028-02-29');
    expect(p[0].startDate).toBe('2028-01-01');
  });

  it('finds the fiscal year for a date', () => {
    expect(fiscalYearForDate('2026-03-31', 4)).toBe(2026);
    expect(fiscalYearForDate('2026-04-01', 4)).toBe(2027);
    expect(fiscalYearForDate('2026-12-31', 1)).toBe(2026);
  });

  it('validates dates', () => {
    expect(() => assertIsoDate('2026-02-30')).toThrow();
    expect(() => assertIsoDate('26-1-1')).toThrow();
    expect(() => assertIsoDate('2026-02-28')).not.toThrow();
  });

  it('only allows posting to open periods', () => {
    expect(canPostToPeriod('OPEN')).toBe(true);
    expect(canPostToPeriod('LOCKED')).toBe(false);
    expect(canPostToPeriod('CLOSED')).toBe(false);
  });
});
