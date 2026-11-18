import { describe, expect, it } from 'vitest';
import { checkDepositTerms, depositClosing, depositInterest, depositMaturityValue, interestToAccrue } from '../src';

const fd = { principal: '100000', annualRate: '7', startDate: '2026-04-01', maturityDate: '2027-04-01', compounding: 'QUARTERLY' as const };

describe('term deposits', () => {
  it('compounds quarterly: ₹1,00,000 at 7% for a year earns 7,185.90', () => {
    expect(depositMaturityValue(fd, 2)).toEqual({ interest: expect.anything(), value: expect.anything() });
    expect(depositMaturityValue(fd, 2).interest.toFixed(2)).toBe('7185.90');
    expect(depositMaturityValue(fd, 2).value.toFixed(2)).toBe('107185.90');
  });

  it('pays simple interest by days on a 365-day year', () => {
    const simple = { ...fd, compounding: 'SIMPLE' as const, startDate: '2026-01-01', maturityDate: '2027-01-01' };
    expect(depositInterest(simple, '2027-01-01', 2).toFixed(2)).toBe('7000.00');
    expect(depositInterest(simple, '2026-01-31', 2).toFixed(2)).toBe('575.34');
  });

  it('adds simple interest on the compounded balance for a part period, and stops at maturity', () => {
    // Two full quarters (to 1 Oct) then 10 days.
    expect(depositInterest(fd, '2026-10-11', 2).toFixed(2)).toBe('3729.18');
    expect(depositInterest(fd, '2026-03-01', 2).toFixed(2)).toBe('0.00');
    expect(depositInterest(fd, '2030-01-01', 2).toFixed(2)).toBe('7185.90');
  });

  it('accrues only what is not accrued yet, never a negative amount', () => {
    const first = depositInterest(fd, '2026-06-30', 2);
    expect(interestToAccrue(fd, '0', '2026-06-30', 2).toFixed(2)).toBe(first.toFixed(2));
    expect(interestToAccrue(fd, first, '2027-04-01', 2).plus(first).toFixed(2)).toBe('7185.90');
    expect(interestToAccrue(fd, first, '2026-05-01', 2).toFixed(2)).toBe('0.00');
  });

  it('splits closing into interest, the accrued part and income now (negative after an early-break penalty)', () => {
    const atMaturity = depositClosing('100000', '5000', '106467.31', '718.59');
    expect(atMaturity.interest.toFixed(2)).toBe('7185.90');
    expect(atMaturity.incomeNow.toFixed(2)).toBe('2185.90');
    expect(depositClosing('100000', '3000', '102500', '0').incomeNow.toFixed(2)).toBe('-500.00');
  });

  it('explains bad terms', () => {
    expect(checkDepositTerms({ ...fd, principal: '0', annualRate: '60', maturityDate: '2026-03-01' })).toEqual([
      'The amount deposited must be more than zero',
      'The interest rate must be between 0 and 50 percent a year',
      'The maturity date must be after the start date',
    ]);
    expect(checkDepositTerms(fd)).toEqual([]);
  });
});
