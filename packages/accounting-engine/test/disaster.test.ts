import { describe, expect, it } from 'vitest';
import { checkShock, shockDrivers, simulateDisaster, stressTests, TwinError, type DisasterInput, type TwinActualMonth } from '../src';

// Revenue 1,00,000 a month, cost of sales 40,000, payroll 30,000, other costs 10,000: profit
// 20,000 a month. Cash 5,00,000; customers and suppliers both on 30 days.
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
const input: DisasterInput = {
  baseline: { months: [month('2026-07'), month('2026-08'), month('2026-09')], currency: 'INR', scale: 2 },
  horizonMonths: 3,
  customers: [
    { contactId: 'c1', name: 'Acme Retail', monthlyRevenue: '25000.00', balance: '30000.00' },
    { contactId: 'c2', name: 'Small Shop', monthlyRevenue: '5000.00', balance: '0.00' },
  ],
  suppliers: [{ contactId: 's1', name: 'Mill Supplies', monthlySpend: '20000.00' }],
};
const cash = (r: ReturnType<typeof simulateDisaster>) => r.stressed.projection.months.map((m) => m.closingCash);

describe('disaster simulation', () => {
  it('stops operations for a month: old invoices still come in, then the restart ties up cash', () => {
    const r = simulateDisaster({ ...input, shocks: [{ kind: 'OPERATIONAL_DISRUPTION', revenueLostPercent: '100', months: 1, recoveryCost: '0', insuranceRecovery: '0', insuranceMonthsLater: 0 }] });
    expect(r.noShock.months.map((m) => m.closingCash)).toEqual(['520000.00', '540000.00', '560000.00']);
    // Month 1: a loss of 40,000, but 1,00,000 of receivables is collected and 40,000 of payables paid.
    expect(cash(r)).toEqual(['520000.00', '480000.00', '500000.00']);
    expect(r.impact).toMatchObject({ profitChange: '-60000.00', lowestCash: { amount: '480000.00', month: '2026-11' }, lowestCashChange: '-40000.00', closingCashChange: '-60000.00', largestCashGap: { amount: '-60000.00', month: '2026-11' }, cashNegativeFrom: null, verdict: 'SURVIVES', monthsBeforeShortfall: null });
    expect(r.shocks[0]!.explanation[0]).toBe('100% of sales are lost for 1 month from Oct 2026, with the cost of those sales; payroll and other running costs carry on.');
    expect(r.summary).toBe('With this shock, the business gets through: cash is lowest at INR 480000.00 in Nov 2026. Profit over 3 months is INR 60000.00 lower.');
  });

  it('writes off a defaulting customer’s balance and loses its share of sales', () => {
    const b = shockDrivers({ kind: 'CUSTOMER_DEFAULT', contactId: 'c1', writeOffPercent: '100', loseFutureSales: true }, input);
    expect(b.title).toBe('Acme Retail defaults');
    expect(b.drivers).toEqual([
      { kind: 'ONE_OFF', label: 'Bad debt: Acme Retail', amount: '-30000.00', month: 1, affectsProfit: true },
      { kind: 'DOWNTURN', label: 'Sales to Acme Retail lost', revenuePercent: '25.00', extraCollectionDays: 0, fromMonth: 1 },
    ]);
    const r = simulateDisaster({ ...input, shocks: [{ kind: 'CUSTOMER_DEFAULT', contactId: 'c1', writeOffPercent: '100', loseFutureSales: true }] });
    // Profit 5,000 a month after the lost sales, less the 30,000 write-off in month 1.
    expect(r.stressed.projection.months.map((m) => m.netProfit)).toEqual(['-25000.00', '5000.00', '5000.00']);
    expect(cash(r)).toEqual(['490000.00', '495000.00', '500000.00']);
    expect(r.impact.profitChange).toBe('-75000.00');
    expect(r.impact.lowestCashChange).toBe('-30000.00');
  });

  it('freezes cash and withdraws credit, and measures against the minimum balance', () => {
    const shock = { kind: 'LIQUIDITY_SHOCK' as const, frozenCash: '200000', frozenMonths: 2, creditWithdrawn: '50000', collectionDelayDays: 0, delayMonths: 1 };
    const r = simulateDisaster({ ...input, cashBuffer: '300000', shocks: [shock] });
    expect(cash(r)).toEqual(['270000.00', '290000.00', '510000.00']);
    expect(r.impact).toMatchObject({ profitChange: '0.00', largestCashGap: { amount: '-250000.00', month: '2026-10' }, verdict: 'BELOW_BUFFER', monthsBeforeShortfall: 0, cashRequired: '30000.00' });
    expect(r.shocks[0]!.explanation).toEqual(['INR 200000.00 cannot be used from Oct 2026 and is released in Dec 2026.', 'The bank withdraws a INR 50000.00 credit line in Oct 2026, and it must be repaid at once.']);
    // Released after the horizon: said so, and no release.
    const late = shockDrivers({ ...shock, frozenMonths: 6 }, input);
    expect(late.drivers.filter((d) => d.kind === 'ONE_OFF')).toHaveLength(2);
    expect(late.explanation[0]).toMatch(/is not released within the period/);
  });

  it('turns a supplier failure into lost sales and a higher cost for its share of purchases', () => {
    const b = shockDrivers({ kind: 'SUPPLIER_FAILURE', contactId: 's1', disruptionMonths: 1, revenueLostPercent: '20', replacementPremiumPercent: '10' }, input);
    expect(b.drivers).toEqual([
      { kind: 'DOWNTURN', label: 'Sales lost without Mill Supplies', revenuePercent: '20', extraCollectionDays: 0, fromMonth: 1, months: 1 },
      { kind: 'SUPPLIER_COST', label: 'Replacement for Mill Supplies', percent: '5', fromMonth: 2 },
    ]);
    expect(b.explanation[1]).toBe('From Nov 2026 the replacement costs 10% more. Mill Supplies supplied INR 20000.00 a month, about 50.0% of cost of sales, so cost of sales rises 5.00%.');
  });

  it('runs shocks together, names the hardest one, and refuses shocks that do not make sense', () => {
    const r = simulateDisaster({
      ...input,
      shocks: [
        { kind: 'OPERATIONAL_DISRUPTION', revenueLostPercent: '100', months: 1, recoveryCost: '0', insuranceRecovery: '0', insuranceMonthsLater: 0 },
        { kind: 'LIQUIDITY_SHOCK', frozenCash: '600000', frozenMonths: 2, creditWithdrawn: '0', collectionDelayDays: 0, delayMonths: 1 },
      ],
    });
    expect(r.impact).toMatchObject({ verdict: 'RUNS_OUT', cashNegativeFrom: '2026-10' });
    expect(r.shocks.map((s) => s.alone.verdict)).toEqual(['SURVIVES', 'RUNS_OUT']);
    expect(r.summary).toMatch(/^With these 2 shocks together, cash runs out in Oct 2026, and about INR 120000\.00 more is needed .* The hardest single shock is "Liquidity shock"/);

    expect(checkShock({ kind: 'CUSTOMER_DEFAULT', contactId: 'nobody', writeOffPercent: '120', loseFutureSales: true }, 3, input)).toEqual(['Choose a customer from the list', 'Share of the balance never paid (%) must be at most 100']);
    expect(checkShock({ kind: 'LIQUIDITY_SHOCK', frozenCash: '0', frozenMonths: 1, creditWithdrawn: '0', collectionDelayDays: 0, delayMonths: 1, month: 4 }, 3, input)).toEqual([
      'Month it starts must be a whole number from 1 to 3',
      'Enter cash frozen, credit withdrawn or a payment delay',
    ]);
    expect(() => simulateDisaster({ ...input, shocks: [] })).toThrow(TwinError);
    try {
      simulateDisaster({ ...input, shocks: [{ kind: 'DEMAND_SHOCK', revenueLostPercent: 'x', months: 1, extraCollectionDays: 0 }] });
    } catch (e) {
      expect((e as TwinError).issues).toEqual(['Shock 1: Sales lost (%): enter a number']);
    }
  });

  it('runs the standard stress tests from the business’s own customers, suppliers and cash, worst first', () => {
    const s = stressTests({ ...input, horizonMonths: 6 });
    expect(s.tests.map((t) => t.key).sort()).toEqual(['CUSTOMERS_PAY_LATE', 'DEMAND_DOWN_30', 'HALF_CASH_FROZEN', 'LARGEST_CUSTOMER_DEFAULTS', 'LARGEST_SUPPLIER_FAILS', 'ONE_MONTH_SHUTDOWN', 'PERFECT_STORM']);
    expect(s.tests.find((t) => t.key === 'LARGEST_CUSTOMER_DEFAULTS')!.title).toBe('Largest customer defaults (Acme Retail)');
    const lows = s.tests.map((t) => Number(t.impact.lowestCash.amount));
    expect(lows).toEqual([...lows].sort((a, b) => a - b));
    expect(s.tests[0]!.key).toBe('HALF_CASH_FROZEN');
    expect(s.survived).toBe(7);
    expect(s.summary).toBe('The business gets through 7 of 7 standard shocks without cash falling below the minimum balance.');
    // Without customers, suppliers or cash, only the tests that apply are run.
    const bare = stressTests({ ...input, customers: [], suppliers: [], baseline: { ...input.baseline, months: input.baseline.months.map((m) => ({ ...m, cash: '0.00' })) } });
    expect(bare.tests.map((t) => t.key).sort()).toEqual(['CUSTOMERS_PAY_LATE', 'DEMAND_DOWN_30', 'ONE_MONTH_SHUTDOWN']);
  });
});
