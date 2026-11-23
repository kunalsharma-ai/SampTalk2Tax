import { describe, expect, it } from 'vitest';
import { riskAreaScore, riskLevel, riskMonitor } from '../src';

describe('risk monitor', () => {
  it('scores an area from its findings, capped at 100', () => {
    expect(riskAreaScore({ high: 0, medium: 0, low: 0 })).toBe(0);
    expect(riskAreaScore({ high: 1, medium: 2, low: 3 })).toBe(54);
    expect(riskAreaScore({ high: 5, medium: 0, low: 0 })).toBe(100);
    expect([0, 1, 24, 25, 49, 50, 74, 75, 100].map(riskLevel)).toEqual(['CLEAR', 'LOW', 'LOW', 'ELEVATED', 'ELEVATED', 'HIGH', 'HIGH', 'SEVERE', 'SEVERE']);
  });

  it('leans the overall score on the worst active area and orders areas to look at', () => {
    const r = riskMonitor(
      [
        { area: 'PAYMENTS', high: 2, medium: 1, low: 0, active: true },
        { area: 'EXPENSES', high: 0, medium: 1, low: 2, active: true },
        { area: 'ALERTS', high: 0, medium: 0, low: 0, active: true },
        { area: 'BANK', high: 0, medium: 0, low: 0, active: false },
      ],
      { score: 30, areas: { PAYMENTS: 20, EXPENSES: 16 } },
    );
    // Payments 60, expenses 16, alerts 0: 60 × 0.6 + (76 ÷ 3) × 0.4 = 46.13 → 46.
    expect(r.score).toBe(46);
    expect(r.level).toBe('ELEVATED');
    expect(r.change).toBe(16);
    expect(r.areas.map((a) => [a.area, a.score, a.level, a.change])).toEqual([
      ['ALERTS', 0, 'CLEAR', null],
      ['PAYMENTS', 60, 'HIGH', 40],
      ['EXPENSES', 16, 'LOW', 0],
      ['BANK', 0, 'CLEAR', null],
      ['COMPLIANCE', 0, 'CLEAR', null],
      ['VENDORS', 0, 'CLEAR', null],
    ]);
    expect(r.focus).toEqual(['PAYMENTS', 'EXPENSES']);
  });

  it('is clear with nothing active', () => {
    expect(riskMonitor([], null)).toMatchObject({ score: 0, level: 'CLEAR', change: null, focus: [] });
  });
});
