import { describe, expect, it } from 'vitest';
import { baselineMonthFor, checkOutcome, evaluateOutcome, monthIsOver, searchTerms, suggestVerdict } from '../src/decisions';

describe('decision memory', () => {
  it('measures against the last full month before the decision and only months that are over', () => {
    expect(baselineMonthFor('2026-07-14')).toBe('2026-06');
    expect(baselineMonthFor('2026-01-01')).toBe('2025-12');
    expect(monthIsOver('2026-10', '2026-11-01')).toBe(true);
    expect(monthIsOver('2026-11', '2026-11-30')).toBe(false);
  });

  it('checks expected outcomes', () => {
    const ok = { kpi: 'grossMargin', comparator: 'AT_LEAST', target: '40', measureMonth: '2026-12' };
    expect(checkOutcome(ok, '2026-11-04')).toBeNull();
    expect(checkOutcome({ ...ok, kpi: 'happiness' }, '2026-11-04')).toMatch(/Unknown measure/);
    expect(checkOutcome({ ...ok, comparator: 'ABOUT' }, '2026-11-04')).toMatch(/at least or at most/);
    expect(checkOutcome({ ...ok, target: '4O' }, '2026-11-04')).toMatch(/number/);
    expect(checkOutcome({ ...ok, measureMonth: '2026-13' }, '2026-11-04')).toMatch(/YYYY-MM/);
    expect(checkOutcome({ ...ok, measureMonth: '2026-10' }, '2026-11-04')).toMatch(/before the decision/);
  });

  it('says what happened, with the change from before the decision', () => {
    const o = { kpi: 'grossMargin' as const, comparator: 'AT_LEAST' as const, target: '40', measureMonth: '2026-09' };
    expect(evaluateOutcome(o, '42.5', '35.0', '2026-11-04')).toEqual({ status: 'MET', change: '7.5', improved: true, explanation: 'Met: gross margin was 42.5% in Sep 2026, against 35.0% before the decision. Expected at least 40.0%.' });
    expect(evaluateOutcome(o, '38.0', '39.0', '2026-11-04')).toMatchObject({ status: 'MISSED', change: '-1.0', improved: false });
    expect(evaluateOutcome(o, null, '39.0', '2026-11-04')).toMatchObject({ status: 'NO_VALUE', change: null });
    expect(evaluateOutcome({ ...o, measureMonth: '2026-11' }, '50', '39.0', '2026-11-04')).toMatchObject({ status: 'NOT_DUE', explanation: 'Expected: Gross margin of at least 40.0% in Nov 2026. Measured once Nov 2026 is over.' });
    // Lower is better for collection days: a fall is an improvement.
    const dso = { kpi: 'dso' as const, comparator: 'AT_MOST' as const, target: '45', measureMonth: '2026-09' };
    expect(evaluateOutcome(dso, '41.2', '58.0', '2026-11-04')).toMatchObject({ status: 'MET', change: '-16.8', improved: true });
    // Money uses the caller's formatter.
    const rev = { kpi: 'revenue' as const, comparator: 'AT_LEAST' as const, target: '500000', measureMonth: '2026-09' };
    expect(evaluateOutcome(rev, '480000.00', null, '2026-11-04', (v) => `₹${v}`).explanation).toBe('Missed: revenue was ₹480000.00 in Sep 2026. Expected at least ₹500000.');
  });

  it('suggests a verdict from the measured outcomes only', () => {
    expect(suggestVerdict([{ status: 'NOT_DUE' }, { status: 'NO_VALUE' }])).toBeNull();
    expect(suggestVerdict([{ status: 'MET' }, { status: 'NOT_DUE' }])).toBe('WORKED');
    expect(suggestVerdict([{ status: 'MET' }, { status: 'MISSED' }])).toBe('PARTLY');
    expect(suggestVerdict([{ status: 'MISSED' }])).toBe('DID_NOT_WORK');
  });

  it('splits a search into words', () => {
    expect(searchTerms('  Price RISE, 5% a ')).toEqual(['price', 'rise', '5%']);
  });
});
