import { describe, expect, it } from 'vitest';
import { assessImpact, changeDrivers, checkChange, costOfSalesShare, runTwin, TwinError, type ImpactInput, type TwinActualMonth } from '../src';

// Revenue 1,00,000 a month, cost of sales 40,000 (40%), payroll 30,000, other costs 10,000:
// profit 20,000 a month, no tax. Cash 5,00,000; customers and suppliers both on 30 days.
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
const input: ImpactInput = {
  baseline: { months: [month('2026-07'), month('2026-08'), month('2026-09')], currency: 'INR', scale: 2 },
  horizonMonths: 6,
  customers: [
    { contactId: 'c1', name: 'Acme Retail', monthlyRevenue: '25000.00' },
    { contactId: 'c2', name: 'Dormant Co', monthlyRevenue: '0.00' },
  ],
  suppliers: [{ contactId: 's1', name: 'Mill Supplies', monthlySpend: '20000.00' }],
};

describe('business impact engine', () => {
  it('reads the cost of sales ratio from the books', () => {
    expect(costOfSalesShare(input.baseline).toFixed(2)).toBe('40.00');
  });

  it('a new customer brings revenue with its cost of sales, and receivables with it', () => {
    const r = assessImpact({ ...input, changes: [{ lever: 'NEW_CUSTOMER', label: 'Zenith Foods', monthlyRevenue: '30000', rampMonths: 3 }] });
    const c = r.changes[0]!;
    expect(c.title).toBe('New customer: Zenith Foods');
    expect(c.area).toBe('SALES');
    expect(c.drivers).toEqual([{ kind: 'EXPANSION', label: 'New customer: Zenith Foods', oneOffCost: '0', monthlyCost: '0', monthlyRevenue: '30000', rampMonths: 3, month: 1, costOfSalesPercent: '40.00' }]);
    // Revenue 10,000 + 20,000 + 4 × 30,000; cost of sales 40% of it.
    expect(r.change).toMatchObject({ revenue: '150000.00', grossProfit: '90000.00', operatingProfit: '90000.00', netProfit: '90000.00', closingCash: '72000.00' });
    expect(r.change.grossMarginPoints).toBe('0.00');
    expect(c.lines).toEqual([
      { key: 'revenue', label: 'Revenue', change: '150000.00' },
      { key: 'costOfSales', label: 'Cost of sales', change: '60000.00' },
      { key: 'grossProfit', label: 'Gross profit', change: '90000.00' },
      { key: 'netProfit', label: 'Net profit', change: '90000.00' },
      { key: 'receivables', label: 'Receivables at the end', change: '30000.00' },
      { key: 'payables', label: 'Payables at the end', change: '12000.00' },
      { key: 'closingCash', label: 'Cash at the end', change: '72000.00' },
    ]);
    expect(c.payback.status).toBe('NO_OUTLAY');
    expect(r.before.netProfit).toBe('120000.00');
    expect(r.after.netProfit).toBe('210000.00');
    expect(r.months[0]).toMatchObject({ month: '2026-10', revenueBefore: '100000.00', revenueAfter: '110000.00' });
    expect(r.summary).toBe('This change leaves net profit INR 90000.00 higher over 6 months, with cash INR 72000.00 higher at the end.');
  });

  it('equipment costs cash up front, saves running costs and is depreciated', () => {
    const r = assessImpact({ ...input, changes: [{ lever: 'EQUIPMENT', label: 'a packing machine', cost: '120000', usefulLifeMonths: 24, monthlySaving: '10000' }] });
    const c = r.changes[0]!;
    expect(c.title).toBe('Buy a packing machine');
    // Savings 5 × 10,000 from month 2, depreciation 5 × 5,000.
    expect(c.alone).toMatchObject({ netProfit: '25000.00', closingCash: '-80000.00', lowestCash: '-120000.00' });
    expect(c.lines.map((l) => [l.key, l.change])).toEqual([
      ['otherOperating', '-50000.00'],
      ['depreciation', '25000.00'],
      ['netProfit', '25000.00'],
      ['payables', '-10000.00'],
      ['investment', '120000.00'],
      ['closingCash', '-80000.00'],
    ]);
    expect(c.payback).toEqual({ status: 'NOT_WITHIN', deepest: { amount: '-120000.00', month: '2026-10' }, month: null });
    expect(c.explanation[1]).toBe('It saves INR 10000.00 a month in running costs from Nov 2026.');
  });

  it('a headcount reduction pays back its severance', () => {
    const r = assessImpact({ ...input, horizonMonths: 3, changes: [{ lever: 'HEADCOUNT_REDUCTION', count: 2, monthlyCostPerHead: '10000', severancePerHead: '15000' }] });
    const c = r.changes[0]!;
    expect(c.area).toBe('HR');
    expect(c.alone.netProfit).toBe('30000.00');
    expect(c.lines.map((l) => [l.key, l.change])).toEqual([
      ['payroll', '-60000.00'],
      ['oneOffItems', '-30000.00'],
      ['netProfit', '30000.00'],
      ['closingCash', '30000.00'],
    ]);
    expect(c.payback).toEqual({ status: 'PAYS_BACK', deepest: { amount: '-10000.00', month: '2026-10' }, month: '2026-11' });
    expect(r.summary).toContain('is back level by Nov 2026');
  });

  it('losing a customer takes its share of sales and their cost', () => {
    const b = changeDrivers({ lever: 'LOSE_CUSTOMER', contactId: 'c1', month: 2 }, input);
    expect(b.drivers).toEqual([{ kind: 'DOWNTURN', label: 'Lose Acme Retail', revenuePercent: '25.00', extraCollectionDays: 0, fromMonth: 2 }]);
    const r = assessImpact({ ...input, changes: [{ lever: 'LOSE_CUSTOMER', contactId: 'c1', month: 2 }] });
    expect(r.change).toMatchObject({ revenue: '-125000.00', grossProfit: '-75000.00', netProfit: '-75000.00' });
    expect(r.payback.status).toBe('NEVER_AHEAD');
  });

  it('a supplier’s price applies to its share of cost of sales', () => {
    const b = changeDrivers({ lever: 'SUPPLIER_PRICE', contactId: 's1', percent: '10' }, input);
    // Mill Supplies is half of cost of sales, so cost of sales rises 5%.
    expect(b.drivers).toEqual([{ kind: 'SUPPLIER_COST', label: 'Mill Supplies up 10%', percent: '5', fromMonth: 1 }]);
    const all = changeDrivers({ lever: 'SUPPLIER_PRICE', contactId: null, percent: '-5' }, input);
    expect(all.title).toBe('All suppliers down 5%');
  });

  it('reports business areas on their own, and their interaction', () => {
    const r = assessImpact({
      ...input,
      horizonMonths: 3,
      changes: [
        { lever: 'PRICE_CHANGE', pricePercent: '0', volumePercent: '50' },
        { lever: 'SUPPLIER_PRICE', contactId: null, percent: '10' },
        { lever: 'PAY_RISE', percent: '10' },
      ],
    });
    expect(r.areas.map((a) => [a.area, a.changes, a.alone.netProfit])).toEqual([
      ['SALES', [1], '90000.00'],
      ['HR', [3], '-9000.00'],
      ['PROCUREMENT', [2], '-12000.00'],
    ]);
    // Together: cost of sales 40,000 × 1.5 × 1.1 = 66,000, so the supplier rise costs 6,000 a month, not 4,000.
    expect(r.change.netProfit).toBe('63000.00');
    expect(r.interaction.netProfit).toBe('-6000.00');
  });

  it('checks changes against the books and explains problems in words', () => {
    expect(checkChange({ lever: 'LOSE_CUSTOMER', contactId: 'zz' }, 6, input)).toEqual(['Choose a customer from the list']);
    expect(checkChange({ lever: 'LOSE_CUSTOMER', contactId: 'c2' }, 6, input)).toEqual(['That customer had no sales in the baseline months, so there is nothing to lose']);
    expect(checkChange({ lever: 'HEADCOUNT_REDUCTION', count: 4, monthlyCostPerHead: '10000', severancePerHead: '0' }, 6, input)).toEqual(['The people leaving cost more than the whole payroll in the baseline months']);
    expect(checkChange({ lever: 'RUNNING_COSTS', percent: '0', monthlyAmount: '0' }, 6, input)).toEqual(['Enter a percentage or an amount a month']);
    expect(checkChange({ lever: 'HIRE', count: 0, monthlyCostPerHead: 'abc', oneOffCostPerHead: '0', month: 9 }, 6, input)).toEqual(['Month it starts must be a whole number from 1 to 6', 'People hired must be a whole number from 1 to 10000', 'Monthly cost per person: enter a number']);
    expect(() => assessImpact({ ...input, changes: [] })).toThrow(TwinError);
    try {
      assessImpact({ ...input, changes: [{ lever: 'CUSTOMER_TERMS', collectionDaysChange: 0 }] });
    } catch (e) {
      expect((e as TwinError).issues).toEqual(['Change 1: Enter how many days sooner (negative) or later customers pay']);
    }
  });

  it('the twin’s expansion keeps working without a cost-of-sales share', () => {
    const r = runTwin({ baseline: input.baseline, horizonMonths: 1, drivers: [{ kind: 'EXPANSION', oneOffCost: '0', monthlyCost: '0', monthlyRevenue: '10000', rampMonths: 1 }] });
    expect(r.projection.months[0]).toMatchObject({ revenue: '110000.00', costOfSales: '40000.00' });
  });
});
