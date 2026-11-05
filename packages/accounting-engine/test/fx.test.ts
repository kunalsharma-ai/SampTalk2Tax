import { describe, expect, it } from 'vitest';
import { checkRate, FxError, isMonetary, nextDay, rateOn, revaluationJournal, revaluationPlan, validateJournal, type ForeignBalance } from '../src';

const bal = (code: string, type: ForeignBalance['type'], subtype: string | null, currency: string, foreign: string, carried: string): ForeignBalance => ({ accountId: `id-${code}-${currency}`, code, name: code, type, subtype, currency, foreign, carried });

describe('foreign-currency revaluation', () => {
  it('knows which balances are monetary', () => {
    expect(isMonetary('ASSET', 'BANK')).toBe(true);
    expect(isMonetary('LIABILITY', 'LONG_TERM_DEBT')).toBe(true);
    expect(isMonetary('ASSET', null)).toBe(true);
    expect(isMonetary('ASSET', 'INVENTORY')).toBe(false);
    expect(isMonetary('ASSET', 'FIXED_ASSET')).toBe(false);
    expect(isMonetary('EXPENSE', 'OPERATING_EXPENSE')).toBe(false);
  });

  it('checks rates and finds the one in force', () => {
    expect(checkRate(' 83.25 ').toFixed()).toBe('83.25');
    expect(() => checkRate('0')).toThrow(FxError);
    expect(() => checkRate('-1')).toThrow(FxError);
    expect(() => checkRate('83,25')).toThrow(FxError);
    const rates = [{ date: '2026-10-01', rate: '83' }, { date: '2026-10-31', rate: '84' }, { date: '2026-11-15', rate: '85' }];
    expect(rateOn(rates, '2026-11-01')?.rate).toBe('84');
    expect(rateOn(rates, '2026-09-30')).toBeNull();
    expect(nextDay('2026-10-31')).toBe('2026-11-01');
    expect(nextDay('2028-02-28')).toBe('2028-02-29');
  });

  it('restates monetary balances at the closing rate and posts a balanced journal', () => {
    const plan = revaluationPlan(
      [
        bal('1130', 'ASSET', 'BANK', 'USD', '10000', '830000'), // 10,000 USD carried at 83
        bal('2710', 'LIABILITY', 'LONG_TERM_DEBT', 'EUR', '-5000', '-450000'), // 5,000 EUR owed at 90
        bal('1300', 'ASSET', 'INVENTORY', 'USD', '100', '8300'),
        bal('1140', 'ASSET', 'BANK', 'GBP', '200', '21000'),
        bal('1120', 'ASSET', 'BANK', 'INR', '5000', '5000'),
      ],
      { USD: '84.5', EUR: '91.2' },
      'INR',
    );
    expect(plan.missingRates).toEqual(['GBP']);
    expect(plan.skipped.map((s) => s.code)).toEqual(['1300']);
    expect(plan.lines.map((l) => [l.code, l.revalued.toFixed(2), l.adjustment.toFixed(2)])).toEqual([
      ['1130', '845000.00', '15000.00'], // gain on the bank balance
      ['2710', '-456000.00', '-6000.00'], // loss on the loan
    ]);
    expect(plan.gain.toFixed(2)).toBe('9000.00');
    const lines = revaluationJournal(plan, 'fx', 'INR')!;
    expect(lines).toEqual([
      { accountId: 'id-1130-USD', debit: '15000.00', description: 'USD 10000 at 84.5' },
      { accountId: 'id-2710-EUR', credit: '6000.00', description: 'EUR -5000 at 91.2' },
      { accountId: 'fx', credit: '9000.00', description: 'Unrealised exchange gain' },
    ]);
    const accounts = new Map(['id-1130-USD', 'id-2710-EUR', 'fx'].map((id) => [id, { id, code: id, type: 'ASSET' as const, isPostable: true, isActive: true }]));
    expect(validateJournal(lines, { functionalCurrency: 'INR', accounts }).totalFunctionalDebit.toFixed(2)).toBe('15000.00');
  });

  it('posts a loss to the exchange account, rounds to the currency, and does nothing when rates are unchanged', () => {
    const loss = revaluationPlan([bal('1130', 'ASSET', 'BANK', 'USD', '333.33', '27999.72')], { USD: '83.3333' }, 'INR');
    expect(loss.lines[0].revalued.toFixed(2)).toBe('27777.49');
    expect(loss.gain.toFixed(2)).toBe('-222.23');
    expect(revaluationJournal(loss, 'fx', 'INR')!.at(-1)).toEqual({ accountId: 'fx', debit: '222.23', description: 'Unrealised exchange loss' });
    const same = revaluationPlan([bal('1130', 'ASSET', 'BANK', 'USD', '100', '8300')], { USD: '83' }, 'INR');
    expect(revaluationJournal(same, 'fx', 'INR')).toBeNull();
    // A balance in JPY rounds to whole units of a JPY book.
    const jpy = revaluationPlan([bal('1130', 'ASSET', 'BANK', 'USD', '10.01', '1500')], { USD: '150.37' }, 'JPY');
    expect(jpy.lines[0].revalued.toFixed()).toBe('1505');
  });
});
