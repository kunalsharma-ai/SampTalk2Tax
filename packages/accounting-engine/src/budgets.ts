/**
 * Budgets: twelve monthly amounts per revenue or expense account for a fiscal year,
 * ways to fill them (spread an annual total, copy last year's actuals with a change),
 * and budget-versus-actual variance by month, quarter or year.
 *
 * Amounts are on each account's normal side: revenue as earned (credit minus debit),
 * expenses as spent (debit minus credit). No floating point: inputs are decimal strings.
 */
import Decimal from 'decimal.js';
import { D, Dec, dec, sum } from './money';

export const BUDGET_PERIODS = 12;
export type BudgetAccountType = 'REVENUE' | 'EXPENSE';
export type BudgetGranularity = 'MONTH' | 'QUARTER' | 'YEAR';
/** Largest amount one budget cell may hold (NUMERIC(18,2)). */
export const BUDGET_MAX = new D('9999999999999999.99');

export class BudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetError';
  }
}

function minorStep(scale: number): Dec {
  return new D(1).dividedBy(new D(10).pow(scale));
}

/**
 * Spread `total` across `weights` so the parts add up to `total` exactly at `scale`
 * decimals. Each part is rounded towards zero and the remaining minor units go, one
 * each, to the parts with the largest remainders (earliest first on ties). With
 * weights that add up to zero, the total is spread evenly.
 */
export function spreadByWeights(total: string | Dec, weights: readonly (string | Dec)[], scale = 2): string[] {
  const t = dec(total);
  if (weights.length === 0) throw new BudgetError('Nothing to spread over');
  let w = weights.map((x) => dec(x));
  if (w.some((x) => x.isNegative())) throw new BudgetError('Weights cannot be negative');
  const wTotal = sum(w);
  if (wTotal.isZero()) {
    w = w.map(() => new D(1));
  }
  const weightSum = sum(w);
  const sign = t.isNegative() ? -1 : 1;
  const abs = t.abs();
  const exact = w.map((x) => abs.times(x).dividedBy(weightSum));
  const parts = exact.map((x) => x.toDecimalPlaces(scale, Decimal.ROUND_DOWN));
  const step = minorStep(scale);
  let left = abs.minus(sum(parts)).dividedBy(step).round().toNumber();
  const order = exact
    .map((x, i) => ({ i, rem: x.minus(parts[i]) }))
    .sort((a, b) => b.rem.comparedTo(a.rem) || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) parts[order[k].i] = parts[order[k].i].plus(step);
  return parts.map((p) => (sign < 0 && !p.isZero() ? p.negated() : p).toFixed(scale));
}

/** An annual total spread over the twelve months as evenly as the currency allows. */
export function spreadEvenly(total: string | Dec, scale = 2): string[] {
  return spreadByWeights(total, Array.from({ length: BUDGET_PERIODS }, () => '1'), scale);
}

/** Last year's monthly actuals changed by `changePercent` (for example "10" or "-5"), each month rounded half-even. */
export function fromPriorYear(prior: readonly (string | Dec)[], changePercent: string, scale = 2): string[] {
  if (prior.length !== BUDGET_PERIODS) throw new BudgetError(`Expected ${BUDGET_PERIODS} months, got ${prior.length}`);
  const pct = dec(changePercent);
  if (pct.lessThan(-100) || pct.greaterThan(1000)) throw new BudgetError('The change must be between -100% and 1000%');
  const factor = new D(1).plus(pct.dividedBy(100));
  return prior.map((p) => dec(p).times(factor).toDecimalPlaces(scale, Decimal.ROUND_HALF_EVEN).toFixed(scale));
}

/** Checks one account's twelve amounts; returns the problem in words, or null. */
export function budgetAmountsIssue(amounts: readonly string[], scale = 2): string | null {
  if (amounts.length !== BUDGET_PERIODS) return `Give ${BUDGET_PERIODS} monthly amounts`;
  for (const [i, a] of amounts.entries()) {
    if (typeof a !== 'string' || !/^-?\d{1,16}(\.\d+)?$/.test(a.trim())) return `Month ${i + 1}: not an amount`;
    const v = new D(a.trim());
    if (v.decimalPlaces() > scale) return `Month ${i + 1}: at most ${scale} decimal places`;
    if (v.abs().greaterThan(BUDGET_MAX)) return `Month ${i + 1}: too large`;
  }
  return null;
}

/** Period numbers (1–12) grouped by month, quarter or the whole year. */
export function budgetBuckets(granularity: BudgetGranularity): number[][] {
  const months = Array.from({ length: BUDGET_PERIODS }, (_, i) => i + 1);
  if (granularity === 'MONTH') return months.map((m) => [m]);
  if (granularity === 'QUARTER') return [0, 1, 2, 3].map((q) => months.slice(q * 3, q * 3 + 3));
  return [months];
}

export interface Variance {
  budget: string;
  /** null when no part of the bucket has started yet. */
  actual: string | null;
  /** actual − budget; null without an actual. */
  variance: string | null;
  /** variance as a percentage of the budget, one decimal; null when the budget is zero or there is no actual. */
  percent: string | null;
  /** Revenue above budget or spending below it. null without an actual. */
  favourable: boolean | null;
}

