import { describe, expect, it } from 'vitest';
import { normaliseViewFilters, resolveView, viewFilterIssues } from '../src';

const range = (preset: string, today: string, fy = 4) => {
  const r = resolveView('income-statement', { dates: { preset: preset as never } }, today, fy);
  return [r.from, r.to];
};

describe('saved report views (RPT-028, RPT-029, RPT-037)', () => {
  it('resolves relative periods on the day the view is opened, by fiscal year', () => {
    expect(range('THIS_MONTH', '2026-11-21')).toEqual(['2026-11-01', '2026-11-21']);
    expect(range('LAST_MONTH', '2026-01-10')).toEqual(['2025-12-01', '2025-12-31']);
    expect(range('THIS_QUARTER', '2026-11-21')).toEqual(['2026-10-01', '2026-11-21']);
    expect(range('LAST_QUARTER', '2026-11-21')).toEqual(['2026-07-01', '2026-09-30']);
    expect(range('LAST_QUARTER', '2026-04-15')).toEqual(['2026-01-01', '2026-03-31']);
    expect(range('FY_TO_DATE', '2026-02-03')).toEqual(['2025-04-01', '2026-02-03']);
    expect(range('LAST_FY', '2026-11-21')).toEqual(['2025-04-01', '2026-03-31']);
    expect(range('LAST_FY', '2026-11-21', 1)).toEqual(['2025-01-01', '2025-12-31']);
    expect(range('THIS_QUARTER', '2026-02-28', 1)).toEqual(['2026-01-01', '2026-02-28']);
  });

  it('resolves dates for reports at one date', () => {
    const at = (preset: string, today: string) => resolveView('balance-sheet', { dates: { preset: preset as never, to: '2026-06-30' } }, today, 4).to;
    expect(['TODAY', 'END_OF_LAST_MONTH', 'END_OF_LAST_QUARTER', 'END_OF_LAST_FY', 'FIXED'].map((p) => at(p, '2026-11-21'))).toEqual(['2026-11-21', '2026-10-31', '2026-09-30', '2026-03-31', '2026-06-30']);
    expect(resolveView('balance-sheet', { dates: { preset: 'TODAY' } }, '2026-11-21', 4).from).toBeNull();
  });

  it('keeps fixed dates and the filters the report takes', () => {
    const f = { dates: { preset: 'FIXED' as const, from: '2026-04-01', to: '2026-06-30' }, basis: 'ACCRUAL' as const, departmentId: 'd1' };
    expect(resolveView('income-statement', f, '2026-11-21', 4)).toEqual({ from: '2026-04-01', to: '2026-06-30', basis: 'ACCRUAL', departmentId: 'd1', projectId: null });
    expect(normaliseViewFilters('income-statement', { dates: { preset: 'LAST_MONTH', from: '2020-01-01', to: '2020-01-31' }, projectId: '', basis: 'CASH' })).toEqual({ dates: { preset: 'LAST_MONTH', from: null, to: null }, basis: 'CASH' });
    expect(normaliseViewFilters('trial-balance', { dates: { preset: 'FIXED', from: '2026-01-01', to: '2026-03-31' } })).toEqual({ dates: { preset: 'FIXED', from: null, to: '2026-03-31' } });
  });

  it('says what is wrong with a view before it is saved', () => {
    expect(viewFilterIssues('balance-sheet', { dates: { preset: 'LAST_MONTH' } })).toEqual(['Choose one of the periods offered for the balance sheet']);
    expect(viewFilterIssues('income-statement', { dates: { preset: 'FIXED', from: '2026-07-01', to: '2026-06-30' } })).toEqual(['The start date must be on or before the end date']);
    expect(viewFilterIssues('income-statement', { dates: { preset: 'FIXED', from: '2026-02-30', to: '2026-06-30' } })).toEqual(['Give the start date']);
    expect(viewFilterIssues('balance-sheet', { dates: { preset: 'TODAY' }, departmentId: 'x' })).toEqual(['The balance sheet does not take a departmentId filter']);
    expect(viewFilterIssues('income-statement', { dates: { preset: 'LAST_FY' }, basis: 'MIXED' as never })).toEqual(['Basis is accrual or cash']);
    expect(viewFilterIssues('trial-balance', { dates: { preset: 'END_OF_LAST_MONTH' } })).toEqual([]);
  });
});
