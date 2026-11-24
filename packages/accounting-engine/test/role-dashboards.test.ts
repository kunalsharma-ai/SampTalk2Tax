import { describe, expect, it } from 'vitest';
import { adminAttention, agingByDueDate, biggestMovements, furthestOffPlan, projectHealth, sharePercent, cashHeadroom, concentrationBand, quarterChange, quarterlyTotals, rankAttentionItems } from '../src/role-dashboards';

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

  it('judges a project from its revenue, costs and dates', () => {
    expect(projectHealth({ revenue: '100000', cost: '70000', startDate: '2026-01-01', endDate: '2026-01-10', asOf: '2026-01-05' })).toEqual({ profit: '30000', margin: '30.0', health: 'HEALTHY', elapsedPercent: 50, daysLeft: 5, ended: false });
    expect(projectHealth({ revenue: '100000', cost: '95000', startDate: null, endDate: null, asOf: '2026-01-05' })).toMatchObject({ margin: '5.0', health: 'THIN', elapsedPercent: null });
    expect(projectHealth({ revenue: '100', cost: '150', startDate: '2025-01-01', endDate: '2025-12-31', asOf: '2026-01-05' })).toMatchObject({ profit: '-50', health: 'LOSS', elapsedPercent: 100, ended: true });
    expect(projectHealth({ revenue: '0', cost: '10', startDate: '2026-02-01', endDate: '2026-02-28', asOf: '2026-01-05' })).toMatchObject({ health: 'NO_REVENUE', margin: null, elapsedPercent: 0 });
    expect(projectHealth({ revenue: '0', cost: '0', startDate: null, endDate: null, asOf: '2026-01-05' }).health).toBe('NO_ACTIVITY');
  });

  it('lists what an administrator should look at, most urgent first', () => {
    const a = adminAttention({
      requireTwoStep: false,
      membersWithoutTwoStep: 3,
      adminsWithoutTwoStep: 1,
      expiredInvitations: 2,
      sso: { configured: true, enabled: true, verifiedDomains: 0 },
      integrations: [{ name: 'Email', configured: true, enabled: true, testStatus: 'FAILED' }, { name: 'AI', configured: false, enabled: false, testStatus: 'NOT_TESTED' }],
      usage: [{ name: 'AI requests', state: 'NEAR', percent: 85 }, { name: 'Uploads', state: 'OK', percent: 10 }],
    });
    expect(a.map((x) => [x.level, x.title])).toEqual([
      ['HIGH', 'Email connection failed its last test'],
      ['HIGH', 'Owners or admins without two-step sign-in'],
      ['MEDIUM', 'AI requests nearly used up'],
      ['MEDIUM', 'Single sign-on has no verified domain'],
      ['MEDIUM', 'Two-step sign-in is not required'],
      ['LOW', 'Invitations expired'],
    ]);
    expect(adminAttention({ requireTwoStep: true, membersWithoutTwoStep: 0, adminsWithoutTwoStep: 0, expiredInvitations: 0, sso: { configured: false, enabled: false, verifiedDomains: 0 }, integrations: [], usage: [] })).toEqual([]);
  });
});
