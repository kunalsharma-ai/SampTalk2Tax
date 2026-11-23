import { D, type Dec } from './money';

/**
 * Department performance (DASH-035): each department's revenue, spending, profit and margin over a
 * range of months, month by month, against its spending budget for the fiscal year, and ranked.
 * Built from posted amounts per department, account type and month; what carries no department is
 * shown as "Not assigned" so the columns add up to the profit and loss. No framework or database code.
 */

export interface PerformanceDepartment {
  id: string;
  code: string;
  name: string;
}
/** The natural amount (revenue: credit less debit; expense: debit less credit) of one department, type and month. */
export interface PerformanceAmount {
  departmentId: string | null;
  month: string;
  type: 'REVENUE' | 'EXPENSE';
  amount: string;
}
export interface PerformanceBudget {
  departmentId: string;
  /** The fiscal year's spending budget. */
  amount: string;
  /** Spending booked to the department from the start of that fiscal year to the end of the range. */
  spentInYear: string;
}

export interface DepartmentMonth {
  month: string;
  revenue: string;
  expenses: string;
  profit: string;
}
export interface DepartmentPerformanceRow {
  id: string | null;
  code: string | null;
  name: string;
  revenue: string;
  expenses: string;
  profit: string;
  /** Profit as a percentage of revenue, one decimal; null without revenue. */
  margin: number | null;
  /** Share of all spending, percent with one decimal. */
  expenseShare: number;
  months: DepartmentMonth[];
  /** Spending in the last month against the average of the months before it, percent; null when there is no earlier spending. */
  expenseTrend: number | null;
  budget: { amount: string; spent: string; remaining: string; usedPercent: number | null; status: 'UNDER' | 'NEAR' | 'OVER' } | null;
}

const money = (d: Dec) => d.toFixed(2);
const pct = (part: Dec, whole: Dec) => (whole.isZero() ? null : part.dividedBy(whole).times(100).toDecimalPlaces(1).toNumber());

/** Departments with any activity or a budget, then "Not assigned" if it has activity, ordered by profit (largest first). */
export function departmentPerformance(
  departments: readonly PerformanceDepartment[],
  amounts: readonly PerformanceAmount[],
  months: readonly string[],
  budgets: readonly PerformanceBudget[] = [],
  opts: { nearPercent?: number } = {},
): { months: string[]; rows: DepartmentPerformanceRow[]; totals: { revenue: string; expenses: string; profit: string; margin: number | null; unassignedExpenseShare: number } } {
  const near = opts.nearPercent ?? 85;
  const known = new Set(departments.map((d) => d.id));
  const key = (id: string | null) => (id !== null && known.has(id) ? id : null);
  const cell = new Map<string, Dec>();
  const add = (k: string, v: Dec) => cell.set(k, (cell.get(k) ?? new D(0)).plus(v));
  for (const a of amounts) {
    const d = key(a.departmentId);
    add(`${d}|${a.month}|${a.type}`, new D(a.amount));
    add(`${d}|*|${a.type}`, new D(a.amount));
  }
  const get = (d: string | null, m: string, t: 'REVENUE' | 'EXPENSE') => cell.get(`${d}|${m}|${t}`) ?? new D(0);
  const allExpenses = [...known, null].reduce((s, d) => s.plus(get(d, '*', 'EXPENSE')), new D(0));
  const allRevenue = [...known, null].reduce((s, d) => s.plus(get(d, '*', 'REVENUE')), new D(0));
  const budgetOf = new Map(budgets.map((b) => [b.departmentId, b]));
  const build = (id: string | null, code: string | null, name: string): DepartmentPerformanceRow => {
    const revenue = get(id, '*', 'REVENUE');
    const expenses = get(id, '*', 'EXPENSE');
    const profit = revenue.minus(expenses);
    const monthly = months.map((m) => {
      const r = get(id, m, 'REVENUE');
      const e = get(id, m, 'EXPENSE');
      return { month: m, revenue: money(r), expenses: money(e), profit: money(r.minus(e)) };
    });
    let expenseTrend: number | null = null;
    if (months.length > 1) {
      const earlier = months.slice(0, -1).map((m) => get(id, m, 'EXPENSE'));
      const avg = earlier.reduce((s, v) => s.plus(v), new D(0)).dividedBy(earlier.length);
      if (avg.greaterThan(0)) expenseTrend = get(id, months[months.length - 1]!, 'EXPENSE').minus(avg).dividedBy(avg).times(100).toDecimalPlaces(1).toNumber();
    }
    const b = id ? budgetOf.get(id) : undefined;
    let budget: DepartmentPerformanceRow['budget'] = null;
    if (b) {
      const amount = new D(b.amount);
      const spent = new D(b.spentInYear);
      const used = pct(spent, amount);
      budget = { amount: money(amount), spent: money(spent), remaining: money(D.max(0, amount.minus(spent))), usedPercent: used, status: spent.greaterThan(amount) ? 'OVER' : used !== null && used >= near ? 'NEAR' : 'UNDER' };
    }
    return { id, code, name, revenue: money(revenue), expenses: money(expenses), profit: money(profit), margin: revenue.greaterThan(0) ? pct(profit, revenue) : null, expenseShare: pct(expenses, allExpenses) ?? 0, months: monthly, expenseTrend, budget };
  };
  const rows = departments
    .filter((d) => !get(d.id, '*', 'REVENUE').isZero() || !get(d.id, '*', 'EXPENSE').isZero() || budgetOf.has(d.id))
    .map((d) => build(d.id, d.code, d.name))
    .sort((a, b) => new D(b.profit).comparedTo(a.profit) || (a.code ?? '').localeCompare(b.code ?? ''));
  const unassigned = !get(null, '*', 'REVENUE').isZero() || !get(null, '*', 'EXPENSE').isZero();
  if (unassigned) rows.push(build(null, null, 'Not assigned'));
  const profit = allRevenue.minus(allExpenses);
  return {
    months: [...months],
    rows,
    totals: { revenue: money(allRevenue), expenses: money(allExpenses), profit: money(profit), margin: allRevenue.greaterThan(0) ? pct(profit, allRevenue) : null, unassignedExpenseShare: pct(get(null, '*', 'EXPENSE'), allExpenses) ?? 0 },
  };
}
