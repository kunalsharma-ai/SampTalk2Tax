import { afterEach, describe, expect, it, vi } from 'vitest';
import { date, isNegative, money, today } from '../src/lib/format';

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

describe('today', () => {
  afterEach(() => vi.useRealTimers());
  it('is the date in India, not the browser’s own date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T18:45:00Z')); // 00:15 on 5 Nov in India
    expect(today()).toBe('2026-11-05');
    vi.setSystemTime(new Date('2026-11-04T18:29:59Z')); // 23:59 on 4 Nov in India
    expect(today()).toBe('2026-11-04');
  });
});
