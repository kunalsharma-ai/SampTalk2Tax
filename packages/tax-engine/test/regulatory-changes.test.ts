import { describe, expect, it } from 'vitest';
import { KNOWN_CHANGES, regulatoryWatch, ruleSets } from '../src';

describe('regulatory change monitoring', () => {
  it('lists every rule set with a valid checked date and unique keys', () => {
    const r = ruleSets();
    expect(new Set(r.map((x) => x.key)).size).toBe(r.length);
    for (const x of r) expect(x.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Set(KNOWN_CHANGES.map((c) => c.key)).size).toBe(KNOWN_CHANGES.length);
  });

  it("shows a country's changes by timing, with what was dealt with, and flags old rules", () => {
    const w = regulatoryWatch({
      country: 'DE',
      today: '2026-11-24',
      acknowledgements: [{ changeKey: 'DE-EINVOICE-ISSUE-2027', note: 'Sending XRechnung from our bank', by: 'Synthetic Owner', at: '2026-11-20T10:00:00.000Z' }],
      rateChanges: [
        { taxRateId: 'a', name: 'Standard 19%', from: '19', to: '20', effectiveFrom: '2027-01-01', reason: 'Synthetic change' },
        { taxRateId: 'b', name: 'Old', from: '7', to: '5', effectiveFrom: '2026-01-01', reason: 'Already in force' },
      ],
      rules: [
        { key: 'old', title: 'Old rules', countries: ['DE'], checkedOn: '2026-01-01', page: null },
        { key: 'new', title: 'New rules', countries: [], checkedOn: '2026-11-01', page: null },
        { key: 'other', title: 'Other country', countries: ['IN'], checkedOn: '2020-01-01', page: null },
      ],
    });
    expect(w.changes.map((c) => [c.key, c.timing, c.status, c.inDays])).toEqual([
      ['DE-EINVOICE-RECEIVE-2025', 'IN_FORCE', 'IN_FORCE', -692],
      ['DE-EINVOICE-ISSUE-2027', 'UPCOMING', 'DEALT_WITH', 38],
      ['DE-EINVOICE-ALL-2028', 'UPCOMING', 'TO_REVIEW', 403],
    ]);
    expect(w.rules.map((r) => [r.key, r.stale])).toEqual([
      ['old', true],
      ['new', false],
    ]);
    expect(w.rateChanges.map((r) => r.taxRateId)).toEqual(['a']);
    expect(w.summary).toEqual({ toReview: 1, upcoming: 2, staleRules: 1, scheduledRateChanges: 1 });
  });

  it('keeps a recent change open until it is dealt with', () => {
    const w = regulatoryWatch({ country: 'US', today: '2026-02-01', acknowledgements: [], rateChanges: [] });
    expect(w.changes.find((c) => c.key === 'US-1099-THRESHOLD-2026')).toMatchObject({ timing: 'RECENT', status: 'TO_REVIEW', inDays: -31 });
    expect(w.rules.some((r) => r.key === 'us-1099')).toBe(true);
    expect(w.rules.some((r) => r.key === 'country:IN')).toBe(false);
  });
});
