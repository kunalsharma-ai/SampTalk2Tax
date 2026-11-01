import { money } from './format';

export type KpiUnit = 'MONEY' | 'PERCENT' | 'RATIO' | 'DAYS' | 'MONTHS';
export type TargetStatus = 'MET' | 'MISSED' | 'NO_VALUE';
export type Comparator = 'AT_LEAST' | 'AT_MOST';

export interface Kpi {
  key: string;
  label: string;
  unit: KpiUnit;
  better: 'HIGHER' | 'LOWER';
  group: 'GROWTH' | 'PROFITABILITY' | 'LIQUIDITY' | 'EFFICIENCY' | 'CASH';
  formula: string;
  value: string | null;
  reason: string | null;
  components: { label: string; amount: string }[];
  previous: string | null;
  change: string | null;
  improved: boolean | null;
  lastYear: string | null;
  target: { comparator: Comparator; target: string; note: string | null; status: TargetStatus } | null;
  series: { month: string; value: string | null }[];
}

export interface Concentration {
  total: string;
  customers: number;
  top: { id: string; name: string; revenue: string; share: string | null }[];
  others: { count: number; revenue: string; share: string | null };
  largestShare: string | null;
  topFiveShare: string | null;
}

export interface KpiReport {
  currency: string;
  month: string;
  from: string;
  to: string;
  inProgress: boolean;
  previousMonth: string;
  sameMonthLastYear: string;
  kpis: Kpi[];
  customers: Concentration & { from: string; to: string };
}

export interface ReportLine {
  key: string;
  label: string;
  kind: 'REVENUE' | 'EXPENSE' | 'TOTAL';
  actual: string;
  previous: string;
  lastYear: string;
  budget: string | null;
  variance: string | null;
  favourable: boolean | null;
  ytd: string;
  ytdBudget: string | null;
}

export interface ManagementReport {
  currency: string;
  month: string;
  from: string;
  to: string;
  inProgress: boolean;
  fiscalYear: number;
  ytdFrom: string;
  budget: { id: string; label: string } | null;
  lines: ReportLine[];
  cash: { opening: string; change: string; closing: string };
  kpis: { key: string; label: string; unit: KpiUnit; value: string | null; reason: string | null; previous: string | null; change: string | null; improved: boolean | null }[];
  customers: Concentration;
  status: 'DRAFT' | 'FINAL';
  commentary: string;
  updatedBy: string | null;
  updatedAt: string | null;
  finalisedBy: string | null;
  finalisedAt: string | null;
  changedSince: { key: string; label: string; then: string; now: string }[];
}

export interface ReportMonth {
  month: string;
  ended: boolean;
  status: 'DRAFT' | 'FINAL' | null;
  hasCommentary: boolean;
  finalisedBy: string | null;
  finalisedAt: string | null;
}

export const GROUPS: { key: Kpi['group']; label: string }[] = [
  { key: 'GROWTH', label: 'Growth' },
  { key: 'PROFITABILITY', label: 'Profitability' },
  { key: 'LIQUIDITY', label: 'Liquidity and leverage' },
  { key: 'EFFICIENCY', label: 'Working capital' },
  { key: 'CASH', label: 'Cash' },
];

/** A KPI value with its unit: ₹ amounts, 60.0%, 1.50×, 36.0 days, 6.7 months. */
export function formatKpi(value: string | null, unit: KpiUnit, currency: string): string {
  if (value === null) return '—';
  switch (unit) {
    case 'MONEY':
      return money(value, currency);
    case 'PERCENT':
      return `${value}%`;
    case 'RATIO':
      return `${value}×`;
    case 'DAYS':
      return `${value} days`;
    case 'MONTHS':
      return `${value} months`;
  }
}

/** A change with its sign and unit; percentages change in points. */
export function formatChange(change: string | null, unit: KpiUnit, currency: string): string {
  if (change === null) return '';
  const neg = change.startsWith('-');
  const abs = neg ? change.slice(1) : change;
  const sign = neg ? '−' : '+';
  if (unit === 'PERCENT') return `${sign}${abs} pts`;
  return `${sign}${formatKpi(abs, unit, currency)}`;
}

/** "Oct 2026" */
export function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** The last `n` months, newest first, ending with the current month. */
export function recentMonths(today: string, n: number): string[] {
  const out: string[] = [];
  let y = +today.slice(0, 4);
  let m = +today.slice(5, 7);
  for (let i = 0; i < n; i++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return out;
}
