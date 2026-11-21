import { describe, expect, it } from 'vitest';
import { buildVendorSpend, previousPeriod, type SpendDocument } from '../src';

const rent = { accountId: 'a-rent', accountCode: '6200', accountName: 'Rent' };
const soft = { accountId: 'a-soft', accountCode: '6400', accountName: 'Software' };
const bill = (vendorId: string, issueDate: string, lines: [typeof rent, string][], rate = '1', kind: SpendDocument['kind'] = 'BILL'): SpendDocument => ({
  vendorId,
  vendorName: { v1: 'Landlord', v2: 'Cloud Co', v3: 'Stationer' }[vendorId]!,
  kind,
  issueDate,
  exchangeRate: rate,
  lines: lines.map(([a, netAmount]) => ({ ...a, netAmount })),
});

describe('vendor spending (RPT-016)', () => {
  const current = [
    bill('v1', '2026-10-01', [[rent, '50000.00']]),
    bill('v1', '2026-11-01', [[rent, '50000.00']]),
    bill('v2', '2026-10-15', [[soft, '120.00']], '83.2550'), // USD at the bill's own rate: 9990.60
    bill('v2', '2026-11-15', [[soft, '20.00']], '83.2550', 'VENDOR_CREDIT'), // 1665.10 back
    bill('v3', '2026-11-20', [[soft, '0.10'], [rent, '0.20']]),
  ];
  const previous = [bill('v1', '2026-09-01', [[rent, '45000.00']]), bill('v3', '2026-08-10', [[soft, '900.00']])];
  const s = buildVendorSpend(current, previous, 'INR');

  it('totals bills before tax at their own rate, less vendor credits', () => {
    expect(s.total.toFixed(2)).toBe('108325.80');
    expect(s.vendors.map((v) => [v.name, v.amount.toFixed(2), v.bills])).toEqual([['Landlord', '100000.00', 2], ['Cloud Co', '8325.50', 1], ['Stationer', '0.30', 1]]);
    expect(s.vendors[0]!.share!.toFixed(4)).toBe('0.9231');
  });

  it('compares each vendor and the total with the period before', () => {
    expect(s.previousTotal.toFixed(2)).toBe('45900.00');
    expect(s.change.toFixed(2)).toBe('62425.80');
    expect(s.vendors.find((v) => v.name === 'Stationer')!.change.toFixed(2)).toBe('-899.70');
  });

  it('splits by account and month, and both add up to the total', () => {
    expect(s.accounts.map((a) => [a.code, a.amount.toFixed(2)])).toEqual([['6200', '100000.20'], ['6400', '8325.60']]);
    expect(s.months.map((m) => [m.month, m.amount.toFixed(2)])).toEqual([['2026-10', '59990.60'], ['2026-11', '48335.20']]);
    expect(s.accounts.reduce((t, a) => t.plus(a.amount), s.total.minus(s.total)).equals(s.total)).toBe(true);
    expect(s.months.reduce((t, a) => t.plus(a.amount), s.total.minus(s.total)).equals(s.total)).toBe(true);
  });

  it('counts the vendors that make up 80% of spend', () => {
    expect(s.vendorsFor80Percent).toBe(1);
    expect(buildVendorSpend([], [], 'INR')).toMatchObject({ vendors: [], vendorsFor80Percent: 0 });
    expect(buildVendorSpend([], [], 'INR').total.isZero()).toBe(true);
  });

  it('takes the same number of days just before as the period before', () => {
    expect(previousPeriod('2026-10-01', '2026-11-30')).toEqual({ from: '2026-08-01', to: '2026-09-30' });
    expect(previousPeriod('2026-11-01', '2026-11-01')).toEqual({ from: '2026-10-31', to: '2026-10-31' });
  });
});
