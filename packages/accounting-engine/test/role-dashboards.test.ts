import { describe, expect, it } from 'vitest';
import { agingByDueDate, biggestMovements, furthestOffPlan, sharePercent, cashHeadroom, concentrationBand, quarterChange, quarterlyTotals, rankAttentionItems } from '../src/role-dashboards';

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

  it('ages open amounts by days past due', () => {
    const r = agingByDueDate(
      [
        { open: '100', dueDate: '2026-11-30' },
        { open: '50', dueDate: '2026-11-01' },
        { open: '25', dueDate: '2026-10-15' },
        { open: '15', dueDate: '2026-09-15' },
        { open: '10', dueDate: '2026-01-01' },
      ],
      '2026-11-01',
    );
    expect(r.total).toBe('200.00');
    expect(r.overdue).toBe('50.00');
    expect(r.buckets.map((b) => `${b.bucket} ${b.amount} ${b.count} ${b.share}`)).toEqual(['CURRENT 150.00 2 75.0', 'DAYS_1_30 25.00 1 12.5', 'DAYS_31_60 15.00 1 7.5', 'DAYS_61_90 0.00 0 0.0', 'OVER_90 10.00 1 5.0']);
    expect(agingByDueDate([], '2026-11-01').buckets[0]!.share).toBeNull();
  });

  it('finds the figures that moved most, and whether each move is an improvement', () => {
    const r = biggestMovements(
      [
        { key: 'revenue', label: 'Revenue', value: '1100', previous: '1000', better: 'HIGHER' },
        { key: 'dso', label: 'DSO', value: '60', previous: '40', better: 'LOWER' },
        { key: 'margin', label: 'Margin', value: '-5', previous: '-10', better: 'HIGHER' },
        { key: 'flat', label: 'Flat', value: '7', previous: '7', better: 'HIGHER' },
        { key: 'none', label: 'None', value: '7', previous: null, better: 'HIGHER' },
        { key: 'zero', label: 'Zero', value: '7', previous: '0', better: 'HIGHER' },
      ],
      3,
    );
    expect(r).toEqual([
      { key: 'dso', label: 'DSO', value: '60', previous: '40', changePercent: '50.0', improved: false },
      { key: 'margin', label: 'Margin', value: '-5', previous: '-10', changePercent: '50.0', improved: true },
      { key: 'revenue', label: 'Revenue', value: '1100', previous: '1000', changePercent: '10.0', improved: true },
    ]);
    expect(biggestMovements([{ key: 'f', label: 'F', value: '7', previous: '7', better: 'LOWER' }])[0]).toMatchObject({ changePercent: '0.0', improved: null });
  });

  it('works out a share in percent', () => {
    expect(sharePercent('25', '200')).toBe('12.5');
    expect(sharePercent('1', '3')).toBe('33.3');
    expect(sharePercent('1', '0')).toBeNull();
    expect(sharePercent(null, '10')).toBeNull();
  });

  it('puts the accounts furthest off plan first, unfavourable before favourable', () => {
    const f = (variance: string | null, favourable: boolean | null) => ({ budget: '100', actual: variance === null ? null : '1', variance, percent: null, favourable });
    const r = furthestOffPlan([
      { code: '4100', yearToDate: f('-50', false) },
      { code: '6100', yearToDate: f('80', false) },
      { code: '6200', yearToDate: f('-200', true) },
      { code: '6300', yearToDate: f('0', true) },
      { code: '6400', yearToDate: f(null, null) },
      { code: '6500', yearToDate: f('80', false) },
    ]);
    expect(r.map((x) => x.code)).toEqual(['6100', '6500', '4100', '6200']);
  });
});
