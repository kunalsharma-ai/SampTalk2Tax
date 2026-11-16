/** Types and form metadata for the financial digital twin (what-if scenarios). */

export type DriverKind =
  | 'REVENUE_GROWTH'
  | 'PRICE_CHANGE'
  | 'CHURN'
  | 'HIRING'
  | 'EXPENSE_CHANGE'
  | 'SUPPLIER_COST'
  | 'NEW_DEBT'
  | 'INVESTMENT'
  | 'EXPANSION'
  | 'CURRENCY'
  | 'INFLATION'
  | 'DOWNTURN'
  | 'WORKING_CAPITAL'
  | 'TAX_RATE'
  | 'ONE_OFF';

export type Driver = { kind: DriverKind; id?: string; label?: string | null; departmentId?: string | null } & Record<string, string | number | boolean | null | undefined>;

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
  cashNegativeFrom: string | null;
  cashRequired: string;
  breakEvenMonth: string | null;
}

export interface TwinRun {
  currency: string;
  actualMonths: { month: string; revenue: string; cash: string; costOfSales: string; payroll: string; otherOperating: string }[];
  baseline: {
    fromMonth: string;
    toMonth: string;
    monthsUsed: number;
    revenue: string;
    costOfSales: string;
    payroll: string;
    otherOperating: string;
    cash: string;
    receivables: string;
    payables: string;
    collectionDays: string;
    paymentDays: string;
    taxRatePercent: string;
    taxRateSource: 'SCENARIO' | 'HISTORY' | 'NONE';
  };
  projection: TwinProjection;
  assumptions: string[];
  risks: { level: 'HIGH' | 'MEDIUM' | 'LOW'; code: string; message: string }[];
  missing: { field: string; question: string }[];
  insights?: TwinInsights;
}

export interface TwinImpact { index: number; kind: DriverKind; departmentId: string | null; netProfit: string; ebitda: string; closingCash: string; minimumCash: string }
export interface TwinSuggestion {
  code: 'FUND_GAP' | 'COLLECT_SOONER' | 'PRICE_RISE' | 'DELAY_LARGEST_COST' | 'SET_TAX_RATE';
  title: string;
  message: string;
  drivers: Driver[];
  replaces: number | null;
  effect: { netProfit: string; closingCash: string; minimumCash: string; cashNegativeFrom: string | null };
}
export interface TwinInsights {
  total: { netProfit: string; closingCash: string };
  impacts: TwinImpact[];
  interaction: { netProfit: string; closingCash: string };
  departments: { departmentId: string | null; changes: number[]; netProfit: string; closingCash: string }[];
  suggestions: TwinSuggestion[];
}

export type ScenarioStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED';
export const STATUS: Record<ScenarioStatus, { label: string; tone: 'neutral' | 'warning' | 'positive' | 'negative' }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  SUBMITTED: { label: 'Waiting for approval', tone: 'warning' },
  APPROVED: { label: 'Approved', tone: 'positive' },
  REJECTED: { label: 'Rejected', tone: 'negative' },
};

export interface ScenarioNote { id: string; version: number; month: number | null; changeNumber: number | null; body: string; authorId: string; createdAt: string; resolvedById: string | null; resolvedAt: string | null }
export interface ScenarioVersion { version: number; name: string; description: string | null; baselineMonths: number; horizonMonths: number; drivers: Driver[]; reason: string; createdById: string; createdAt: string }
export interface ScenarioDetail {
  scenario: Scenario;
  result: TwinRun;
  baseline: { projection: TwinProjection };
  people: Record<string, string>;
  versions: ScenarioVersion[];
  notes: ScenarioNote[];
}

/** "EDITED", "RESTORED_FROM_2"… in words. */
export function versionReason(r: string): string {
  if (r === 'CREATED') return 'Created';
  if (r === 'EDITED') return 'Edited';
  const m = /^RESTORED_FROM_(\d+)$/.exec(r);
  return m ? `Restored from version ${m[1]}` : r;
}

