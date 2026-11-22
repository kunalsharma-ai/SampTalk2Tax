import { D, type Dec } from './money';

/**
 * Department budgets (EXP-014). Each department (cost centre) gets an amount for the fiscal year
 * to spend on expenses. Against it: what was spent (posted expense lines carrying the department:
 * approved expense claims, bills and journals), what is committed (submitted claims waiting for
 * approval), how much of the year has gone, and where the department is heading at its pace so
 * far. A claim waiting for approval shows what it would do to each department's budget.
 */

export type DepartmentBudgetStatus = 'NO_BUDGET' | 'ON_TRACK' | 'AT_RISK' | 'OVER';
export const DEPARTMENT_BUDGET_STATUS_LABEL: Record<DepartmentBudgetStatus, string> = { NO_BUDGET: 'No budget', ON_TRACK: 'On track', AT_RISK: 'At risk', OVER: 'Over budget' };

export interface DepartmentBudgetRowInput {
  departmentId: string;
  code: string;
  name: string;
  budget: string | null;
  /** Spent this fiscal year so far (posted). */
  actual: string;
  /** Claims submitted and waiting for approval. */
  committed: string;
}

export interface DepartmentBudgetRow extends DepartmentBudgetRowInput {
  status: DepartmentBudgetStatus;
  /** What the budget allows by today if spread evenly over the year. */
  expectedByNow: string | null;
  usedPercent: string | null;
  /** Budget left after what is spent and committed (negative when over). */
  remaining: string | null;
  /** Spending by year end at the pace so far. */
  projected: string;
  reason: string;
}

const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1; // not money

/** The share of the fiscal year gone by `asOf`, as elapsed and total days. */
export function yearElapsed(fyStart: string, fyEnd: string, asOf: string) {
  const total = days(fyStart, fyEnd); // not money
  const elapsed = asOf < fyStart ? 0 : asOf > fyEnd ? total : days(fyStart, asOf); // not money
  return { elapsed, total };
}

export function departmentBudgets(rows: DepartmentBudgetRowInput[], opts: { fyStart: string; fyEnd: string; asOf: string; scale?: number; money?: (amount: string) => string }) {
  const scale = opts.scale ?? 2;
  const fx = (d: Dec) => d.toDecimalPlaces(scale, D.ROUND_HALF_EVEN).toFixed(scale);
  const show = opts.money ?? ((a: string) => a);
  const { elapsed, total } = yearElapsed(opts.fyStart, opts.fyEnd, opts.asOf);
  const out: DepartmentBudgetRow[] = rows.map((r) => {
    const actual = new D(r.actual);
    const committed = new D(r.committed);
    const projected = elapsed > 0 ? actual.mul(total).div(elapsed) : actual;
    if (r.budget === null) {
      return { ...r, actual: fx(actual), committed: fx(committed), status: 'NO_BUDGET', expectedByNow: null, usedPercent: null, remaining: null, projected: fx(projected), reason: 'No budget set for this year' };
    }
    const budget = new D(r.budget);
    const remaining = budget.minus(actual).minus(committed);
    const used = budget.gt(0) ? actual.div(budget).mul(100) : null;
    let status: DepartmentBudgetStatus;
    let reason: string;
    if (actual.gt(budget)) {
      status = 'OVER';
      reason = `Spent ${show(fx(actual.minus(budget)))} more than the budget`;
    } else if (remaining.lt(0)) {
      status = 'AT_RISK';
      reason = `Claims waiting for approval would take it ${show(fx(remaining.neg()))} over`;
    } else if (projected.gt(budget)) {
      status = 'AT_RISK';
      reason = `At this pace it spends ${show(fx(projected))} by the year end, ${show(fx(projected.minus(budget)))} over`;
    } else {
      status = 'ON_TRACK';
      reason = `At this pace it spends ${show(fx(projected))} by the year end`;
    }
    return {
      ...r,
      budget: fx(budget),
      actual: fx(actual),
      committed: fx(committed),
      status,
      expectedByNow: fx(budget.mul(elapsed).div(total)),
      usedPercent: used ? used.toDecimalPlaces(1, D.ROUND_HALF_EVEN).toFixed(1) : null,
      remaining: fx(remaining),
      projected: fx(projected),
      reason,
    };
  });
  const rank: Record<DepartmentBudgetStatus, number> = { OVER: 0, AT_RISK: 1, ON_TRACK: 2, NO_BUDGET: 3 }; // not money
  out.sort((a, b) => rank[a.status] - rank[b.status] || a.code.localeCompare(b.code));
  const sum = (k: 'budget' | 'actual' | 'committed') => fx(out.reduce((s, r) => s.plus(r[k] ?? 0), new D(0)));
  return { rows: out, totals: { budget: sum('budget'), actual: sum('actual'), committed: sum('committed') }, elapsedDays: elapsed, totalDays: total };
}

export interface ClaimBudgetImpact {
  departmentId: string;
  name: string;
  /** This claim's spending charged to the department (before tax). */
  amount: string;
  budget: string | null;
  /** Budget left before this claim, after what is spent and the other claims waiting. */
  remainingBefore: string | null;
  remainingAfter: string | null;
  takesOver: boolean;
}

/** What approving a claim would do to each department's budget. */
export function claimBudgetImpact(departments: { departmentId: string; name: string; budget: string | null; actual: string; committedOthers: string }[], claimByDepartment: Map<string, string>, scale = 2): ClaimBudgetImpact[] {
  const fx = (d: Dec) => d.toDecimalPlaces(scale, D.ROUND_HALF_EVEN).toFixed(scale);
  return departments
    .filter((d) => claimByDepartment.has(d.departmentId))
    .map((d) => {
      const amount = new D(claimByDepartment.get(d.departmentId)!);
      if (d.budget === null) return { departmentId: d.departmentId, name: d.name, amount: fx(amount), budget: null, remainingBefore: null, remainingAfter: null, takesOver: false };
      const before = new D(d.budget).minus(d.actual).minus(d.committedOthers);
      const after = before.minus(amount);
      return { departmentId: d.departmentId, name: d.name, amount: fx(amount), budget: fx(new D(d.budget)), remainingBefore: fx(before), remainingAfter: fx(after), takesOver: after.lt(0) };
    });
}
