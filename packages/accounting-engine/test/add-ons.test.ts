import { describe, expect, it } from 'vitest';
import { addOnLines, addOnProblems, checkoutPlan, chooseAddOns, effectiveFeatures, priceWithAddOns, sameAddOns } from '../src';

const offers = [
  { feature: 'PAYROLL' as const, prices: { INR: { monthly: '999', annual: '9990' }, USD: { monthly: '15', annual: '150' } }, isActive: true },
  { feature: 'MULTI_CURRENCY' as const, prices: { INR: { monthly: '499', annual: '4990' }, USD: { monthly: '9', annual: '90' } }, isActive: true },
  { feature: 'CONSOLIDATION' as const, prices: { INR: { monthly: '1999', annual: '19990' }, USD: { monthly: '35', annual: '350' } }, isActive: false },
];

describe('add-on modules', () => {
  it('checks prices before they are saved', () => {
    expect(addOnProblems(offers[0])).toEqual([]);
    expect(addOnProblems({ feature: 'AI' as never, prices: offers[0].prices })).toEqual(['AI cannot be bought as an add-on']);
    expect(addOnProblems({ feature: 'PAYROLL', prices: { INR: { monthly: '0', annual: '10' } } as never })).toEqual(['INR monthly price must be more than zero, with at most 2 decimals', 'A USD price is needed']);
  });

  it('takes only modules on offer that the plan does not include, in a fixed order', () => {
    expect(chooseAddOns(['AI'], ['MULTI_CURRENCY', 'PAYROLL'], offers)).toEqual(['PAYROLL', 'MULTI_CURRENCY']);
    expect(() => chooseAddOns(['AI', 'PAYROLL'], ['PAYROLL'], offers)).toThrow('The plan already includes Payroll');
    expect(() => chooseAddOns([], ['CONSOLIDATION'], offers)).toThrow('not offered');
    expect(() => chooseAddOns([], ['AI'], offers)).toThrow('cannot be bought as an add-on');
    expect(() => chooseAddOns([], ['PAYROLL', 'PAYROLL'], offers)).toThrow('chosen twice');
  });

  it('prices each add-on for the billing and adds them to the plan', () => {
    const lines = addOnLines(['PAYROLL', 'MULTI_CURRENCY'], offers, 'INR', 'ANNUAL');
    expect(lines).toEqual([
      { feature: 'PAYROLL', label: 'Payroll', price: '9990.00' },
      { feature: 'MULTI_CURRENCY', label: 'Exchange rates and revaluation', price: '4990.00' },
    ]);
    expect(priceWithAddOns('14990', lines).toFixed(2)).toBe('29970.00');
    expect(effectiveFeatures(['AI'], ['PAYROLL'])).toEqual(['AI', 'PAYROLL']);
    expect(sameAddOns(['PAYROLL', 'MULTI_CURRENCY'], ['MULTI_CURRENCY', 'PAYROLL'])).toBe(true);
    expect(sameAddOns([], undefined)).toBe(true);
  });

  it('charges an added module now for the days left, and leaves a removed one to the renewal', () => {
    const base = {
      status: 'ACTIVE' as const,
      planCode: 'GROWTH',
      interval: 'MONTHLY' as const,
      price: '1499.00',
      addOns: [],
      trialEndsAt: null,
      currentPeriodStart: new Date('2026-11-01T00:00:00Z'),
      currentPeriodEnd: new Date('2026-12-01T00:00:00Z'),
      currency: 'INR' as const,
      now: new Date('2026-11-16T00:00:00Z'),
    };
    const more = checkoutPlan({ ...base, target: { planCode: 'GROWTH', interval: 'MONTHLY', price: '2498.00', addOns: ['PAYROLL'] } });
    expect(more).toMatchObject({ kind: 'UPGRADE', periodEnd: base.currentPeriodEnd });
    // Half the month left: half of the 999 difference.
    expect(more.kind === 'UPGRADE' && more.amount.toFixed(2)).toBe('499.50');
    const same = checkoutPlan({ ...base, addOns: ['PAYROLL'], price: '2498.00', target: { planCode: 'GROWTH', interval: 'MONTHLY', price: '2498.00', addOns: ['PAYROLL'] } });
    expect(same.kind).toBe('RENEWAL');
    const fewer = checkoutPlan({ ...base, addOns: ['PAYROLL'], price: '2498.00', target: { planCode: 'GROWTH', interval: 'MONTHLY', price: '1499.00', addOns: [] } });
    expect(fewer).toEqual({ kind: 'SCHEDULED', reason: 'Removing an add-on takes effect at the renewal; it stays until the end of the period paid for' });
  });
});
