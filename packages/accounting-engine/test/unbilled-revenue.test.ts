import { describe, expect, it } from 'vitest';
import { orderUnbilledAmount, stillDismissed, unbilledAge, unbilledFingerprint, unbilledTotals } from '../src/unbilled-revenue';

describe('unbilled revenue', () => {
  it('prices what is left on an order, ignoring over-billed lines', () => {
    expect(orderUnbilledAmount([{ quantity: '10', billed: '4', unitPrice: '250.00' }, { quantity: '2', billed: '3', unitPrice: '99' }, { quantity: '1', billed: '0', unitPrice: '0.333' }])).toBe('1500.33');
    expect(orderUnbilledAmount([{ quantity: '5', billed: '5', unitPrice: '10' }])).toBe('0.00');
  });

  it('keeps a dismissal until the amount grows', () => {
    expect(stillDismissed({ amount: '500.00' }, null)).toBe(false);
    expect(stillDismissed({ amount: '500.00' }, { action: 'DISMISS', amount: '500.00' })).toBe(true);
    expect(stillDismissed({ amount: '499.00' }, { action: 'DISMISS', amount: '500.00' })).toBe(true);
    expect(stillDismissed({ amount: '650.00' }, { action: 'DISMISS', amount: '500.00' })).toBe(false);
    expect(stillDismissed({ amount: '500.00' }, { action: 'RESTORE', amount: '500.00' })).toBe(false);
    expect(stillDismissed({ amount: null }, { action: 'DISMISS', amount: null })).toBe(true);
  });

  it('totals by currency and source, largest first', () => {
    const t = unbilledTotals([
      { currency: 'INR', amount: '1000.00', source: 'MILESTONE' },
      { currency: 'INR', amount: '250.50', source: 'ORDER' },
      { currency: 'INR', amount: '49.50', source: 'ORDER' },
      { currency: 'USD', amount: '20.00', source: 'CONTRACT_PERIOD' },
      { currency: 'USD', amount: null, source: 'REGULAR_CUSTOMER' },
    ]);
    expect(t).toEqual([
      { currency: 'INR', amount: '1300.00', count: 3, bySource: { MILESTONE: '1000.00', ORDER: '300.00' } },
      { currency: 'USD', amount: '20.00', count: 2, bySource: { CONTRACT_PERIOD: '20.00' } },
    ]);
    expect(unbilledFingerprint({ source: 'ORDER', refId: 'abc' })).toBe('ORDER:abc');
    expect(unbilledAge('2026-11-01', '2026-11-10')).toBe(9);
    expect(unbilledAge('2026-11-12', '2026-11-10')).toBe(0);
  });
});
