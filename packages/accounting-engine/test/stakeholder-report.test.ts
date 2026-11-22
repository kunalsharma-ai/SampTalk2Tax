import { describe, expect, it } from 'vitest';
import { buildStakeholderReport, concentration, D, type MonthFigures, periodFor, reportMonthsNeeded, reportPeriod } from '../src';

const month = (m: string, x: Partial<Record<'revenue' | 'cos' | 'opex' | 'cash' | 'cashChange' | 'receivables' | 'payables', string>>): MonthFigures => {
  const z = () => new D(0);
  return {
    month: m,
    from: `${m}-01`,
    to: `${m}-28`,
    days: 28,
    operatingRevenue: new D(x.revenue ?? 0),
    otherIncome: z(),
    costOfSales: new D(x.cos ?? 0),
    operatingExpenses: new D(x.opex ?? 0),
    payroll: z(),
    depreciation: z(),
    interest: z(),
    incomeTax: z(),
    otherExpenses: z(),
    cash: new D(x.cash ?? 0),
    receivables: new D(x.receivables ?? 0),
    inventory: z(),
    otherCurrentAssets: z(),
    nonCurrentAssets: z(),
    payables: new D(x.payables ?? 0),
    otherCurrentLiabilities: z(),
    nonCurrentLiabilities: z(),
    cashChange: new D(x.cashChange ?? 0),
  };
};

describe('report periods', () => {
  it('reads fiscal quarters and years from April', () => {
    expect(reportPeriod('FY2027-Q1', 4)).toMatchObject({ label: 'Q1 FY 2026-27', months: ['2026-04', '2026-05', '2026-06'], from: '2026-04-01', to: '2026-06-30', prior: 'FY2026-Q4', lastYear: 'FY2026-Q1' });
    expect(reportPeriod('FY2027-Q4', 4)).toMatchObject({ months: ['2027-01', '2027-02', '2027-03'], prior: 'FY2027-Q3' });
    expect(reportPeriod('FY2027', 4)).toMatchObject({ label: 'FY 2026-27', kind: 'YEAR', from: '2026-04-01', to: '2027-03-31', prior: 'FY2026', lastYear: 'FY2026' });
    expect(reportPeriod('FY2026', 1)).toMatchObject({ label: 'FY 2026', from: '2026-01-01', to: '2026-12-31' });
    expect(reportPeriod('2026-Q1', 4)).toBeNull();
    expect(reportPeriod('FY2027-Q5', 4)).toBeNull();
  });

  it('finds the period of a date and the months to fetch', () => {
    expect(periodFor('2026-11-22', 4, 'QUARTER')).toBe('FY2027-Q3');
    expect(periodFor('2027-02-01', 4, 'QUARTER')).toBe('FY2027-Q4');
    expect(periodFor('2026-03-31', 4, 'YEAR')).toBe('FY2026');
    expect(periodFor('2026-11-22', 1, 'QUARTER')).toBe('FY2026-Q4');
    const q = reportMonthsNeeded(reportPeriod('FY2027-Q1', 4)!, 4);
    expect(q[0]).toBe('2025-04');
    expect(q).toHaveLength(15);
    expect(reportMonthsNeeded(reportPeriod('FY2027', 4)!, 4)).toHaveLength(24);
  });
});

