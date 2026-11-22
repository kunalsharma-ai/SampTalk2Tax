import { describe, expect, it } from 'vitest';
import { claimBudgetImpact, departmentBudgets, yearElapsed } from '../src/department-budgets';

const FY = { fyStart: '2026-04-01', fyEnd: '2027-03-31' };

describe('department budgets', () => {
  it('counts the share of the year gone', () => {
    expect(yearElapsed(FY.fyStart, FY.fyEnd, '2026-09-30')).toEqual({ elapsed: 183, total: 365 });
    expect(yearElapsed(FY.fyStart, FY.fyEnd, '2026-03-01')).toEqual({ elapsed: 0, total: 365 });
    expect(yearElapsed(FY.fyStart, FY.fyEnd, '2027-05-01')).toEqual({ elapsed: 365, total: 365 });
  });

  it('marks each department on track, at risk or over, worst first', () => {
    const r = departmentBudgets(
      [
        { departmentId: 'a', code: 'D01', name: 'Sales', budget: '120000.00', actual: '40000.00', committed: '5000.00' },
        { departmentId: 'b', code: 'D02', name: 'Field', budget: '100000.00', actual: '70000.00', committed: '0' },
        { departmentId: 'c', code: 'D03', name: 'Admin', budget: '20000.00', actual: '21000.00', committed: '0' },
        { departmentId: 'd', code: 'D04', name: 'Labs', budget: '50000.00', actual: '10000.00', committed: '45000.00' },
        { departmentId: 'e', code: 'D05', name: 'Legal', budget: null, actual: '3000.00', committed: '0' },
      ],
      { ...FY, asOf: '2026-09-30' },
    );
    expect(r.rows.map((x) => [x.name, x.status])).toEqual([['Admin', 'OVER'], ['Field', 'AT_RISK'], ['Labs', 'AT_RISK'], ['Sales', 'ON_TRACK'], ['Legal', 'NO_BUDGET']]);
    const sales = r.rows.find((x) => x.name === 'Sales')!;
    expect(sales).toMatchObject({ expectedByNow: '60164.38', usedPercent: '33.3', remaining: '75000.00', projected: '79781.42' });
    expect(r.rows.find((x) => x.name === 'Field')!.reason).toBe('At this pace it spends 139617.49 by the year end, 39617.49 over');
    expect(r.rows.find((x) => x.name === 'Labs')!.reason).toBe('Claims waiting for approval would take it 5000.00 over');
    expect(r.rows.find((x) => x.name === 'Admin')!.reason).toBe('Spent 1000.00 more than the budget');
    expect(r.totals).toEqual({ budget: '290000.00', actual: '144000.00', committed: '50000.00' });
  });

  it('shows what approving a claim does to each department', () => {
    const impact = claimBudgetImpact(
      [
        { departmentId: 'a', name: 'Sales', budget: '10000.00', actual: '8000.00', committedOthers: '1000.00' },
        { departmentId: 'b', name: 'Field', budget: null, actual: '0', committedOthers: '0' },
        { departmentId: 'c', name: 'Admin', budget: '5000.00', actual: '0', committedOthers: '0' },
      ],
      new Map([['a', '1500.00'], ['b', '200.00']]),
    );
    expect(impact).toEqual([
      { departmentId: 'a', name: 'Sales', amount: '1500.00', budget: '10000.00', remainingBefore: '1000.00', remainingAfter: '-500.00', takesOver: true },
      { departmentId: 'b', name: 'Field', amount: '200.00', budget: null, remainingBefore: null, remainingAfter: null, takesOver: false },
    ]);
  });
});
