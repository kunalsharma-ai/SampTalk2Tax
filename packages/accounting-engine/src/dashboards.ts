/**
 * Dashboards described in words. A dashboard is a list of widgets, each showing approved
 * metrics (the KPIs and the main figures of the books) as a figure, a chart or a table. The
 * configuration is checked here, whether a person built it or the AI drafted it, and the
 * figures are worked out here from posted month figures, so the AI never produces a number.
 *
 * No framework or database code.
 */
import { D, type Dec } from './money';
import { computeKpis, kpiSeries, KPI_DEFINITIONS, plFigures, type KpiKey, type KpiUnit, type MonthFigures } from './kpis';

export const MAX_WIDGETS = 12;
export const MAX_DASHBOARD_MONTHS = 24;

export type FigureKey = 'costOfSales' | 'grossProfit' | 'operatingExpenses' | 'payroll' | 'operatingProfit' | 'netIncome' | 'cash' | 'receivables' | 'payables' | 'inventory';
export type MetricKey = KpiKey | FigureKey;

export interface MetricDefinition {
  key: MetricKey;
  label: string;
  unit: KpiUnit;
  better: 'HIGHER' | 'LOWER';
  group: 'GROWTH' | 'PROFITABILITY' | 'LIQUIDITY' | 'EFFICIENCY' | 'CASH' | 'FIGURES';
  formula: string;
}

const FIGURES: readonly (MetricDefinition & { key: FigureKey })[] = [
  { key: 'costOfSales', label: 'Cost of sales', unit: 'MONEY', better: 'LOWER', group: 'FIGURES', formula: 'Cost of sales posted in the month.' },
  { key: 'grossProfit', label: 'Gross profit', unit: 'MONEY', better: 'HIGHER', group: 'FIGURES', formula: 'Revenue − cost of sales in the month.' },
  { key: 'operatingExpenses', label: 'Operating expenses', unit: 'MONEY', better: 'LOWER', group: 'FIGURES', formula: 'Operating expenses, payroll and depreciation posted in the month.' },
  { key: 'payroll', label: 'Payroll', unit: 'MONEY', better: 'LOWER', group: 'FIGURES', formula: 'Payroll expenses posted in the month.' },
  { key: 'operatingProfit', label: 'Operating profit', unit: 'MONEY', better: 'HIGHER', group: 'FIGURES', formula: 'Gross profit − operating expenses in the month.' },
  { key: 'netIncome', label: 'Net income', unit: 'MONEY', better: 'HIGHER', group: 'FIGURES', formula: 'Operating profit + other income − other expenses, interest and income tax in the month.' },
  { key: 'cash', label: 'Cash and bank', unit: 'MONEY', better: 'HIGHER', group: 'FIGURES', formula: 'Cash and bank balances at the month end.' },
  { key: 'receivables', label: 'Receivables', unit: 'MONEY', better: 'LOWER', group: 'FIGURES', formula: 'Money customers owe at the month end.' },
  { key: 'payables', label: 'Payables', unit: 'MONEY', better: 'LOWER', group: 'FIGURES', formula: 'Money owed to suppliers at the month end.' },
  { key: 'inventory', label: 'Inventory', unit: 'MONEY', better: 'LOWER', group: 'FIGURES', formula: 'Inventory at the month end.' },
];

/** The approved metrics a dashboard can show. */
export const DASHBOARD_METRICS: readonly MetricDefinition[] = [...KPI_DEFINITIONS, ...FIGURES];
const metricDef = (k: string) => DASHBOARD_METRICS.find((m) => m.key === k);

export const WIDGET_TYPES = ['STAT', 'LINE', 'BAR', 'TABLE', 'TOP_CUSTOMERS'] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];
export const WIDGET_SIZES = ['SMALL', 'MEDIUM', 'LARGE'] as const;
export type WidgetSize = (typeof WIDGET_SIZES)[number];
export const COMPARISONS = ['PREVIOUS_MONTH', 'SAME_MONTH_LAST_YEAR', 'NONE'] as const;
export type Comparison = (typeof COMPARISONS)[number];

export const WIDGET_LABELS: Record<WidgetType, string> = { STAT: 'Figure', LINE: 'Line chart', BAR: 'Bar chart', TABLE: 'Table', TOP_CUSTOMERS: 'Top customers' };

export type Widget =
  | { type: 'STAT'; title: string; size: WidgetSize; metric: MetricKey; compare: Comparison }
  | { type: 'LINE' | 'BAR'; title: string; size: WidgetSize; metrics: MetricKey[]; months: number }
  | { type: 'TABLE'; title: string; size: WidgetSize; metrics: MetricKey[]; months: number }
  | { type: 'TOP_CUSTOMERS'; title: string; size: WidgetSize; count: number; months: number };

export interface DashboardConfig {
  widgets: Widget[];
}

