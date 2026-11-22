import { addMonths } from './forecast-lab';
import { D, type Dec } from './money';

/**
 * Expense forecasting (EXP-025). From the expense claim lines people spent in past months, the
 * spending each expense account is likely to see in the coming months: the average of the last
 * three full months, scaled by how that calendar month compared with the year's average when
 * there is a year of history (seasonal), with a range from how much the account usually moves.
 * Accounts with spending in fewer than two of the last six months are listed as occasional, not
 * forecast. The money already owed to employees (approved, not yet paid back) and waiting for
 * approval is shown beside it. Every figure comes from the claims; nothing is guessed by a model.
 */

export interface ForecastExpenseLine {
  /** When the money was spent (YYYY-MM-DD). */
  date: string;
  accountId: string;
  accountLabel: string;
  amount: string;
}

export type ExpenseForecastMethod = 'SEASONAL' | 'RECENT_AVERAGE';
export const EXPENSE_FORECAST_METHOD_LABEL: Record<ExpenseForecastMethod, string> = { SEASONAL: 'Seasonal', RECENT_AVERAGE: 'Recent average' };

export interface ExpenseForecastMonth {
  month: string;
  forecast: string;
  low: string;
  high: string;
}

export interface ExpenseAccountForecast {
  accountId: string;
  accountLabel: string;
  method: ExpenseForecastMethod;
  basis: string;
  /** The last 12 full months, oldest first. */
  history: { month: string; amount: string }[];
  /** Spent so far this month. */
  thisMonthSoFar: string;
  months: ExpenseForecastMonth[];
  /** Last three months against the three before, as a percentage; null without spending before. */
  trendPercent: string | null;
}

export interface ExpenseForecast {
  asOf: string;
  months: string[];
  accounts: ExpenseAccountForecast[];
  occasional: { accountId: string; accountLabel: string; lastSpent: string; total12Months: string }[];
  totals: ExpenseForecastMonth[];
  thisMonthSoFar: string;
  owed: { approvedNotPaid: string; approvedClaims: number; waitingApproval: string; waitingClaims: number };
}

export const EXPENSE_FORECAST_HISTORY_MONTHS = 12; // not money
export const EXPENSE_FORECAST_MAX_MONTHS = 6; // not money

const sum = (xs: Dec[]) => xs.reduce((a, b) => a.plus(b), new D(0));
const mean = (xs: Dec[]) => (xs.length ? sum(xs).div(xs.length) : new D(0));

export function expenseForecast(input: {
  asOf: string;
  months: number;
  lines: ForecastExpenseLine[];
  approvedNotPaid?: string[];
  waitingApproval?: string[];
  scale?: number;
}): ExpenseForecast {
  const scale = input.scale ?? 2;
  const fx = (d: Dec) => d.toDecimalPlaces(scale, D.ROUND_HALF_EVEN).toFixed(scale);
  const horizon = Math.min(Math.max(1, Math.trunc(input.months)), EXPENSE_FORECAST_MAX_MONTHS); // not money
  const current = input.asOf.slice(0, 7);
  const past = Array.from({ length: EXPENSE_FORECAST_HISTORY_MONTHS }, (_, i) => addMonths(current, i - EXPENSE_FORECAST_HISTORY_MONTHS)); // not money
  const ahead = Array.from({ length: horizon }, (_, i) => addMonths(current, i)); // not money
  const first = past[0]!;

  const byAccount = new Map<string, { label: string; months: Map<string, Dec>; soFar: Dec; last: string }>();
  for (const l of input.lines) {
    const m = l.date.slice(0, 7);
    if (m < first || l.date > input.asOf) continue;
    const a = byAccount.get(l.accountId) ?? { label: l.accountLabel, months: new Map(), soFar: new D(0), last: l.date };
    if (m === current) a.soFar = a.soFar.plus(l.amount);
    else a.months.set(m, (a.months.get(m) ?? new D(0)).plus(l.amount));
    if (l.date > a.last) a.last = l.date;
    byAccount.set(l.accountId, a);
  }

  const accounts: ExpenseAccountForecast[] = [];
  const occasional: ExpenseForecast['occasional'] = [];
  for (const [accountId, a] of byAccount) {
    const series = past.map((m) => a.months.get(m) ?? new D(0));
    const lastSix = series.slice(-6);
    if (lastSix.filter((x) => x.gt(0)).length < 2) {
      occasional.push({ accountId, accountLabel: a.label, lastSpent: a.last, total12Months: fx(sum(series).plus(a.soFar)) });
      continue;
    }
    const recent = mean(series.slice(-3));
    const year = mean(series);
    const monthsWithSpend = series.filter((x) => x.gt(0)).length; // not money
    const seasonal = monthsWithSpend >= 10 && year.gt(0);
    // How far the account usually moves month to month: the spread of the last six months.
    const m6 = mean(lastSix);
    const spread = mean(lastSix.map((x) => x.minus(m6).pow(2))).sqrt();
    const months = ahead.map((month) => {
      let f = recent;
      if (seasonal) {
        const lastYear = a.months.get(addMonths(month, -12)) ?? new D(0);
        const factor = D.min(D.max(lastYear.div(year), new D('0.5')), new D(2));
        f = recent.mul(factor);
      }
      return { month, forecast: fx(f), low: fx(D.max(f.minus(spread), new D(0))), high: fx(f.plus(spread)) };
    });
    const before = mean(series.slice(-6, -3));
    accounts.push({
      accountId,
      accountLabel: a.label,
      method: seasonal ? 'SEASONAL' : 'RECENT_AVERAGE',
      basis: seasonal
        ? 'Average of the last 3 months, adjusted for how each month compared with the year before'
        : 'Average of the last 3 months; with a year of history it follows the season',
      history: past.map((month, i) => ({ month, amount: fx(series[i]!) })),
      thisMonthSoFar: fx(a.soFar),
      months,
      trendPercent: before.gt(0) ? recent.minus(before).div(before).mul(100).toDecimalPlaces(1, D.ROUND_HALF_EVEN).toFixed(1) : null,
    });
  }
  accounts.sort((x, y) => new D(y.months[0]!.forecast).cmp(x.months[0]!.forecast) || x.accountLabel.localeCompare(y.accountLabel));
  occasional.sort((x, y) => y.lastSpent.localeCompare(x.lastSpent));
  const totals = ahead.map((month, i) => ({
    month,
    forecast: fx(sum(accounts.map((a) => new D(a.months[i]!.forecast)))),
    low: fx(sum(accounts.map((a) => new D(a.months[i]!.low)))),
    high: fx(sum(accounts.map((a) => new D(a.months[i]!.high)))),
  }));
  const approved = input.approvedNotPaid ?? [];
  const waiting = input.waitingApproval ?? [];
  return {
    asOf: input.asOf,
    months: ahead,
    accounts,
    occasional,
    totals,
    thisMonthSoFar: fx(sum([...byAccount.values()].map((a) => a.soFar))),
    owed: { approvedNotPaid: fx(sum(approved.map((x) => new D(x)))), approvedClaims: approved.length, waitingApproval: fx(sum(waiting.map((x) => new D(x)))), waitingClaims: waiting.length },
  };
}
