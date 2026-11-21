import { describe, expect, it } from 'vitest';
import { automaticCheckOutcome, CONTROL_LIBRARY, controlPeriodFor, controlStatus, dueControlPeriod, parseControlPeriod } from '../src';

describe('internal controls (AUDIT-008, AUDIT-013)', () => {
  it('works out monthly, fiscal-quarter and fiscal-year periods', () => {
    expect(controlPeriodFor('MONTHLY', '2026-11-21', 4)).toEqual({ key: '2026-11', label: 'Nov 2026', from: '2026-11-01', to: '2026-11-30' });
    expect(controlPeriodFor('QUARTERLY', '2026-11-21', 4)).toEqual({ key: '2026-Q3', label: 'Q3: Oct 2026 to Dec 2026', from: '2026-10-01', to: '2026-12-31' });
    expect(controlPeriodFor('QUARTERLY', '2027-02-10', 4)).toMatchObject({ key: '2026-Q4', from: '2027-01-01', to: '2027-03-31' });
    expect(controlPeriodFor('YEARLY', '2027-02-10', 4)).toMatchObject({ key: 'FY2026', from: '2026-04-01', to: '2027-03-31' });
    expect(controlPeriodFor('QUARTERLY', '2026-02-10', 1)).toMatchObject({ key: '2026-Q1', from: '2026-01-01', to: '2026-03-31' });
  });

  it('tests the latest period that has ended', () => {
    expect(dueControlPeriod('MONTHLY', '2026-11-21', 4).key).toBe('2026-10');
    expect(dueControlPeriod('MONTHLY', '2026-01-05', 4).key).toBe('2025-12');
    expect(dueControlPeriod('QUARTERLY', '2026-11-21', 4).key).toBe('2026-Q2');
    expect(dueControlPeriod('YEARLY', '2026-11-21', 4).key).toBe('FY2025');
  });

  it('reads a period key only when it is a real period of the frequency', () => {
    expect(parseControlPeriod('MONTHLY', '2026-10', 4)).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
    expect(parseControlPeriod('MONTHLY', '2026-13', 4)).toBeNull();
    expect(parseControlPeriod('QUARTERLY', '2026-Q4', 4)).toMatchObject({ from: '2027-01-01', to: '2027-03-31' });
    expect(parseControlPeriod('QUARTERLY', '2026-10', 4)).toBeNull();
    expect(parseControlPeriod('YEARLY', 'FY2026', 4)).toMatchObject({ from: '2026-04-01' });
  });

  it('is due until 15 days after the period, then overdue, unless tested', () => {
    const c = { active: true, frequency: 'MONTHLY' as const };
    expect(controlStatus(c, null, '2026-11-15', 4)).toBe('DUE');
    expect(controlStatus(c, null, '2026-11-16', 4)).toBe('OVERDUE');
    expect(controlStatus(c, 'PASS', '2026-11-21', 4)).toBe('PASSED');
    expect(controlStatus(c, 'FAIL', '2026-11-21', 4)).toBe('FAILED');
    expect(controlStatus({ ...c, active: false }, null, '2026-11-21', 4)).toBe('INACTIVE');
  });

  it('passes an automatic check only with no exceptions', () => {
    expect(automaticCheckOutcome('BANKS_RECONCILED', { items: 2, exceptions: [] })).toEqual({ result: 'PASS', summary: '2 bank accounts with postings checked; no exceptions.', exceptions: [] });
    expect(automaticCheckOutcome('PERIODS_LOCKED', { items: 7, exceptions: ['Oct 2026 is open'] })).toMatchObject({ result: 'FAIL', summary: '7 accounting periods that had ended checked; 1 exception.' });
  });

  it('starts with a library of controls, each with a unique id', () => {
    expect(new Set(CONTROL_LIBRARY.map((c) => c.id)).size).toBe(CONTROL_LIBRARY.length);
    expect(CONTROL_LIBRARY.filter((c) => c.check).length).toBe(4);
  });
});