export interface Scenario {
  id: string;
  name: string;
  description: string | null;
  baselineMonths: 3 | 6 | 12;
  horizonMonths: number;
  drivers: Driver[];
  status: ScenarioStatus;
  version: number;
  submittedById: string | null;
  submittedAt: string | null;
  decidedById: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  people?: { submittedBy: string | null; decidedBy: string | null; updatedBy: string | null };
  openNotes?: number;
}

export interface Template {
  key: string;
  name: string;
  description: string;
  drivers: Driver[];
}

type Field =
  | { key: string; label: string; type: 'number' | 'int'; optional?: boolean; hint?: string }
  | { key: string; label: string; type: 'month'; optional?: boolean }
  | { key: string; label: string; type: 'bool' }
  | { key: string; label: string; type: 'text' }
  | { key: string; label: string; type: 'select'; options: [string, string][] };

const from: Field = { key: 'fromMonth', label: 'From month', type: 'month', optional: true };

export const DRIVERS: Record<DriverKind, { title: string; help: string; fields: Field[]; blank: Driver }> = {
  REVENUE_GROWTH: { title: 'Revenue growth', help: 'Sales volume grows (or shrinks) by a percentage every month.', fields: [{ key: 'percentPerMonth', label: 'Growth per month (%)', type: 'number' }, from], blank: { kind: 'REVENUE_GROWTH', percentPerMonth: '3', fromMonth: 1 } },
  PRICE_CHANGE: { title: 'Price change', help: 'Prices change, and customers buy more or less in response. Cost of sales follows volume, not price.', fields: [{ key: 'pricePercent', label: 'Price change (%)', type: 'number' }, { key: 'volumePercent', label: 'Volume change (%)', type: 'number' }, from], blank: { kind: 'PRICE_CHANGE', pricePercent: '5', volumePercent: '-2', fromMonth: 1 } },
  CHURN: { title: 'Customer churn', help: 'A share of the customer base is lost each month, compounding.', fields: [{ key: 'percentPerMonth', label: 'Lost per month (%)', type: 'number' }, from], blank: { kind: 'CHURN', percentPerMonth: '2', fromMonth: 1 } },
  HIRING: { title: 'Hiring', help: 'People join at a monthly cost each, with an optional one-off cost (recruiting, equipment).', fields: [{ key: 'count', label: 'People', type: 'int' }, { key: 'monthlyCostPerHead', label: 'Monthly cost each', type: 'number' }, { key: 'oneOffCostPerHead', label: 'One-off cost each', type: 'number', optional: true }, from], blank: { kind: 'HIRING', count: 1, monthlyCostPerHead: '50000', oneOffCostPerHead: '0', fromMonth: 1 } },
  EXPENSE_CHANGE: {
    title: 'Expense change',
    help: 'A group of costs changes by a percentage, a monthly amount, or both.',
    fields: [{ key: 'target', label: 'Costs', type: 'select', options: [['OPERATING', 'Other operating costs'], ['PAYROLL', 'Payroll'], ['COST_OF_SALES', 'Cost of sales']] }, { key: 'percent', label: 'Change (%)', type: 'number', optional: true }, { key: 'monthlyAmount', label: 'Monthly amount', type: 'number', optional: true }, from],
    blank: { kind: 'EXPENSE_CHANGE', target: 'OPERATING', percent: '-10', fromMonth: 1 },
  },
  SUPPLIER_COST: { title: 'Supplier costs', help: 'What suppliers charge for goods sold changes (cost of sales).', fields: [{ key: 'percent', label: 'Change (%)', type: 'number' }, from], blank: { kind: 'SUPPLIER_COST', percent: '8', fromMonth: 1 } },
  NEW_DEBT: { title: 'New loan', help: 'A loan is received and repaid in equal monthly instalments (EMI) from the month after.', fields: [{ key: 'amount', label: 'Amount', type: 'number' }, { key: 'annualRatePercent', label: 'Interest (% a year)', type: 'number' }, { key: 'termMonths', label: 'Term (months)', type: 'int' }, { key: 'month', label: 'Month received', type: 'month', optional: true }], blank: { kind: 'NEW_DEBT', amount: '1000000', annualRatePercent: '11', termMonths: 36, month: 1 } },
  INVESTMENT: { title: 'Investment', help: 'Equipment or other assets are bought and depreciated straight-line from the month after.', fields: [{ key: 'amount', label: 'Amount', type: 'number' }, { key: 'usefulLifeMonths', label: 'Useful life (months)', type: 'int' }, { key: 'month', label: 'Month bought', type: 'month', optional: true }], blank: { kind: 'INVESTMENT', amount: '500000', usefulLifeMonths: 60, month: 1 } },
  EXPANSION: {
    title: 'Expansion',
    help: 'A new location or line: a one-off cost, running costs, and revenue building up to full speed.',
    fields: [{ key: 'oneOffCost', label: 'One-off cost', type: 'number' }, { key: 'monthlyCost', label: 'Monthly cost', type: 'number' }, { key: 'monthlyRevenue', label: 'Monthly revenue at full speed', type: 'number' }, { key: 'rampMonths', label: 'Months to full speed', type: 'int' }, { key: 'month', label: 'Opening month', type: 'month', optional: true }],
    blank: { kind: 'EXPANSION', oneOffCost: '1000000', monthlyCost: '200000', monthlyRevenue: '500000', rampMonths: 6, month: 1 },
  },
  CURRENCY: { title: 'Exchange rate', help: 'Revenue earned in a foreign currency is worth more or less when converted.', fields: [{ key: 'exposurePercent', label: 'Revenue in foreign currency (%)', type: 'number' }, { key: 'changePercent', label: 'Rate change (%)', type: 'number' }, from], blank: { kind: 'CURRENCY', exposurePercent: '30', changePercent: '-5', fromMonth: 1 } },
  INFLATION: { title: 'Cost inflation', help: 'All costs rise by a yearly rate, compounded monthly.', fields: [{ key: 'annualPercent', label: 'Inflation (% a year)', type: 'number' }], blank: { kind: 'INFLATION', annualPercent: '6' } },
  DOWNTURN: { title: 'Market downturn', help: 'Revenue drops and customers pay later, for a while or for good.', fields: [{ key: 'revenuePercent', label: 'Revenue drop (%)', type: 'number' }, { key: 'extraCollectionDays', label: 'Extra days to pay', type: 'int' }, from, { key: 'months', label: 'Lasts (months)', type: 'int', optional: true }], blank: { kind: 'DOWNTURN', revenuePercent: '20', extraCollectionDays: 15, fromMonth: 1, months: 6 } },
  WORKING_CAPITAL: { title: 'Payment terms', help: 'Customers pay sooner or later, and suppliers are paid sooner or later (in days).', fields: [{ key: 'collectionDaysChange', label: 'Customers: days later (+) or sooner (−)', type: 'int' }, { key: 'paymentDaysChange', label: 'Suppliers: days later (+) or sooner (−)', type: 'int' }, from], blank: { kind: 'WORKING_CAPITAL', collectionDaysChange: -10, paymentDaysChange: 0, fromMonth: 1 } },
  TAX_RATE: { title: 'Income tax rate', help: 'The income tax rate on profit before tax (losses get no relief).', fields: [{ key: 'percent', label: 'Rate (%)', type: 'number' }], blank: { kind: 'TAX_RATE', percent: '25' } },
  ONE_OFF: { title: 'One-off item', help: 'A single amount in one month: positive for money in, negative for money out.', fields: [{ key: 'label', label: 'What it is', type: 'text' }, { key: 'amount', label: 'Amount (+ in, − out)', type: 'number' }, { key: 'month', label: 'Month', type: 'month', optional: true }, { key: 'affectsProfit', label: 'Goes through profit', type: 'bool' }], blank: { kind: 'ONE_OFF', label: 'Grant', amount: '100000', month: 1, affectsProfit: false } },
};

export const DRIVER_ORDER = Object.keys(DRIVERS) as DriverKind[];

/** Projected month number (1-based) as a calendar month name. */
export function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function shiftYm(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}
