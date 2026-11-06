import { describe, expect, it } from 'vitest';
import { allowsOneMore, recentMonths, usageLevel, usageMonth, usageMonthRange } from '../src';

describe('usageLevel', () => {
  it('reports unlimited, fine, near and reached', () => {
    expect(usageLevel(40, null)).toEqual({ used: 40, limit: null, remaining: null, percent: null, state: 'UNLIMITED' });
    expect(usageLevel(79, 100)).toMatchObject({ state: 'OK', remaining: 21, percent: 79 });
    expect(usageLevel(80, 100)).toMatchObject({ state: 'NEAR', percent: 80 });
    expect(usageLevel(100, 100)).toMatchObject({ state: 'REACHED', remaining: 0, percent: 100 });
    expect(usageLevel(103, 100)).toMatchObject({ state: 'REACHED', remaining: 0, percent: 103 });
    expect(usageLevel(0, 0)).toMatchObject({ state: 'REACHED', percent: 100 });
  });
  it('refuses nonsense', () => {
    expect(() => usageLevel(-1, 10)).toThrow(RangeError);
    expect(() => usageLevel(1, 2.5)).toThrow(RangeError);
  });
  it('allows one more only under the limit', () => {
    expect(allowsOneMore(299, 300)).toBe(true);
    expect(allowsOneMore(300, 300)).toBe(false);
    expect(allowsOneMore(10_000, null)).toBe(true);
  });
});

describe('months', () => {
  it('follow India time', () => {
    expect(usageMonth(new Date('2026-10-31T18:29:59Z'))).toBe('2026-10');
    expect(usageMonth(new Date('2026-10-31T18:30:00Z'))).toBe('2026-11');
    expect(usageMonthRange('2026-12')).toEqual({ start: new Date('2026-11-30T18:30:00Z'), end: new Date('2026-12-31T18:30:00Z') });
    expect(() => usageMonthRange('2026-13')).toThrow(RangeError);
  });
  it('lists recent months across a year end', () => {
    expect(recentMonths('2027-02', 4)).toEqual(['2027-02', '2027-01', '2026-12', '2026-11']);
  });
});
