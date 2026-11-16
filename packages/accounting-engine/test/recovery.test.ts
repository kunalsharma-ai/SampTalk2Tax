import { describe, expect, it } from 'vitest';
import { dec, recoveryForecast, recoveryOptions, type RecoveryInput, type TwinActualMonth } from '../src';

// A business losing 20,000 a month with 100,000 in the bank: cash runs out within the year.
const month = (m: string): TwinActualMonth => ({
  month: m,
  revenue: '100000.00',
  otherIncome: '0.00',
  costOfSales: '40000.00',
  payroll: '60000.00',
  otherOperating: '20000.00',
  depreciation: '0.00',
  interest: '0.00',
  incomeTax: '0.00',
  otherExpenses: '0.00',
  cash: '100000.00',
  receivables: '100000.00',
  payables: '40000.00',
});
const input: RecoveryInput = {
  baseline: { months: [month('2026-07'), month('2026-08'), month('2026-09')], currency: 'INR', scale: 2 },
  horizonMonths: 12,
  customers: [
    { contactId: 'c1', name: 'Acme', overdue1to30: '20000.00', overdue31to90: '10000.00', overdueOver90: '0.00' },
    { contactId: 'c2', name: 'Beta', overdue1to30: '0.00', overdue31to90: '0.00', overdueOver90: '15000.00' },
    { contactId: 'c3', name: 'Gamma', overdue1to30: '0.00', overdue31to90: '0.00', overdueOver90: '0.00' },
  ],
  suppliers: [
    { contactId: 's1', name: 'Small Supplies', monthlySpend: '5000.00', balance: '2000.00' },
    { contactId: 's2', name: 'Big Parts', monthlySpend: '30000.00', balance: '25000.00' },
  ],
  expenses: [
    { accountId: 'a1', code: '6200', name: 'Rent', monthly: '12000.00' },
    { accountId: 'a2', code: '6500', name: 'Marketing', monthly: '8000.00' },
    { accountId: 'a3', code: '6700', name: 'Travel', monthly: '0.00' },
  ],
};

describe('recovery planner', () => {
  const r = recoveryOptions(input);
  const opt = (k: string) => r.options.find((o) => o.key === k)!;

  it('starts from taking no action: when cash runs out and how much is needed', () => {
    expect(r.noAction.cashNegativeFrom).not.toBeNull();
    expect(r.noAction.runwayMonths).toBeGreaterThan(0);
    expect(dec(r.noAction.cashRequired).gt(0)).toBe(true);
    expect(r.noAction.cash).toHaveLength(12);
    expect(r.collectionDays).toBe('30.0');
  });

  it('lists options in every category, each measured against no action', () => {
    expect(r.options.map((o) => o.key)).toEqual([
      'COLLECT_OVERDUE',
      'COLLECT_SOONER',
      'EXTEND_SUPPLIER_TERMS',
      'SUPPLIER_DISCOUNT',
      'CUT_6200',
      'CUT_6500',
      'SPENDING_FREEZE',
      'BRIDGE_LOAN',
      'OWNER_FUNDING',
      'PRICE_RISE',
      'PAYROLL_REDUCTION',
    ]);
    for (const o of r.options) expect(o.drivers.length).toBeGreaterThan(0);
    // Cutting rent by a fifth saves 2,400 a month over 12 months.
    expect(opt('CUT_6200').effect.netProfit).toBe('28800.00');
    expect(opt('CUT_6200').drivers[0]).toMatchObject({ kind: 'EXPENSE_CHANGE', target: 'OPERATING', monthlyAmount: '-2400.00' });
    // Collecting does not change profit, only cash.
    expect(opt('COLLECT_OVERDUE').effect.netProfit).toBe('0.00');
    expect(dec(opt('COLLECT_OVERDUE').effect.minimumCash).gt(0)).toBe(true);
  });

  it('counts overdue debt up to 90 days as recoverable and lists the customers, largest first', () => {
    const o = opt('COLLECT_OVERDUE');
    // 30,000 recoverable at 3,333.33 a day of revenue: 9 days sooner.
    expect(o.drivers[0]).toMatchObject({ kind: 'WORKING_CAPITAL', collectionDaysChange: -9 });
    expect(o.targets.map((t) => [t.name, t.amount])).toEqual([['Acme', '30000.00'], ['Beta', '15000.00']]);
    expect(o.targets[1]!.note).toContain('more than 90 days late');
    expect(opt('EXTEND_SUPPLIER_TERMS').targets.map((t) => t.name)).toEqual(['Big Parts', 'Small Supplies']);
  });

  it('sizes the loan so the gap stays closed, and marks decisions about people, contracts and borrowing', () => {
    const loan = opt('BRIDGE_LOAN');
    expect(loan.effect.cashNegativeFrom).toBeNull();
    expect(loan.needsDecision).toBe(true);
    expect(opt('PAYROLL_REDUCTION').needsDecision).toBe(true);
    expect(opt('PAYROLL_REDUCTION').detail).toContain('not a recommendation to let anyone go');
    expect(opt('CUT_6500').needsDecision).toBe(false);
  });

  it('forecasts a plan of several options together', () => {
    const drivers = [...opt('COLLECT_OVERDUE').drivers, ...opt('CUT_6200').drivers, ...opt('CUT_6500').drivers, ...opt('PRICE_RISE').drivers];
    const f = recoveryForecast(input, drivers);
    expect(f.noAction.closingCash).toBe(r.noAction.closingCash);
    expect(dec(f.withPlan.closingCash).gt(f.noAction.closingCash)).toBe(true);
    expect(f.effect.closingCash).toBe(dec(f.withPlan.closingCash).minus(f.noAction.closingCash).toFixed(2));
    expect(typeof f.gapClosed).toBe('boolean');
    const withLoan = recoveryForecast(input, [...drivers, ...opt('BRIDGE_LOAN').drivers]);
    expect(withLoan.gapClosed).toBe(true);
    expect(withLoan.withPlan.runwayMonths).toBeNull();
  });

  it('offers no financing when cash never runs short, and nothing to collect when nothing is overdue', () => {
    const healthy = recoveryOptions({ ...input, baseline: { ...input.baseline, months: input.baseline.months.map((m) => ({ ...m, payroll: '20000.00', cash: '900000.00' })) }, customers: [] });
    expect(healthy.noAction.cashNegativeFrom).toBeNull();
    expect(healthy.options.map((o) => o.key)).not.toContain('BRIDGE_LOAN');
    expect(healthy.options.map((o) => o.key)).not.toContain('COLLECT_OVERDUE');
  });
});
