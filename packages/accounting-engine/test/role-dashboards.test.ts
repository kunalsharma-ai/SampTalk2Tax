import { describe, expect, it } from 'vitest';
import { cashHeadroom, concentrationBand, quarterChange, quarterlyTotals, rankAttentionItems } from '../src/role-dashboards';

describe('role dashboards', () => {
  it('ranks what needs attention by level, then amount, then title', () => {
    const r = rankAttentionItems(
      [
        { area: 'A', title: 'b', detail: '', level: 'LOW', href: '/x', amount: '900' },
        { area: 'A', title: 'z', detail: '', level: 'HIGH', href: '/x', amount: '10' },
        { area: 'A', title: 'y', detail: '', level: 'HIGH', href: '/x', amount: '500' },
        { area: 'A', title: 'a', detail: '', level: 'HIGH', href: '/x', amount: '500' },
        { area: 'A', title: 'm', detail: '', level: 'MEDIUM', href: '/x' },
      ],
      4,
    );
    expect(r.map((i) => i.title)).toEqual(['a', 'y', 'z', 'm']);
  });

  it('rolls months into calendar quarters', () => {
    const q = quarterlyTotals(
      [
        { month: '2026-05', value: '100' },
        { month: '2026-06', value: '50.5' },
        { month: '2026-07', value: '10' },
        { month: '2026-08', value: null },
        { month: '2026-09', value: '20' },
        { month: '2026-10', value: null },
      ],
      2,
    );
    expect(q).toEqual([
      { quarter: '2026-Q2', value: '150.50', months: 2 },
      { quarter: '2026-Q3', value: '30.00', months: 2 },
      { quarter: '2026-Q4', value: null, months: 0 },
    ]);
    expect(quarterChange('150.50', '30.00')).toBe('-80.1');
    expect(quarterChange('0', '30')).toBeNull();
    expect(quarterChange(null, '30')).toBeNull();
  });

  it('bands concentration without naming anyone', () => {
    expect(concentrationBand(null)).toBe('NONE');
    expect(concentrationBand('14.9')).toBe('LOW');
    expect(concentrationBand(15)).toBe('MODERATE');
    expect(concentrationBand('25')).toBe('HIGH');
  });

  it('measures headroom above the cash buffer', () => {
    expect(cashHeadroom({ asOf: '2026-11-01', lowest: { date: '2026-11-21', amount: '4000' }, buffer: '5000' })).toEqual({ headroom: '-1000.00', breaks: true, lowestOn: '2026-11-21', daysToLowest: 20 });
    expect(cashHeadroom({ asOf: '2026-11-01', lowest: { date: '2026-11-01', amount: '6000' }, buffer: '0', scale: 0 }).headroom).toBe('6000');
  });
});
