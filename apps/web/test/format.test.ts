import { describe, expect, it } from 'vitest';
import { date, isNegative, money } from '../src/lib/format';

describe('display formatting', () => {
  it('formats decimal strings exactly, without float rounding', () => {
    expect(money('1234567.89', 'INR')).toBe('₹12,34,567.89');
    expect(money('0.10', 'USD')).toBe('$0.10');
    // 2^53 + 1 is not representable as a double; the string path keeps every digit.
    expect(money('9007199254740993.00', 'USD')).toBe('$9,007,199,254,740,993.00');
  });

  it('handles empty and negative values', () => {
    expect(money(null, 'USD')).toBe('—');
    expect(money('-50.00', 'USD')).toBe('-$50.00');
    expect(isNegative('-0.01')).toBe(true);
    expect(isNegative('0.00')).toBe(false);
  });

  it('formats ISO dates without timezone drift', () => {
    expect(date('2026-04-01')).toBe('01 Apr 2026');
  });
});
