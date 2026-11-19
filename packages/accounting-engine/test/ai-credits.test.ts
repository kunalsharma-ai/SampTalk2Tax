import { describe, expect, it } from 'vitest';
import { creditBalance, creditExpiry, creditPackProblems, creditsLeft, pickCreditGrant, pricePerRequest } from '../src';

describe('extra AI requests', () => {
  it('checks a pack before it is saved', () => {
    expect(creditPackProblems({ name: '1,000 requests', requests: 1000, prices: { INR: '799', USD: '12' } })).toEqual([]);
    expect(creditPackProblems({ name: ' ', requests: 5, prices: { INR: '0', USD: '' } as never })).toEqual([
      'A pack needs a name of up to 60 characters',
      'A pack holds a whole number of requests, from 10 to 1,000,000',
      'The INR price must be more than zero, with at most 2 decimals',
      'A USD price is needed',
    ]);
    expect(creditPackProblems({ name: 'Half', requests: 10.5, prices: { INR: '1.999', USD: '1' } })).toHaveLength(2);
  });

  it('keeps a pack for a year and uses the one expiring first', () => {
    const now = new Date('2026-11-19T00:00:00Z');
    expect(creditExpiry(new Date('2026-01-01T00:00:00Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
    const older = { id: 'a', requests: 100, used: 100, grantedAt: new Date('2026-01-01'), expiresAt: new Date('2027-01-01') };
    const mid = { id: 'b', requests: 500, used: 20, grantedAt: new Date('2026-06-01'), expiresAt: new Date('2027-06-01') };
    const newer = { id: 'c', requests: 1000, used: 0, grantedAt: new Date('2026-11-01'), expiresAt: new Date('2027-11-01') };
    const expired = { id: 'd', requests: 1000, used: 0, grantedAt: new Date('2025-10-01'), expiresAt: new Date('2026-10-01') };
    expect(creditsLeft(older, now)).toBe(0);
    expect(creditsLeft(expired, now)).toBe(0);
    expect(creditBalance([older, mid, newer, expired], now)).toBe(1480);
    // The used-up and the expired packs are passed over; the one expiring first goes next.
    expect(pickCreditGrant([newer, expired, older, mid], now)?.id).toBe('b');
    expect(pickCreditGrant([older, expired], now)).toBeNull();
    // Use can pass the pack a little when calls already running finish; it never reads below zero.
    expect(creditsLeft({ ...mid, used: 503 }, now)).toBe(0);
  });

  it('shows what a request costs in a pack', () => {
    expect(pricePerRequest('799', 1000)).toBe('0.80');
    expect(pricePerRequest('12', 1000)).toBe('0.01');
  });
});
