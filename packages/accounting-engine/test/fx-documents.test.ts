import { describe, expect, it } from 'vitest';
import { D, atRate, functionalOpen, settlement, toFunctional, validateJournal } from '../src';

const accounts = new Map(
  ['ar', 'ap', 'sales', 'fx', 'bank'].map((id) => [id, { id, code: id, type: 'ASSET' as const, isPostable: true, isActive: true }]),
);
const ctx = { functionalCurrency: 'INR', accounts };

describe('foreign-currency documents', () => {
  it('converts at the rate, rounding half to even', () => {
    expect(toFunctional(new D('100.25'), '83.1', 'INR').toFixed()).toBe('8330.78');
    expect(toFunctional(new D('0.05'), '83.1', 'INR').toFixed()).toBe('4.16');
  });

  it('puts lines at one rate and posts any rounding to the rounding account', () => {
    const lines = atRate(
      [
        { accountId: 'ar', debit: '0.03' },
        { accountId: 'sales', credit: '0.01' },
        { accountId: 'sales', credit: '0.01' },
        { accountId: 'sales', credit: '0.01' },
      ],
      'USD',
      '83.333',
      'INR',
      'fx',
    );
    // 0.03 × 83.333 = 2.50; three times 0.01 × 83.333 = 0.83 each = 2.49.
    expect(lines.at(-1)).toMatchObject({ accountId: 'fx', currency: 'INR', credit: '0.01', description: 'Currency rounding' });
    const j = validateJournal(lines, ctx);
    expect(j.totalFunctionalDebit.toFixed()).toBe(j.totalFunctionalCredit.toFixed());
    expect(atRate([{ accountId: 'ar', debit: '1' }, { accountId: 'sales', credit: '1' }], 'USD', '83', 'INR', null)).toHaveLength(2);
    expect(() => atRate([{ accountId: 'ar', debit: '0.03' }, { accountId: 'sales', credit: '0.01' }, { accountId: 'sales', credit: '0.01' }, { accountId: 'sales', credit: '0.01' }], 'USD', '83.333', 'INR', null)).toThrow(/rounding account/);
    expect(atRate([{ accountId: 'ar', debit: '1' }, { accountId: 'sales', credit: '1' }], 'INR', '1', 'INR', null)[0]).not.toHaveProperty('exchangeRate');
  });

  it('records a realised gain when a receipt comes in at a higher rate', () => {
    const s = settlement({ ledger: 'SALES', amount: new D(1000), currency: 'USD', targetRate: '83', sourceRate: '84.5', controlAccountId: 'ar', fxAccountId: 'fx', functionalCurrency: 'INR' });
    expect(s.gain.toFixed()).toBe('1500');
    expect(s.lines).toEqual([
      expect.objectContaining({ accountId: 'ar', currency: 'USD', exchangeRate: '84.5', debit: '1000' }),
      expect.objectContaining({ accountId: 'ar', currency: 'USD', exchangeRate: '83', credit: '1000' }),
      expect.objectContaining({ accountId: 'fx', currency: 'INR', credit: '1500', description: 'Realised exchange gain' }),
    ]);
    validateJournal(s.lines!, ctx);
  });

  it('records a realised loss when a receipt comes in lower, and the opposite for bills', () => {
    const r = settlement({ ledger: 'SALES', amount: new D(400), currency: 'USD', targetRate: '83', sourceRate: '82.25', controlAccountId: 'ar', fxAccountId: 'fx', functionalCurrency: 'INR' });
    expect(r.gain.toFixed()).toBe('-300');
    expect(r.lines![2]).toMatchObject({ debit: '300', description: 'Realised exchange loss' });
    validateJournal(r.lines!, ctx);
    const p = settlement({ ledger: 'PURCHASES', amount: new D(400), currency: 'USD', targetRate: '83', sourceRate: '82.25', controlAccountId: 'ap', fxAccountId: 'fx', functionalCurrency: 'INR' });
    expect(p.gain.toFixed()).toBe('300');
    expect(p.lines![0]).toMatchObject({ accountId: 'ap', credit: '400', exchangeRate: '82.25' });
    validateJournal(p.lines!, ctx);
    const loss = settlement({ ledger: 'PURCHASES', amount: new D(400), currency: 'USD', targetRate: '83', sourceRate: '84', controlAccountId: 'ap', fxAccountId: 'fx', functionalCurrency: 'INR' });
    expect(loss.gain.toFixed()).toBe('-400');
    validateJournal(loss.lines!, ctx);
  });

  it('posts nothing for the same rate or the functional currency', () => {
    expect(settlement({ ledger: 'SALES', amount: new D(5), currency: 'USD', targetRate: '83.0', sourceRate: '83', controlAccountId: 'ar', fxAccountId: 'fx', functionalCurrency: 'INR' }).lines).toBeNull();
    expect(settlement({ ledger: 'SALES', amount: new D(5), currency: 'INR', targetRate: '1', sourceRate: '2', controlAccountId: 'ar', fxAccountId: 'fx', functionalCurrency: 'INR' }).lines).toBeNull();
  });

  it('works out what is open in the functional currency the way it was posted', () => {
    expect(functionalOpen(new D('100'), [new D('33.33'), new D('33.33')], '83.333', 'USD', 'INR').toFixed()).toBe(
      toFunctional(new D(100), '83.333', 'INR').minus(toFunctional(new D('33.33'), '83.333', 'INR').times(2)).toFixed(),
    );
    expect(functionalOpen(new D('100'), [new D('40')], '1', 'INR', 'INR').toFixed()).toBe('60');
  });
});