const LIMITS = { chartMetrics: 4, tableMetrics: 8, chartMonths: [3, MAX_DASHBOARD_MONTHS], tableMonths: [1, 12], customerCount: [3, 10], customerMonths: [1, 12] } as const;
const UNIT_WORDS: Record<KpiUnit, string> = { MONEY: 'amounts', PERCENT: 'percentages', RATIO: 'ratios', DAYS: 'days', MONTHS: 'months' };

/**
 * Checks a dashboard configuration. Returns it cleaned (titles trimmed, defaults filled) and
 * every problem in words, each prefixed with the widget it is about.
 */
export function checkDashboard(input: unknown): { config: DashboardConfig; issues: string[] } {
  const issues: string[] = [];
  const raw = (input && typeof input === 'object' ? (input as { widgets?: unknown }).widgets : undefined) as unknown[] | undefined;
  if (!Array.isArray(raw) || !raw.length) return { config: { widgets: [] }, issues: ['Add at least one widget'] };
  if (raw.length > MAX_WIDGETS) issues.push(`At most ${MAX_WIDGETS} widgets on a dashboard`);
  const widgets: Widget[] = [];
  raw.slice(0, MAX_WIDGETS).forEach((w0, i) => {
    const at = `Widget ${i + 1}`;
    const w = (w0 && typeof w0 === 'object' ? w0 : {}) as Record<string, unknown>;
    const type = w.type as WidgetType;
    if (!WIDGET_TYPES.includes(type)) return void issues.push(`${at}: choose a kind of widget (${WIDGET_TYPES.map((t) => WIDGET_LABELS[t].toLowerCase()).join(', ')})`);
    const title = typeof w.title === 'string' ? w.title.trim() : '';
    if (!title) issues.push(`${at}: give the widget a title`);
    else if (title.length > 80) issues.push(`${at}: keep the title under 80 characters`);
    const size = (w.size ?? (type === 'STAT' ? 'SMALL' : 'MEDIUM')) as WidgetSize;
    if (!WIDGET_SIZES.includes(size)) issues.push(`${at}: size must be small, medium or large`);
    const whole = (v: unknown, [lo, hi]: readonly [number, number], what: string) => {
      if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi) {
        issues.push(`${at}: ${what} must be a whole number from ${lo} to ${hi}`);
        return lo;
      }
      return v as number;
    };
    const metricsOf = (list: unknown, max: number): MetricKey[] => {
      const keys = Array.isArray(list) ? list : [];
      if (!keys.length) issues.push(`${at}: choose at least one metric`);
      if (keys.length > max) issues.push(`${at}: at most ${max} metrics`);
      const ok: MetricKey[] = [];
      for (const k of keys) {
        if (!metricDef(String(k))) issues.push(`${at}: "${String(k)}" is not an approved metric`);
        else if (ok.includes(k as MetricKey)) issues.push(`${at}: ${metricDef(String(k))!.label} is chosen twice`);
        else ok.push(k as MetricKey);
      }
      return ok;
    };
    if (type === 'STAT') {
      const metric = String(w.metric ?? '');
      if (!metricDef(metric)) issues.push(`${at}: "${metric}" is not an approved metric`);
      const compare = (w.compare ?? 'PREVIOUS_MONTH') as Comparison;
      if (!COMPARISONS.includes(compare)) issues.push(`${at}: compare with the previous month, the same month last year, or nothing`);
      widgets.push({ type, title, size, metric: metric as MetricKey, compare });
    } else if (type === 'LINE' || type === 'BAR') {
      const metrics = metricsOf(w.metrics, LIMITS.chartMetrics);
      const units = [...new Set(metrics.map((k) => metricDef(k)!.unit))];
      if (units.length > 1) issues.push(`${at}: a chart can only show metrics measured the same way; these mix ${units.map((u) => UNIT_WORDS[u]).join(' and ')}`);
      widgets.push({ type, title, size, metrics, months: whole(w.months ?? 12, LIMITS.chartMonths, 'Months') });
    } else if (type === 'TABLE') {
      widgets.push({ type, title, size, metrics: metricsOf(w.metrics, LIMITS.tableMetrics), months: whole(w.months ?? 6, LIMITS.tableMonths, 'Months') });
    } else {
      widgets.push({ type, title, size, count: whole(w.count ?? 5, LIMITS.customerCount, 'Number of customers'), months: whole(w.months ?? 12, LIMITS.customerMonths, 'Months') });
    }
  });
  return { config: { widgets }, issues };
}

/** How many months of figures a dashboard needs, including the trailing KPI windows and last year's month. */
export function monthsNeeded(config: DashboardConfig): number {
  let n = 1;
  for (const w of config.widgets) {
    if (w.type === 'STAT') n = Math.max(n, w.compare === 'SAME_MONTH_LAST_YEAR' ? 13 : 2);
    else if (w.type !== 'TOP_CUSTOMERS') n = Math.max(n, w.months);
  }
  return n + 2;
}

