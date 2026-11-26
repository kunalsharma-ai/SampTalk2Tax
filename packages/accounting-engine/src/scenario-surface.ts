import { D, type Dec } from './money';
import { runTwin, TwinError, type TwinBaseline, type TwinDriver, type TwinProjection } from './twin';

/**
 * Scenario surface (DASH-027): the digital twin run over a grid of two changes, say price
 * against payroll, measuring one outcome (net profit, EBITDA, closing cash or the lowest cash)
 * at every point, month by month. The result is a surface: two changes across, the outcome up,
 * and, for each projected month, how the surface looks by then (DASH-039 reads a "4D" request as
 * this: a 3D surface that changes over time, nothing more). Every point is a full re-run of the
 * twin, so it is as reliable as the twin itself; all of it is hypothetical.
 */
export const SURFACE_AXES = ['PRICE', 'VOLUME_GROWTH', 'CHURN', 'COST_OF_SALES', 'PAYROLL', 'OPERATING_COSTS', 'COLLECTION_DAYS', 'PAYMENT_DAYS'] as const;
export type SurfaceAxisKey = (typeof SURFACE_AXES)[number];
export const SURFACE_MEASURES = ['NET_PROFIT', 'EBITDA', 'CLOSING_CASH', 'MINIMUM_CASH'] as const;
export type SurfaceMeasure = (typeof SURFACE_MEASURES)[number];

export const SURFACE_AXIS: Record<SurfaceAxisKey, { label: string; unit: '%' | '% a month' | 'days'; min: number; max: number; driver: (v: string) => TwinDriver }> = {
  PRICE: { label: 'Price change', unit: '%', min: -50, max: 50, driver: (v) => ({ kind: 'PRICE_CHANGE', pricePercent: v, volumePercent: '0' }) },
  VOLUME_GROWTH: { label: 'Sales growth', unit: '% a month', min: -20, max: 20, driver: (v) => ({ kind: 'REVENUE_GROWTH', percentPerMonth: v }) },
  CHURN: { label: 'Customers lost', unit: '% a month', min: 0, max: 20, driver: (v) => ({ kind: 'CHURN', percentPerMonth: v }) },
  COST_OF_SALES: { label: 'Cost of sales change', unit: '%', min: -50, max: 50, driver: (v) => ({ kind: 'EXPENSE_CHANGE', target: 'COST_OF_SALES', percent: v }) },
  PAYROLL: { label: 'Payroll change', unit: '%', min: -50, max: 50, driver: (v) => ({ kind: 'EXPENSE_CHANGE', target: 'PAYROLL', percent: v }) },
  OPERATING_COSTS: { label: 'Operating costs change', unit: '%', min: -50, max: 50, driver: (v) => ({ kind: 'EXPENSE_CHANGE', target: 'OPERATING', percent: v }) },
  COLLECTION_DAYS: { label: 'Days to collect, change', unit: 'days', min: -60, max: 60, driver: (v) => ({ kind: 'WORKING_CAPITAL', collectionDaysChange: Number(v), paymentDaysChange: 0 }) },
  PAYMENT_DAYS: { label: 'Days to pay, change', unit: 'days', min: -60, max: 60, driver: (v) => ({ kind: 'WORKING_CAPITAL', collectionDaysChange: 0, paymentDaysChange: Number(v) }) },
};

export interface SurfaceAxis {
  axis: SurfaceAxisKey;
  min: number;
  max: number;
  /** Points along the axis, 3 to 11, both ends included. */
  steps: number;
}
export interface SurfaceInput {
  baseline: TwinBaseline;
  horizonMonths: number;
  x: SurfaceAxis;
  y: SurfaceAxis;
  measure: SurfaceMeasure;
  /** Changes applied at every point, under the two being varied. */
  drivers?: readonly TwinDriver[];
}
export interface SurfaceCell {
  x: string;
  y: string;
  value: string;
}
export interface SurfaceFrame {
  month: string;
  /** values[yIndex][xIndex] */
  values: string[][];
  min: string;
  max: string;
}
export interface ScenarioSurface {
  x: { axis: SurfaceAxisKey; label: string; unit: string; values: string[] };
  y: { axis: SurfaceAxisKey; label: string; unit: string; values: string[] };
  measure: SurfaceMeasure;
  currency: string;
  /** One frame per projected month: the measure up to and including that month. */
  frames: SurfaceFrame[];
  /** The measure with neither change (0 on both axes), at the horizon; null when 0 is off the grid. */
  current: string | null;
  best: SurfaceCell;
  worst: SurfaceCell;
  /** Points where cash goes below zero at some month before the horizon. */
  cashNegativeCells: number;
  runs: number;
}

export const MAX_SURFACE_HORIZON = 24;

