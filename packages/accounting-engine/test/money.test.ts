import { describe, expect, it } from 'vitest';
import { D, MoneyError, assertCurrencyPrecision, dec, roundToCurrency, sum } from '../src';

describe('money', () => {
  it('refuses JS numbers so floats never enter the ledger', () => {
    expect(() => dec(0.1 as unknown as string)).toThrow(MoneyError);
  });

  it('adds decimals exactly (0.1 + 0.2 = 0.3)', () => {
    expect(sum([dec('0.1'), dec('0.2')]).equals(dec('0.3'))).toBe(true);
  });

  it('rejects malformed strings', () => {
    for (const bad of ['', '1e5', 'abc', '1.2.3', 'NaN', 'Infinity', '1,000']) {
      expect(() => dec(bad)).toThrow(MoneyError);
    }
  });

  it('rounds half-even to the currency minor unit', () => {
    expect(roundToCurrency(dec('2.345'), 'USD').toFixed()).toBe('2.34');
    expect(roundToCurrency(dec('2.355'), 'USD').toFixed()).toBe('2.36');
    expect(roundToCurrency(dec('1234.5'), 'JPY').toFixed()).toBe('1234');
    expect(roundToCurrency(dec('1.2345'), 'KWD').toFixed()).toBe('1.234');
  });

  it('enforces currency precision', () => {
    expect(() => assertCurrencyPrecision(dec('1.001'), 'USD')).toThrow(/more decimal places/);
    expect(() => assertCurrencyPrecision(dec('1.5'), 'JPY')).toThrow();
    expect(() => assertCurrencyPrecision(dec('1.001'), 'BHD')).not.toThrow();
  });

  it('keeps precision on very large amounts', () => {
    const big = dec('999999999999999999.99');
    expect(big.plus(dec('0.01')).toFixed(2)).toBe('1000000000000000000.00');
    expect(new D('0').isZero()).toBe(true);
  });
});
