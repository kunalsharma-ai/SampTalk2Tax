import { D, type Dec } from './money';
import type { VisualAccount, VisualAmount } from './financial-visuals';

/**
 * Financial landscape (DASH-023): income or spending laid out as a landscape of towers, one row
 * per account (the largest, the rest joined as one row) and one column per month, each tower as
 * tall as the amount. Rows are ordered largest first; amounts that run against an account's
 * nature (a refund larger than the month's spending) are kept as negative so totals stay true.
 * Pure: the caller reads the books (posted entries, closing entries left out).
 */
export const LANDSCAPE_VIEWS = ['EXPENSES', 'REVENUE'] as const;
export type LandscapeView = (typeof LANDSCAPE_VIEWS)[number];

export interface LandscapeRow {
  key: string;
  label: string;
  accountIds: string[];
  /** One per month, in order. */
  values: string[];
  total: string;
}
export interface FinancialLandscape {
  view: LandscapeView;
  months: string[];
  rows: LandscapeRow[];
  monthTotals: string[];
  total: string;
  peak: { row: string; month: string; amount: string } | null;
  /** The month with the most in total. */
  busiestMonth: string | null;
}

export function financialLandscape(input: { accounts: VisualAccount[]; amounts: VisualAmount[]; months: string[]; view: LandscapeView; top?: number; scale: number }): FinancialLandscape {
  const type = input.view === 'REVENUE' ? 'REVENUE' : 'EXPENSE';
  const top = Math.max(1, Math.min(input.top ?? 8, 15));
  const accounts = new Map(input.accounts.filter((a) => a.type === type).map((a) => [a.id, a]));
  const col = new Map(input.months.map((m, i) => [m, i]));
  const per = new Map<string, Dec[]>();
  for (const x of input.amounts) {
    const i = col.get(x.month);
    if (i === undefined || !accounts.has(x.accountId)) continue;
    const row = per.get(x.accountId) ?? input.months.map(() => new D(0));
    row[i] = row[i].plus(x.amount);
    per.set(x.accountId, row);
  }
  const sum = (v: Dec[]) => v.reduce((t, x) => t.plus(x), new D(0));
  const ranked = [...per.entries()]
    .map(([id, values]) => ({ id, values, total: sum(values) }))
    .filter((r) => !r.total.isZero() || r.values.some((v) => !v.isZero()))
    .sort((a, b) => b.total.comparedTo(a.total) || accounts.get(a.id)!.code.localeCompare(accounts.get(b.id)!.code));
  const head = ranked.length > top ? ranked.slice(0, top - 1) : ranked;
  const rest = ranked.slice(head.length);
  const fx = (d: Dec) => d.toFixed(input.scale);
  const rows: LandscapeRow[] = head.map((r) => {
    const a = accounts.get(r.id)!;
    return { key: r.id, label: `${a.code} ${a.name}`, accountIds: [r.id], values: r.values.map(fx), total: fx(r.total) };
  });
  if (rest.length) {
    const values = input.months.map((_, i) => rest.reduce((t, r) => t.plus(r.values[i]), new D(0)));
    rows.push({ key: 'others', label: `${rest.length} other account${rest.length === 1 ? '' : 's'}`, accountIds: rest.map((r) => r.id), values: values.map(fx), total: fx(sum(values)) });
  }
  const monthTotals = input.months.map((_, i) => rows.reduce((t, r) => t.plus(r.values[i]), new D(0)));
  let peak: FinancialLandscape['peak'] = null;
  for (const r of rows) r.values.forEach((v, i) => (!peak || new D(v).gt(peak.amount)) && new D(v).gt(0) && (peak = { row: r.label, month: input.months[i], amount: v }));
  let busiest = -1;
  monthTotals.forEach((t, i) => (busiest < 0 || t.gt(monthTotals[busiest])) && t.gt(0) && (busiest = i));
  return { view: input.view, months: input.months, rows, monthTotals: monthTotals.map(fx), total: fx(sum(monthTotals)), peak, busiestMonth: busiest >= 0 ? input.months[busiest] : null };
}
