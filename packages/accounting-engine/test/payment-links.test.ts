import { describe, expect, it } from 'vitest';
import { minorToAmount, linkAmountIssues, linkExpired, paymentLinkRef, amountToMinor } from '../src';

describe('payment links', () => {
  it('convert amounts to and from minor units', () => {
    expect(paymentLinkRef(12)).toBe('PL-0012');
    expect(amountToMinor('1234.50', 'INR')).toBe(123450);
    expect(amountToMinor('0.105', 'USD')).toBe(11);
    expect(amountToMinor('500', 'JPY')).toBe(500);
    expect(minorToAmount(123450, 'INR')).toBe('1234.50');
    expect(minorToAmount(500, 'JPY')).toBe('500');
  });

  it('check the amount asked for', () => {
    expect(linkAmountIssues('1000', '1180', 'INR')).toEqual([]);
    expect(linkAmountIssues('0', '1180', 'INR')).toEqual(['The amount must be above zero']);
    expect(linkAmountIssues('1200', '1180', 'INR')).toEqual(['Only 1180.00 is still owed on this invoice']);
    expect(linkAmountIssues('10.001', '1180', 'INR')).toEqual(['Use at most 2 decimal places']);
  });

  it('expire open links after their time', () => {
    const now = new Date('2026-11-09T10:00:00Z');
    expect(linkExpired('OPEN', new Date('2026-11-09T09:59:59Z'), now)).toBe(true);
    expect(linkExpired('OPEN', new Date('2026-11-10T00:00:00Z'), now)).toBe(false);
    expect(linkExpired('PAID', new Date('2026-11-01T00:00:00Z'), now)).toBe(false);
    expect(linkExpired('OPEN', null, now)).toBe(false);
  });
});
