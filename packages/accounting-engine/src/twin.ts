import { D, Dec, dec } from './money';

/**
 * Financial digital twin: a monthly model of the organisation built from its own posted figures,
 * on which hypothetical changes ("drivers") are played forward. Nothing here touches the books:
 * the baseline is read from actuals, and every projected figure is hypothetical.
 *
 * Method, per projected month m (0 = the month after the last actual month):
 *  - Volume index: 1, compounded by revenue growth, changed by price-volume effects, churn,
 *    downturns. Revenue = base revenue × volume × price factor × currency factor + expansion
 *    revenue. Cost of sales follows volume (not price), times supplier cost and inflation factors.
 *  - Payroll and other operating costs are inflated, plus hires, expense changes and expansion
 *    costs. Depreciation adds new investments straight-line; interest adds new debt (EMI loans).
 *  - Tax is the tax rate on positive profit before tax, month by month (no loss carry-forward).
 *  - Working capital: receivables = revenue × collection days / 30, payables = (cost of sales +
 *    other operating costs) × payment days / 30. Starting from the actual balances, the change is
 *    a cash movement. Cash = net profit + depreciation − working capital change − investments +
 *    loan proceeds − loan principal + cash-only one-offs.
 */

export const DRIVER_KINDS = [
  'REVENUE_GROWTH',
  'PRICE_CHANGE',
  'CHURN',
  'HIRING',
  'EXPENSE_CHANGE',
  'SUPPLIER_COST',
  'NEW_DEBT',
  'INVESTMENT',
  'EXPANSION',
  'CURRENCY',
  'INFLATION',
  'DOWNTURN',
  'WORKING_CAPITAL',
  'TAX_RATE',
  'ONE_OFF',
] as const;
export type DriverKind = (typeof DRIVER_KINDS)[number];

/** Month numbers are 1-based offsets into the projection (1 = the first projected month). */
export type TwinDriver =
  | { kind: 'REVENUE_GROWTH'; percentPerMonth: string; fromMonth?: number }
  | { kind: 'PRICE_CHANGE'; pricePercent: string; volumePercent: string; fromMonth?: number }
  | { kind: 'CHURN'; percentPerMonth: string; fromMonth?: number }
  | { kind: 'HIRING'; count: number; monthlyCostPerHead: string; oneOffCostPerHead?: string; fromMonth?: number }
  | { kind: 'EXPENSE_CHANGE'; target: 'COST_OF_SALES' | 'PAYROLL' | 'OPERATING'; percent?: string; monthlyAmount?: string; fromMonth?: number }
  | { kind: 'SUPPLIER_COST'; percent: string; fromMonth?: number }
  | { kind: 'NEW_DEBT'; amount: string; annualRatePercent: string; termMonths: number; month?: number }
  | { kind: 'INVESTMENT'; amount: string; usefulLifeMonths: number; month?: number }
  | { kind: 'EXPANSION'; oneOffCost: string; monthlyCost: string; monthlyRevenue: string; rampMonths: number; month?: number; costOfSalesPercent?: string }
  | { kind: 'CURRENCY'; exposurePercent: string; changePercent: string; fromMonth?: number }
  | { kind: 'INFLATION'; annualPercent: string }
  | { kind: 'DOWNTURN'; revenuePercent: string; extraCollectionDays: number; fromMonth?: number; months?: number }
  | { kind: 'WORKING_CAPITAL'; collectionDaysChange: number; paymentDaysChange: number; fromMonth?: number }
  | { kind: 'TAX_RATE'; percent: string }
  | { kind: 'ONE_OFF'; label: string; amount: string; month?: number; affectsProfit: boolean };

/** A driver as stored: an optional client id, a label, and the department it belongs to (for impact by department). */
export type TwinDriverWithMeta = TwinDriver & { id?: string; label?: string | null; departmentId?: string | null };

export interface TwinActualMonth {
  /** YYYY-MM */
  month: string;
  revenue: string;
  otherIncome: string;
  costOfSales: string;
  payroll: string;
  /** Operating expenses other than payroll and depreciation. */
  otherOperating: string;
  depreciation: string;
  interest: string;
  incomeTax: string;
  otherExpenses: string;
  /** Balances at the month end. */
  cash: string;
  receivables: string;
  payables: string;
}

export interface TwinBaseline {
  /** The actual months the baseline averages, oldest first. */
  months: TwinActualMonth[];
  currency: string;
  scale: number;
}

export interface TwinMonth {
  index: number;
  month: string;
  revenue: string;
  otherIncome: string;
  costOfSales: string;
  grossProfit: string;
  payroll: string;
  otherOperating: string;
  otherExpenses: string;
  ebitda: string;
  depreciation: string;
  interest: string;
  profitBeforeTax: string;
  tax: string;
  netProfit: string;
  receivables: string;
  payables: string;
  workingCapitalChange: string;
  investment: string;
  loanProceeds: string;
  loanPrincipal: string;
  oneOffCash: string;
  cashFlow: string;
  closingCash: string;
  headcountAdded: number;
}

