import { describe, expect, it } from 'vitest';
import { contractCovers, contractInstant, contractLimits, contractProblems } from '../src';

const good = { reference: 'ENT/2026/014', interval: 'ANNUAL' as const, price: '250000', startsOn: '2026-12-01', endsOn: '2028-12-01', limits: { members: 200 } };

describe('enterprise contracts', () => {
  it('checks a contract before it is saved', () => {
    expect(contractProblems(good)).toEqual([]);
    expect(contractProblems({ reference: 'x', interval: 'WEEKLY' as never, price: '0', startsOn: '2026-02-30', endsOn: '2026-01-01', limits: { seats: 3, members: -1 } as never })).toEqual([
      'A contract reference is 3 to 40 letters, digits or / _ . -',
      'Billing is monthly or annual',
      'The price must be more than zero, with at most 2 decimals',
      'The start is a date written YYYY-MM-DD',
      'seats is not a plan limit',
      'members must be a whole number, zero or more',
    ]);
    expect(contractProblems({ ...good, endsOn: '2026-12-01' })).toEqual(['The term ends after it starts']);
  });

  it('runs from its start date to the day before its end date, India time', () => {
    const c = { startsOn: contractInstant('2026-12-01'), endsOn: contractInstant('2028-12-01') };
    expect(c.startsOn.toISOString()).toBe('2026-11-30T18:30:00.000Z');
    expect(contractCovers(c, new Date('2026-11-30T18:29:59Z'))).toBe(false);
    expect(contractCovers(c, new Date('2027-06-01T00:00:00Z'))).toBe(true);
    expect(contractCovers(c, contractInstant('2028-12-01'))).toBe(false);
  });

  it('puts its limits in place of the plan’s', () => {
    expect(contractLimits({ members: 50, aiCreditsPerMonth: 5000, documentUploadsPerMonth: null }, { members: 200, aiCreditsPerMonth: 20000 })).toEqual({ members: 200, aiCreditsPerMonth: 20000, documentUploadsPerMonth: null });
    expect(contractLimits({ members: 50, aiCreditsPerMonth: 5000, documentUploadsPerMonth: null }, null)).toEqual({ members: 50, aiCreditsPerMonth: 5000, documentUploadsPerMonth: null });
  });
});
