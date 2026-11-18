import { D, Dec } from '@talk2tax/accounting-engine';

/**
 * Advance income tax for a business that is not an individual: the tax on the year's estimated
 * income, and how much of it should have been paid by each instalment date.
 *
 * Rates are those in force for domestic companies, firms and LLPs (Finance Act 2025, unchanged
 * for tax year 2026-27 as far as this module knows): they change with each Finance Act and must
 * be checked against the year's Act before relying on them. Individuals and HUFs (slab rates),
 * presumptive income (a single instalment by 15 March), minimum alternate tax and interest for
 * late or short instalments are not covered.
 */

export const ADVANCE_TAX_REGIMES = ['COMPANY_22', 'COMPANY_25', 'COMPANY_30', 'FIRM_30'] as const;
export type AdvanceTaxRegime = (typeof ADVANCE_TAX_REGIMES)[number];

interface RegimeDef {
  label: string;
  rate: string;
  /** Surcharge bands on the tax, by income above which they apply, lowest first. */
  surcharge: { above: string; rate: string }[];
  note: string;
}

const CRORE = '10000000';

export const ADVANCE_TAX_REGIME: Record<AdvanceTaxRegime, RegimeDef> = {
  COMPANY_22: {
    label: 'Company, concessional rate (22%)',
    rate: '0.22',
    surcharge: [{ above: '0', rate: '0.10' }],
    note: 'A domestic company that opted for the 22% rate without exemptions and deductions: surcharge 10% whatever the income.',
  },
  COMPANY_25: {
    label: 'Company, turnover up to ₹400 crore (25%)',
    rate: '0.25',
    surcharge: [
      { above: CRORE, rate: '0.07' },
      { above: '100000000', rate: '0.12' },
    ],
    note: 'A domestic company whose turnover two years before was ₹400 crore or less: surcharge 7% above ₹1 crore and 12% above ₹10 crore.',
  },
  COMPANY_30: {
    label: 'Company, other (30%)',
    rate: '0.30',
    surcharge: [
      { above: CRORE, rate: '0.07' },
      { above: '100000000', rate: '0.12' },
    ],
    note: 'Any other domestic company: surcharge 7% above ₹1 crore and 12% above ₹10 crore.',
  },
  FIRM_30: {
    label: 'Firm or LLP (30%)',
    rate: '0.30',
    surcharge: [{ above: CRORE, rate: '0.12' }],
    note: 'A partnership firm or LLP: surcharge 12% above ₹1 crore.',
  },
};

/** Health and education cess on the tax and surcharge. */
export const CESS_RATE = '0.04';
/** Advance tax is payable only when the year's tax, less tax deducted or collected at source, is this much or more. */
export const ADVANCE_TAX_THRESHOLD = '10000';

/** Rounds to the nearest ten rupees, half up, as income and tax are rounded for the return. */
const toTen = (x: Dec) => x.div(10).toDecimalPlaces(0, D.ROUND_HALF_UP).times(10);

function bandRate(def: RegimeDef, income: Dec): Dec {
  let r = new D(0);
  for (const b of def.surcharge) if (income.gt(b.above)) r = new D(b.rate);
  return r;
}

export interface CorporateTax {
  income: Dec;
  tax: Dec;
  surchargeRate: Dec;
  surcharge: Dec;
  /** Surcharge given up so that crossing a threshold never costs more than the income above it. */
  marginalRelief: Dec;
  cess: Dec;
  total: Dec;
}

