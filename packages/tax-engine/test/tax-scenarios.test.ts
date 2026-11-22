import { describe, expect, it } from 'vitest';
import { compareRegimes, corporateTax, simulateTaxScenario, type TaxScenarioInput } from '../src';

const none: TaxScenarioInput = { revenueChange: '0', revenueGstRate: '18', expenseChange: '0', expenseGstRate: '18', extraDepreciation: '0', disallowed: '0' };
const base = { income: '5000000', regime: 'COMPANY_25' as const, credits: '200000' };

describe('tax scenario simulations (TAX-049)', () => {
  it('gives the estimate itself when nothing changes', () => {
    const r = simulateTaxScenario(base, none);
    // 50 lakh at 25% = 12,50,000; cess 4% = 50,000.
    expect(r.tax.total.toFixed(2)).toBe('1300000.00');
    expect(r.taxChange.toFixed(2)).toBe('0.00');
    expect(r.netPayable.toFixed(2)).toBe('1100000.00');
    expect(r.effectiveRate).toBe('26.0');
    expect(r.cashEffect.toFixed(2)).toBe('0.00');
    expect(r.notes).toEqual([]);
  });

  it('works out more sales, more expenses, depreciation and add-backs, with GST', () => {
    const r = simulateTaxScenario(base, { ...none, revenueChange: '2000000', expenseChange: '500000', expenseGstRate: '12', extraDepreciation: '300000', disallowed: '100000' });
    expect(r.bookProfit.toFixed(2)).toBe('6200000.00');
    expect(r.taxableIncome.toFixed(2)).toBe('6300000.00');
    // 63 lakh × 25% × 1.04 = 16,38,000.
    expect(r.tax.total.toFixed(2)).toBe('1638000.00');
    expect(r.taxChange.toFixed(2)).toBe('338000.00');
    expect(r.profitAfterTax.toFixed(2)).toBe('4562000.00');
    expect([r.gst.output.toFixed(2), r.gst.input.toFixed(2), r.gst.net.toFixed(2)]).toEqual(['360000.00', '60000.00', '300000.00']);
    // 20 lakh − 5 lakh − 3,38,000 more tax.
    expect(r.cashEffect.toFixed(2)).toBe('1162000.00');
    expect(r.notes).toEqual(['Expenses that are not deductible raise the tax but not the profit in the books.']);
  });

  it('crosses the ₹1 crore surcharge threshold with marginal relief', () => {
    const r = simulateTaxScenario(base, { ...none, revenueChange: '5010000' });
    expect(r.taxableIncome.toFixed(2)).toBe('10010000.00');
    expect(r.tax.total.toFixed(2)).toBe(corporateTax('10010000', 'COMPANY_25').total.toFixed(2));
    expect(r.tax.marginalRelief.gt(0)).toBe(true);
  });

  it('switches the regime and warns; a loss pays no tax', () => {
    const r = simulateTaxScenario(base, { ...none, regime: 'COMPANY_22' });
    // 50 lakh × 22% × 1.10 × 1.04 = 12,58,400.
    expect(r.tax.total.toFixed(2)).toBe('1258400.00');
    expect(r.taxChange.toFixed(2)).toBe('-41600.00');
    expect(r.notes[0]).toContain('to "Company, concessional rate (22%)"');
    expect(r.notes[1]).toContain('cannot be withdrawn');
    const loss = simulateTaxScenario(base, { ...none, expenseChange: '6000000' });
    expect(loss.tax.total.toFixed(2)).toBe('0.00');
    expect(loss.netPayable.toFixed(2)).toBe('0.00');
    expect(loss.effectiveRate).toBeNull();
    expect(loss.notes[0]).toContain('nil or a loss');
  });

  it('compares the regimes open to a company, lowest first; a firm has one', () => {
    expect(compareRegimes('5000000', 'COMPANY_25').map((r) => [r.regime, r.total.toFixed(0), r.current])).toEqual([
      ['COMPANY_22', '1258400', false],
      ['COMPANY_25', '1300000', true],
      ['COMPANY_30', '1560000', false],
    ]);
    expect(compareRegimes('5000000', 'FIRM_30').map((r) => r.regime)).toEqual(['FIRM_30']);
  });
});
