/**
 * The forecast evaluation lab: several simple, explainable forecasting models run against the
 * organisation's own monthly history, and measured on how well they would have predicted the
 * months that actually happened (a rolling-origin backtest). Saved forecasts are measured again
 * later against the months as they turn out.
 *
 * Everything is decimal arithmetic; nothing here reads a database.
 */
import { D, Dec, sum } from './money';
import { plFigures, type MonthFigures } from './kpis';

export const LAB_SERIES = [
  { key: 'revenue', label: 'Revenue', description: 'Operating revenue posted in the month.' },
  { key: 'costOfSales', label: 'Cost of sales', description: 'Cost of sales posted in the month.' },
  { key: 'operatingExpenses', label: 'Operating expenses', description: 'Operating expenses, payroll and depreciation posted in the month.' },
  { key: 'netIncome', label: 'Net income', description: 'Revenue and other income less every expense.' },
  { key: 'netCashFlow', label: 'Net cash flow', description: 'Change in cash and bank balances during the month.' },
] as const;
export type LabSeries = (typeof LAB_SERIES)[number]['key'];

export const LAB_MODELS = [
  { key: 'NAIVE', label: 'Last month', minHistory: 1, description: 'Next month will be the same as the last one.' },
  { key: 'MEAN_3', label: '3-month average', minHistory: 3, description: 'The average of the last 3 months.' },
  { key: 'MEAN_6', label: '6-month average', minHistory: 6, description: 'The average of the last 6 months.' },
  { key: 'MEAN_12', label: '12-month average', minHistory: 12, description: 'The average of the last 12 months.' },
  { key: 'SEASONAL', label: 'Same month last year', minHistory: 12, description: 'The same calendar month a year earlier.' },
  { key: 'DRIFT', label: 'Last month plus trend', minHistory: 6, description: 'The last month plus the average monthly change over up to 12 months, for each month ahead.' },
  { key: 'LINEAR', label: 'Straight-line trend', minHistory: 6, description: 'A straight line fitted to up to 12 months (least squares), extended.' },
  { key: 'SMOOTHING', label: 'Exponential smoothing', minHistory: 3, description: 'A weighted average where each older month counts 30% less (α = 0.3).' },
] as const;
export type LabModel = (typeof LAB_MODELS)[number]['key'];

export const LAB_HORIZONS = [1, 2, 3] as const;
export const LAB_WINDOWS = [6, 12, 18] as const;

/** The value of each series in a month's figures. */
export function seriesValue(m: MonthFigures, s: LabSeries): Dec {
  switch (s) {
    case 'revenue':
      return m.operatingRevenue;
    case 'costOfSales':
      return m.costOfSales;
    case 'operatingExpenses':
      return m.operatingExpenses;
    case 'netIncome':
      return plFigures(m).netIncome;
    case 'netCashFlow':
      return m.cashChange;
  }
}

const mean = (xs: readonly Dec[]) => sum(xs).dividedBy(xs.length);

/**
 * Forecast `h` months after the last value of `history` (oldest first). Null when the model
 * needs more history than there is.
 */
export function forecastValue(model: LabModel, history: readonly Dec[], h: number): Dec | null {
  const def = LAB_MODELS.find((m) => m.key === model)!;
  const n = history.length;
  if (n < def.minHistory || h < 1) return null;
  const last = history[n - 1]!;
  switch (model) {
    case 'NAIVE':
      return last;
    case 'MEAN_3':
      return mean(history.slice(-3));
    case 'MEAN_6':
      return mean(history.slice(-6));
    case 'MEAN_12':
      return mean(history.slice(-12));
    case 'SEASONAL':
      // The month h ahead, a year earlier: index n - 1 + h - 12.
      return h <= 12 ? history[n - 13 + h]! : null;
    case 'DRIFT': {
      const w = history.slice(-12);
      const slope = w[w.length - 1]!.minus(w[0]!).dividedBy(w.length - 1);
      return last.plus(slope.times(h));
    }
    case 'LINEAR': {
      const w = history.slice(-12);
      const k = w.length;
      const xs = w.map((_, i) => new D(i));
      const xm = mean(xs);
      const ym = mean(w);
      const sxy = sum(w.map((y, i) => xs[i]!.minus(xm).times(y.minus(ym))));
      const sxx = sum(xs.map((x) => x.minus(xm).pow(2)));
      const slope = sxx.isZero() ? new D(0) : sxy.dividedBy(sxx);
      return ym.plus(slope.times(new D(k - 1 + h).minus(xm)));
    }
    case 'SMOOTHING': {
      const alpha = new D('0.3');
      let level = history[0]!;
      for (const y of history.slice(1)) level = alpha.times(y).plus(new D(1).minus(alpha).times(level));
      return level;
    }
  }
}