describe('executive and investor reports', () => {
  const period = reportPeriod('FY2027-Q2', 4)!;
  const prior = reportPeriod(period.prior, 4)!;
  const lastYear = reportPeriod(period.lastYear, 4)!;
  const figures = [
    month('2025-07', { revenue: '50000', cos: '20000' }),
    month('2026-04', { revenue: '100000', cos: '30000', opex: '20000' }),
    month('2026-05', { revenue: '100000', cos: '30000', opex: '20000' }),
    month('2026-06', { revenue: '100000', cos: '30000', opex: '20000', cash: '600000' }),
    month('2026-07', { revenue: '80000', cos: '40000', opex: '60000', cash: '560000', cashChange: '-40000' }),
    month('2026-08', { revenue: '80000', cos: '40000', opex: '60000', cash: '520000', cashChange: '-40000' }),
    month('2026-09', { revenue: '80000', cos: '40000', opex: '60000', cash: '480000', cashChange: '-40000', receivables: '90000', payables: '30000' }),
  ];
  const customers = concentration([{ id: 'a', name: 'Acme Retail', revenue: '120000' }, { id: 'b', name: 'Bharat Foods', revenue: '80000' }, { id: 'c', name: 'Coastal Labs', revenue: '40000' }], 5, 2);

  it('works out the headline, the P&L comparison and the months', () => {
    const r = buildStakeholderReport({ audience: 'EXECUTIVE', period, prior, lastYear, figures, customers, scale: 2 });
    expect(r.period).toEqual({ key: 'FY2027-Q2', label: 'Q2 FY 2026-27', from: '2026-07-01', to: '2026-09-30' });
    expect(r.headline).toMatchObject({
      revenue: '240000.00',
      revenueGrowthPrior: '-20.0',
      revenueGrowthYear: '380.0',
      grossProfit: '120000.00',
      grossMargin: '50.0',
      grossMarginPrior: '70.0',
      operatingProfit: '-60000.00',
      netIncome: '-60000.00',
      netMargin: '-25.0',
      cashOpening: '600000.00',
      cashClosing: '480000.00',
      cashChange: '-120000.00',
      averageMonthlyCashChange: '-40000.00',
      runwayMonths: '12.0',
      receivables: '90000.00',
      payables: '30000.00',
    });
    expect(r.lines.find((l) => l.key === 'operatingRevenue')).toMatchObject({ current: '240000.00', prior: '300000.00', lastYear: '50000.00', changePrior: '-20.0' });
    expect(r.months.map((m) => [m.month, m.netIncome, m.cash])).toEqual([['2026-07', '-20000.00', '560000.00'], ['2026-08', '-20000.00', '520000.00'], ['2026-09', '-20000.00', '480000.00']]);
  });

  it('lists points for attention and names customers for executives only', () => {
    const ex = buildStakeholderReport({ audience: 'EXECUTIVE', period, prior, lastYear, figures, customers, scale: 2 });
    expect(ex.attention.map((a) => [a.code, a.severity])).toEqual([['NET_LOSS', 'HIGH'], ['REVENUE_DOWN', 'MEDIUM'], ['MARGIN_DOWN', 'MEDIUM'], ['CONCENTRATION', 'MEDIUM']]);
    expect(ex.attention[2]!.message).toBe('Gross margin fell 20.0 points, from 70.0% to 50.0%');
    expect(ex.attention[3]!.message).toBe('Acme Retail brought 50.0% of revenue');
    expect(ex.customers.top.map((c) => c.name)).toEqual(['Acme Retail', 'Bharat Foods', 'Coastal Labs']);
    const inv = buildStakeholderReport({ audience: 'INVESTOR', period, prior, lastYear, figures, customers, scale: 2 });
    expect(inv.attention).toEqual([]);
    expect(inv.customers).toEqual({ count: 3, largestShare: '50.0', topFiveShare: '100.0', top: [] });
    expect(JSON.stringify(inv)).not.toContain('Acme');
    expect(inv.headline).toEqual(ex.headline);
  });

  it('flags a short runway and leaves growth empty with nothing to compare', () => {
    const short = figures.map((m) => (m.month === '2026-09' ? { ...m, cash: new D('100000') } : m));
    const r = buildStakeholderReport({ audience: 'EXECUTIVE', period, prior, lastYear: reportPeriod('FY2025-Q2', 4)!, figures: short, customers: concentration([], 5, 2), scale: 2 });
    expect(r.headline.runwayMonths).toBe('2.5');
    expect(r.attention.find((a) => a.code === 'SHORT_RUNWAY')).toMatchObject({ severity: 'HIGH', message: "Cash lasts about 2.5 months at the period's average outflow" });
    expect(r.headline.revenueGrowthYear).toBeNull();
    expect(r.customers.largestShare).toBeNull();
  });
});
