import { describe, expect, it } from 'vitest';
import { departmentPerformance, type PerformanceAmount } from '../src';

const DEPTS = [
  { id: 'd1', code: 'SALES', name: 'Sales' },
  { id: 'd2', code: 'OPS', name: 'Operations' },
  { id: 'd3', code: 'IDLE', name: 'Idle' },
  { id: 'd4', code: 'RND', name: 'Research' },
];
const A = (departmentId: string | null, month: string, type: 'REVENUE' | 'EXPENSE', amount: string): PerformanceAmount => ({ departmentId, month, type, amount });
const AMOUNTS = [
  A('d1', '2026-09', 'REVENUE', '100000'), A('d1', '2026-10', 'REVENUE', '120000'), A('d1', '2026-09', 'EXPENSE', '30000'), A('d1', '2026-10', 'EXPENSE', '45000'),
  A('d2', '2026-09', 'EXPENSE', '20000'), A('d2', '2026-10', 'EXPENSE', '20000'),
  A(null, '2026-10', 'EXPENSE', '5000'), A('gone', '2026-10', 'EXPENSE', '5000'),
];

describe('department performance', () => {
  const r = departmentPerformance(DEPTS, AMOUNTS, ['2026-09', '2026-10'], [{ departmentId: 'd2', amount: '45000', spentInYear: '40000' }, { departmentId: 'd4', amount: '10000', spentInYear: '12000' }]);

  it('ranks departments by profit, keeps budgeted ones, and adds what is not assigned', () => {
    expect(r.rows.map((x) => `${x.name} ${x.revenue} ${x.expenses} ${x.profit} ${x.margin}`)).toEqual([
      'Sales 220000.00 75000.00 145000.00 65.9',
      'Research 0.00 0.00 0.00 null',
      'Operations 0.00 40000.00 -40000.00 null',
      'Not assigned 0.00 10000.00 -10000.00 null',
    ]);
    expect(r.totals).toEqual({ revenue: '220000.00', expenses: '125000.00', profit: '95000.00', margin: 43.2, unassignedExpenseShare: 8 });
  });

  it('gives each department its months, its spending trend and its share', () => {
    const sales = r.rows[0]!;
    expect(sales.months).toEqual([{ month: '2026-09', revenue: '100000.00', expenses: '30000.00', profit: '70000.00' }, { month: '2026-10', revenue: '120000.00', expenses: '45000.00', profit: '75000.00' }]);
    expect(sales.expenseTrend).toBe(50);
    expect(sales.expenseShare).toBe(60);
    expect(r.rows[2]!.expenseTrend).toBe(0);
    expect(r.rows[1]!.expenseTrend).toBeNull();
  });

  it('compares spending with the budget', () => {
    expect(r.rows.find((x) => x.id === 'd2')!.budget).toEqual({ amount: '45000.00', spent: '40000.00', remaining: '5000.00', usedPercent: 88.9, status: 'NEAR' });
    expect(r.rows.find((x) => x.id === 'd4')!.budget).toMatchObject({ remaining: '0.00', status: 'OVER', usedPercent: 120 });
    expect(r.rows[0]!.budget).toBeNull();
  });
});
