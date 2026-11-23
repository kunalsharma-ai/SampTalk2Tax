import { describe, expect, it } from 'vitest';
import { categoryUsage, checkClaimCategories, expenseCategoryIssues, expenseCategoryKey } from '../src';

const base = { name: 'Travel', description: null, accountId: 'acc-1', taxRateId: null, receipt: 'POLICY' as const };

describe('expense categories', () => {
  it('needs a name, an account and a name no other active category has', () => {
    expect(expenseCategoryIssues(base, new Set())).toEqual([]);
    expect(expenseCategoryIssues({ ...base, name: '  ' }, new Set())).toContain('Give the category a name');
    expect(expenseCategoryIssues({ ...base, accountId: '' }, new Set())).toContain('Choose the expense account the category posts to');
    expect(expenseCategoryIssues({ ...base, name: ' travel ' }, new Set([expenseCategoryKey('Travel')]))).toEqual(['There is already an active category called travel']);
    expect(expenseCategoryIssues({ ...base, name: 'x'.repeat(61) }, new Set())).toEqual(['Keep the name to 60 characters']);
    expect(expenseCategoryIssues({ ...base, receipt: 'SOMETIMES' as never }, new Set())).toEqual(['Choose whether a receipt is always required']);
  });

  it('blocks a claim without receipts for a category that always needs one, but not allowance lines', () => {
    const cats = [
      { id: 'c1', name: 'Hotels', accountId: 'a1', receipt: 'ALWAYS' as const, isActive: true },
      { id: 'c2', name: 'Taxis', accountId: 'a2', receipt: 'POLICY' as const, isActive: true },
    ];
    const lines = [
      { lineNo: 1, categoryId: 'c1', accountId: 'a1' },
      { lineNo: 2, categoryId: 'c2', accountId: 'a2' },
      { lineNo: 3, categoryId: 'c1', accountId: 'a1' },
      { lineNo: 4, categoryId: 'c1', accountId: 'a1', isAllowance: true },
    ];
    const v = checkClaimCategories(lines, cats, 0);
    expect(v).toEqual([{ ruleId: 'category:c1', kind: 'CATEGORY_RECEIPT', severity: 'BLOCK', lineNo: null, message: 'Attach the receipts: Hotels always needs one (lines 1, 3) and the claim has none' }]);
    expect(checkClaimCategories(lines, cats, 1)).toEqual([]);
  });

  it('flags a line whose category moved to another account', () => {
    const v = checkClaimCategories([{ lineNo: 2, categoryId: 'c2', accountId: 'old' }], [{ id: 'c2', name: 'Taxis', accountId: 'a2', receipt: 'POLICY', isActive: true }], 0);
    expect(v.map((x) => x.kind)).toEqual(['CATEGORY_ACCOUNT']);
    expect(checkClaimCategories([{ lineNo: 1, categoryId: null, accountId: 'a' }], [], 0)).toEqual([]);
  });

  it('adds up what was claimed per category in decimals', () => {
    const u = categoryUsage([{ categoryId: 'c1', amount: '0.10' }, { categoryId: 'c1', amount: '0.20' }, { categoryId: null, amount: '5' }, { categoryId: 'c2', amount: '7' }], 2);
    expect(u.get('c1')).toEqual({ lines: 2, total: '0.30' });
    expect(u.get('c2')).toEqual({ lines: 1, total: '7.00' });
    expect(u.size).toBe(2);
  });
});