export interface TwinProjection {
  months: TwinMonth[];
  totals: { revenue: string; netProfit: string; ebitda: string; cashFlow: string; netMarginPercent: string | null };
  openingCash: string;
  closingCash: string;
  minimumCash: { amount: string; month: string };
  /** First month the cash balance goes below zero, if any. */
  cashNegativeFrom: string | null;
  /** Money to raise to keep the balance at or above the buffer throughout. */
  cashRequired: string;
  /** First month with a positive net profit when the first projected month makes a loss. */
  breakEvenMonth: string | null;
}

export interface TwinBaselineSummary {
  fromMonth: string;
  toMonth: string;
  monthsUsed: number;
  revenue: string;
  costOfSales: string;
  payroll: string;
  otherOperating: string;
  otherIncome: string;
  otherExpenses: string;
  depreciation: string;
  interest: string;
  cash: string;
  receivables: string;
  payables: string;
  collectionDays: string;
  paymentDays: string;
  taxRatePercent: string;
  taxRateSource: 'SCENARIO' | 'HISTORY' | 'NONE';
}

export interface TwinRisk {
  level: 'HIGH' | 'MEDIUM' | 'LOW';
  code: string;
  message: string;
}

export interface TwinMissing {
  field: string;
  question: string;
}

export interface TwinResult {
  baseline: TwinBaselineSummary;
  projection: TwinProjection;
  assumptions: string[];
  risks: TwinRisk[];
  missing: TwinMissing[];
}

export class TwinError extends Error {
  constructor(
    message: string,
    public readonly issues: string[] = [],
  ) {
    super(message);
    this.name = 'TwinError';
  }
}

const NUM = /^-?\d{1,14}(\.\d{1,6})?$/;

export function shiftYm(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

/** Problems with a driver's fields, in words a user can act on. */
export function checkDriver(d: TwinDriver, horizon: number): string[] {
  const issues: string[] = [];
  const num = (v: unknown, label: string, opts: { min?: number; max?: number; positive?: boolean } = {}) => {
    if (typeof v !== 'string' || !NUM.test(v)) return issues.push(`${label}: enter a number`);
    const x = dec(v);
    if (opts.positive && x.lte(0)) issues.push(`${label} must be above zero`);
    if (opts.min !== undefined && x.lt(opts.min)) issues.push(`${label} must be at least ${opts.min}`);
    if (opts.max !== undefined && x.gt(opts.max)) issues.push(`${label} must be at most ${opts.max}`);
  };
  const int = (v: unknown, label: string, min: number, max: number) => {
    if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) issues.push(`${label} must be a whole number from ${min} to ${max}`);
  };
  const month = (v: number | undefined, label = 'Starting month') => {
    if (v !== undefined) int(v, label, 1, horizon);
  };
  switch (d.kind) {
    case 'REVENUE_GROWTH':
      num(d.percentPerMonth, 'Growth per month (%)', { min: -50, max: 100 });
      month(d.fromMonth);
      break;
    case 'PRICE_CHANGE':
      num(d.pricePercent, 'Price change (%)', { min: -90, max: 500 });
      num(d.volumePercent, 'Volume change (%)', { min: -100, max: 500 });
      month(d.fromMonth);
      break;
    case 'CHURN':
      num(d.percentPerMonth, 'Customers lost per month (%)', { min: 0, max: 100 });
      month(d.fromMonth);
      break;
    case 'HIRING':
      int(d.count, 'People hired', 1, 10000);
      num(d.monthlyCostPerHead, 'Monthly cost per person', { positive: true });
      if (d.oneOffCostPerHead !== undefined) num(d.oneOffCostPerHead, 'One-off cost per person', { min: 0 });
      month(d.fromMonth);
      break;
    case 'EXPENSE_CHANGE':
      if (d.percent === undefined && d.monthlyAmount === undefined) issues.push('Enter a percentage or a monthly amount');
      if (d.percent !== undefined) num(d.percent, 'Change (%)', { min: -100, max: 1000 });
      if (d.monthlyAmount !== undefined) num(d.monthlyAmount, 'Monthly amount');
      if (!['COST_OF_SALES', 'PAYROLL', 'OPERATING'].includes(d.target)) issues.push('Choose which costs change');
      month(d.fromMonth);
      break;
    case 'SUPPLIER_COST':
      num(d.percent, 'Supplier cost change (%)', { min: -90, max: 500 });
      month(d.fromMonth);
      break;
    case 'NEW_DEBT':
      num(d.amount, 'Loan amount', { positive: true });
      num(d.annualRatePercent, 'Interest rate (% a year)', { min: 0, max: 100 });
      int(d.termMonths, 'Term in months', 1, 600);
      month(d.month, 'Month received');
      break;
    case 'INVESTMENT':
      num(d.amount, 'Investment amount', { positive: true });
      int(d.usefulLifeMonths, 'Useful life in months', 1, 1200);
      month(d.month, 'Month bought');
      break;
    case 'EXPANSION':
      num(d.oneOffCost, 'One-off cost', { min: 0 });
      num(d.monthlyCost, 'Monthly running cost', { min: 0 });
      num(d.monthlyRevenue, 'Monthly revenue at full speed', { min: 0 });
      int(d.rampMonths, 'Months to reach full speed', 1, 60);
      month(d.month, 'Opening month');
      if (d.costOfSalesPercent !== undefined) num(d.costOfSalesPercent, 'Cost of sales on the new revenue (%)', { min: 0, max: 100 });
      break;
    case 'CURRENCY':
      num(d.exposurePercent, 'Revenue in foreign currency (%)', { min: 0, max: 100 });
      num(d.changePercent, 'Change in the exchange rate (%)', { min: -90, max: 500 });
      month(d.fromMonth);
      break;
    case 'INFLATION':
      num(d.annualPercent, 'Cost inflation (% a year)', { min: -20, max: 200 });
      break;
    case 'DOWNTURN':
      num(d.revenuePercent, 'Revenue drop (%)', { min: 0, max: 100 });
      int(d.extraCollectionDays, 'Extra days customers take to pay', 0, 365);
      month(d.fromMonth);
      if (d.months !== undefined) int(d.months, 'Months it lasts', 1, horizon);
      break;
    case 'WORKING_CAPITAL':
      int(d.collectionDaysChange, 'Change in collection days', -365, 365);
      int(d.paymentDaysChange, 'Change in payment days', -365, 365);
      month(d.fromMonth);
      break;
    case 'TAX_RATE':
      num(d.percent, 'Income tax rate (%)', { min: 0, max: 100 });
      break;
    case 'ONE_OFF':
      if (!d.label?.trim()) issues.push('Describe the one-off item');
      num(d.amount, 'Amount (positive for money in, negative for money out)');
      month(d.month, 'Month');
      break;
    default:
      issues.push('Unknown kind of change');
  }
  return issues;
}