/** A metric's value for every month given, each KPI using its own trailing window. */
export function metricSeries(months: readonly MonthFigures[], scale = 2): Record<MetricKey, { month: string; value: string | null }[]> {
  const kpis = kpiSeries(months, scale);
  const figure = (m: MonthFigures, k: FigureKey): Dec => {
    const pl = plFigures(m);
    switch (k) {
      case 'costOfSales':
        return m.costOfSales;
      case 'grossProfit':
        return pl.grossProfit;
      case 'operatingExpenses':
        return m.operatingExpenses;
      case 'payroll':
        return m.payroll;
      case 'operatingProfit':
        return pl.operatingProfit;
      case 'netIncome':
        return pl.netIncome;
      default:
        return m[k];
    }
  };
  const out = { ...kpis } as Record<MetricKey, { month: string; value: string | null }[]>;
  for (const f of FIGURES) out[f.key] = months.map((m) => ({ month: m.month, value: figure(m, f.key).toFixed(scale) }));
  return out;
}

export interface CustomerRow {
  id: string;
  name: string;
  revenue: string;
  share: string | null;
}
export type WidgetData =
  | { type: 'STAT'; metric: MetricDefinition; value: string | null; reason: string | null; month: string; compareMonth: string | null; compareValue: string | null; change: string | null; better: boolean | null }
  | { type: 'LINE' | 'BAR' | 'TABLE'; metrics: MetricDefinition[]; rows: { month: string; values: Record<string, string | null> }[] }
  | { type: 'TOP_CUSTOMERS'; from: string; to: string; total: string; rows: CustomerRow[]; others: { count: number; revenue: string; share: string | null } }
  | { type: 'UNAVAILABLE'; reason: string };

const shiftMonth = (ym: string, k: number) => {
  const t = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1 + k;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};

/**
 * Works out every widget's figures. `months` are chronological month figures ending with the
 * dashboard's month; `customers(widget, index)` gives a customer widget's figures (or null when
 * the viewer may not see customers).
 */
export function dashboardData(
  config: DashboardConfig,
  months: readonly MonthFigures[],
  scale: number,
  customers: (w: Extract<Widget, { type: 'TOP_CUSTOMERS' }>, index: number) => Extract<WidgetData, { type: 'TOP_CUSTOMERS' }> | null,
): WidgetData[] {
  if (!months.length) throw new Error('No months');
  const series = metricSeries(months, scale);
  const last = months[months.length - 1]!.month;
  const reasons = new Map(computeKpis(months, scale).map((k) => [k.key as string, k.reason]));
  const at = (k: MetricKey, month: string) => series[k].find((s) => s.month === month)?.value ?? null;
  return config.widgets.map((w, index): WidgetData => {
    if (w.type === 'STAT') {
      const def = metricDef(w.metric)!;
      const value = at(w.metric, last);
      const compareMonth = w.compare === 'NONE' ? null : shiftMonth(last, w.compare === 'PREVIOUS_MONTH' ? -1 : -12);
      const compareValue = compareMonth ? at(w.metric, compareMonth) : null;
      const change = value !== null && compareValue !== null ? new D(value).minus(compareValue).toFixed(def.unit === 'MONEY' ? scale : def.unit === 'RATIO' ? 2 : 1) : null;
      const better = change === null || new D(change).isZero() ? null : new D(change).greaterThan(0) === (def.better === 'HIGHER');
      return { type: 'STAT', metric: def, value, reason: value === null ? (reasons.get(w.metric) ?? 'No value') : null, month: last, compareMonth, compareValue, change, better };
    }
    if (w.type === 'TOP_CUSTOMERS') return customers(w, index) ?? { type: 'UNAVAILABLE', reason: 'Showing customers needs access to sales' };
    const shown = months.slice(-w.months).map((m) => m.month);
    return {
      type: w.type,
      metrics: w.metrics.map((k) => metricDef(k)!),
      rows: shown.map((month) => ({ month, values: Object.fromEntries(w.metrics.map((k) => [k, at(k, month)])) })),
    };
  });
}

/** A dashboard in words, for checking an AI draft. */
export function describeDashboard(config: DashboardConfig): string[] {
  const names = (ks: MetricKey[]) => ks.map((k) => metricDef(k)?.label ?? k).join(', ');
  return config.widgets.map((w) => {
    switch (w.type) {
      case 'STAT':
        return `${w.title}: ${metricDef(w.metric)?.label ?? w.metric} for the month${w.compare === 'NONE' ? '' : w.compare === 'PREVIOUS_MONTH' ? ', against the month before' : ', against the same month last year'}`;
      case 'LINE':
      case 'BAR':
        return `${w.title}: ${w.type === 'LINE' ? 'line' : 'bar'} chart of ${names(w.metrics)} over ${w.months} months`;
      case 'TABLE':
        return `${w.title}: table of ${names(w.metrics)} for ${w.months} month${w.months === 1 ? '' : 's'}`;
      case 'TOP_CUSTOMERS':
        return `${w.title}: the ${w.count} largest customers by revenue over ${w.months} month${w.months === 1 ? '' : 's'}`;
    }
  });
}
