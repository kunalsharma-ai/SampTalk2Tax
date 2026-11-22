import { D, Dec } from '@talk2tax/accounting-engine';
import { ADVANCE_TAX_REGIME, ADVANCE_TAX_REGIMES, type AdvanceTaxRegime, corporateTax } from './advance-tax';

/**
 * Tax scenario simulations (TAX-049): what a change to the year's business would do to income tax
 * and GST, against the year's estimate (the advance tax plan: projected income plus adjustments,
 * its regime and its tax credits).
 *
 * A scenario changes taxable sales and deductible expenses (each with its GST rate), adds
 * depreciation, adds back expenses that are not deductible and may switch the tax regime. It gives
 * the tax on the new taxable income (corporateTax: surcharge, marginal relief and cess), the change
 * on the estimate, the net tax payable after credits, the profit after tax and the effective rate,
 * the GST collected less the input credit on the change, and the cash effect: sales less expenses
 * less the change in income tax (depreciation is not cash; GST passes through).
 *
 * Not modelled: losses carried forward, minimum alternate tax, deductions and exemptions given up
 * under the 22% regime other than by the scenario's own figures, and the timing of instalments.
 */

export const SCENARIO_GST_RATES = ['0', '5', '12', '18', '28', '40'] as const;
export type ScenarioGstRate = (typeof SCENARIO_GST_RATES)[number];

export interface TaxScenarioBase {
  /** Taxable income of the year as estimated: projected income plus the plan's adjustments. */
  income: Dec | string;
  regime: AdvanceTaxRegime;
  /** TDS and other credits against the year's tax. */
  credits: Dec | string;
}

export interface TaxScenarioInput {
  regime?: AdvanceTaxRegime | null;
  /** More (or, negative, less) taxable sales, before GST. */
  revenueChange: string;
  revenueGstRate: ScenarioGstRate;
  /** More (or less) deductible expenses, before GST. */
  expenseChange: string;
  /** The GST rate on those expenses, claimed back as input credit. */
  expenseGstRate: ScenarioGstRate;
  /** Depreciation on new assets: lowers taxable income and profit, not cash. */
  extraDepreciation: string;
  /** Expenses already in the books that are not deductible (penalties, for example): added back. */
  disallowed: string;
}

export interface TaxScenarioResult {
  regime: AdvanceTaxRegime;
  bookProfit: Dec;
  taxableIncome: Dec;
  tax: ReturnType<typeof corporateTax>;
  baseTax: Dec;
  taxChange: Dec;
  netPayable: Dec;
  profitAfterTax: Dec;
  /** Tax as a percentage of book profit, one decimal; null without a profit. */
  effectiveRate: string | null;
  gst: { output: Dec; input: Dec; net: Dec };
  cashEffect: Dec;
  notes: string[];
}

const pct = (amount: Dec, rate: string) => amount.times(rate).div(100).toDecimalPlaces(2);

export function simulateTaxScenario(base: TaxScenarioBase, s: TaxScenarioInput): TaxScenarioResult {
  const regime = s.regime ?? base.regime;
  const income = new D(base.income.toString());
  const revenue = new D(s.revenueChange);
  const expense = new D(s.expenseChange);
  const depreciation = new D(s.extraDepreciation);
  const disallowed = new D(s.disallowed);
  const bookProfit = income.plus(revenue).minus(expense).minus(depreciation);
  const taxableIncome = bookProfit.plus(disallowed);
  const tax = corporateTax(taxableIncome, regime);
  const baseTax = corporateTax(income, base.regime).total;
  const taxChange = tax.total.minus(baseTax);
  const output = pct(revenue, s.revenueGstRate);
  const input = pct(expense, s.expenseGstRate);
  const notes: string[] = [];
  if (taxableIncome.lte(0)) notes.push('Taxable income is nil or a loss: no tax for the year. A loss carried forward is not modelled.');
  if (regime !== base.regime) notes.push(`Changes the regime from "${ADVANCE_TAX_REGIME[base.regime].label}" to "${ADVANCE_TAX_REGIME[regime].label}".`);
  if (regime === 'COMPANY_22' && base.regime !== 'COMPANY_22') notes.push('The 22% rate gives up most exemptions and deductions and, once chosen, cannot be withdrawn.');
  if (regime === 'COMPANY_25' && base.regime !== 'COMPANY_25') notes.push('The 25% rate applies only if turnover two years before was ₹400 crore or less.');
  if (disallowed.gt(0)) notes.push('Expenses that are not deductible raise the tax but not the profit in the books.');
  return {
    regime,
    bookProfit,
    taxableIncome,
    tax,
    baseTax,
    taxChange,
    netPayable: D.max(tax.total.minus(base.credits.toString()), 0),
    profitAfterTax: bookProfit.minus(tax.total),
    effectiveRate: bookProfit.gt(0) ? tax.total.times(100).div(bookProfit).toDecimalPlaces(1).toFixed(1) : null,
    gst: { output, input, net: output.minus(input) },
    cashEffect: revenue.minus(expense).minus(taxChange),
    notes,
  };
}

/** The tax on one income under each regime open to the same kind of business, lowest first. */
export function compareRegimes(income: Dec | string, current: AdvanceTaxRegime): { regime: AdvanceTaxRegime; label: string; total: Dec; current: boolean }[] {
  const company = current.startsWith('COMPANY');
  return ADVANCE_TAX_REGIMES.filter((r) => r.startsWith('COMPANY') === company)
    .map((r) => ({ regime: r, label: ADVANCE_TAX_REGIME[r].label, total: corporateTax(income, r).total, current: r === current }))
    .sort((a, b) => a.total.comparedTo(b.total) || ADVANCE_TAX_REGIMES.indexOf(a.regime) - ADVANCE_TAX_REGIMES.indexOf(b.regime));
}