const pct = (v: string) => dec(v).div(100);
const from = (d: { fromMonth?: number }) => d.fromMonth ?? 1;

/** Plain-language description of a driver, for the assumptions list. */
export function describeDriver(d: TwinDriver, fmt: (v: Dec | string) => string, monthName: (n: number) => string): string {
  const at = (n: number | undefined) => monthName(n ?? 1);
  switch (d.kind) {
    case 'REVENUE_GROWTH':
      return `Sales volume grows ${d.percentPerMonth}% a month from ${at(d.fromMonth)}.`;
    case 'PRICE_CHANGE':
      return `Prices change ${d.pricePercent}% from ${at(d.fromMonth)}, with sales volume changing ${d.volumePercent}% in response.`;
    case 'CHURN':
      return `${d.percentPerMonth}% of the customer base is lost each month from ${at(d.fromMonth)}.`;
    case 'HIRING':
      return `${d.count} ${d.count === 1 ? 'person joins' : 'people join'} in ${at(d.fromMonth)} at ${fmt(d.monthlyCostPerHead)} a month each${d.oneOffCostPerHead && !dec(d.oneOffCostPerHead).isZero() ? `, with a one-off cost of ${fmt(d.oneOffCostPerHead)} each` : ''}.`;
    case 'EXPENSE_CHANGE': {
      const what = { COST_OF_SALES: 'Cost of sales', PAYROLL: 'Payroll', OPERATING: 'Other operating costs' }[d.target];
      const parts = [d.percent !== undefined ? `change ${d.percent}%` : null, d.monthlyAmount !== undefined ? `change by ${fmt(d.monthlyAmount)} a month` : null].filter(Boolean);
      return `${what} ${parts.join(' and ')} from ${at(d.fromMonth)}.`;
    }
    case 'SUPPLIER_COST':
      return `Supplier costs (cost of sales) change ${d.percent}% from ${at(d.fromMonth)}.`;
    case 'NEW_DEBT':
      return `A loan of ${fmt(d.amount)} is received in ${at(d.month)} at ${d.annualRatePercent}% a year, repaid in ${d.termMonths} equal monthly instalments starting the month after.`;
    case 'INVESTMENT':
      return `An investment of ${fmt(d.amount)} is paid in ${at(d.month)} and depreciated straight-line over ${d.usefulLifeMonths} months from the month after.`;
    case 'EXPANSION':
      return `An expansion opening in ${at(d.month)} costs ${fmt(d.oneOffCost)} once and ${fmt(d.monthlyCost)} a month, and brings revenue rising evenly to ${fmt(d.monthlyRevenue)} a month over ${d.rampMonths} months${d.costOfSalesPercent !== undefined && !dec(d.costOfSalesPercent).isZero() ? `, with cost of sales of ${d.costOfSalesPercent}% of that revenue` : ''}.`;
    case 'CURRENCY':
      return `${d.exposurePercent}% of revenue is earned in foreign currency, whose exchange rate changes ${d.changePercent}% from ${at(d.fromMonth)}.`;
    case 'INFLATION':
      return `Costs rise ${d.annualPercent}% a year, compounded monthly.`;
    case 'DOWNTURN':
      return `A downturn from ${at(d.fromMonth)}${d.months ? ` lasting ${d.months} months` : ''} cuts revenue ${d.revenuePercent}% and customers take ${d.extraCollectionDays} days longer to pay.`;
    case 'WORKING_CAPITAL':
      return `From ${at(d.fromMonth)}, customers pay ${Math.abs(d.collectionDaysChange)} days ${d.collectionDaysChange >= 0 ? 'later' : 'sooner'} and suppliers are paid ${Math.abs(d.paymentDaysChange)} days ${d.paymentDaysChange >= 0 ? 'later' : 'sooner'}.`;
    case 'TAX_RATE':
      return `Income tax is ${d.percent}% of profit before tax.`;
    case 'ONE_OFF':
      return `${d.label}: ${fmt(d.amount)} in ${at(d.month)}${d.affectsProfit ? ', through profit' : ', cash only'}.`;
  }
}

