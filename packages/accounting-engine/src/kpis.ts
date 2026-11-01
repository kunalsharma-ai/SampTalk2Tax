/**
 * Financial KPIs from the ledger: margins, liquidity, leverage, collection and payment
 * days, cash burn and runway, each with the figures it was computed from, plus targets
 * and the grouped profit and loss used by the monthly management report.
 *
 * Inputs are posted-journal totals grouped by account type and subtype. Amounts are on
 * each group's normal side. No floating point.
 */
import Decimal from 'decimal.js';
import type { AccountType } from './accounts';
import { D, Dec, dec, sum } from './money';

/** Debit and credit totals of one account type and subtype. */
export interface SubtypeTotals {
  type: AccountType;
  subtype: string | null;
  debit: string | Dec;
  credit: string | Dec;
}

/** One month's figures: P&L movements in the month and balances at its end. */
export interface MonthFigures {
  /** YYYY-MM */
  month: string;
  from: string;
  to: string;
  days: number;
  operatingRevenue: Dec;
  otherIncome: Dec;
  costOfSales: Dec;
  /** Operating expenses, payroll and depreciation. */
  operatingExpenses: Dec;
  payroll: Dec;
  depreciation: Dec;
  interest: Dec;
  incomeTax: Dec;
  /** Other expenses, exchange differences and expenses without a subtype. */
  otherExpenses: Dec;
  cash: Dec;
  receivables: Dec;
  inventory: Dec;
  otherCurrentAssets: Dec;
  nonCurrentAssets: Dec;
  payables: Dec;
  otherCurrentLiabilities: Dec;
  nonCurrentLiabilities: Dec;
  /** Net change in cash and bank during the month. */
  cashChange: Dec;
}

const CURRENT_ASSETS = new Set(['CASH', 'BANK', 'ACCOUNTS_RECEIVABLE', 'INVENTORY', 'PREPAID', 'OTHER_CURRENT_ASSET', 'TAX_RECEIVABLE']);
const NON_CURRENT_LIABILITIES = new Set(['LONG_TERM_DEBT', 'OTHER_NON_CURRENT_LIABILITY']);

/**
 * Group movements (for the month) and balances (cumulative to its end) into a month's
 * figures. An asset without a subtype counts as non-current and a liability without one
 * as current, the cautious reading for liquidity ratios.
 */
export function monthFigures(month: { month: string; from: string; to: string }, movements: readonly SubtypeTotals[], balances: readonly SubtypeTotals[], cashChange: string | Dec): MonthFigures {
  const z = () => new D(0);
  const f: MonthFigures = {
    ...month,
    days: Math.round((Date.parse(`${month.to}T00:00:00Z`) - Date.parse(`${month.from}T00:00:00Z`)) / 86_400_000) + 1,
    operatingRevenue: z(),
    otherIncome: z(),
    costOfSales: z(),
    operatingExpenses: z(),
    payroll: z(),
    depreciation: z(),
    interest: z(),
    incomeTax: z(),
    otherExpenses: z(),
    cash: z(),
    receivables: z(),
    inventory: z(),
    otherCurrentAssets: z(),
    nonCurrentAssets: z(),
    payables: z(),
    otherCurrentLiabilities: z(),
    nonCurrentLiabilities: z(),
    cashChange: dec(cashChange),
  };
  for (const m of movements) {
    const dr = dec(m.debit).minus(dec(m.credit));
    if (m.type === 'REVENUE') {
      if (m.subtype === 'OTHER_INCOME') f.otherIncome = f.otherIncome.minus(dr);
      else f.operatingRevenue = f.operatingRevenue.minus(dr);
    } else if (m.type === 'EXPENSE') {
      switch (m.subtype) {
        case 'COST_OF_SALES':
          f.costOfSales = f.costOfSales.plus(dr);
          break;
        case 'OPERATING_EXPENSE':
          f.operatingExpenses = f.operatingExpenses.plus(dr);
          break;
        case 'PAYROLL_EXPENSE':
          f.operatingExpenses = f.operatingExpenses.plus(dr);
          f.payroll = f.payroll.plus(dr);
          break;
        case 'DEPRECIATION':
          f.operatingExpenses = f.operatingExpenses.plus(dr);
          f.depreciation = f.depreciation.plus(dr);
          break;
        case 'INTEREST_EXPENSE':
          f.interest = f.interest.plus(dr);
          break;
        case 'TAX_EXPENSE':
          f.incomeTax = f.incomeTax.plus(dr);
          break;
        default:
          f.otherExpenses = f.otherExpenses.plus(dr);
      }
    }
  }
  for (const b of balances) {
    const dr = dec(b.debit).minus(dec(b.credit));
    if (b.type === 'ASSET') {
      if (b.subtype === 'CASH' || b.subtype === 'BANK') f.cash = f.cash.plus(dr);
      else if (b.subtype === 'ACCOUNTS_RECEIVABLE') f.receivables = f.receivables.plus(dr);
      else if (b.subtype === 'INVENTORY') f.inventory = f.inventory.plus(dr);
      else if (b.subtype && CURRENT_ASSETS.has(b.subtype)) f.otherCurrentAssets = f.otherCurrentAssets.plus(dr);
      else f.nonCurrentAssets = f.nonCurrentAssets.plus(dr);
    } else if (b.type === 'LIABILITY') {
      if (b.subtype === 'ACCOUNTS_PAYABLE') f.payables = f.payables.minus(dr);
      else if (b.subtype && NON_CURRENT_LIABILITIES.has(b.subtype)) f.nonCurrentLiabilities = f.nonCurrentLiabilities.minus(dr);
      else f.otherCurrentLiabilities = f.otherCurrentLiabilities.minus(dr);
    }
  }
  return f;
}

