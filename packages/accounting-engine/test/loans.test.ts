import { describe, expect, it } from 'vitest';
import { checkLoanTerms, loanDueDate, loanInstallment, loanMaturity, loanSchedule, loanTotals, projectLoan } from '../src';

const terms = { principal: '1000000', annualRate: '9.5', months: 60, method: 'EMI' as const, disbursementDate: '2026-04-10', firstDueDate: '2026-05-05' };

describe('loans', () => {
  it('works out the EMI with the standard formula', () => {
    // 10 lakh at 9.5% for 5 years: EMI ₹21,001.86 (rounded half up).
    expect(loanInstallment('EMI', '1000000', '9.5', 60, 2).toFixed(2)).toBe('21001.86');
    expect(loanInstallment('EMI', '120000', '0', 12, 2).toFixed(2)).toBe('10000.00');
    expect(loanInstallment('EQUAL_PRINCIPAL', '100000', '12', 3, 2).toFixed(2)).toBe('33333.33');
  });

  it('builds a schedule that repays exactly, interest on the opening balance each month', () => {
    const rows = loanSchedule(terms, 2);
    expect(rows).toHaveLength(60);
    expect(rows[0]).toEqual({ no: 1, dueDate: '2026-05-05', opening: '1000000.00', interest: '7916.67', principal: '13085.19', payment: '21001.86', closing: '986914.81' });
    expect(rows[59]!.closing).toBe('0.00');
    expect(rows[59]!.dueDate).toBe('2031-04-05');
    const t = loanTotals(rows, 2);
    expect(t.principal).toBe('1000000.00');
    // The last installment absorbs rounding: within a rupee of the EMI.
    expect(Math.abs(+rows[59]!.payment - 21001.86)).toBeLessThan(1);
    expect(rows.slice(0, 59).every((r) => r.payment === '21001.86')).toBe(true);
    expect((+t.principal + +t.interest).toFixed(2)).toBe(t.payment);
  });

  it('repays equal principal with falling interest', () => {
    const rows = loanSchedule({ ...terms, principal: '100000', annualRate: '12', months: 3, method: 'EQUAL_PRINCIPAL' }, 2);
    expect(rows.map((r) => [r.interest, r.principal, r.payment])).toEqual([
      ['1000.00', '33333.33', '34333.33'],
      ['666.67', '33333.33', '34000.00'],
      ['333.33', '33333.34', '33666.67'],
    ]);
  });

  it('keeps the installment after a prepayment, so the term shortens', () => {
    const before = loanSchedule(terms, 2);
    const rows = projectLoan({ balance: '700000.00', annualRate: '9.5', method: 'EMI', installment: '21001.86', startNo: 13, firstDueDate: '2026-05-05', scale: 2 });
    expect(rows[0]!.no).toBe(13);
    expect(rows[0]!.dueDate).toBe('2027-05-05');
    expect(rows.length).toBeLessThan(before.length - 12);
    expect(rows.at(-1)!.closing).toBe('0.00');
    expect(+rows.at(-1)!.payment).toBeLessThanOrEqual(21001.86);
  });

  it('refuses an installment that does not cover the interest', () => {
    expect(() => projectLoan({ balance: '1000000', annualRate: '12', method: 'EMI', installment: '9000', startNo: 1, firstDueDate: '2026-05-05', scale: 2 })).toThrow(/does not cover the interest/);
  });

  it('keeps the day of the month, or the last day of a shorter month', () => {
    expect(loanDueDate('2026-01-31', 2)).toBe('2026-02-28');
    expect(loanDueDate('2026-01-31', 3)).toBe('2026-03-31');
    expect(loanDueDate('2026-11-15', 3)).toBe('2027-01-15');
  });

  it('splits what is owed into the next twelve months and later', () => {
    const rows = loanSchedule(terms, 2);
    const m = loanMaturity(rows, '2026-04-30', 2);
    expect(m.current).toBe(loanTotals(rows.slice(0, 12), 2).principal);
    expect(+m.current + +m.nonCurrent).toBeCloseTo(1000000, 2);
  });

  it('checks the terms', () => {
    expect(checkLoanTerms({ ...terms, principal: '0' })).toContain('The amount borrowed must be more than zero');
    expect(checkLoanTerms({ ...terms, annualRate: '120' })[0]).toMatch(/below 100/);
    expect(checkLoanTerms({ ...terms, months: 0 })[0]).toMatch(/1 to 480/);
    expect(checkLoanTerms({ ...terms, firstDueDate: '2026-04-01' })[0]).toMatch(/after the loan is taken/);
    expect(checkLoanTerms(terms)).toEqual([]);
  });
});