function emi(principal: Dec, monthlyRate: Dec, n: number): Dec {
  if (monthlyRate.isZero()) return principal.div(n);
  const f = monthlyRate.plus(1).pow(n);
  return principal.times(monthlyRate).times(f).div(f.minus(1));
}

/**
 * Builds the baseline from actual months and projects it with the drivers.
 * `cashBuffer` is the minimum balance to keep (the cash flow forecast's setting).
 */
export function runTwin(input: { baseline: TwinBaseline; drivers: readonly TwinDriver[]; horizonMonths: number; cashBuffer?: string | null }): TwinResult {
  const { baseline, drivers, horizonMonths: H } = input;
  const scale = baseline.scale;
  const r = (x: Dec) => x.toDecimalPlaces(scale, D.ROUND_HALF_UP);
  const f = (x: Dec) => r(x).toFixed(scale);
  if (!Number.isInteger(H) || H < 1 || H > 60) throw new TwinError('Choose a horizon from 1 to 60 months');
  if (!baseline.months.length) throw new TwinError('There are no actual months to build the baseline from');
  const issues = drivers.flatMap((d, i) => checkDriver(d, H).map((m) => `Change ${i + 1}: ${m}`));
  if (issues.length) throw new TwinError('Some changes need fixing', issues);

  // ---- baseline: monthly averages of the actual months, balances at the last one.
  const n = baseline.months.length;
  const avg = (k: keyof Omit<TwinActualMonth, 'month'>) => baseline.months.reduce((a, m) => a.plus(m[k]), new D(0)).div(n);
  const last = baseline.months[n - 1]!;
  const b = {
    revenue: avg('revenue'),
    otherIncome: avg('otherIncome'),
    costOfSales: avg('costOfSales'),
    payroll: avg('payroll'),
    otherOperating: avg('otherOperating'),
    depreciation: avg('depreciation'),
    interest: avg('interest'),
    incomeTax: avg('incomeTax'),
    otherExpenses: avg('otherExpenses'),
    cash: dec(last.cash),
    receivables: dec(last.receivables),
    payables: dec(last.payables),
  };
  const purchases = b.costOfSales.plus(b.otherOperating);
  const collectionDays = b.revenue.gt(0) ? b.receivables.div(b.revenue).times(30) : new D(0);
  const paymentDays = purchases.gt(0) ? b.payables.div(purchases).times(30) : new D(0);
  const pbtBase = b.revenue.plus(b.otherIncome).minus(b.costOfSales).minus(b.payroll).minus(b.otherOperating).minus(b.otherExpenses).minus(b.depreciation).minus(b.interest);
  const taxDriver = [...drivers].reverse().find((d): d is Extract<TwinDriver, { kind: 'TAX_RATE' }> => d.kind === 'TAX_RATE');
  const historyRate = pbtBase.gt(0) && b.incomeTax.gt(0) ? b.incomeTax.div(pbtBase).times(100) : null;
  const taxRate = taxDriver ? dec(taxDriver.percent) : historyRate ? historyRate.toDecimalPlaces(2) : new D(0);
  const taxRateSource: TwinBaselineSummary['taxRateSource'] = taxDriver ? 'SCENARIO' : historyRate ? 'HISTORY' : 'NONE';
  const firstMonth = shiftYm(last.month, 1);
  const monthOf = (i: number) => shiftYm(firstMonth, i - 1);
  const active = (start: number, i: number, months?: number) => i >= start && (months === undefined || i < start + months);

  // ---- projection
  const out: TwinMonth[] = [];
  let cash = b.cash;
  let prevAr = b.receivables;
  let prevAp = b.payables;
  const loans = drivers.filter((d): d is Extract<TwinDriver, { kind: 'NEW_DEBT' }> => d.kind === 'NEW_DEBT').map((d) => ({ d, balance: new D(0), started: false }));
  const inflation = drivers.filter((d): d is Extract<TwinDriver, { kind: 'INFLATION' }> => d.kind === 'INFLATION').reduce((a, d) => a.times(pct(d.annualPercent).plus(1)), new D(1));
  const monthlyInflation = inflation.pow(new D(1).div(12));
  let growth = new D(1);
  for (let i = 1; i <= H; i++) {
    let volume = new D(1);
    let price = new D(1);
    let fx = new D(1);
    let supplier = new D(1);
    let cosFactor = new D(1);
    let payrollFactor = new D(1);
    let opexFactor = new D(1);
    let extraCos = new D(0);
    let extraPayroll = new D(0);
    let extraOpex = new D(0);
    let extraRevenue = new D(0);
    let extraOtherIncome = new D(0);
    let extraOtherExpense = new D(0);
    let extraCollection = new D(0);
    let extraPayment = new D(0);
    let investment = new D(0);
    let extraDep = new D(0);
    let oneOffCash = new D(0);
    let headcount = 0;
    for (const d of drivers) {
      switch (d.kind) {
        case 'REVENUE_GROWTH':
          if (i >= from(d)) growth = growth.times(pct(d.percentPerMonth).plus(1));
          break;
        case 'PRICE_CHANGE':
          if (i >= from(d)) {
            price = price.times(pct(d.pricePercent).plus(1));
            volume = volume.times(pct(d.volumePercent).plus(1));
          }
          break;
        case 'CHURN':
          if (i >= from(d)) volume = volume.times(new D(1).minus(pct(d.percentPerMonth)).pow(i - from(d) + 1));
          break;
        case 'HIRING':
          if (i >= from(d)) {
            extraPayroll = extraPayroll.plus(dec(d.monthlyCostPerHead).times(d.count));
            headcount += d.count;
          }
          if (i === from(d) && d.oneOffCostPerHead) extraOpex = extraOpex.plus(dec(d.oneOffCostPerHead).times(d.count));
          break;
        case 'EXPENSE_CHANGE':
          if (i >= from(d)) {
            const p = d.percent !== undefined ? pct(d.percent).plus(1) : new D(1);
            const amt = d.monthlyAmount !== undefined ? dec(d.monthlyAmount) : new D(0);
            if (d.target === 'COST_OF_SALES') (cosFactor = cosFactor.times(p)), (extraCos = extraCos.plus(amt));
            else if (d.target === 'PAYROLL') (payrollFactor = payrollFactor.times(p)), (extraPayroll = extraPayroll.plus(amt));
            else (opexFactor = opexFactor.times(p)), (extraOpex = extraOpex.plus(amt));
          }
          break;
        case 'SUPPLIER_COST':
          if (i >= from(d)) supplier = supplier.times(pct(d.percent).plus(1));
          break;
        case 'INVESTMENT': {
          const m = d.month ?? 1;
          if (i === m) investment = investment.plus(d.amount);
          if (i > m && i <= m + d.usefulLifeMonths) extraDep = extraDep.plus(dec(d.amount).div(d.usefulLifeMonths));
          break;
        }
        case 'EXPANSION': {
          const m = d.month ?? 1;
          if (i === m) extraOpex = extraOpex.plus(d.oneOffCost);
          if (i >= m) {
            extraOpex = extraOpex.plus(d.monthlyCost);
            const share = D.min(new D(i - m + 1).div(d.rampMonths), 1);
            const added = dec(d.monthlyRevenue).times(share);
            extraRevenue = extraRevenue.plus(added);
            // The cost of the goods or services behind the new revenue, when given.
            if (d.costOfSalesPercent !== undefined) extraCos = extraCos.plus(added.times(pct(d.costOfSalesPercent)));
          }
          break;
        }
        case 'CURRENCY':
          if (i >= from(d)) fx = fx.plus(pct(d.exposurePercent).times(pct(d.changePercent)));
          break;
        case 'DOWNTURN':
          if (active(from(d), i, d.months)) {
            volume = volume.times(new D(1).minus(pct(d.revenuePercent)));
            extraCollection = extraCollection.plus(d.extraCollectionDays);
          }
          break;
        case 'WORKING_CAPITAL':
          if (i >= from(d)) {
            extraCollection = extraCollection.plus(d.collectionDaysChange);
            extraPayment = extraPayment.plus(d.paymentDaysChange);
          }
          break;
        case 'ONE_OFF':
          if (i === (d.month ?? 1)) {
            const a = dec(d.amount);
            if (!d.affectsProfit) oneOffCash = oneOffCash.plus(a);
            else if (a.gte(0)) extraOtherIncome = extraOtherIncome.plus(a);
            else extraOtherExpense = extraOtherExpense.plus(a.negated());
          }
          break;
        default:
          break;
      }
    }
    const inflationNow = monthlyInflation.pow(i);
    const vol = growth.times(volume);
    const revenue = b.revenue.times(vol).times(price).times(fx).plus(extraRevenue);
    const costOfSales = b.costOfSales.times(vol).times(supplier).times(cosFactor).times(inflationNow).plus(extraCos);
    const payroll = b.payroll.times(payrollFactor).times(inflationNow).plus(extraPayroll);
    const otherOperating = b.otherOperating.times(opexFactor).times(inflationNow).plus(extraOpex);
    const otherIncome = b.otherIncome.plus(extraOtherIncome);
    const otherExpenses = b.otherExpenses.plus(extraOtherExpense);
    const depreciation = b.depreciation.plus(extraDep);

    // New loans: received in their month, repaid by EMI from the month after.
    let interestNew = new D(0);
    let principal = new D(0);
    let proceeds = new D(0);
    for (const l of loans) {
      const m = l.d.month ?? 1;
      const rate = pct(l.d.annualRatePercent).div(12);
      if (i === m) {
        proceeds = proceeds.plus(l.d.amount);
        l.balance = dec(l.d.amount);
      } else if (i > m && i <= m + l.d.termMonths && l.balance.gt(0)) {
        const pay = emi(dec(l.d.amount), rate, l.d.termMonths);
        const int = l.balance.times(rate);
        const prin = i === m + l.d.termMonths ? l.balance : D.min(pay.minus(int), l.balance);
        interestNew = interestNew.plus(int);
        principal = principal.plus(prin);
        l.balance = l.balance.minus(prin);
      }
    }
    const interest = b.interest.plus(interestNew);
    const ebitda = revenue.plus(otherIncome).minus(costOfSales).minus(payroll).minus(otherOperating).minus(otherExpenses);
    const pbt = ebitda.minus(depreciation).minus(interest);
    const tax = pbt.gt(0) ? pbt.times(taxRate).div(100) : new D(0);
    const net = pbt.minus(tax);
    const cDays = D.max(collectionDays.plus(extraCollection), 0);
    const pDays = D.max(paymentDays.plus(extraPayment), 0);
    const ar = revenue.times(cDays).div(30);
    const ap = costOfSales.plus(otherOperating).times(pDays).div(30);
    const wc = ar.minus(prevAr).minus(ap.minus(prevAp));
    prevAr = ar;
    prevAp = ap;
    const flow = net.plus(depreciation).minus(wc).minus(investment).plus(proceeds).minus(principal).plus(oneOffCash);
    cash = cash.plus(flow);
    out.push({
      index: i,
      month: monthOf(i),
      revenue: f(revenue),
      otherIncome: f(otherIncome),
      costOfSales: f(costOfSales),
      grossProfit: f(revenue.minus(costOfSales)),
      payroll: f(payroll),
      otherOperating: f(otherOperating),
      otherExpenses: f(otherExpenses),
      ebitda: f(ebitda),
      depreciation: f(depreciation),
      interest: f(interest),
      profitBeforeTax: f(pbt),
      tax: f(tax),
      netProfit: f(net),
      receivables: f(ar),
      payables: f(ap),
      workingCapitalChange: f(wc),
      investment: f(investment),
      loanProceeds: f(proceeds),
      loanPrincipal: f(principal),
      oneOffCash: f(oneOffCash),
      cashFlow: f(flow),
      closingCash: f(cash),
      headcountAdded: headcount,
    });
  }

  const sumOf = (k: keyof TwinMonth) => out.reduce((a, m) => a.plus(m[k] as string), new D(0));
  const totalRevenue = sumOf('revenue');
  const totalNet = sumOf('netProfit');
  const min = out.reduce((a, m) => (dec(m.closingCash).lt(a.amount) ? { amount: dec(m.closingCash), month: m.month } : a), { amount: dec(out[0]!.closingCash), month: out[0]!.month });
  const negative = out.find((m) => dec(m.closingCash).lt(0));
  const buffer = input.cashBuffer ? dec(input.cashBuffer) : new D(0);
  const required = D.max(buffer.minus(min.amount), 0);
  const breakEven = dec(out[0]!.netProfit).lt(0) ? (out.find((m) => dec(m.netProfit).gt(0))?.month ?? null) : null;
  const projection: TwinProjection = {
    months: out,
    totals: {
      revenue: f(totalRevenue),
      netProfit: f(totalNet),
      ebitda: f(sumOf('ebitda')),
      cashFlow: f(sumOf('cashFlow')),
      netMarginPercent: totalRevenue.gt(0) ? totalNet.div(totalRevenue).times(100).toFixed(1) : null,
    },
    openingCash: f(b.cash),
    closingCash: out[out.length - 1]!.closingCash,
    minimumCash: { amount: f(min.amount), month: min.month },
    cashNegativeFrom: negative?.month ?? null,
    cashRequired: f(required),
    breakEvenMonth: breakEven,
  };

  const fmt = (v: Dec | string) => `${baseline.currency} ${dec(v).toFixed(scale)}`;
  const monthName = (i: number) => monthOf(i);
  const baselineSummary: TwinBaselineSummary = {
    fromMonth: baseline.months[0]!.month,
    toMonth: last.month,
    monthsUsed: n,
    revenue: f(b.revenue),
    costOfSales: f(b.costOfSales),
    payroll: f(b.payroll),
    otherOperating: f(b.otherOperating),
    otherIncome: f(b.otherIncome),
    otherExpenses: f(b.otherExpenses),
    depreciation: f(b.depreciation),
    interest: f(b.interest),
    cash: f(b.cash),
    receivables: f(b.receivables),
    payables: f(b.payables),
    collectionDays: collectionDays.toFixed(1),
    paymentDays: paymentDays.toFixed(1),
    taxRatePercent: taxRate.toFixed(2),
    taxRateSource,
  };
  const assumptions = [
    `Baseline: the monthly average of ${n} actual month${n === 1 ? '' : 's'} (${baselineSummary.fromMonth} to ${baselineSummary.toMonth}) from the posted books: revenue ${fmt(b.revenue)}, cost of sales ${fmt(b.costOfSales)}, payroll ${fmt(b.payroll)}, other operating costs ${fmt(b.otherOperating)}.`,
    `Cash starts at ${fmt(b.cash)}, the bank and cash balance at the end of ${last.month}.`,
    `Customers pay in about ${collectionDays.toFixed(0)} days and suppliers are paid in about ${paymentDays.toFixed(0)} days, from the receivable and payable balances against the baseline's monthly figures.`,
    taxRateSource === 'SCENARIO'
      ? `Income tax at ${taxRate.toFixed(2)}% of profit, as set in this scenario, with no relief for losses.`
      : taxRateSource === 'HISTORY'
        ? `Income tax at ${taxRate.toFixed(2)}% of profit, the rate in the baseline months, with no relief for losses.`
        : 'No income tax: none was booked in the baseline months and the scenario does not set a rate.',
    'Existing loans keep costing the baseline interest; their principal repayments are not modelled separately.',
    'Nothing changes unless a change below says so: no growth, no inflation and no price changes in the baseline itself.',
    ...drivers.map((d) => describeDriver(d, fmt, monthName)),
  ];

  const risks: TwinRisk[] = [];
  if (negative) risks.push({ level: 'HIGH', code: 'CASH_NEGATIVE', message: `Cash runs out in ${negative.month}: about ${fmt(required)} more is needed to stay at or above the buffer.` });
  else if (min.amount.lt(buffer)) risks.push({ level: 'MEDIUM', code: 'BELOW_BUFFER', message: `Cash falls to ${fmt(min.amount)} in ${min.month}, below the minimum balance of ${fmt(buffer)}.` });
  if (totalNet.lt(0)) risks.push({ level: 'HIGH', code: 'LOSS', message: `The scenario makes a loss of ${fmt(totalNet.negated())} over ${H} months.` });
  const lastM = out[out.length - 1]!;
  if (dec(lastM.netProfit).lt(0) && totalNet.gte(0)) risks.push({ level: 'MEDIUM', code: 'ENDS_LOSS_MAKING', message: `Profitable overall, but making a loss by ${lastM.month}.` });
  const grossMargin = dec(lastM.revenue).gt(0) ? dec(lastM.grossProfit).div(lastM.revenue).times(100) : null;
  if (grossMargin !== null && grossMargin.lt(10)) risks.push({ level: 'MEDIUM', code: 'THIN_MARGIN', message: `Gross margin is ${grossMargin.toFixed(1)}% by ${lastM.month}.` });
  if (dec(lastM.receivables).gt(dec(b.receivables).times(1.5)) && dec(lastM.receivables).minus(b.receivables).gt(dec(b.revenue).times(0.25))) {
    risks.push({ level: 'MEDIUM', code: 'RECEIVABLES_GROW', message: `Money owed by customers grows from ${fmt(b.receivables)} to ${fmt(lastM.receivables)}, tying up cash.` });
  }
  const debt = loans.reduce((a, l) => a.plus(l.d.amount), new D(0));
  if (debt.gt(0)) {
    const ebitdaTotal = sumOf('ebitda');
    const service = sumOf('interest').plus(sumOf('loanPrincipal'));
    if (service.gt(0) && ebitdaTotal.div(service).lt(1.25)) risks.push({ level: 'MEDIUM', code: 'DEBT_SERVICE', message: `Operating profit covers loan payments only ${ebitdaTotal.div(service).toFixed(2)} times over the period (lenders often look for 1.25 or more).` });
  }
  if (n < 3) risks.push({ level: 'LOW', code: 'SHORT_HISTORY', message: `The baseline rests on ${n} month${n === 1 ? '' : 's'} of actuals, so it may not be representative.` });

  const missing: TwinMissing[] = [];
  if (taxRateSource === 'NONE') missing.push({ field: 'TAX_RATE', question: 'What income tax rate applies? Add an income tax rate change, or the scenario assumes no tax.' });
  if (b.revenue.lte(0)) missing.push({ field: 'REVENUE', question: 'There is no revenue in the baseline months. Is the business pre-revenue, or are sales still to be booked?' });
  if (!drivers.some((d) => d.kind === 'INFLATION') && H > 12) missing.push({ field: 'INFLATION', question: `Over ${H} months, should costs rise with inflation? Add a cost inflation change if so.` });
  if (drivers.some((d) => d.kind === 'HIRING') && !drivers.some((d) => d.kind === 'INVESTMENT') && drivers.filter((d) => d.kind === 'HIRING').reduce((a, d) => a + (d as { count: number }).count, 0) >= 5) {
    missing.push({ field: 'INVESTMENT', question: 'Hiring several people often needs equipment or space. Is there an investment to add?' });
  }
  if (drivers.some((d) => d.kind === 'PRICE_CHANGE' && dec(d.volumePercent).isZero() && !dec(d.pricePercent).isZero())) {
    missing.push({ field: 'VOLUME', question: 'A price change usually changes how much customers buy. Is no change in volume intended?' });
  }
  if (b.cash.lte(0)) missing.push({ field: 'CASH', question: 'The books show no cash or bank balance. Are bank accounts and opening balances recorded?' });

  return { baseline: baselineSummary, projection, assumptions, risks, missing };
}