// ------------------------------------------------------------------ the profit and loss

export const PL_LINES = [
  { key: 'operatingRevenue', label: 'Revenue', kind: 'REVENUE' },
  { key: 'costOfSales', label: 'Cost of sales', kind: 'EXPENSE' },
  { key: 'grossProfit', label: 'Gross profit', kind: 'TOTAL' },
  { key: 'operatingExpenses', label: 'Operating expenses', kind: 'EXPENSE' },
  { key: 'operatingProfit', label: 'Operating profit', kind: 'TOTAL' },
  { key: 'otherIncome', label: 'Other income', kind: 'REVENUE' },
  { key: 'otherExpenses', label: 'Other expenses', kind: 'EXPENSE' },
  { key: 'interest', label: 'Interest', kind: 'EXPENSE' },
  { key: 'incomeTax', label: 'Income tax', kind: 'EXPENSE' },
  { key: 'netIncome', label: 'Net income', kind: 'TOTAL' },
] as const;
export type PlLineKey = (typeof PL_LINES)[number]['key'];
export type PlFigures = Record<PlLineKey, Dec>;

/** Grouped P&L from movements alone (also used for budgets, which have no balances). */
export function plFigures(x: Pick<MonthFigures, 'operatingRevenue' | 'otherIncome' | 'costOfSales' | 'operatingExpenses' | 'interest' | 'incomeTax' | 'otherExpenses'>): PlFigures {
  const grossProfit = x.operatingRevenue.minus(x.costOfSales);
  const operatingProfit = grossProfit.minus(x.operatingExpenses);
  return {
    operatingRevenue: x.operatingRevenue,
    costOfSales: x.costOfSales,
    grossProfit,
    operatingExpenses: x.operatingExpenses,
    operatingProfit,
    otherIncome: x.otherIncome,
    otherExpenses: x.otherExpenses,
    interest: x.interest,
    incomeTax: x.incomeTax,
    netIncome: operatingProfit.plus(x.otherIncome).minus(x.otherExpenses).minus(x.interest).minus(x.incomeTax),
  };
}

export function addPl(a: PlFigures, b: PlFigures): PlFigures {
  const out = {} as PlFigures;
  for (const l of PL_LINES) out[l.key] = a[l.key].plus(b[l.key]);
  return out;
}

export function zeroPl(): PlFigures {
  const out = {} as PlFigures;
  for (const l of PL_LINES) out[l.key] = new D(0);
  return out;
}

/** Group budget amounts (normal side) by account type and subtype into P&L lines. */
export function plFromAmounts(lines: readonly { type: AccountType; subtype: string | null; amount: string | Dec }[]): PlFigures {
  const totals: SubtypeTotals[] = lines.map((l) => ({ type: l.type, subtype: l.subtype, debit: l.type === 'EXPENSE' ? dec(l.amount) : new D(0), credit: l.type === 'REVENUE' ? dec(l.amount) : new D(0) }));
  return plFigures(monthFigures({ month: '0000-01', from: '2000-01-01', to: '2000-01-01' }, totals, [], '0'));
}

