import { describe, expect, it } from 'vitest';
import { BudgetError, budgetAmountsIssue, budgetBuckets, buildBudgetVariance, D, fromPriorYear, spreadByWeights, spreadEvenly, sum, variance } from '../src';

const total = (xs: string[]) => sum(xs.map((x) => new D(x))).toFixed(2);
const twelve = (v: string) => Array.from({ length: 12 }, () => v);

describe('filling a budget', () => {
  it('spreads an annual total evenly, to the paisa', () => {
    expect(spreadEvenly('1200000')).toEqual(twelve('100000.00'));
    const odd = spreadEvenly('100.00');
    expect(total(odd)).toBe('100.00');
    // 100 / 12 = 8.333…: four months get the extra paisa, the earliest first
    expect(odd.slice(0, 4)).toEqual(twelve('8.34').slice(0, 4));
    expect(odd.slice(4)).toEqual(twelve('8.33').slice(4));
    expect(total(spreadEvenly('-0.05'))).toBe('-0.05');
    expect(spreadEvenly('0')).toEqual(twelve('0.00'));
  });

  it('spreads by weights with the largest remainders getting the extra units', () => {
    const parts = spreadByWeights('1000', ['1', '1', '1']);
    expect(parts).toEqual(['333.34', '333.33', '333.33']);
    const seasonal = spreadByWeights('999.99', ['10', '0', '30', '60']);
    expect(seasonal).toEqual(['100.00', '0.00', '300.00', '599.99']);
    expect(total(seasonal)).toBe('999.99');
    // no history: falls back to an even spread
    expect(spreadByWeights('30', ['0', '0', '0'])).toEqual(['10.00', '10.00', '10.00']);
    expect(spreadByWeights('7', ['1', '1'], 0)).toEqual(['4', '3']);
    expect(() => spreadByWeights('10', ['-1', '2'])).toThrow(BudgetError);
    expect(() => spreadByWeights(10 as unknown as string, ['1'])).toThrow();
  });

  it('copies last year with a change, rounded half-even each month', () => {
    const prior = twelve('1000.05');
    expect(fromPriorYear(prior, '10')[0]).toBe('1100.06'); // 1100.055 → 1100.06
    expect(fromPriorYear(prior, '-100')).toEqual(twelve('0.00'));
    expect(fromPriorYear(twelve('80.25'), '0')).toEqual(twelve('80.25'));
    expect(() => fromPriorYear(['1'], '5')).toThrow(BudgetError);
    expect(() => fromPriorYear(prior, '-101')).toThrow(BudgetError);
  });

  it('checks amounts', () => {
    expect(budgetAmountsIssue(twelve('10.50'))).toBeNull();
    expect(budgetAmountsIssue(twelve('10'))).toBeNull();
    expect(budgetAmountsIssue(['1'])).toMatch(/12 monthly/);
    expect(budgetAmountsIssue([...twelve('1').slice(1), '1.234'])).toBe('Month 12: at most 2 decimal places');
    expect(budgetAmountsIssue(['abc', ...twelve('1').slice(1)])).toBe('Month 1: not an amount');
    expect(budgetAmountsIssue(['99999999999999999', ...twelve('1').slice(1)])).toMatch(/too large|not an amount/);
  });
});

