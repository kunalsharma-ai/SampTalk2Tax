import { describe, expect, it } from 'vitest';
import { expenseReport, type ExpenseReportLine } from '../src';

const line = (p: Partial<ExpenseReportLine>): ExpenseReportLine => ({ claimId: 'c1', claimantId: 'asha', status: 'APPROVED', date: '2026-10-05', accountId: 'travel', merchant: null, net: '100', tax: '0', amount: '100', ...p });

describe('expense report', () => {
  const lines = [
    line({ merchant: 'Uber', net: '400', amount: '400' }),
    line({ accountId: 'meals', merchant: ' uber  ', net: '200', tax: '10', amount: '210' }),
    line({ claimId: 'c2', claimantId: 'ravi', status: 'REIMBURSED', date: '2026-11-02', merchant: 'IndiGo', net: '5000', tax: '250', amount: '5250' }),
    line({ claimId: 'c3', claimantId: 'ravi', date: '2026-09-30', amount: '999', net: '999' }),
  ];
  const r = expenseReport(lines, '2026-10-01', '2026-11-30');
  const flat = (gs: { key: string; total: { toFixed: (n: number) => string }; share: string; claims: number }[]) => gs.map((g) => [g.key, g.total.toFixed(2), g.share, g.claims]);

  it('leaves out lines dated outside the range and adds up the rest', () => {
    expect([r.totals.claims, r.totals.lines, r.totals.net.toFixed(2), r.totals.tax.toFixed(2), r.totals.total.toFixed(2)]).toEqual([2, 3, '5600.00', '260.00', '5860.00']);
  });

  it('groups by category, person and status, largest first, with shares', () => {
    expect(flat(r.byCategory)).toEqual([['travel', '5650.00', '96.4', 2], ['meals', '210.00', '3.6', 1]]);
    expect(flat(r.byPerson)).toEqual([['ravi', '5250.00', '89.6', 1], ['asha', '610.00', '10.4', 1]]);
    expect(flat(r.byStatus)).toEqual([['REIMBURSED', '5250.00', '89.6', 1], ['APPROVED', '610.00', '10.4', 1]]);
  });

  it('keeps months in order and merges merchants written differently', () => {
    expect(flat(r.byMonth)).toEqual([['2026-10', '610.00', '10.4', 1], ['2026-11', '5250.00', '89.6', 1]]);
    expect(flat(r.byMerchant)).toEqual([['IndiGo', '5250.00', '89.6', 1], ['Uber', '610.00', '10.4', 1]]);
  });

  it('is empty, not broken, when nothing falls in the range', () => {
    const e = expenseReport(lines, '2025-01-01', '2025-01-31');
    expect([e.totals.total.toFixed(2), e.byCategory.length, e.byMerchant.length]).toEqual(['0.00', 0, 0]);
  });
});