// ------------------------------------------------------------------ KPIs

export type KpiUnit = 'MONEY' | 'PERCENT' | 'RATIO' | 'DAYS' | 'MONTHS';
export type KpiKey =
  | 'revenue'
  | 'grossMargin'
  | 'operatingMargin'
  | 'netMargin'
  | 'opexRatio'
  | 'currentRatio'
  | 'quickRatio'
  | 'workingCapital'
  | 'debtToEquity'
  | 'dso'
  | 'dpo'
  | 'netCashFlow'
  | 'runway';

export interface KpiDefinition {
  key: KpiKey;
  label: string;
  unit: KpiUnit;
  /** Which way is better. */
  better: 'HIGHER' | 'LOWER';
  group: 'GROWTH' | 'PROFITABILITY' | 'LIQUIDITY' | 'EFFICIENCY' | 'CASH';
  formula: string;
}

export const KPI_DEFINITIONS: readonly KpiDefinition[] = [
  { key: 'revenue', label: 'Revenue', unit: 'MONEY', better: 'HIGHER', group: 'GROWTH', formula: 'Operating revenue posted in the month (other income excluded).' },
  { key: 'grossMargin', label: 'Gross margin', unit: 'PERCENT', better: 'HIGHER', group: 'PROFITABILITY', formula: '(Revenue − cost of sales) ÷ revenue.' },
  { key: 'operatingMargin', label: 'Operating margin', unit: 'PERCENT', better: 'HIGHER', group: 'PROFITABILITY', formula: '(Revenue − cost of sales − operating expenses, payroll and depreciation) ÷ revenue.' },
  { key: 'netMargin', label: 'Net margin', unit: 'PERCENT', better: 'HIGHER', group: 'PROFITABILITY', formula: 'Net income ÷ (revenue + other income).' },
  { key: 'opexRatio', label: 'Operating expense ratio', unit: 'PERCENT', better: 'LOWER', group: 'PROFITABILITY', formula: 'Operating expenses, payroll and depreciation ÷ revenue.' },
  { key: 'currentRatio', label: 'Current ratio', unit: 'RATIO', better: 'HIGHER', group: 'LIQUIDITY', formula: 'Current assets ÷ current liabilities at the month end.' },
  { key: 'quickRatio', label: 'Quick ratio', unit: 'RATIO', better: 'HIGHER', group: 'LIQUIDITY', formula: '(Cash and bank + receivables) ÷ current liabilities at the month end.' },
  { key: 'workingCapital', label: 'Working capital', unit: 'MONEY', better: 'HIGHER', group: 'LIQUIDITY', formula: 'Current assets − current liabilities at the month end.' },
  { key: 'debtToEquity', label: 'Liabilities to equity', unit: 'RATIO', better: 'LOWER', group: 'LIQUIDITY', formula: 'Total liabilities ÷ equity (assets − liabilities) at the month end.' },
  { key: 'dso', label: 'Days sales outstanding', unit: 'DAYS', better: 'LOWER', group: 'EFFICIENCY', formula: 'Receivables at the month end ÷ revenue of the last 3 months × days in those months. Receivables include GST; revenue does not.' },
  { key: 'dpo', label: 'Days payables outstanding', unit: 'DAYS', better: 'HIGHER', group: 'EFFICIENCY', formula: 'Payables at the month end ÷ (cost of sales + operating expenses, without payroll and depreciation) of the last 3 months × days in those months. Payables include GST; expenses do not.' },
  { key: 'netCashFlow', label: 'Net cash flow', unit: 'MONEY', better: 'HIGHER', group: 'CASH', formula: 'Average monthly change in cash and bank over the last 3 months (negative = burn).' },
  { key: 'runway', label: 'Cash runway', unit: 'MONTHS', better: 'HIGHER', group: 'CASH', formula: 'Cash and bank at the month end ÷ the average monthly net cash outflow of the last 3 months. Only when cash is falling.' },
];