/** Ready-made scenarios to start from; every figure is a placeholder the user is expected to change. */
export const TWIN_TEMPLATES: { key: string; name: string; description: string; drivers: TwinDriver[] }[] = [
  { key: 'HIRE', name: 'Hire a team', description: 'Five people join in month 2, with a one-off cost for each.', drivers: [{ kind: 'HIRING', count: 5, monthlyCostPerHead: '60000', oneOffCostPerHead: '25000', fromMonth: 2 }] },
  { key: 'PRICE_RISE', name: 'Raise prices', description: 'Prices up 8% from month 2, losing 3% of volume.', drivers: [{ kind: 'PRICE_CHANGE', pricePercent: '8', volumePercent: '-3', fromMonth: 2 }] },
  { key: 'DOWNTURN', name: 'Market downturn', description: 'Revenue down 20% for six months from month 2, and customers pay 15 days later.', drivers: [{ kind: 'DOWNTURN', revenuePercent: '20', extraCollectionDays: 15, fromMonth: 2, months: 6 }] },
  { key: 'LOAN', name: 'Take a term loan', description: 'Borrow for three years at 11% a year and invest in equipment.', drivers: [{ kind: 'NEW_DEBT', amount: '2500000', annualRatePercent: '11', termMonths: 36, month: 1 }, { kind: 'INVESTMENT', amount: '2000000', usefulLifeMonths: 60, month: 2 }] },
  { key: 'EXPANSION', name: 'Open a new location', description: 'Set-up cost, running cost, and revenue building up over six months.', drivers: [{ kind: 'EXPANSION', oneOffCost: '1500000', monthlyCost: '250000', monthlyRevenue: '600000', rampMonths: 6, month: 3 }] },
  { key: 'SUPPLIER', name: 'Supplier price rise', description: 'Supplier costs up 10% from month 1, with 6% cost inflation a year.', drivers: [{ kind: 'SUPPLIER_COST', percent: '10', fromMonth: 1 }, { kind: 'INFLATION', annualPercent: '6' }] },
  { key: 'CHURN', name: 'Losing customers', description: '2% of customers lost each month.', drivers: [{ kind: 'CHURN', percentPerMonth: '2', fromMonth: 1 }] },
  { key: 'CURRENCY', name: 'Home currency strengthens', description: '30% of revenue is in foreign currency, which weakens 8% against the home currency.', drivers: [{ kind: 'CURRENCY', exposurePercent: '30', changePercent: '-8', fromMonth: 1 }] },
  { key: 'COLLECTIONS', name: 'Collect faster', description: 'Customers pay 15 days sooner; suppliers are paid 5 days later.', drivers: [{ kind: 'WORKING_CAPITAL', collectionDaysChange: -15, paymentDaysChange: 5, fromMonth: 2 }] },
];