describe('budget against actual', () => {
  it('groups months into quarters and the year', () => {
    expect(budgetBuckets('MONTH')).toHaveLength(12);
    expect(budgetBuckets('QUARTER')).toEqual([[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12]]);
    expect(budgetBuckets('YEAR')).toEqual([[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]]);
  });

  it('judges revenue and expenses the right way round', () => {
    expect(variance('REVENUE', new D('100'), new D('120'))).toEqual({ budget: '100.00', actual: '120.00', variance: '20.00', percent: '20.0', favourable: true });
    expect(variance('EXPENSE', new D('100'), new D('120'))).toMatchObject({ variance: '20.00', favourable: false });
    expect(variance('EXPENSE', new D('100'), new D('100'))).toMatchObject({ variance: '0.00', favourable: true });
    expect(variance('EXPENSE', new D('0'), new D('50'))).toMatchObject({ percent: null, favourable: false });
    expect(variance('NET', new D('-200'), new D('-100'))).toMatchObject({ variance: '100.00', percent: '50.0', favourable: true });
    expect(variance('REVENUE', new D('100'), null)).toEqual({ budget: '100.00', actual: null, variance: null, percent: null, favourable: null });
  });

  it('reports by quarter with year to date, unbudgeted accounts and totals', () => {
    const r = buildBudgetVariance({
      granularity: 'QUARTER',
      periodsStarted: 5,
      accounts: [
        { accountId: 'rent', code: '6100', name: 'Rent', type: 'EXPENSE', budget: twelve('1000'), actual: ['1000', '1000', '1000', '1200', '300', '999', '0', '0', '0', '0', '0', '0'] },
        { accountId: 'sales', code: '4000', name: 'Sales', type: 'REVENUE', budget: twelve('5000'), actual: ['4000', '6000', '5500', '5000', '1000', '0', '0', '0', '0', '0', '0', '0'] },
        { accountId: 'misc', code: '6900', name: 'Sundry', type: 'EXPENSE', budget: null, actual: ['0', '250', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0'] },
        { accountId: 'idle', code: '6950', name: 'Unused', type: 'EXPENSE', budget: null, actual: twelve('0') },
      ],
    });
    expect(r.rows.map((x) => x.code)).toEqual(['4000', '6100', '6900']);
    expect(r.buckets.map((b) => b.started)).toEqual([true, true, false, false]);
    const rent = r.rows.find((x) => x.code === '6100')!;
    expect(rent.buckets[0]).toMatchObject({ budget: '3000.00', actual: '3000.00', variance: '0.00', favourable: true });
    // Q2 in progress: whole quarter's budget against two months; month 6 has not started, so its 999 is ignored
    expect(rent.buckets[1]).toMatchObject({ budget: '3000.00', actual: '1500.00', favourable: true });
    expect(rent.buckets[2]).toMatchObject({ actual: null });
    expect(rent.yearToDate).toMatchObject({ budget: '5000.00', actual: '4500.00', variance: '-500.00', percent: '-10.0', favourable: true });
    expect(rent.fullYearBudget).toBe('12000.00');
    const misc = r.rows.find((x) => x.code === '6900')!;
    expect(misc).toMatchObject({ budgeted: false, fullYearBudget: '0.00' });
    expect(misc.yearToDate).toMatchObject({ budget: '0.00', actual: '250.00', favourable: false, percent: null });
    expect(r.revenue.yearToDate).toMatchObject({ budget: '25000.00', actual: '21500.00', variance: '-3500.00', favourable: false });
    expect(r.expenses.yearToDate).toMatchObject({ budget: '5000.00', actual: '4750.00' });
    expect(r.netIncome.yearToDate).toMatchObject({ budget: '20000.00', actual: '16750.00', variance: '-3250.00', percent: '-16.2', favourable: false }); // -16.25 rounds half-even
    expect(r.netIncome.fullYearBudget).toBe('48000.00');
  });

  it('has no actuals before the year starts', () => {
    const r = buildBudgetVariance({ granularity: 'YEAR', periodsStarted: 0, accounts: [{ accountId: 'a', code: '4000', name: 'Sales', type: 'REVENUE', budget: twelve('1'), actual: twelve('5') }] });
    expect(r.rows[0].buckets[0].actual).toBeNull();
    expect(r.rows[0].yearToDate).toMatchObject({ budget: '0.00', actual: null });
    expect(() => buildBudgetVariance({ granularity: 'YEAR', periodsStarted: 1, accounts: [{ accountId: 'a', code: '1', name: 'x', type: 'REVENUE', budget: ['1'], actual: twelve('0') }] })).toThrow(BudgetError);
  });
});
