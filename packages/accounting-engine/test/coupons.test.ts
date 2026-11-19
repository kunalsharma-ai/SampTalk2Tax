import { describe, expect, it } from 'vitest';
import { couponDiscount, couponProblem, describeCoupon, validateCoupon, type CouponTerms } from '../src';

const base = { code: 'launch-20', kind: 'PERCENT' as const, percentOff: '20', amountOff: null, currency: null, planCodes: [], intervals: [], cycles: 3, maxRedemptions: 2, redeemBy: new Date('2026-12-31T23:59:59Z') };
const coupon = (over: Partial<CouponTerms> = {}): CouponTerms => ({ ...validateCoupon(base), isActive: true, ...over });
const use = { planCode: 'GROWTH', interval: 'MONTHLY' as const, currency: 'INR' as const, now: new Date('2026-11-19T00:00:00Z'), redemptions: 0, usedByOrg: false, usesByOrg: 0 };

describe('subscription coupons', () => {
  it('tidies the terms and refuses ones that do not make sense', () => {
    expect(validateCoupon({ ...base, planCodes: [' growth', 'GROWTH', 'pro'], intervals: ['MONTHLY'] })).toMatchObject({ code: 'LAUNCH-20', percentOff: '20.00', amountOff: null, currency: null, planCodes: ['GROWTH', 'PRO'] });
    expect(validateCoupon({ ...base, kind: 'AMOUNT', percentOff: '5', amountOff: '500', currency: 'INR' })).toMatchObject({ percentOff: null, amountOff: '500.00', currency: 'INR' });
    expect(() => validateCoupon({ ...base, code: 'x' })).toThrow('3 to 20');
    expect(() => validateCoupon({ ...base, percentOff: '100' })).toThrow('complimentary');
    expect(() => validateCoupon({ ...base, percentOff: '12.345' })).toThrow('0.01 to 99.99');
    expect(() => validateCoupon({ ...base, kind: 'AMOUNT', amountOff: '500', currency: null })).toThrow('currency');
    expect(() => validateCoupon({ ...base, cycles: 0 })).toThrow('1 to 36');
    expect(() => validateCoupon({ ...base, maxRedemptions: 0 })).toThrow('100,000');
  });

  it('applies to a new organisation only while on offer', () => {
    expect(couponProblem(coupon(), use)).toBeNull();
    expect(couponProblem(coupon({ isActive: false }), use)).toBe('This coupon is no longer offered');
    expect(couponProblem(coupon(), { ...use, now: new Date('2027-01-01T00:00:00Z') })).toBe('This coupon could be used until 2026-12-31');
    expect(couponProblem(coupon(), { ...use, redemptions: 2 })).toContain('as many organisations');
  });

  it('keeps applying for an organisation already using it, until its payments are used up', () => {
    const using = { ...use, usedByOrg: true, redemptions: 2, now: new Date('2027-02-01T00:00:00Z') };
    expect(couponProblem(coupon({ isActive: false }), { ...using, usesByOrg: 2 })).toBeNull();
    expect(couponProblem(coupon(), { ...using, usesByOrg: 3 })).toBe('This coupon has taken money off all 3 payments it was for');
    expect(couponProblem(coupon({ cycles: null }), { ...using, usesByOrg: 30 })).toBeNull();
  });

  it('must fit the plan, billing and currency', () => {
    expect(couponProblem(coupon({ planCodes: ['PRO'] }), use)).toBe('This coupon is for the PRO plan');
    expect(couponProblem(coupon({ intervals: ['ANNUAL'] }), use)).toBe('This coupon is for annual billing');
    expect(couponProblem(coupon({ kind: 'AMOUNT', percentOff: null, amountOff: '10.00', currency: 'USD' }), use)).toBe('This coupon is for payments in USD');
  });

  it('takes the percentage, rounded, or the amount off before tax, never all of it', () => {
    const p = couponDiscount({ kind: 'PERCENT', percentOff: '12.50', amountOff: null }, '2999.00', 'INR');
    expect([p.discount.toFixed(2), p.charged.toFixed(2)]).toEqual(['374.88', '2624.12']);
    const a = couponDiscount({ kind: 'AMOUNT', percentOff: null, amountOff: '500.00' }, '2999.00', 'INR');
    expect([a.discount.toFixed(2), a.charged.toFixed(2)]).toEqual(['500.00', '2499.00']);
    expect(() => couponDiscount({ kind: 'AMOUNT', percentOff: null, amountOff: '500.00' }, '500.00', 'INR')).toThrow('nothing to pay');
  });

  it('says what it is worth', () => {
    expect(describeCoupon({ kind: 'PERCENT', percentOff: '20.00', amountOff: null, currency: null, cycles: 3 })).toBe('20% off the first 3 payments');
    expect(describeCoupon({ kind: 'AMOUNT', percentOff: null, amountOff: '500.00', currency: 'INR', cycles: 1 })).toBe('INR 500.00 off the first payment');
    expect(describeCoupon({ kind: 'PERCENT', percentOff: '12.50', amountOff: null, currency: null, cycles: null })).toBe('12.5% off every payment');
  });
});
