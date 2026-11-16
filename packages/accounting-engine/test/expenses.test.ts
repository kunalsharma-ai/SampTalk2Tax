import { describe, expect, it } from 'vitest';
import { D, DocumentValidationError, PostingAccount, TaxRateInfo, buildExpenseClaimJournal, buildReimbursementJournal, computeExpenseClaim, includedTax, possibleDuplicateLines, validateJournal } from '../src';

const rates = new Map<string, TaxRateInfo>([
  ['t18', { id: 't18', name: 'Tax 18%', rate: '18', accountId: 'itc' }],
  ['t5', { id: 't5', name: 'Tax 5%', rate: '5', accountId: 'itc' }],
  ['zero', { id: 'zero', name: 'Exempt', rate: '0', accountId: null }],
  ['broken', { id: 'broken', name: 'Broken', rate: '12', accountId: null }],
]);
const accounts = new Map<string, PostingAccount>(
  ['travel', 'meals', 'itc', 'owed', 'bank'].map((id) => [id, { id, code: id, type: id === 'owed' ? 'LIABILITY' : id === 'itc' || id === 'bank' ? 'ASSET' : 'EXPENSE', isPostable: true, isActive: true }]),
);

describe('expense claims', () => {
  it('splits the tax out of tax-inclusive amounts, half-even', () => {
    expect(includedTax(new D('1180.00'), new D('18'), 'INR').toFixed(2)).toBe('180.00');
    expect(includedTax(new D('105.00'), new D('5'), 'INR').toFixed(2)).toBe('5.00');
    // 100 × 18 / 118 = 15.2542… → 15.25
    expect(includedTax(new D('100.00'), new D('18'), 'INR').toFixed(2)).toBe('15.25');
    expect(includedTax(new D('100.00'), new D('0'), 'INR').toFixed(2)).toBe('0.00');
  });

  it('totals lines so that net + tax equals what was paid', () => {
    const c = computeExpenseClaim(
      [
        { date: '2026-10-02', accountId: 'travel', merchant: 'Synthetic Cabs', amount: '1180.00', taxRateId: 't18' },
        { date: '2026-10-03', accountId: 'meals', amount: '100.00', taxRateId: 't18' },
        { date: '2026-10-03', accountId: 'meals', amount: '250.50' },
      ],
      'INR',
      rates,
    );
    expect(c.total.toFixed(2)).toBe('1530.50');
    expect(c.taxTotal.toFixed(2)).toBe('195.25');
    expect(c.netTotal.plus(c.taxTotal).eq(c.total)).toBe(true);
    expect(c.lines.map((l) => l.netAmount.toFixed(2))).toEqual(['1000.00', '84.75', '250.50']);
    expect(c.lines[0].merchant).toBe('Synthetic Cabs');
  });

  it('rejects empty claims, bad amounts, dates and unusable tax rates with every issue listed', () => {
    expect(() => computeExpenseClaim([], 'INR', rates)).toThrow(DocumentValidationError);
    try {
      computeExpenseClaim(
        [
          { date: '2026-10-02', accountId: 'travel', amount: '0' },
          { date: '2026-10-02', accountId: 'travel', amount: '1.005' },
          { date: '2026-13-02', accountId: 'travel', amount: '5' },
          { date: '2026-10-02', accountId: 'travel', amount: '5', taxRateId: 'broken' },
          { date: '2026-10-02', accountId: 'travel', amount: '5', taxRateId: 'missing' },
        ],
        'INR',
        rates,
      );
      expect.unreachable();
    } catch (e) {
      expect((e as DocumentValidationError).issues).toHaveLength(5);
    }
  });

  it('posts a balanced journal: expenses and tax against the amount owed, then reimbursement from the bank', () => {
    const c = computeExpenseClaim(
      [
        { date: '2026-10-02', accountId: 'travel', amount: '1180.00', taxRateId: 't18' },
        { date: '2026-10-03', accountId: 'meals', amount: '210.00', taxRateId: 't5' },
      ],
      'INR',
      rates,
    );
    const lines = buildExpenseClaimJournal(c, 'owed', 'INR');
    const v = validateJournal(lines, { functionalCurrency: 'INR', accounts });
    expect(v.totalFunctionalDebit.toFixed(2)).toBe('1390.00');
    expect(lines.filter((l) => l.accountId === 'itc')).toEqual([{ accountId: 'itc', currency: 'INR', debit: '190', description: 'Tax on expenses' }]);
    const r = buildReimbursementJournal(c.total, 'bank', 'owed', 'INR');
    expect(validateJournal(r, { functionalCurrency: 'INR', accounts }).totalFunctionalCredit.toFixed(2)).toBe('1390.00');
    expect(() => buildReimbursementJournal(new D('0'), 'bank', 'owed', 'INR')).toThrow();
  });

  it('flags lines that another claim already has with the same date and amount', () => {
    const hits = possibleDuplicateLines(
      [
        { lineNo: 1, date: '2026-10-02', amount: new D('1180.00') },
        { lineNo: 2, date: '2026-10-03', amount: new D('99.00') },
      ],
      [
        { claimLabel: 'EXP-000004', date: '2026-10-02', amount: new D('1180') },
        { claimLabel: 'EXP-000004', date: '2026-10-02', amount: new D('1180') },
        { claimLabel: 'EXP-000007', date: '2026-10-04', amount: new D('99.00') },
      ],
    );
    expect([...hits]).toEqual([[1, ['EXP-000004']]]);
  });
});