export interface ErrorPoint {
  month: string;
  horizon: number;
  forecast: Dec;
  actual: Dec;
}

export interface AccuracyStats {
  /** How many forecasts were measured. */
  count: number;
  /** Mean absolute error, money. */
  mae: string | null;
  /** Total absolute error ÷ total absolute actual, percent. The ranking measure. */
  wape: string | null;
  /** Mean of forecast − actual: positive means the model forecast too high. */
  bias: string | null;
  /** Share of months where the error was within 10% of the actual, percent. */
  within10: string | null;
}

export function accuracy(points: readonly ErrorPoint[], scale = 2): AccuracyStats {
  if (!points.length) return { count: 0, mae: null, wape: null, bias: null, within10: null };
  const abs = points.map((p) => p.forecast.minus(p.actual).abs());
  const totalActual = sum(points.map((p) => p.actual.abs()));
  const close = points.filter((p, i) => !p.actual.isZero() && abs[i]!.lessThanOrEqualTo(p.actual.abs().times('0.1'))).length;
  return {
    count: points.length,
    mae: mean(abs).toDecimalPlaces(scale, D.ROUND_HALF_EVEN).toFixed(scale),
    wape: totalActual.isZero() ? null : sum(abs).dividedBy(totalActual).times(100).toDecimalPlaces(1, D.ROUND_HALF_EVEN).toFixed(1),
    bias: mean(points.map((p) => p.forecast.minus(p.actual))).toDecimalPlaces(scale, D.ROUND_HALF_EVEN).toFixed(scale),
    within10: new D(close).dividedBy(points.length).times(100).toDecimalPlaces(1, D.ROUND_HALF_EVEN).toFixed(1),
  };
}

export interface ModelResult {
  model: LabModel;
  stats: AccuracyStats;
  /** Stats for each horizon (1, 2, 3 months ahead). */
  byHorizon: { horizon: number; stats: AccuracyStats }[];
  /** Each forecast made in the window, oldest first. */
  points: { month: string; horizon: number; forecast: string; actual: string }[];
  /** 1 = most accurate; null when the model could not be measured. */
  rank: number | null;
  /** Why it could not be measured. */
  note: string | null;
}

export interface Backtest {
  series: LabSeries;
  /** The months forecasts were checked against, oldest first. */
  months: string[];
  actuals: { month: string; value: string }[];
  models: ModelResult[];
  best: LabModel | null;
  /** A sentence about the result. */
  summary: string;
}

/**
 * Rolling-origin backtest over the last `window` months of `history` (oldest first): for every
 * month in the window and every horizon, the model sees only the months before the forecast was
 * made. Models are ranked on WAPE, then MAE.
 */