export interface KpiComponent {
  label: string;
  amount: string;
}
export interface KpiValue {
  key: KpiKey;
  /** Decimal string: money at the currency scale, percentages and days to 1 place, ratios to 2. */
  value: string | null;
  /** Why there is no value. */
  reason: string | null;
  components: KpiComponent[];
}

const places: Record<KpiUnit, number> = { MONEY: 2, PERCENT: 1, RATIO: 2, DAYS: 1, MONTHS: 1 };
const round = (x: Dec, n: number) => x.toDecimalPlaces(n, Decimal.ROUND_HALF_EVEN).toFixed(n);

/**
 * Every KPI for the last month of `months` (chronological). Trailing measures use up to
 * the last three months given.
 */
export function computeKpis(months: readonly MonthFigures[], scale = 2): KpiValue[] {
  if (!months.length) throw new Error('No months');
  const m = months[months.length - 1];
  const last3 = months.slice(-3);
  const money = (x: Dec) => x.toFixed(scale);
  const unitOf = (k: KpiKey) => KPI_DEFINITIONS.find((d) => d.key === k)!.unit;
  const value = (key: KpiKey, v: Dec | null, reason: string | null, components: [string, Dec][]): KpiValue => ({
    key,
    value: v === null ? null : unitOf(key) === 'MONEY' ? money(v) : round(v, places[unitOf(key)]),
    reason: v === null ? reason : null,
    components: components.map(([label, amount]) => ({ label, amount: money(amount) })),
  });
  const pct = (a: Dec, b: Dec) => a.dividedBy(b).times(100);
  const pl = plFigures(m);
  const rev = m.operatingRevenue;
  const noRevenue = 'No revenue in the month';
  const currentAssets = m.cash.plus(m.receivables).plus(m.inventory).plus(m.otherCurrentAssets);
  const currentLiabilities = m.payables.plus(m.otherCurrentLiabilities);
  const liabilities = currentLiabilities.plus(m.nonCurrentLiabilities);
  const equity = currentAssets.plus(m.nonCurrentAssets).minus(liabilities);
  const days3 = last3.reduce((a, x) => a + x.days, 0);
  const rev3 = sum(last3.map((x) => x.operatingRevenue));
  const spend3 = sum(last3.map((x) => x.costOfSales.plus(x.operatingExpenses).minus(x.payroll).minus(x.depreciation)));
  const avgCash = sum(last3.map((x) => x.cashChange)).dividedBy(last3.length);
  const n = `${last3.length} month${last3.length === 1 ? '' : 's'}`;

  return [
    value('revenue', rev, null, [['Operating revenue', rev], ['Other income (not included)', m.otherIncome]]),
    value('grossMargin', rev.greaterThan(0) ? pct(pl.grossProfit, rev) : null, noRevenue, [['Revenue', rev], ['Cost of sales', m.costOfSales], ['Gross profit', pl.grossProfit]]),
    value('operatingMargin', rev.greaterThan(0) ? pct(pl.operatingProfit, rev) : null, noRevenue, [['Revenue', rev], ['Cost of sales', m.costOfSales], ['Operating expenses', m.operatingExpenses], ['Operating profit', pl.operatingProfit]]),
    value('netMargin', rev.plus(m.otherIncome).greaterThan(0) ? pct(pl.netIncome, rev.plus(m.otherIncome)) : null, noRevenue, [['Revenue and other income', rev.plus(m.otherIncome)], ['Net income', pl.netIncome]]),
    value('opexRatio', rev.greaterThan(0) ? pct(m.operatingExpenses, rev) : null, noRevenue, [['Operating expenses', m.operatingExpenses], ['Revenue', rev]]),
    value('currentRatio', currentLiabilities.greaterThan(0) ? currentAssets.dividedBy(currentLiabilities) : null, 'No current liabilities', [['Current assets', currentAssets], ['Current liabilities', currentLiabilities]]),
    value('quickRatio', currentLiabilities.greaterThan(0) ? m.cash.plus(m.receivables).dividedBy(currentLiabilities) : null, 'No current liabilities', [['Cash and bank', m.cash], ['Receivables', m.receivables], ['Current liabilities', currentLiabilities]]),
    value('workingCapital', currentAssets.minus(currentLiabilities), null, [['Current assets', currentAssets], ['Current liabilities', currentLiabilities]]),
    value('debtToEquity', equity.greaterThan(0) ? liabilities.dividedBy(equity) : null, 'Equity is zero or negative', [['Total liabilities', liabilities], ['Equity', equity]]),
    value('dso', rev3.greaterThan(0) ? m.receivables.dividedBy(rev3).times(days3) : null, `No revenue in the last ${n}`, [['Receivables', m.receivables], [`Revenue, last ${n}`, rev3]]),
    value('dpo', spend3.greaterThan(0) ? m.payables.dividedBy(spend3).times(days3) : null, `No purchases or expenses in the last ${n}`, [['Payables', m.payables], [`Cost of sales and operating expenses, last ${n}`, spend3]]),
    value('netCashFlow', avgCash.toDecimalPlaces(scale, Decimal.ROUND_HALF_EVEN), null, last3.map((x) => [`Change in cash, ${x.month}`, x.cashChange] as [string, Dec])),
    value('runway', avgCash.lessThan(0) && m.cash.greaterThan(0) ? m.cash.dividedBy(avgCash.negated()) : null, m.cash.greaterThan(0) ? 'Cash is not falling' : 'No cash', [['Cash and bank', m.cash], ['Average monthly change', avgCash.toDecimalPlaces(scale, Decimal.ROUND_HALF_EVEN)]]),
  ];
}

