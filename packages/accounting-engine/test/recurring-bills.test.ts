import { describe, expect, it } from 'vitest';
import { fillPlaceholders, recurringBillRef, recurringReferenceIssue, runDate } from '../src';

describe('recurring bills', () => {
  it('numbers recurring bills RB-', () => {
    expect(recurringBillRef(7)).toBe('RB-0007');
  });

  it('needs a reference that changes from run to run', () => {
    expect(recurringReferenceIssue(null, 'MONTHLY')).toBeNull();
    expect(recurringReferenceIssue('  ', 'MONTHLY')).toBeNull();
    expect(recurringReferenceIssue('Rent {month}', 'MONTHLY')).toBeNull();
    expect(recurringReferenceIssue('AMC {quarter}', 'QUARTERLY')).toBeNull();
    expect(recurringReferenceIssue('Licence {fy}', 'YEARLY')).toBeNull();
    expect(recurringReferenceIssue('Rent', 'MONTHLY')).toMatch(/would repeat/);
    // {quarter} repeats three times in a year of monthly runs; {fy} repeats for quarterly runs.
    expect(recurringReferenceIssue('Rent {quarter}', 'MONTHLY')).toMatch(/such as \{month\}/);
    expect(recurringReferenceIssue('AMC {fy}', 'QUARTERLY')).toMatch(/would repeat/);
  });

  it('gives each monthly run its own reference', () => {
    const s = { start: '2026-04-05', frequency: 'MONTHLY' as const, monthEnd: false };
    const refs = [1, 2, 3].map((n) => fillPlaceholders('Rent {month}', runDate(s, n), 4));
    expect(refs).toEqual(['Rent April 2026', 'Rent May 2026', 'Rent June 2026']);
  });
});
