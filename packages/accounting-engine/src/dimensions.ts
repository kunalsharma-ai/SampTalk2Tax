import { D, dec, type Dec } from './money';

/**
 * Financial dimensions: departments (cost centres) and projects that journal lines are tagged
 * with, and the profit and loss split by them.
 *
 * Revenue is credits less debits, expenses debits less credits, per account and per dimension
 * value; lines with no value go to a "Not assigned" column, so every column adds up to the
 * organisation's profit and loss for the period.
 */
export type DimensionType = 'DEPARTMENT' | 'PROJECT';
export const DIMENSION_TYPES: readonly DimensionType[] = ['DEPARTMENT', 'PROJECT'];

export interface DimensionValueRef {
  id: string;
  code: string;
  name: string;
}

export interface DimensionActivity {
  accountId: string;
  code: string;
  name: string;
  type: 'REVENUE' | 'EXPENSE';
  /** Null: the line has no value of this dimension. */
  valueId: string | null;
  debit: string;
  credit: string;
}

export interface DimensionColumn {
  id: string | null;
  code: string | null;
  name: string;
}

export interface DimensionSection {
  type: 'REVENUE' | 'EXPENSE';
  rows: { accountId: string; code: string; name: string; amounts: string[]; total: string }[];
  totals: string[];
  total: string;
}

export interface DimensionReport {
  columns: DimensionColumn[];
  sections: DimensionSection[];
  netProfit: string[];
  netProfitTotal: string;
  /** Net profit as a percentage of revenue, one decimal place; null where there is no revenue. */
  margin: (string | null)[];
}

/** Codes are short and plain: letters, digits, dash and underscore, up to 20 characters. */
export function checkDimensionCode(code: string): string | null {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,19}$/.test(code) ? null : 'Use a code of up to 20 letters, digits, dashes or underscores';
}

/**
 * The profit and loss with one column per value (in the order given), then "Not assigned".
 * Values with no activity are kept, so a department with nothing posted shows as zero.
 */
export function profitByDimension(values: readonly DimensionValueRef[], activity: readonly DimensionActivity[], scale = 2): DimensionReport {
  const columns: DimensionColumn[] = [...values.map((v) => ({ id: v.id, code: v.code, name: v.name })), { id: null, code: null, name: 'Not assigned' }];
  const index = new Map<string | null, number>(columns.map((c, i) => [c.id, i]));
  const n = columns.length;
  const zero = () => Array.from({ length: n }, () => new D(0) as Dec);
  const sections: DimensionSection[] = [];
  const sectionTotals: Record<'REVENUE' | 'EXPENSE', Dec[]> = { REVENUE: zero(), EXPENSE: zero() };
  for (const type of ['REVENUE', 'EXPENSE'] as const) {
    const byAccount = new Map<string, { code: string; name: string; amounts: Dec[] }>();
    for (const a of activity) {
      if (a.type !== type) continue;
      const col = index.get(a.valueId) ?? n - 1;
      const amount = type === 'REVENUE' ? dec(a.credit).minus(dec(a.debit)) : dec(a.debit).minus(dec(a.credit));
      const row = byAccount.get(a.accountId) ?? { code: a.code, name: a.name, amounts: zero() };
      row.amounts[col] = row.amounts[col]!.plus(amount);
      byAccount.set(a.accountId, row);
    }
    const rows = [...byAccount.entries()]
      .sort((x, y) => x[1].code.localeCompare(y[1].code))
      .filter(([, r]) => r.amounts.some((v) => !v.isZero()))
      .map(([accountId, r]) => {
        r.amounts.forEach((v, i) => (sectionTotals[type][i] = sectionTotals[type][i]!.plus(v)));
        return { accountId, code: r.code, name: r.name, amounts: r.amounts.map((v) => v.toFixed(scale)), total: r.amounts.reduce((s, v) => s.plus(v), new D(0)).toFixed(scale) };
      });
    const totals = sectionTotals[type];
    sections.push({ type, rows, totals: totals.map((v) => v.toFixed(scale)), total: totals.reduce((s, v) => s.plus(v), new D(0)).toFixed(scale) });
  }
  const net = sectionTotals.REVENUE.map((r, i) => r.minus(sectionTotals.EXPENSE[i]!));
  return {
    columns,
    sections,
    netProfit: net.map((v) => v.toFixed(scale)),
    netProfitTotal: net.reduce((s, v) => s.plus(v), new D(0)).toFixed(scale),
    margin: net.map((v, i) => (sectionTotals.REVENUE[i]!.gt(0) ? v.div(sectionTotals.REVENUE[i]!).times(100).toFixed(1) : null)),
  };
}
