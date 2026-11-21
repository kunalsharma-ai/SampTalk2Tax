import { describe, expect, it } from 'vitest';
import { OpeningAccount, planOpeningBalances } from '../src/opening-balances';

const accounts: OpeningAccount[] = [
  { id: 'cash', code: '1110', name: 'Cash on Hand', type: 'ASSET' },
  { id: 'bank', code: '1120', name: 'Operating Bank Account', type: 'ASSET' },
  { id: 'ppe', code: '1510', name: 'Property, Plant and Equipment', type: 'ASSET' },
  { id: 'loan', code: '2500', name: 'Long-term Loans', type: 'LIABILITY' },
  { id: 'capital', code: '3100', name: 'Share Capital', type: 'EQUITY' },
  { id: 'sales', code: '4100', name: 'Sales', type: 'REVENUE' },
  { id: 'obe', code: '3250', name: 'Opening Balance Equity', type: 'EQUITY' },
];
const plan = (lines: { accountId: string; debit?: string; credit?: string }[], currency = 'INR') => planOpeningBalances({ currency, accounts, lines, offsetAccountId: 'obe' });

describe('opening balances (GL-010)', () => {
  it('posts balances that agree without touching Opening Balance Equity', () => {
    const p = plan([
      { accountId: 'bank', debit: '250000' },
      { accountId: 'ppe', debit: '1200000.50' },
      { accountId: 'loan', credit: '450000.50' },
      { accountId: 'capital', credit: '1000000' },
    ]);
    expect(p.issues).toEqual([]);
    expect(p.warnings).toEqual([]);
    expect(p.difference).toBe('0.00');
    expect(p.lines.map((l) => [l.accountId, l.debit, l.credit])).toEqual([
      ['bank', '250000.00', '0.00'],
      ['ppe', '1200000.50', '0.00'],
      ['loan', '0.00', '450000.50'],
      ['capital', '0.00', '1000000.00'],
    ]);
    expect(p.totalDebit).toBe('1450000.50');
    expect(p.totalCredit).toBe('1450000.50');
  });

  it('puts the difference in Opening Balance Equity, on whichever side balances it', () => {
    const more = plan([{ accountId: 'bank', debit: '1000' }, { accountId: 'capital', credit: '600' }]);
    expect(more.difference).toBe('400.00');
    expect(more.lines.at(-1)).toEqual({ accountId: 'obe', debit: '0.00', credit: '400.00', description: 'Difference in the opening balances' });
    expect([more.totalDebit, more.totalCredit]).toEqual(['1000.00', '1000.00']);
    const less = plan([{ accountId: 'loan', credit: '700' }, { accountId: 'cash', debit: '200' }]);
    expect(less.difference).toBe('-500.00');
    expect(less.lines.at(-1)).toMatchObject({ accountId: 'obe', debit: '500.00', credit: '0.00' });
  });

  it('skips blank and zero rows, and needs at least one balance', () => {
    expect(plan([{ accountId: 'bank', debit: '' }, { accountId: 'cash', credit: '0.00' }]).issues).toEqual(['Enter at least one balance']);
    expect(plan([{ accountId: 'bank', debit: '0', credit: '' }, { accountId: 'cash', debit: '10' }, { accountId: 'capital', credit: '10' }]).lines).toHaveLength(2);
  });

  it('refuses both sides, bad amounts, repeats, unknown accounts and the equity account itself', () => {
    const p = plan([
      { accountId: 'bank', debit: '10', credit: '10' },
      { accountId: 'cash', debit: '-5' },
      { accountId: 'ppe', debit: '1.234' },
      { accountId: 'loan', credit: '1,00,000' },
      { accountId: 'capital', credit: '100' },
      { accountId: 'capital', credit: '100' },
      { accountId: 'nope', debit: '5' },
      { accountId: 'obe', credit: '5' },
    ]);
    expect(p.issues).toEqual([
      '1120 Operating Bank Account: enter a debit or a credit, not both',
      '1110 Cash on Hand: "-5" is not an amount with at most 2 decimal places',
      '1510 Property, Plant and Equipment: "1.234" is not an amount with at most 2 decimal places',
      '2500 Long-term Loans: "1,00,000" is not an amount with at most 2 decimal places',
      '3100 Share Capital is entered twice',
      'nope is not an account that can take an opening balance',
      '3250 Opening Balance Equity takes the difference: leave it out',
    ]);
  });

  it('uses the currency’s own decimal places', () => {
    expect(plan([{ accountId: 'bank', debit: '1.5' }, { accountId: 'capital', credit: '1.5' }], 'JPY').issues).toEqual(['1120 Operating Bank Account: "1.5" is not a whole amount in JPY', '3100 Share Capital: "1.5" is not a whole amount in JPY']);
    expect(plan([{ accountId: 'bank', debit: '1.125' }, { accountId: 'capital', credit: '1.125' }], 'KWD').difference).toBe('0.000');
  });

  it('warns about balances on the unusual side and about income and expense accounts', () => {
    const p = plan([{ accountId: 'bank', credit: '5000' }, { accountId: 'sales', credit: '20000' }, { accountId: 'capital', debit: '25000' }]);
    expect(p.issues).toEqual([]);
    expect(p.warnings).toEqual([
      '1120 Operating Bank Account usually has a debit balance',
      '4100 Sales is an income or expense account: enter it only when the books start part-way through a financial year',
      '3100 Share Capital usually has a credit balance',
    ]);
  });

  it('cannot balance without somewhere for the difference', () => {
    expect(planOpeningBalances({ currency: 'INR', accounts, lines: [{ accountId: 'bank', debit: '5' }], offsetAccountId: null }).issues).toEqual(['There is no Opening Balance Equity account to take the difference']);
  });
});