export function backtest(series: LabSeries, history: readonly { month: string; value: Dec }[], window: number, horizons: readonly number[] = LAB_HORIZONS, scale = 2): Backtest {
  const n = history.length;
  const first = Math.max(0, n - window);
  const months = history.slice(first).map((h) => h.month);
  const values = history.map((h) => h.value);
  const label = LAB_SERIES.find((s) => s.key === series)!.label.toLowerCase();
  const models: ModelResult[] = LAB_MODELS.map((def) => {
    const points: ErrorPoint[] = [];
    for (let t = first; t < n; t++) {
      for (const h of horizons) {
        const origin = t - h + 1; // months available when the forecast was made: [0, origin)
        if (origin < 1) continue;
        const f = forecastValue(def.key, values.slice(0, origin), h);
        if (f) points.push({ month: history[t]!.month, horizon: h, forecast: f, actual: values[t]! });
      }
    }
    const round = (x: Dec) => x.toDecimalPlaces(scale, D.ROUND_HALF_EVEN).toFixed(scale);
    return {
      model: def.key,
      stats: accuracy(points, scale),
      byHorizon: horizons.map((h) => ({ horizon: h, stats: accuracy(points.filter((p) => p.horizon === h), scale) })),
      points: points.map((p) => ({ month: p.month, horizon: p.horizon, forecast: round(p.forecast), actual: round(p.actual) })),
      rank: null,
      note: points.length ? null : `Needs at least ${def.minHistory} month${def.minHistory === 1 ? '' : 's'} of history before the first month checked`,
    };
  });
  // A method checked on far fewer forecasts than the others (because it needs more history) is
  // not ranked: an error from one or two forecasts is not comparable with one from fifteen.
  const most = Math.max(0, ...models.map((m) => m.stats.count));
  for (const m of models) {
    if (m.stats.count > 0 && m.stats.count * 2 < most) {
      const def = LAB_MODELS.find((d) => d.key === m.model)!;
      m.note = `Only ${m.stats.count} of ${most} forecasts could be checked (it needs ${def.minHistory} months of history), too few to rank fairly`;
    }
  }
  const measured = models.filter((m) => m.stats.count > 0 && m.note === null);
  const key = (m: ModelResult) => [m.stats.wape === null ? Infinity : Number(m.stats.wape), Number(m.stats.mae)] as const;
  measured.sort((a, b) => key(a)[0] - key(b)[0] || key(a)[1] - key(b)[1]);
  measured.forEach((m, i) => (m.rank = i + 1));
  const best = measured[0] ?? null;
  const bestDef = best ? LAB_MODELS.find((d) => d.key === best.model)! : null;
  const summary = !best
    ? `Not enough history to test any model on ${label}.`
    : best.stats.wape === null
      ? `${bestDef!.label} had the smallest average error on ${label} over ${months.length} months; the actual figures were zero, so no percentage error can be given.`
      : `Over the last ${months.length} months, ${bestDef!.label.toLowerCase()} forecast ${label} best, with an error of ${best.stats.wape}% of the actual figures${measured[1]?.stats.wape ? ` (next best: ${LAB_MODELS.find((d) => d.key === measured[1]!.model)!.label.toLowerCase()}, ${measured[1]!.stats.wape}%)` : ''}.`;
  return {
    series,
    months,
    actuals: history.slice(first).map((h) => ({ month: h.month, value: h.value.toDecimalPlaces(scale, D.ROUND_HALF_EVEN).toFixed(scale) })),
    models,
    best: best?.model ?? null,
    summary,
  };
}

/** Forecasts of every model for the next `horizons` months after `history`. */
export function forecastAhead(history: readonly Dec[], lastMonth: string, horizons: readonly number[] = LAB_HORIZONS, scale = 2) {
  const out: { model: LabModel; month: string; horizon: number; value: string }[] = [];
  for (const def of LAB_MODELS) {
    for (const h of horizons) {
      const f = forecastValue(def.key, history, h);
      if (f) out.push({ model: def.key, month: addMonths(lastMonth, h), horizon: h, value: f.toDecimalPlaces(scale, D.ROUND_HALF_EVEN).toFixed(scale) });
    }
  }
  return out;
}

export function addMonths(month: string, by: number): string {
  const t = +month.slice(0, 4) * 12 + (+month.slice(5, 7) - 1) + by;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