/** Variance of one figure: for revenue more is better, for expenses less is better. */
export function variance(kind: BudgetAccountType | 'NET', budget: Dec, actual: Dec | null, scale = 2): Variance {
  if (actual === null) return { budget: budget.toFixed(scale), actual: null, variance: null, percent: null, favourable: null };
  const v = actual.minus(budget);
  return {
    budget: budget.toFixed(scale),
    actual: actual.toFixed(scale),
    variance: v.toFixed(scale),
    percent: budget.isZero() ? null : v.dividedBy(budget.abs()).times(100).toDecimalPlaces(1, Decimal.ROUND_HALF_EVEN).toFixed(1),
    favourable: kind === 'EXPENSE' ? !v.greaterThan(0) : !v.lessThan(0),
  };
}

export interface BudgetVarianceAccount {
  accountId: string;
  code: string;
  name: string;
  type: BudgetAccountType;
  /** Twelve budget amounts (missing months count as zero). */
  budget: readonly (string | Dec)[] | null;
  /** Twelve actual amounts on the normal side; months not started are ignored. */
  actual: readonly (string | Dec)[];
}

export interface BudgetVarianceInput {
  accounts: readonly BudgetVarianceAccount[];
  granularity: BudgetGranularity;
  /** How many periods have started by the report date (0–12). Later periods have no actual. */
  periodsStarted: number;
  scale?: number;
}

export interface BudgetVarianceRow {
  accountId: string;
  code: string;
  name: string;
  type: BudgetAccountType;
  budgeted: boolean;
  buckets: Variance[];
  /** Started periods only: their budget against their actual. */
  yearToDate: Variance;
  fullYearBudget: string;
}

export interface BudgetVarianceTotals {
  buckets: Variance[];
  yearToDate: Variance;
  fullYearBudget: string;
}

export interface BudgetVarianceReport {
  buckets: { periods: number[]; started: boolean }[];
  rows: BudgetVarianceRow[];
  revenue: BudgetVarianceTotals;
  expenses: BudgetVarianceTotals;
  netIncome: BudgetVarianceTotals;
}

const zeros = () => Array.from({ length: BUDGET_PERIODS }, () => new D(0));

/**
 * Budget against actual for each account and for revenue, expenses and net income.
 * Accounts with actuals but no budget appear with a zero budget (unbudgeted spending or
 * income). A bucket's actual covers its started periods; the bucket's budget is the whole
 * bucket, so a quarter in progress compares the quarter's full budget with actuals so far.
 */
export function buildBudgetVariance(input: BudgetVarianceInput): BudgetVarianceReport {
  const scale = input.scale ?? 2;
  const started = Math.max(0, Math.min(BUDGET_PERIODS, Math.trunc(input.periodsStarted)));
  const groups = budgetBuckets(input.granularity);
  const bucketStarted = groups.map((g) => g[0] <= started);

  const figures = (budget: Dec[], actual: Dec[], kind: BudgetAccountType | 'NET') => {
    const buckets = groups.map((g, i) =>
      variance(kind, sum(g.map((p) => budget[p - 1])), bucketStarted[i] ? sum(g.filter((p) => p <= started).map((p) => actual[p - 1])) : null, scale),
    );
    const ytdBudget = sum(budget.slice(0, started));
    const yearToDate = variance(kind, ytdBudget, started > 0 ? sum(actual.slice(0, started)) : null, scale);
    return { buckets, yearToDate, fullYearBudget: sum(budget).toFixed(scale) };
  };

  const totals: Record<BudgetAccountType, { budget: Dec[]; actual: Dec[] }> = {
    REVENUE: { budget: zeros(), actual: zeros() },
    EXPENSE: { budget: zeros(), actual: zeros() },
  };
  const rows: BudgetVarianceRow[] = [];
  for (const a of input.accounts) {
    if (a.actual.length !== BUDGET_PERIODS) throw new BudgetError(`Account ${a.code}: expected ${BUDGET_PERIODS} actual amounts`);
    if (a.budget && a.budget.length !== BUDGET_PERIODS) throw new BudgetError(`Account ${a.code}: expected ${BUDGET_PERIODS} budget amounts`);
    const budget = a.budget ? a.budget.map((x) => dec(x)) : zeros();
    const actual = a.actual.map((x, i) => (i < started ? dec(x) : new D(0)));
    const hasActual = actual.some((x) => !x.isZero());
    if (!a.budget && !hasActual) continue;
    for (let i = 0; i < BUDGET_PERIODS; i++) {
      totals[a.type].budget[i] = totals[a.type].budget[i].plus(budget[i]);
      totals[a.type].actual[i] = totals[a.type].actual[i].plus(actual[i]);
    }
    rows.push({ accountId: a.accountId, code: a.code, name: a.name, type: a.type, budgeted: !!a.budget, ...figures(budget, actual, a.type) });
  }
  rows.sort((x, y) => (x.type === y.type ? x.code.localeCompare(y.code) : x.type === 'REVENUE' ? -1 : 1));
  const net = (k: 'budget' | 'actual') => totals.REVENUE[k].map((r, i) => r.minus(totals.EXPENSE[k][i]));
  return {
    buckets: groups.map((periods, i) => ({ periods, started: bucketStarted[i] })),
    rows,
    revenue: figures(totals.REVENUE.budget, totals.REVENUE.actual, 'REVENUE'),
    expenses: figures(totals.EXPENSE.budget, totals.EXPENSE.actual, 'EXPENSE'),
    netIncome: figures(net('budget'), net('actual'), 'NET'),
  };
}
