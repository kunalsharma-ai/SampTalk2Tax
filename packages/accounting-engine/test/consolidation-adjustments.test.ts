import { describe, expect, it } from 'vitest';
import { adjustmentProblems, adjustmentsForPeriod, consolidate, ConsolidationError, type ConsolidationEntity } from '../src';

const parent: ConsolidationEntity = {
  id: 'p',
  name: 'Parent',
  currency: 'INR',
  closing: [
    { code: '1000', name: 'Bank', type: 'ASSET', netDebit: '500' },
    { code: '1500', name: 'Investment in subsidiary', type: 'ASSET', netDebit: '400' },
    { code: '3000', name: 'Share capital', type: 'EQUITY', netDebit: '-900' },
  ],
  period: [],
};
const sub: ConsolidationEntity = {
  id: 's',
  name: 'Subsidiary',
  currency: 'INR',
  closing: [
    { code: '1000', name: 'Bank', type: 'ASSET', netDebit: '300' },
    { code: '1300', name: 'Stock', type: 'ASSET', netDebit: '200' },
    { code: '3000', name: 'Share capital', type: 'EQUITY', netDebit: '-300' },
    { code: '4000', name: 'Sales', type: 'REVENUE', netDebit: '-1000' },
    { code: '5000', name: 'Cost of sales', type: 'EXPENSE', netDebit: '800' },
  ],
  period: [
    { code: '4000', name: 'Sales', type: 'REVENUE', netDebit: '-1000' },
    { code: '5000', name: 'Cost of sales', type: 'EXPENSE', netDebit: '800' },
  ],
};
const line = (code: string, name: string, type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE', debit: string, credit: string) => ({ code, name, type, debit, credit });

describe('consolidation adjustments', () => {
  it('are checked before they are recorded', () => {
    expect(adjustmentProblems([line('1900', 'Goodwill', 'ASSET', '100', ''), line('1500', 'Investment', 'ASSET', '', '100')], 'INR')).toEqual([]);
    expect(adjustmentProblems([line('1900', 'Goodwill', 'ASSET', '100', '')], 'INR')).toEqual(['An adjustment needs at least two lines']);
    expect(adjustmentProblems([line('1900', 'Goodwill', 'ASSET', '100', '5'), line('', '', 'X' as never, '1.234', '')], 'INR')).toEqual([
      'Line 1: enter a debit or a credit, not both',
      'Line 2: an account code is 1 to 20 letters, digits, dots or dashes',
      'Line 2: name the account',
      'Line 2: choose the account type',
      'Line 2: amounts are numbers with at most 2 decimals',
    ]);
    expect(adjustmentProblems([line('1900', 'Goodwill', 'ASSET', '100', ''), line('1500', 'Investment', 'ASSET', '', '90')], 'INR')).toEqual(['Debits (100.00) and credits (90.00) must be equal']);
    expect(adjustmentProblems([line('1900', 'Goodwill', 'ASSET', '100', ''), line('1500', 'Investment', 'ASSET', '', '100')], 'JPY')).toEqual([]);
  });

  it('change only the consolidated column, add new accounts, and keep every column balanced', () => {
    const recorded = [
      // Goodwill on acquisition: the investment over the share capital acquired.
      { id: 'a1', name: 'Goodwill on acquisition', date: '2026-04-01', lines: [line('1900', 'Goodwill', 'ASSET', '100', ''), line('3000', 'Share capital', 'EQUITY', '300', ''), line('1500', 'Investment in subsidiary', 'ASSET', '', '400')] },
      // Unrealised profit in the subsidiary's stock, this period.
      { id: 'a2', name: 'Unrealised profit in stock', date: '2026-09-30', lines: [line('5000', 'Cost of sales', 'EXPENSE', '50', ''), line('1300', 'Stock', 'ASSET', '', '50')] },
      // After the period: not applied.
      { id: 'a3', name: 'Later', date: '2026-10-05', lines: [line('5000', 'Cost of sales', 'EXPENSE', '10', ''), line('1300', 'Stock', 'ASSET', '', '10')] },
    ];
    const adj = adjustmentsForPeriod(recorded, '2026-07-01', '2026-09-30');
    expect(adj.map((a) => a.id)).toEqual(['a1', 'a2']);
    const r = consolidate({ currency: 'INR', entities: [parent, sub], rules: [], adjustments: adj });
    expect(r.balanced).toBe(true);
    const row = (code: string) => r.rows.find((x) => x.code === code)!;
    expect(row('1900')).toMatchObject({ amounts: ['0.00', '0.00'], adjustment: '100.00', consolidated: '100.00' });
    expect(row('1500')).toMatchObject({ amounts: ['400.00', '0.00'], adjustment: '-400.00', consolidated: '0.00' });
    expect(row('1300')).toMatchObject({ adjustment: '-50.00', consolidated: '150.00' });
    expect(r.incomeStatement.netIncome).toBe('150.00');
    expect(r.balanceSheet).toMatchObject({ totalAssets: '1050.00', balanced: true });
    expect(r.adjustments.map((a) => a.name)).toEqual(['Goodwill on acquisition', 'Unrealised profit in stock']);
  });

  it('carry revenue and expenses dated before the period into earnings brought forward', () => {
    const adj = adjustmentsForPeriod([{ id: 'b', name: 'Prior year stock profit', date: '2026-03-31', lines: [line('5000', 'Cost of sales', 'EXPENSE', '30', ''), line('1300', 'Stock', 'ASSET', '', '30')] }], '2026-04-01', '2026-09-30');
    const r = consolidate({ currency: 'INR', entities: [parent, sub], rules: [], adjustments: adj });
    expect(r.rows.find((x) => x.kind === 'EARNINGS_BROUGHT_FORWARD')!.adjustment).toBe('30.00');
    expect(r.rows.find((x) => x.code === '5000')!.adjustment).toBe('0.00');
    expect(r.incomeStatement.netIncome).toBe('200.00');
    expect(r.balanced).toBe(true);
  });

  it('refuse an account used with another type than the companies use', () => {
    const adj = adjustmentsForPeriod([{ id: 'c', name: 'Wrong type', date: '2026-09-01', lines: [line('1300', 'Stock', 'EXPENSE', '5', ''), line('1000', 'Bank', 'ASSET', '', '5')] }], '2026-07-01', '2026-09-30');
    expect(() => consolidate({ currency: 'INR', entities: [parent, sub], rules: [], adjustments: adj })).toThrow(ConsolidationError);
  });
});
