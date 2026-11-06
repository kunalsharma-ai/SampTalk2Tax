import { describe, expect, it } from 'vitest';
import { billingCurrencyFor, DEFAULT_PLANS, isDowngrade, periodEnd, planProblems, priceFor, subscriptionAccess, upgradeCharge } from '../src/plans';

const at = (s: string) => new Date(s);

describe('plans', () => {
  it('ships the proposed launch prices, valid, with annual at ten months', () => {
    expect(DEFAULT_PLANS.map((p) => [p.code, p.prices.INR.monthly, p.prices.USD.monthly])).toEqual([
      ['STARTER', '499', '9'],
      ['GROWTH', '1499', '25'],
      ['PROFESSIONAL', '3499', '59'],
      ['ENTERPRISE', '8999', '149'],
    ]);
    for (const p of DEFAULT_PLANS) {
      expect(planProblems(p)).toEqual([]);
      expect(priceFor(p, 'INR', 'ANNUAL').toString()).toBe(priceFor(p, 'INR', 'MONTHLY').times(10).toString());
    }
  });

  it('finds the problems in a plan', () => {
    const bad = { ...DEFAULT_PLANS[0]!, code: 'starter', prices: { INR: { monthly: '0', annual: '4990.123' }, USD: { monthly: '9', annual: '90' } }, limits: { members: 0, aiCreditsPerMonth: null, documentUploadsPerMonth: 2.5 }, features: ['AI', 'AI', 'TELEPORT'] as never };
    expect(planProblems(bad)).toEqual([
      'The code is 2-24 capital letters, digits or underscores, starting with a letter',
      'INR monthly price must be more than zero, with at most 2 decimals',
      'INR annual price must be more than zero, with at most 2 decimals',
      'Limit members must be a whole number from 1, or no limit',
      'Limit documentUploadsPerMonth must be a whole number from 1, or no limit',
      'Unknown modules: TELEPORT',
      'A module is listed twice',
    ]);
  });

  it('bills India in rupees and everyone else in dollars', () => {
    expect(billingCurrencyFor('in')).toBe('INR');
    expect(billingCurrencyFor('GB')).toBe('USD');
  });
});

describe('billing periods', () => {
  it('run a calendar month or year, keeping the end of the month', () => {
    expect(periodEnd(at('2026-01-31T10:00:00Z'), 'MONTHLY').toISOString()).toBe('2026-02-28T10:00:00.000Z');
    expect(periodEnd(at('2026-11-05T00:00:00Z'), 'MONTHLY').toISOString()).toBe('2026-12-05T00:00:00.000Z');
    expect(periodEnd(at('2028-02-29T00:00:00Z'), 'ANNUAL').toISOString()).toBe('2029-02-28T00:00:00.000Z');
  });
});

describe('access', () => {
  const now = at('2026-11-10T00:00:00Z');
  it('is full during a trial and read-only after it', () => {
    expect(subscriptionAccess({ status: 'TRIALING', trialEndsAt: at('2026-11-15T00:00:00Z'), currentPeriodEnd: null }, now)).toEqual({ level: 'FULL', state: 'TRIAL', until: at('2026-11-15T00:00:00Z'), daysLeft: 5 });
    expect(subscriptionAccess({ status: 'TRIALING', trialEndsAt: at('2026-11-09T00:00:00Z'), currentPeriodEnd: null }, now)).toMatchObject({ level: 'READ_ONLY', state: 'TRIAL_ENDED' });
  });
  it('keeps a paid plan open for a grace week after its period, then read-only', () => {
    expect(subscriptionAccess({ status: 'ACTIVE', trialEndsAt: null, currentPeriodEnd: at('2026-12-01T00:00:00Z') }, now)).toMatchObject({ level: 'FULL', state: 'ACTIVE', daysLeft: 21 });
    expect(subscriptionAccess({ status: 'ACTIVE', trialEndsAt: null, currentPeriodEnd: at('2026-11-05T00:00:00Z') }, now)).toMatchObject({ level: 'FULL', state: 'GRACE', daysLeft: 2 });
    expect(subscriptionAccess({ status: 'ACTIVE', trialEndsAt: null, currentPeriodEnd: at('2026-11-01T00:00:00Z') }, now)).toMatchObject({ level: 'READ_ONLY', state: 'LAPSED' });
  });
  it('lets a cancelled plan run to its period end; complimentary has no end', () => {
    expect(subscriptionAccess({ status: 'CANCELLED', trialEndsAt: null, currentPeriodEnd: at('2026-11-20T00:00:00Z') }, now)).toMatchObject({ level: 'FULL', state: 'CANCELLING' });
    expect(subscriptionAccess({ status: 'CANCELLED', trialEndsAt: null, currentPeriodEnd: at('2026-11-01T00:00:00Z') }, now)).toMatchObject({ level: 'READ_ONLY', state: 'CANCELLED' });
    expect(subscriptionAccess({ status: 'COMPLIMENTARY', trialEndsAt: null, currentPeriodEnd: null }, now)).toMatchObject({ level: 'FULL', state: 'COMPLIMENTARY', daysLeft: null });
  });
});

describe('changing plan', () => {
  it('charges the difference for the days left, rounded, and nothing for a cheaper plan', () => {
    const base = { periodStart: at('2026-11-01T00:00:00Z'), periodEnd: at('2026-12-01T00:00:00Z'), currency: 'INR' as const };
    // 15 of 30 days left: half of (3499 - 1499).
    expect(upgradeCharge({ ...base, currentPrice: '1499', newPrice: '3499', now: at('2026-11-16T00:00:00Z') }).toFixed(2)).toBe('1000.00');
    // 10 of 30 days: 2000 / 3 = 666.666… -> 666.67.
    expect(upgradeCharge({ ...base, currentPrice: '1499', newPrice: '3499', now: at('2026-11-21T00:00:00Z') }).toFixed(2)).toBe('666.67');
    expect(upgradeCharge({ ...base, currentPrice: '3499', newPrice: '1499', now: at('2026-11-16T00:00:00Z') }).toFixed(2)).toBe('0.00');
    expect(isDowngrade('3499', '1499')).toBe(true);
    expect(isDowngrade('499', '1499')).toBe(false);
  });
});