/** Each KPI for every month, each month using its own trailing window. */
export function kpiSeries(months: readonly MonthFigures[], scale = 2): Record<KpiKey, { month: string; value: string | null }[]> {
  const out = Object.fromEntries(KPI_DEFINITIONS.map((d) => [d.key, [] as { month: string; value: string | null }[]])) as Record<KpiKey, { month: string; value: string | null }[]>;
  months.forEach((m, i) => {
    for (const k of computeKpis(months.slice(Math.max(0, i - 2), i + 1), scale)) out[k.key].push({ month: m.month, value: k.value });
  });
  return out;
}

// ------------------------------------------------------------------ targets

export type TargetComparator = 'AT_LEAST' | 'AT_MOST';
export type TargetStatus = 'MET' | 'MISSED' | 'NO_VALUE';

export function targetStatus(value: string | null, comparator: TargetComparator, target: string | Dec): TargetStatus {
  if (value === null) return 'NO_VALUE';
  const v = dec(value);
  return comparator === 'AT_LEAST' ? (v.greaterThanOrEqualTo(dec(target)) ? 'MET' : 'MISSED') : v.lessThanOrEqualTo(dec(target)) ? 'MET' : 'MISSED';
}

/** The change from the previous value, and whether it is an improvement. */
export function kpiChange(key: KpiKey, current: string | null, previous: string | null): { change: string | null; improved: boolean | null } {
  if (current === null || previous === null) return { change: null, improved: null };
  const def = KPI_DEFINITIONS.find((d) => d.key === key)!;
  const c = dec(current).minus(dec(previous));
  const n = def.unit === 'MONEY' ? 2 : places[def.unit];
  return { change: round(c, n), improved: c.isZero() ? null : def.better === 'HIGHER' ? c.greaterThan(0) : c.lessThan(0) };
}

/** Share of each customer in total revenue, largest first; the rest grouped. */
export function concentration(rows: readonly { id: string; name: string; revenue: string | Dec }[], top = 5, scale = 2) {
  const list = rows.map((r) => ({ ...r, revenue: dec(r.revenue) })).filter((r) => !r.revenue.isZero());
  const total = sum(list.map((r) => r.revenue));
  list.sort((a, b) => b.revenue.comparedTo(a.revenue) || a.name.localeCompare(b.name));
  const share = (x: Dec) => (total.greaterThan(0) ? round(x.dividedBy(total).times(100), 1) : null);
  const head = list.slice(0, top);
  const rest = sum(list.slice(top).map((r) => r.revenue));
  return {
    total: total.toFixed(scale),
    customers: list.length,
    top: head.map((r) => ({ id: r.id, name: r.name, revenue: r.revenue.toFixed(scale), share: share(r.revenue) })),
    others: { count: Math.max(0, list.length - top), revenue: rest.toFixed(scale), share: share(rest) },
    largestShare: head.length ? share(head[0].revenue) : null,
    topFiveShare: head.length ? share(sum(head.map((r) => r.revenue))) : null,
  };
}
