import { describe, expect, it } from 'vitest';
import { checkExpensePolicy, describeExpensePolicyRule, expensePolicyRuleIssues, ExpensePolicyRule } from '../src';

const rule = (r: Partial<ExpensePolicyRule> & Pick<ExpensePolicyRule, 'kind'>): ExpensePolicyRule => ({ id: r.kind, severity: 'WARN', accountId: null, amount: null, days: null, ...r });
const MEALS = 'acc-meals';
const TRAVEL = 'acc-travel';

describe('rules as set', () => {
  it('are checked for their kind', () => {
    expect(expensePolicyRuleIssues({ kind: 'LINE_MAX', severity: 'BLOCK', accountId: MEALS, amount: '3000', days: null }, 'INR')).toEqual([]);
    expect(expensePolicyRuleIssues({ kind: 'LINE_MAX', severity: 'WARN', accountId: null, amount: '0', days: null }, 'INR')).toEqual(['The limit must be above zero']);
    expect(expensePolicyRuleIssues({ kind: 'CLAIM_MAX', severity: 'WARN', accountId: MEALS, amount: '10.005', days: null }, 'INR')).toEqual([
      'Only limits per receipt, per day and per month can be narrowed to one category',
      'The amount has more decimal places than INR allows',
    ]);
    expect(expensePolicyRuleIssues({ kind: 'RECEIPT_ABOVE', severity: 'BLOCK', accountId: null, amount: '0', days: null }, 'INR')).toEqual([]);
    expect(expensePolicyRuleIssues({ kind: 'MAX_AGE_DAYS', severity: 'BLOCK', accountId: null, amount: null, days: 0 }, 'INR')).toEqual(['Give the number of days, from 1 to 3650']);
    expect(expensePolicyRuleIssues({ kind: 'DAILY_MAX', severity: 'WARN', accountId: null, amount: 'lots', days: null }, 'INR')).toEqual(['The limit must be a decimal amount']);
  });

  it('read as a sentence', () => {
    expect(describeExpensePolicyRule(rule({ kind: 'DAILY_MAX', amount: '3000', accountId: MEALS, accountLabel: '6600 · Meals' }), 'INR')).toBe('At most INR 3000.00 a day for 6600 · Meals');
    expect(describeExpensePolicyRule(rule({ kind: 'MAX_AGE_DAYS', days: 90 }), 'INR')).toBe('Receipts no older than 90 days when submitted');
  });
});

describe('checking a claim', () => {
  const lines = [
    { lineNo: 1, date: '2026-11-10', accountId: MEALS, amount: '1800.00' },
    { lineNo: 2, date: '2026-11-10', accountId: MEALS, amount: '1500.00' },
    { lineNo: 3, date: '2026-08-01', accountId: TRAVEL, amount: '4000.00' },
    { lineNo: 4, date: '2026-11-11', accountId: TRAVEL, amount: '900.00', isAllowance: true },
  ];
  const claim = { lines, receiptCount: 0, asOf: '2026-11-17' };

  it('limits per receipt, only in the rule\'s category', () => {
    const v = checkExpensePolicy([rule({ kind: 'LINE_MAX', amount: '1600', accountId: MEALS, accountLabel: '6600 · Meals' })], claim, [], 'INR');
    expect(v).toEqual([{ ruleId: 'LINE_MAX', kind: 'LINE_MAX', severity: 'WARN', lineNo: 1, message: 'Line 1: INR 1800.00 is over the limit of INR 1600.00 per receipt for 6600 · Meals' }]);
  });

  it('adds up a day across claims, but a limit exactly met is fine', () => {
    const daily = rule({ kind: 'DAILY_MAX', amount: '3300', accountId: MEALS, accountLabel: 'Meals' });
    expect(checkExpensePolicy([daily], claim, [], 'INR')).toEqual([]);
    const v = checkExpensePolicy([daily], claim, [{ date: '2026-11-10', accountId: MEALS, amount: '200' }, { date: '2026-11-10', accountId: TRAVEL, amount: '999' }], 'INR');
    expect(v.map((x) => x.message)).toEqual(['On 2026-11-10, INR 3500.00 is claimed for Meals (INR 200.00 of it on your other claims), over the limit of INR 3300.00 a day']);
  });

  it('adds up a calendar month across categories when the rule has none', () => {
    const v = checkExpensePolicy([rule({ kind: 'MONTHLY_MAX', amount: '5000', severity: 'BLOCK' })], claim, [{ date: '2026-11-30', accountId: TRAVEL, amount: '1000' }, { date: '2026-10-31', accountId: TRAVEL, amount: '99999' }], 'INR');
    expect(v).toEqual([{ ruleId: 'MONTHLY_MAX', kind: 'MONTHLY_MAX', severity: 'BLOCK', lineNo: null, message: 'In 2026-11, INR 5200.00 is claimed (INR 1000.00 of it on your other claims), over the limit of INR 5000.00 a month' }]);
  });

  it('checks the claim total, missing receipts (not for allowances) and receipt age', () => {
    const v = checkExpensePolicy([rule({ kind: 'CLAIM_MAX', amount: '8000' }), rule({ kind: 'RECEIPT_ABOVE', amount: '500' }), rule({ kind: 'MAX_AGE_DAYS', days: 60 })], claim, [], 'INR');
    expect(v.map((x) => x.message)).toEqual([
      'The claim totals INR 8200.00, over the limit of INR 8000.00 for one claim',
      'Attach the receipts: lines 1, 2, 3 are over INR 500.00 and the claim has no receipt attached',
      'Line 3: the receipt is 108 days old; claims must be made within 60 days',
    ]);
    expect(checkExpensePolicy([rule({ kind: 'RECEIPT_ABOVE', amount: '500' })], { ...claim, receiptCount: 1 }, [], 'INR')).toEqual([]);
  });
});
