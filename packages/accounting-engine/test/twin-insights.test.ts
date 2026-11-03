import { describe, expect, it } from 'vitest';
import { dec, runTwin, twinInsights, type TwinActualMonth, type TwinBaseline } from '../src';

const month = (m: string): TwinActualMonth => ({
  month: m,
  revenue: '100000.00',
  otherIncome: '0.00',
  costOfSales: '40000.00',
  payroll: '30000.00',
  otherOperating: '10000.00',
  depreciation: '0.00',
  interest: '0.00',
  incomeTax: '0.00',
  otherExpenses: '0.00',
  cash: '500000.00',
  receivables: '100000.00',
  payables: '50000.00',
});
const baseline: TwinBaseline = { months: [month('2026-07'), month('2026-08'), month('2026-09')], currency: 'INR', scale: 2 };

describe('twin insights', () => {
  it('measures each change against the scenario without it, and adds them up by department', () => {
    const drivers = [
      { kind: 'HIRING' as const, count: 2, monthlyCostPerHead: '50000', fromMonth: 1, departmentId: 'sales' },
      { kind: 'EXPENSE_CHANGE' as const, target: 'OPERATING' as const, monthlyAmount: '-5000', fromMonth: 1, departmentId: 'ops' },
      { kind: 'EXPENSE_CHANGE' as const, target: 'OPERATING' as const, monthlyAmount: '-1000', fromMonth: 1, departmentId: 'ops' },
    ];
    const r = twinInsights({ baseline, drivers, horizonMonths: 6 });
    expect(r.impacts.map((x) => x.netProfit)).toEqual(['-600000.00', '30000.00', '6000.00']);
    expect(r.impacts[0]).toMatchObject({ kind: 'HIRING', departmentId: 'sales', closingCash: '-600000.00' });
    expect(r.interaction.netProfit).toBe('0.00');
    expect(r.total.netProfit).toBe('-564000.00');
    expect(r.departments).toEqual([
      { departmentId: 'sales', changes: [0], netProfit: '-600000.00', closingCash: '-600000.00' },
      { departmentId: 'ops', changes: [1, 2], netProfit: '36000.00', closingCash: r.departments[1]!.closingCash },
    ]);
  });

  it('reports interaction when changes compound each other', () => {
    const drivers = [
      { kind: 'REVENUE_GROWTH' as const, percentPerMonth: '10', fromMonth: 1 },
      { kind: 'PRICE_CHANGE' as const, pricePercent: '10', volumePercent: '0', fromMonth: 1 },
    ];
    const r = twinInsights({ baseline, drivers, horizonMonths: 3 });
    // Each impact includes the cross term (growth on the higher price), so the sum overstates it.
    expect(dec(r.interaction.netProfit).lt(0)).toBe(true);
    const sum = r.impacts.reduce((a, x) => a.plus(x.netProfit), dec(r.interaction.netProfit));
    expect(sum.toFixed(2)).toBe(r.total.netProfit);
    expect(r.departments).toEqual([{ departmentId: null, changes: [0, 1], netProfit: sum.minus(r.interaction.netProfit).toFixed(2), closingCash: expect.any(String) }]);
  });

  it('suggests remedies with their measured effect when cash runs out', () => {
    const hire = { kind: 'HIRING' as const, count: 10, monthlyCostPerHead: '50000', fromMonth: 2 };
    const full = runTwin({ baseline, drivers: [hire], horizonMonths: 12 });
    expect(full.projection.cashNegativeFrom).not.toBeNull();
    const r = twinInsights({ baseline, drivers: [hire], horizonMonths: 12 }, full);
    const codes = r.suggestions.map((s) => s.code);
    expect(codes).toEqual(['FUND_GAP', 'COLLECT_SOONER', 'PRICE_RISE', 'DELAY_LARGEST_COST']);
    const fund = r.suggestions[0]!;
    expect(fund.drivers[0]).toMatchObject({ kind: 'NEW_DEBT', annualRatePercent: '11', termMonths: 36 });
    expect(dec(fund.effect.minimumCash).gt(0)).toBe(true);
    expect(dec(fund.effect.netProfit).lt(0)).toBe(true); // interest
    const delay = r.suggestions[3]!;
    expect(delay).toMatchObject({ replaces: 0, drivers: [{ ...hire, fromMonth: 5 }] });
    // Three fewer months of 5,00,000 payroll.
    expect(delay.effect.netProfit).toBe('1500000.00');
    const collect = r.suggestions[1]!;
    // 10 days of 1,00,000 monthly revenue.
    expect(collect.effect.closingCash).toBe('33333.33');
  });

  it('suggests including tax only for a profitable Indian scenario without a rate', () => {
    expect(twinInsights({ baseline, drivers: [], horizonMonths: 12 }).suggestions.map((s) => s.code)).toEqual(['COLLECT_SOONER', 'SET_TAX_RATE']);
    const tax = twinInsights({ baseline, drivers: [], horizonMonths: 12 }).suggestions[1]!;
    // 25.17% of 20,000 a month for 12 months.
    expect(tax.effect.netProfit).toBe('-60408.00');
    expect(twinInsights({ baseline: { ...baseline, currency: 'AED' }, drivers: [], horizonMonths: 12 }).suggestions.map((s) => s.code)).toEqual(['COLLECT_SOONER']);
  });
});
