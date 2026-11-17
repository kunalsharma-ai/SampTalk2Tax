import { describe, expect, it } from 'vitest';
import { DEFAULT_OPPORTUNITY_SETTINGS, findOpportunities, TwinError, type OpportunityInput, type TwinActualMonth } from '../src';

// Revenue 1,00,000 a month, cost of sales 40,000, payroll 30,000, other costs 10,000; no tax.
const month = (m: string): TwinActualMonth => ({ month: m, revenue: '100000.00', otherIncome: '0.00', costOfSales: '40000.00', payroll: '30000.00', otherOperating: '10000.00', depreciation: '0.00', interest: '0.00', incomeTax: '0.00', otherExpenses: '0.00', cash: '500000.00', receivables: '100000.00', payables: '50000.00' });
const months = ['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
const z = () => Array(12).fill('0.00') as string[];
const set = (xs: string[], at: number[], v: string) => xs.map((x, i) => (at.includes(i) ? v : x));
const all = Array.from({ length: 12 }, (_, i) => i);

const base: OpportunityInput = {
  baseline: { months: [month('2026-07'), month('2026-08'), month('2026-09')], currency: 'INR', scale: 2 },
  horizonMonths: 6,
  months,
  margins: months.map((_, i) => ({ revenue: '100000.00', costOfSales: i < 9 ? '40000.00' : '40000.00' })),
  lines: [
    { accountId: 'l1', code: '4100', name: 'Freight' },
    { accountId: 'l2', code: '4200', name: 'Warehousing' },
  ],
  customers: [
    // Bought in months 1-6 (18,000 over the nine earlier months), nothing in the last three.
    { contactId: 'c1', name: 'Lapsed Ltd', byMonth: set(z(), [0, 1, 2, 3, 4, 5], '3000.00'), byLine: { l1: '18000.00' } },
    // Bought once only: not a regular customer.
    { contactId: 'c2', name: 'One-off Co', byMonth: set(z(), [2], '5000.00'), byLine: { l1: '5000.00' } },
    // Warehousing buyers (3), all active.
    { contactId: 'c3', name: 'Alpha', byMonth: set(z(), all, '2000.00'), byLine: { l1: '12000.00', l2: '12000.00' } },
    { contactId: 'c4', name: 'Beta', byMonth: set(z(), all, '2000.00'), byLine: { l1: '12000.00', l2: '12000.00' } },
    { contactId: 'c5', name: 'Gamma', byMonth: set(z(), all, '2000.00'), byLine: { l1: '12000.00', l2: '12000.00' } },
    // Active, freight only: the cross-sell targets.
    { contactId: 'c6', name: 'Delta', byMonth: set(z(), all, '5000.00'), byLine: { l1: '60000.00' } },
    { contactId: 'c7', name: 'Epsilon', byMonth: set(z(), all, '1000.00'), byLine: { l1: '12000.00' } },
  ],
  segments: [],
  settings: DEFAULT_OPPORTUNITY_SETTINGS,
};

describe('opportunity intelligence', () => {
  it('finds lapsed customers and sizes winning a share back', () => {
    const r = findOpportunities(base);
    const o = r.opportunities.find((x) => x.kind === 'WIN_BACK')!;
    expect(o.title).toBe('Win back 1 lapsed customer');
    expect(o.finding).toBe('1 customer bought in at least two months from Oct 2025 to Jun 2026, INR 2000.00 a month on average over those nine months, and nothing from Jul 2026 to Sep 2026.');
    expect(o.evidence.rows).toEqual([['Lapsed Ltd', '6', 'Mar 2026', 'INR 18000.00']]);
    // 25% of 2,000 a month.
    expect(o.changes).toEqual([{ lever: 'NEW_CUSTOMER', label: 'Win back: 1 lapsed customer', monthlyRevenue: '500.00', rampMonths: 3, month: 2 }]);
    expect(o.confidence).toBe('LOW');
    // Month 2: 166.67, month 3: 333.33, months 4-6: 500 → 2,000 of revenue at a 60% gross margin.
    expect(o.effect.revenue).toBe('2000.00');
    expect(o.effect.netProfit).toBe('1200.00');
  });

  it('offers a line three customers buy to active customers who do not', () => {
    const r = findOpportunities(base);
    const o = r.opportunities.find((x) => x.kind === 'CROSS_SELL')!;
    expect(o.key).toBe('CROSS_SELL:l2');
    expect(o.title).toBe('Sell Warehousing to 2 more customers');
    // 36,000 over 12 months from 3 buyers = 1,000 a month each; 15% of 2 targets.
    expect(o.finding).toBe('3 customers buy 4200 Warehousing, INR 1000.00 a month each on average. 2 customers who bought in the last six months do not.');
    expect(o.evidence.rows).toEqual([['Delta', 'INR 60000.00'], ['Epsilon', 'INR 12000.00']]);
    expect(o.changes[0]).toMatchObject({ monthlyRevenue: '300.00', rampMonths: 4 });
    expect(r.checks.find((c) => c.kind === 'CROSS_SELL')!.found).toBe(1);
  });

  it('grows the best-margin segment at its own margin, and needs two to compare', () => {
    const r = findOpportunities({
      ...base,
      segments: [
        { kind: 'DEPARTMENT', id: 'd1', code: 'SALES', name: 'Sales', revenue: '240000.00', costs: '180000.00' },
        { kind: 'DEPARTMENT', id: 'd2', code: 'EXPORT', name: 'Export', revenue: '120000.00', costs: '60000.00' },
        { kind: 'PROJECT', id: 'p1', code: 'P1', name: 'Only project', revenue: '50000.00', costs: '1000.00' },
      ],
    });
    const o = r.opportunities.find((x) => x.kind === 'GROW_SEGMENT')!;
    expect(o.title).toBe('Grow Export');
    expect(o.finding).toBe('EXPORT Export earns a 50.0% margin on INR 10000.00 of sales a month, the best of 2 departments with sales.');
    expect(o.changes).toEqual([{ lever: 'NEW_CUSTOMER', label: 'Grow: Export', monthlyRevenue: '1000.00', rampMonths: 6, month: 2, costOfSalesPercent: '50.00' }]);
    expect(o.evidence.rows.map((x) => x[0])).toEqual(['EXPORT Export', 'SALES Sales']);
    expect(findOpportunities(base).checks.find((c) => c.kind === 'GROW_SEGMENT')!.note).toBe('No sales are tagged to departments or projects.');
  });

  it('restores a slipped gross margin with the price rise it takes', () => {
    const r = findOpportunities({ ...base, margins: months.map((_, i) => ({ revenue: '100000.00', costOfSales: i < 9 ? '40000.00' : '46000.00' })) });
    const o = r.opportunities.find((x) => x.kind === 'MARGIN_RECOVERY')!;
    expect(o.title).toBe('Restore gross margin to 60.0%');
    // Cost share 46% must fall to 40%: prices up 0.46/0.40 − 1 = 15%.
    expect(o.changes).toEqual([{ lever: 'PRICE_CHANGE', pricePercent: '15.00', volumePercent: '0', month: 2 }]);
    expect(Number(o.effect.netProfit)).toBeGreaterThan(0);
    expect(findOpportunities(base).checks.find((c) => c.kind === 'MARGIN_RECOVERY')!.note).toBe('Gross margin is 60.0% in the last three months against 60.0% before: not down by 2 points or more.');
  });

  it('ranks by profit, explains empty checks, and checks its settings', () => {
    const r = findOpportunities(base);
    const profits = r.opportunities.map((o) => Number(o.effect.netProfit));
    expect(profits).toEqual([...profits].sort((a, b) => b - a));
    expect(r.summary).toMatch(/^2 opportunities found in the books from Oct 2025 to Sep 2026/);
    const none = findOpportunities({ ...base, customers: [], lines: [] });
    expect(none.opportunities).toEqual([]);
    expect(none.checks.map((c) => c.found)).toEqual([0, 0, 0, 0]);
    expect(none.summary).toBe('No growth opportunities found in the books from Oct 2025 to Sep 2026. What was checked is listed below.');
    try {
      findOpportunities({ ...base, settings: { ...DEFAULT_OPPORTUNITY_SETTINGS, winBackRatePercent: '0' } });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TwinError);
      expect((e as TwinError).issues).toEqual(['Lapsed customers’ sales won back (%) must be a number above 0 and at most 100']);
    }
  });
});