/** Even steps from min to max, as decimal strings without trailing zeros. */
export function axisValues(a: SurfaceAxis): string[] {
  const lo = new D(a.min);
  const step = new D(a.max).minus(lo).div(a.steps - 1);
  return Array.from({ length: a.steps }, (_, i) => lo.plus(step.times(i)).toDecimalPlaces(2).toString());
}

export function surfaceIssues(input: Pick<SurfaceInput, 'x' | 'y' | 'horizonMonths'>): string[] {
  const issues: string[] = [];
  if (input.x.axis === input.y.axis) issues.push('Choose two different changes');
  if (!Number.isInteger(input.horizonMonths) || input.horizonMonths < 1 || input.horizonMonths > MAX_SURFACE_HORIZON) issues.push(`Choose a horizon from 1 to ${MAX_SURFACE_HORIZON} months`);
  for (const [name, a] of [
    ['Across', input.x],
    ['Up', input.y],
  ] as const) {
    const def = SURFACE_AXIS[a.axis];
    if (!def) {
      issues.push(`${name}: unknown change`);
      continue;
    }
    if (!Number.isInteger(a.steps) || a.steps < 3 || a.steps > 11) issues.push(`${name}: use 3 to 11 points`);
    if (!(a.min < a.max)) issues.push(`${name}: the lowest value must be below the highest`);
    if (a.min < def.min || a.max > def.max) issues.push(`${name}: ${def.label} must stay between ${def.min} and ${def.max} ${def.unit}`);
    if (def.unit === 'days' && (!Number.isInteger(a.min) || !Number.isInteger(a.max) || !Number.isInteger((a.max - a.min) / (a.steps - 1)))) issues.push(`${name}: days must come in whole steps`);
  }
  return issues;
}

/** The measure after each projected month: running totals for profit, balances for cash. */
function series(p: TwinProjection, measure: SurfaceMeasure): Dec[] {
  const out: Dec[] = [];
  let run = new D(0);
  let low: Dec | null = null;
  for (const m of p.months) {
    if (measure === 'NET_PROFIT') out.push((run = run.plus(m.netProfit)));
    else if (measure === 'EBITDA') out.push((run = run.plus(m.ebitda)));
    else if (measure === 'CLOSING_CASH') out.push(new D(m.closingCash));
    else {
      const c = new D(m.closingCash);
      low = low === null || c.lt(low) ? c : low;
      out.push(low);
    }
  }
  return out;
}

export function scenarioSurface(input: SurfaceInput): ScenarioSurface {
  const issues = surfaceIssues(input);
  if (issues.length) throw new TwinError('The surface needs fixing', issues);
  const xs = axisValues(input.x);
  const ys = axisValues(input.y);
  const scale = input.baseline.scale;
  const frames: Dec[][][] = Array.from({ length: input.horizonMonths }, () => ys.map(() => xs.map(() => new D(0))));
  let months: string[] = [];
  let negative = 0;
  ys.forEach((yv, yi) => {
    xs.forEach((xv, xi) => {
      const drivers = [...(input.drivers ?? []), SURFACE_AXIS[input.x.axis].driver(xv), SURFACE_AXIS[input.y.axis].driver(yv)];
      const r = runTwin({ baseline: input.baseline, drivers, horizonMonths: input.horizonMonths });
      months = r.projection.months.map((m) => m.month);
      if (r.projection.cashNegativeFrom) negative += 1;
      series(r.projection, input.measure).forEach((v, m) => (frames[m][yi][xi] = v));
    });
  });
  const fx = (d: Dec) => d.toFixed(scale);
  const last = frames[frames.length - 1];
  let best: SurfaceCell | null = null;
  let worst: SurfaceCell | null = null;
  ys.forEach((yv, yi) =>
    xs.forEach((xv, xi) => {
      const v = last[yi][xi];
      if (!best || v.gt(best.value)) best = { x: xv, y: yv, value: fx(v) };
      if (!worst || v.lt(worst.value)) worst = { x: xv, y: yv, value: fx(v) };
    }),
  );
  const xi0 = xs.findIndex((v) => new D(v).isZero());
  const yi0 = ys.findIndex((v) => new D(v).isZero());
  const def = (a: SurfaceAxis) => ({ axis: a.axis, label: SURFACE_AXIS[a.axis].label, unit: SURFACE_AXIS[a.axis].unit });
  return {
    x: { ...def(input.x), values: xs },
    y: { ...def(input.y), values: ys },
    measure: input.measure,
    currency: input.baseline.currency,
    frames: frames.map((f, m) => {
      const flat = f.flat();
      return { month: months[m], values: f.map((row) => row.map(fx)), min: fx(D.min(...flat)), max: fx(D.max(...flat)) };
    }),
    current: xi0 >= 0 && yi0 >= 0 ? fx(last[yi0][xi0]) : null,
    best: best!,
    worst: worst!,
    cashNegativeCells: negative,
    runs: xs.length * ys.length,
  };
}
