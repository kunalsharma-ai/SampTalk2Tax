import { describe, expect, it } from 'vitest';
import { checkDriver, runTwin, shiftYm, TwinError, type TwinActualMonth, type TwinBaseline } from '../src';

const month = (m: string, over: Partial<TwinActualMonth> = {}): TwinActualMonth => ({
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
  ...over,
});
const base: TwinBaseline = { months: [month('2026-07'), month('2026-08'), month('2026-09')], currency: 'INR', scale: 2 };

describe('digital twin', () => {
  it('projects the baseline unchanged when there are no changes', () => {
    const r = runTwin({ baseline: base, drivers: [], horizonMonths: 3 });
    expect(r.baseline).toMatchObject({ fromMonth: '2026-07', toMonth: '2026-09', revenue: '100000.00', collectionDays: '30.0', paymentDays: '30.0', taxRateSource: 'NONE' });
    expect(r.projection.months.map((m) => m.month)).toEqual(['2026-10', '2026-11', '2026-12']);
    // Profit 20,000 a month; receivables and payables stay at 30 days, so cash grows 20,000 a month.
    expect(r.projection.months.map((m) => [m.netProfit, m.workingCapitalChange, m.closingCash])).toEqual([
      ['20000.00', '0.00', '520000.00'],
      ['20000.00', '0.00', '540000.00'],
      ['20000.00', '0.00', '560000.00'],
    ]);
    expect(r.projection.totals).toMatchObject({ revenue: '300000.00', netProfit: '60000.00', netMarginPercent: '20.0' });
    expect(r.risks).toEqual([]);
    expect(r.missing.map((m) => m.field)).toEqual(['TAX_RATE']);
  });

  it('grows revenue with cost of sales following volume, and ties up cash in receivables', () => {
    const r = runTwin({ baseline: base, drivers: [{ kind: 'REVENUE_GROWTH', percentPerMonth: '10' }], horizonMonths: 2 });
    const [m1, m2] = r.projection.months;
    expect(m1).toMatchObject({ revenue: '110000.00', costOfSales: '44000.00', netProfit: '26000.00', receivables: '110000.00', payables: '54000.00' });
    // Receivables up 10,000, payables up 4,000: 6,000 of the profit is tied up.
    expect(m1!.workingCapitalChange).toBe('6000.00');
    expect(m1!.cashFlow).toBe('20000.00');
    expect(m2).toMatchObject({ revenue: '121000.00', costOfSales: '48400.00' });
  });

  it('prices change revenue but not the cost of sales', () => {
    const r = runTwin({ baseline: base, drivers: [{ kind: 'PRICE_CHANGE', pricePercent: '10', volumePercent: '-5', fromMonth: 2 }], horizonMonths: 2 });
    expect(r.projection.months[0]).toMatchObject({ revenue: '100000.00', costOfSales: '40000.00' });
    // Volume 95%, price 110%: revenue 104,500; cost of sales 38,000.
    expect(r.projection.months[1]).toMatchObject({ revenue: '104500.00', costOfSales: '38000.00' });
    expect(r.missing.find((m) => m.field === 'VOLUME')).toBeUndefined();
  });

  it('hires people, takes a loan and buys equipment', () => {
    const r = runTwin({
      baseline: base,
      drivers: [
        { kind: 'HIRING', count: 2, monthlyCostPerHead: '50000', oneOffCostPerHead: '10000', fromMonth: 1 },
        { kind: 'NEW_DEBT', amount: '1200000', annualRatePercent: '0', termMonths: 12, month: 1 },
        { kind: 'INVESTMENT', amount: '600000', usefulLifeMonths: 60, month: 1 },
        { kind: 'TAX_RATE', percent: '25' },
      ],
      horizonMonths: 3,
    });
    const [m1, m2] = r.projection.months;
    // Month 1: payroll 130,000 and one-off 20,000; loss 100,000, no tax; payables rise with other costs.
    expect(m1).toMatchObject({ payroll: '130000.00', otherOperating: '30000.00', netProfit: '-100000.00', tax: '0.00', loanProceeds: '1200000.00', investment: '600000.00', depreciation: '0.00', headcountAdded: 2 });
    // Month 2: depreciation 10,000; principal 100,000 (no interest).
    expect(m2).toMatchObject({ depreciation: '10000.00', loanPrincipal: '100000.00', interest: '0.00', otherOperating: '10000.00' });
    expect(r.baseline.taxRateSource).toBe('SCENARIO');
    expect(r.assumptions.some((a) => a.includes('2 people join in 2026-10'))).toBe(true);
  });

  it('charges loan interest on the reducing balance with equal instalments', () => {
    const r = runTwin({ baseline: base, drivers: [{ kind: 'NEW_DEBT', amount: '100000', annualRatePercent: '12', termMonths: 2, month: 1 }], horizonMonths: 3 });
    const [, m2, m3] = r.projection.months;
    // EMI on 100,000 at 1% a month over 2 months: 50,751.24; month 2 interest 1,000.
    expect(m2).toMatchObject({ interest: '1000.00', loanPrincipal: '49751.24' });
    expect(m3).toMatchObject({ interest: '502.49', loanPrincipal: '50248.76' });
  });

  it('flags running out of cash, the cash needed and a loss', () => {
    const r = runTwin({ baseline: { ...base, months: [month('2026-09', { cash: '50000.00' })] }, drivers: [{ kind: 'DOWNTURN', revenuePercent: '60', extraCollectionDays: 30 }], horizonMonths: 6, cashBuffer: '20000' });
    // Loss 16,000 a month; slower collections are outweighed by lower receivables, so cash falls 20,000 in the first month and 16,000 a month after.
    expect(r.projection.cashNegativeFrom).toBe('2026-12');
    expect(r.risks.map((x) => x.code)).toEqual(expect.arrayContaining(['CASH_NEGATIVE', 'LOSS', 'SHORT_HISTORY']));
    expect(Number(r.projection.cashRequired)).toBeGreaterThan(20000);
    expect(r.projection.minimumCash).toEqual({ amount: '-50000.00', month: '2027-03' });
    expect(r.projection.cashRequired).toBe('70000.00');
  });

  it('applies churn, currency, inflation, working capital, expansion and one-offs', () => {
    const r = runTwin({
      baseline: base,
      drivers: [
        { kind: 'CHURN', percentPerMonth: '10' },
        { kind: 'CURRENCY', exposurePercent: '50', changePercent: '10' },
        { kind: 'INFLATION', annualPercent: '12.6825' },
        { kind: 'WORKING_CAPITAL', collectionDaysChange: -15, paymentDaysChange: 0 },
        { kind: 'EXPANSION', oneOffCost: '0', monthlyCost: '5000', monthlyRevenue: '20000', rampMonths: 2, month: 1 },
        { kind: 'ONE_OFF', label: 'Grant received', amount: '25000', month: 1, affectsProfit: false },
      ],
      horizonMonths: 2,
    });
    const m1 = r.projection.months[0]!;
    // Volume 90%, currency +5%: 94,500 plus expansion 10,000 at half speed.
    expect(m1.revenue).toBe('104500.00');
    // Inflation of 12.6825% a year is 1% a month: cost of sales 40,000 × 0.9 × 1.01.
    expect(m1.costOfSales).toBe('36360.00');
    expect(m1.oneOffCash).toBe('25000.00');
    // Collection days 15: receivables 52,250.
    expect(m1.receivables).toBe('52250.00');
  });

  it('checks the changes and the horizon', () => {
    expect(checkDriver({ kind: 'HIRING', count: 0, monthlyCostPerHead: '-1' }, 12)).toEqual(['People hired must be a whole number from 1 to 10000', 'Monthly cost per person must be above zero']);
    expect(checkDriver({ kind: 'REVENUE_GROWTH', percentPerMonth: '5', fromMonth: 13 }, 12)).toEqual(['Starting month must be a whole number from 1 to 12']);
    expect(checkDriver({ kind: 'EXPENSE_CHANGE', target: 'OPERATING' }, 12)).toEqual(['Enter a percentage or a monthly amount']);
    expect(() => runTwin({ baseline: base, drivers: [{ kind: 'CHURN', percentPerMonth: 'x' }], horizonMonths: 12 })).toThrow(TwinError);
    expect(() => runTwin({ baseline: base, drivers: [], horizonMonths: 61 })).toThrow('Choose a horizon from 1 to 60 months');
    expect(() => runTwin({ baseline: { ...base, months: [] }, drivers: [], horizonMonths: 12 })).toThrow(TwinError);
    expect(shiftYm('2026-11', 3)).toBe('2027-02');
    expect(shiftYm('2026-01', -1)).toBe('2025-12');
  });

  it('takes the tax rate from history when the scenario does not set one', () => {
    const r = runTwin({ baseline: { ...base, months: [month('2026-09', { incomeTax: '5000.00' })] }, drivers: [], horizonMonths: 1 });
    // Profit before tax 20,000 with 5,000 tax booked: 25%.
    expect(r.baseline).toMatchObject({ taxRatePercent: '25.00', taxRateSource: 'HISTORY' });
    expect(r.projection.months[0]!.tax).toBe('5000.00');
  });
});