/** Tax, surcharge (with marginal relief at each threshold) and cess on a year's taxable income. */
export function corporateTax(incomeIn: Dec | string, regime: AdvanceTaxRegime): CorporateTax {
  const def = ADVANCE_TAX_REGIME[regime];
  const income = D.max(toTen(new D(incomeIn.toString())), 0);
  const tax = income.times(def.rate);
  const surchargeRate = bandRate(def, income);
  const surcharge = tax.times(surchargeRate);
  let relief = new D(0);
  // The band this income crossed into; its threshold is where marginal relief is measured.
  const crossed = [...def.surcharge].reverse().find((b) => new D(b.above).gt(0) && income.gt(b.above));
  if (crossed) {
    const at = new D(crossed.above);
    const atThreshold = at.times(def.rate).times(new D(1).plus(bandRate(def, at)));
    const cap = atThreshold.plus(income.minus(at));
    relief = D.max(tax.plus(surcharge).minus(cap), 0);
  }
  const beforeCess = tax.plus(surcharge).minus(relief);
  const cess = beforeCess.times(CESS_RATE);
  return {
    income,
    tax: tax.toDecimalPlaces(2),
    surchargeRate,
    surcharge: surcharge.toDecimalPlaces(2),
    marginalRelief: relief.toDecimalPlaces(2),
    cess: cess.toDecimalPlaces(2),
    total: toTen(beforeCess.plus(cess)),
  };
}

const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

export type IncomeMethod = 'ANNUALISE' | 'ESTIMATE';

/**
 * The year's income before adjustments: the profit in the books so far scaled up to a full year by
 * days, or the organisation's own estimate. A year that has ended uses the books as they are.
 */
export function projectedIncome(input: { profitToDate: Dec | string; from: string; to: string; asOf: string; method: IncomeMethod; estimate?: Dec | string | null }): { amount: Dec; daysElapsed: number; daysInYear: number } {
  const daysInYear = days(input.from, input.to);
  const asOf = input.asOf > input.to ? input.to : input.asOf;
  const daysElapsed = asOf < input.from ? 0 : days(input.from, asOf);
  if (input.method === 'ESTIMATE') {
    if (input.estimate == null) throw new Error('An estimate is needed');
    return { amount: new D(input.estimate.toString()), daysElapsed, daysInYear };
  }
  const profit = new D(input.profitToDate.toString());
  const amount = daysElapsed === 0 ? new D(0) : daysElapsed >= daysInYear ? profit : profit.times(daysInYear).div(daysElapsed).toDecimalPlaces(2);
  return { amount, daysElapsed, daysInYear };
}

export const ADVANCE_TAX_SHARES = [
  { month: '06', share: '0.15' },
  { month: '09', share: '0.45' },
  { month: '12', share: '0.75' },
  { month: '03', share: '1' },
] as const;

export interface AdvanceTaxInstalment {
  number: number;
  dueDate: string;
  /** Cumulative share of the year's tax payable by the due date. */
  share: Dec;
  required: Dec;
  paidByDue: Dec;
  /** PAID: enough was paid by the date; SHORT: the date passed with less paid; UPCOMING: still to come. */
  status: 'PAID' | 'SHORT' | 'UPCOMING';
  /** What is still to pay for this instalment (for a passed date, what was short by it). */
  toPay: Dec;
}

/** The four instalment dates of a tax year starting on 1 April `fromYear`, with what was due and paid by each. */
export function advanceTaxInstalments(taxYearFrom: string, netLiability: Dec | string, payments: readonly { date: string; amount: Dec | string }[], today: string): AdvanceTaxInstalment[] {
  const y = Number(taxYearFrom.slice(0, 4));
  const net = D.max(new D(netLiability.toString()), 0);
  const paidTo = (date: string) => payments.filter((p) => p.date <= date).reduce((s, p) => s.plus(p.amount.toString()), new D(0));
  const paidNow = paidTo(today);
  return ADVANCE_TAX_SHARES.map((s, i) => {
    const dueDate = `${s.month === '03' ? y + 1 : y}-${s.month}-15`;
    const required = net.times(s.share).toDecimalPlaces(0, D.ROUND_HALF_UP);
    const paidByDue = paidTo(dueDate);
    const passed = dueDate < today;
    const status = paidByDue.gte(required) ? 'PAID' : passed ? 'SHORT' : 'UPCOMING';
    const toPay = D.max(required.minus(passed ? paidByDue : paidNow), 0);
    return { number: i + 1, dueDate, share: new D(s.share), required, paidByDue, status, toPay };
  });
}
