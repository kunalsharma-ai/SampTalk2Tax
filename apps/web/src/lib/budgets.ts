export type BudgetStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'SUPERSEDED';
export type BudgetBasis = 'EMPTY' | 'COPY' | 'PRIOR_ACTUALS';
export type Granularity = 'MONTH' | 'QUARTER' | 'YEAR';

type Person = { id: string; name: string } | null;

export interface BudgetHeader {
  id: string;
  fiscalYear: number;
  version: number;
  name: string;
  note: string | null;
  basis: BudgetBasis;
  sourceBudgetId: string | null;
  changePercent: string | null;
  status: BudgetStatus;
  createdBy: Person;
  createdAt: string;
  updatedAt: string;
  submittedBy: Person;
  submittedAt: string | null;
  approvedBy: Person;
  approvedAt: string | null;
  supersededAt: string | null;
  returned: { by: Person; at: string; reason: string } | null;
}

export interface BudgetOverview {
  currency: string;
  currentFiscalYear: number;
  fiscalYear: number;
  from: string;
  to: string;
  years: { fiscalYear: number; label: string; from: string; to: string }[];
  budgets: (BudgetHeader & { accounts: number; revenue: string; expenses: string; netIncome: string })[];
}

export interface BudgetPeriod {
  periodNo: number;
  label: string;
  startDate: string;
  endDate: string;
}

export interface BudgetRow {
  accountId: string;
  code: string;
  name: string;
  type: 'REVENUE' | 'EXPENSE';
  isActive: boolean;
  amounts: string[] | null;
  total: string | null;
}

export interface BudgetDetail {
  currency: string;
  budget: BudgetHeader;
  source: { id: string; fiscalYear: number; version: number; name: string } | null;
  periods: BudgetPeriod[];
  rows: BudgetRow[];
  totals: { revenue: string[]; expenses: string[]; netIncome: string[]; year: { revenue: string; expenses: string; netIncome: string } };
}

export interface Variance {
  budget: string;
  actual: string | null;
  variance: string | null;
  percent: string | null;
  favourable: boolean | null;
}

export interface VarianceFigures {
  buckets: Variance[];
  yearToDate: Variance;
  fullYearBudget: string;
}

export interface BudgetVariance {
  currency: string;
  budget: BudgetHeader;
  asOf: string;
  actualsThrough: string | null;
  granularity: Granularity;
  periodsStarted: number;
  buckets: { key: string; label: string; from: string; to: string; started: boolean; inProgress: boolean }[];
  rows: ({ accountId: string; code: string; name: string; type: 'REVENUE' | 'EXPENSE'; budgeted: boolean } & VarianceFigures)[];
  revenue: VarianceFigures;
  expenses: VarianceFigures;
  netIncome: VarianceFigures;
}

export const BUDGET_STATUS: Record<BudgetStatus, { label: string; tone: 'neutral' | 'warning' | 'positive' | 'accent' }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  SUBMITTED: { label: 'Waiting for approval', tone: 'warning' },
  APPROVED: { label: 'Approved', tone: 'positive' },
  SUPERSEDED: { label: 'Superseded', tone: 'accent' },
};

export function basisLabel(b: Pick<BudgetHeader, 'basis' | 'changePercent'>, source?: { version: number; fiscalYear: number } | null): string {
  if (b.basis === 'COPY') return source ? `Copied from FY${source.fiscalYear} version ${source.version}` : 'Copied from another version';
  if (b.basis === 'PRIOR_ACTUALS') {
    const pct = b.changePercent && !b.changePercent.startsWith('-') ? `+${b.changePercent}` : b.changePercent;
    return `Last year's actuals ${pct}%`;
  }
  return 'Started empty';
}
