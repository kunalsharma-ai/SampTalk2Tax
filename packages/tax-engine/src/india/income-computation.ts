/**
 * Income tax computation (TAX-019, TAX-020): the computation of total income and tax for a
 * company or firm for one financial year, as prepared for the return of income. It starts from
 * the profit before tax in the books and makes the usual adjustments under the Income-tax Act:
 *
 * - Section 32: depreciation charged in the books is added back and depreciation allowed under
 *   the Act (entered from the block-of-assets working) is deducted.
 * - Section 40A(3): cash payments to one person in one day over 10,000 (from the tax audit
 *   working) are added back.
 * - Other additions and deductions entered by the preparer, each with its section.
 * - Section 72: business loss brought forward is set off against this year's business income,
 *   up to that income; a loss this year is carried forward.
 *
 * Tax is worked out with the corporate rates (see advance-tax.ts: rate, surcharge with marginal
 * relief, cess, income rounded to the nearest 10 under section 288A), less TDS, advance tax and
 * other tax paid, giving the self-assessment tax to pay or the refund due. It prepares figures for
 * a professional to check; it does not compute interest under sections 234A-C or MAT, and files
 * nothing.
 */
import { D, type Dec } from '@talk2tax/accounting-engine';
import { type AdvanceTaxRegime, corporateTax } from './advance-tax';

export const COMPUTATION_ADJUSTMENT_KINDS = ['ADD', 'DEDUCT'] as const;
export type ComputationAdjustmentKind = (typeof COMPUTATION_ADJUSTMENT_KINDS)[number];

export interface IncomeComputationInput {
  profitBeforeTax: string;
  /** Income tax charged in the books, left out of profitBeforeTax; shown for reference. */
  taxInBooks: string;
  bookDepreciation: string;
  /** Depreciation under section 32; null when not entered yet. */
  taxDepreciation: string | null;
  cashDisallowance: string;
  adjustments: readonly { label: string; section: string | null; kind: ComputationAdjustmentKind; amount: string }[];
  broughtForwardLoss: string;
  regime: AdvanceTaxRegime;
  credits: { tds: string; advanceTax: string; other: string };
}

export interface ComputationLine {
  key: string;
  label: string;
  section: string | null;
  kind: 'START' | 'ADD' | 'DEDUCT';
  amount: string;
}

const f = (x: Dec) => x.toFixed(2);

export function incomeComputation(i: IncomeComputationInput) {
  const lines: ComputationLine[] = [{ key: 'PROFIT', label: 'Net profit before tax as per the books', section: null, kind: 'START', amount: f(new D(i.profitBeforeTax)) }];
  const warnings: string[] = [];
  const add = (key: string, label: string, section: string | null, kind: 'ADD' | 'DEDUCT', amount: Dec) => {
    if (!amount.isZero()) lines.push({ key, label, section, kind, amount: f(amount) });
  };
  const bookDep = new D(i.bookDepreciation);
  add('BOOK_DEPRECIATION', 'Depreciation charged in the books', '32', 'ADD', bookDep);
  if (i.taxDepreciation !== null) add('TAX_DEPRECIATION', 'Depreciation allowed under the Income-tax Act', '32', 'DEDUCT', new D(i.taxDepreciation));
  else if (bookDep.gt(0)) warnings.push('Enter the depreciation allowed under section 32 from the block-of-assets working; until then none is deducted.');
  add('CASH_PAYMENTS', 'Cash payments over 10,000 to one person in a day', '40A(3)', 'ADD', new D(i.cashDisallowance));
  i.adjustments.forEach((a, n) => add(`ADJUSTMENT_${n + 1}`, a.label, a.section, a.kind, new D(a.amount)));

  const businessIncome = lines.reduce((s, l) => (l.kind === 'DEDUCT' ? s.minus(l.amount) : s.plus(l.amount)), new D(0));
  const broughtForward = new D(i.broughtForwardLoss);
  const setOff = D.min(broughtForward, D.max(businessIncome, 0));
  const totalIncome = businessIncome.minus(setOff);
  const lossCarriedForward = businessIncome.lt(0) ? broughtForward.plus(businessIncome.negated()) : broughtForward.minus(setOff);
  const tax = corporateTax(D.max(totalIncome, 0), i.regime);
  const credits = new D(i.credits.tds).plus(i.credits.advanceTax).plus(i.credits.other);
  const balance = tax.total.minus(credits);
  if (businessIncome.lt(0)) warnings.push('There is a loss this year: no tax is due, and the loss is carried forward if the return is filed on time (section 80).');

  return {
    lines,
    businessIncome: f(businessIncome),
    broughtForwardLoss: f(broughtForward),
    lossSetOff: f(setOff),
    totalIncome: f(D.max(totalIncome, 0)),
    /** Total income rounded to the nearest 10 (section 288A), on which tax is worked out. */
    roundedIncome: f(tax.income),
    lossCarriedForward: f(lossCarriedForward),
    taxInBooks: f(new D(i.taxInBooks)),
    tax: { tax: f(tax.tax), surchargeRate: tax.surchargeRate.times(100).toFixed(), surcharge: f(tax.surcharge), marginalRelief: f(tax.marginalRelief), cess: f(tax.cess), total: f(tax.total) },
    credits: { tds: f(new D(i.credits.tds)), advanceTax: f(new D(i.credits.advanceTax)), other: f(new D(i.credits.other)), total: f(credits) },
    payable: f(D.max(balance, 0)),
    refund: f(D.max(balance.negated(), 0)),
    warnings,
  };
}

export type IncomeComputation = ReturnType<typeof incomeComputation>;
