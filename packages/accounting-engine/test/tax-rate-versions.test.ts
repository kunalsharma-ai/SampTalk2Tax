import { describe, expect, it } from 'vitest';
import { computeExpenseClaim, nextRateChange, rateEffectiveOn, rateTimeline, rateVersionIssues } from '../src';

const versions = [
  { effectiveFrom: '2025-09-22', rate: '5' },
  { effectiveFrom: '2026-04-01', rate: '12.5' },
];

describe('effective-dated tax rates', () => {
  it('uses the rate in force on the date', () => {
    expect(rateEffectiveOn('12', versions, '2025-09-21')).toBe('12');
    expect(rateEffectiveOn('12', versions, '2025-09-22')).toBe('5');
    expect(rateEffectiveOn('12', versions, '2026-03-31')).toBe('5');
    expect(rateEffectiveOn('12', versions, '2026-04-01')).toBe('12.5');
    expect(rateEffectiveOn('18.00', [], '2030-01-01')).toBe('18');
    expect(nextRateChange(versions, '2025-10-01')).toEqual({ effectiveFrom: '2026-04-01', rate: '12.5' });
    expect(nextRateChange(versions, '2026-04-01')).toBeNull();
  });

  it('lays out the history as past, current and scheduled', () => {
    expect(rateTimeline('12', versions, '2025-12-01')).toEqual([
      { version: 1, rate: '12', effectiveFrom: null, effectiveTo: '2025-09-21', state: 'PAST' },
      { version: 2, rate: '5', effectiveFrom: '2025-09-22', effectiveTo: '2026-03-31', state: 'CURRENT' },
      { version: 3, rate: '12.5', effectiveFrom: '2026-04-01', effectiveTo: null, state: 'SCHEDULED' },
    ]);
    expect(rateTimeline('18', [], '2025-12-01')).toEqual([{ version: 1, rate: '18', effectiveFrom: null, effectiveTo: null, state: 'CURRENT' }]);
  });

  it('only appends versions in date order, never reaching back past recorded use', () => {
    const base = { baseRate: '12', fixedAtZero: false, versions, usedOnOrAfter: 0 };
    expect(rateVersionIssues(base, { effectiveFrom: '2027-04-01', rate: '18' })).toEqual([]);
    expect(rateVersionIssues(base, { effectiveFrom: '2026-01-01', rate: '18' })).toEqual(['Versions are added in date order: the latest takes effect on 2026-04-01, so a new one must start after that']);
    expect(rateVersionIssues(base, { effectiveFrom: '2027-04-01', rate: '12.50' })).toEqual(['The rate is already 12.5% on 2027-04-01']);
    expect(rateVersionIssues(base, { effectiveFrom: '2027-04-01', rate: '101' })).toEqual(['A tax rate is between 0% and 100%']);
    expect(rateVersionIssues(base, { effectiveFrom: '2027-13-01', rate: '18' })[0]).toBe('The date it takes effect must be YYYY-MM-DD');
    expect(rateVersionIssues({ ...base, usedOnOrAfter: 2 }, { effectiveFrom: '2027-04-01', rate: '18' })).toEqual(['2 posted documents or claims use this rate on or after 2027-04-01; a change cannot reach back past them']);
    expect(rateVersionIssues({ ...base, fixedAtZero: true, versions: [] }, { effectiveFrom: '2027-04-01', rate: '5' })).toEqual(['Nil-rated, exempt and non-GST rates stay at 0%; create a new rate instead']);
  });

  it('works out each expense line at the rate in force on its date', () => {
    const rates = new Map([['t', { id: 't', name: 'VAT', rate: '10', accountId: 'tax', versions: [{ effectiveFrom: '2026-07-01', rate: '25' }] }]]);
    const claim = computeExpenseClaim(
      [
        { date: '2026-06-30', accountId: 'e', amount: '110.00', taxRateId: 't' },
        { date: '2026-07-01', accountId: 'e', amount: '125.00', taxRateId: 't' },
      ],
      'INR',
      rates,
    );
    expect(claim.lines.map((l) => [l.taxRate.toFixed(), l.taxAmount.toFixed(2)])).toEqual([['10', '10.00'], ['25', '25.00']]);
  });
});
