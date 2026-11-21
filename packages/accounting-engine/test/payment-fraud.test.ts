import { describe, expect, it } from 'vitest';
import { fraudLevel, normaliseAccountForMatch, normaliseVendorName, paymentFraudIndicators, type OrgFacts, type PaymentToCheck, type VendorFacts } from '../src/payment-fraud';

const money = (a: string) => `₹${a}`;
const T = '2026-11-21';
const vendor = (over: Partial<VendorFacts> = {}): VendorFacts => ({ contactId: 'v1', name: 'Teak Supplies Pvt Ltd', createdOn: '2025-01-01', bank: { accountNumber: '0012 3456 789', changedOn: '2025-02-01', changedById: 'u2', verified: true }, payments: [], ...over });
const pay = (over: Partial<PaymentToCheck> = {}): PaymentToCheck => ({ key: 'p1', date: T, amount: '12345.67', documentIds: ['b1'], madeById: 'u1', ...over });
const org = (over: Partial<OrgFacts> = {}): OrgFacts => ({ vendors: [], employeeAccounts: [], billsInOpenBatches: new Map(), ...over });
const codes = (p: PaymentToCheck, v: VendorFacts, o: OrgFacts) => paymentFraudIndicators(p, v, o, money).map((i) => i.code);

describe('payment fraud indicators (AP-028)', () => {
  it('raises nothing on an ordinary payment', () => {
    expect(paymentFraudIndicators(pay(), vendor(), org(), money)).toEqual([]);
    expect(fraudLevel([])).toBeNull();
  });

  it('normalises names and account numbers', () => {
    expect(normaliseVendorName('M/s. Teak Supplies Pvt. Ltd.')).toBe('teaksupplies');
    expect(normaliseVendorName('TEAK  SUPPLIES PRIVATE LIMITED')).toBe('teaksupplies');
    expect(normaliseAccountForMatch('0012-3456 789')).toBe('123456789');
  });

  it('flags an account shared with an employee or another vendor', () => {
    const o = org({ employeeAccounts: [{ name: 'Ravi Kumar', accountNumber: '123456789' }], vendors: [{ contactId: 'v2', name: 'Oak Traders', accountNumber: '00123456789' }] });
    const r = paymentFraudIndicators(pay(), vendor(), o, money);
    expect(r.map((i) => [i.code, i.level])).toEqual([['EMPLOYEE_ACCOUNT', 'HIGH'], ['SHARED_ACCOUNT', 'HIGH']]);
    expect(r[0]!.detail).toBe('The bank account is also the salary account of Ravi Kumar');
    expect(r[1]!.detail).toBe('Oak Traders has the same bank account');
    expect(fraudLevel(r)).toBe('HIGH');
  });

  it('flags recently changed bank details, unverified worse than verified, and the same person', () => {
    const changed = { accountNumber: '999', changedOn: '2026-11-11', changedById: 'u1', verified: false };
    expect(paymentFraudIndicators(pay(), vendor({ bank: changed }), org(), money).map((i) => [i.code, i.detail])).toEqual([
      ['BANK_CHANGED_UNVERIFIED', 'Bank details changed 10 days before the payment and not verified since'],
      ['SAME_PERSON', 'The person who changed the bank details also made this payment'],
    ]);
    expect(codes(pay(), vendor({ bank: { ...changed, verified: true, changedById: 'u9' } }), org())).toEqual(['BANK_CHANGED']);
    expect(codes(pay(), vendor({ bank: { ...changed, changedOn: '2026-10-01' } }), org())).toEqual([]);
  });

  it('flags a duplicate payment within a week, or the same bill in another open batch', () => {
    const v = vendor({ payments: [{ key: 'old', date: '2026-11-17', amount: '12345.670000' }, { key: 'older', date: '2026-10-01', amount: '12345.67' }] });
    const r = paymentFraudIndicators(pay(), v, org(), money);
    expect(r.map((i) => i.code)).toEqual(['DUPLICATE_PAYMENT']);
    expect(r[0]!.detail).toBe('Another payment of ₹12345.67 to this vendor within 7 days (2026-11-17)');
    expect(codes(pay(), vendor(), org({ billsInOpenBatches: new Map([['b1', ['p1', 'p9']]]) }))).toEqual(['DUPLICATE_PAYMENT']);
    expect(codes(pay(), vendor(), org({ billsInOpenBatches: new Map([['b1', ['p1']]]) }))).toEqual([]);
  });

  it('flags a new vendor, an unusual amount, no bill, a similar name and a large round amount', () => {
    const history = ['2026-03-01', '2026-06-01', '2026-09-01'].map((date, k) => ({ key: `h${k}`, date, amount: '50000.00' }));
    const v = vendor({ createdOn: '2026-11-01', payments: history });
    const o = org({ vendors: [{ contactId: 'v2', name: 'Teak Supplies Limited', accountNumber: '555' }] });
    const r = paymentFraudIndicators(pay({ amount: '200000.00', documentIds: [] }), v, o, money);
    expect(r.map((i) => [i.code, i.level])).toEqual([
      ['NEW_VENDOR', 'MEDIUM'],
      ['UNUSUAL_AMOUNT', 'MEDIUM'],
      ['NO_BILL', 'MEDIUM'],
      ['SIMILAR_NAME', 'LOW'],
      ['ROUND_AMOUNT', 'LOW'],
    ]);
    expect(r[1]!.detail).toBe('Over 3 times the largest payment to this vendor in the year before (₹50000)');
    expect(r[3]!.detail).toBe('Another vendor has almost the same name: Teak Supplies Limited');
    expect(fraudLevel(r)).toBe('MEDIUM');
    // Fewer than three earlier payments: nothing to compare with.
    expect(codes(pay({ amount: '200000.50' }), vendor({ payments: history.slice(1) }), org())).toEqual([]);
  });
});
