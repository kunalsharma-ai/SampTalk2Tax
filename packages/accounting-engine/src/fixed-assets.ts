import Decimal from 'decimal.js';
import { D, dec, type Dec } from './money';

/**
 * Fixed assets: depreciation schedules and disposals.
 *
 * Conventions (documented in docs/FIXED_ASSETS.md):
 * - Depreciation is charged by calendar month, a full month from the month the asset is put to
 *   use, through the month it is disposed of (a full month there too).
 * - Straight line: (cost − residual value) ÷ useful life in months each month, rounded to the
 *   currency; the last month of the life takes what is left, so the asset ends exactly at its
 *   residual value.
 * - Written-down value: an annual rate on the net book value at the start of the fiscal year (or
 *   when depreciation starts, if later), charged in twelve equal monthly parts; never below the
 *   residual value.
 * - An asset brought in already part-depreciated carries its accumulated depreciation and the
 *   month it was depreciated through; the schedule continues from the month after.
 * - A month already posted keeps the amount that was posted.
 */
export type DepreciationMethod = 'STRAIGHT_LINE' | 'WRITTEN_DOWN_VALUE';

export interface AssetTerms {
  cost: string;
  residualValue: string;
  /** YYYY-MM-DD: when it was put to use. */
  inServiceDate: string;
  method: DepreciationMethod;
  /** Straight line only. */
  usefulLifeMonths?: number | null;
  /** Written-down value only: percent a year, e.g. "15" or "25.89". */
  annualRate?: string | null;
  /** Accumulated depreciation brought in from before this system. */
  openingAccumulated: string;
  /** YYYY-MM: the last month the opening accumulated depreciation covers. Null when there is none. */
  depreciatedThrough: string | null;
  /** YYYY-MM-DD, when it was disposed of. */
  disposedOn?: string | null;
}

export interface ScheduleRow {
  month: string;
  charge: string;
  accumulated: string;
  netBookValue: string;
  posted: boolean;
}

/** "2026-03" plus n months. */
export function addMonth(month: string, n: number): string {
  const m = +month.slice(5, 7) - 1 + n;
  const y = +month.slice(0, 4) + Math.floor(m / 12);
  return `${y}-${String((((m % 12) + 12) % 12) + 1).padStart(2, '0')}`;
}

/** Months from a to b ("2026-01" to "2026-03" is 2). */
export function monthsBetween(a: string, b: string): number {
  return (+b.slice(0, 4) - +a.slice(0, 4)) * 12 + (+b.slice(5, 7) - +a.slice(5, 7));
}

/** The last day of a month, YYYY-MM-DD. */
export function monthEnd(month: string): string {
  return new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).toISOString().slice(0, 10);
}

/** The first month that gets a charge. */
export function firstChargeMonth(t: AssetTerms): string {
  const inService = t.inServiceDate.slice(0, 7);
  if (!t.depreciatedThrough) return inService;
  const after = addMonth(t.depreciatedThrough, 1);
  return after > inService ? after : inService;
}

/** Problems with an asset's terms, as sentences; empty when they are usable. */
export function checkAssetTerms(t: AssetTerms & { acquisitionDate: string }, scale = 2): string[] {
  const errors: string[] = [];
  const money = (label: string, v: string) => {
    try {
      const d = dec(v);
      if (d.decimalPlaces() > scale) errors.push(`${label} has more than ${scale} decimal places`);
      return d;
    } catch {
      errors.push(`${label} is not an amount`);
      return null;
    }
  };
  const cost = money('Cost', t.cost);
  const residual = money('Residual value', t.residualValue);
  const opening = money('Opening accumulated depreciation', t.openingAccumulated);
  if (cost && cost.lte(0)) errors.push('Cost must be more than zero');
  if (residual && residual.lt(0)) errors.push('Residual value cannot be negative');
  if (cost && residual && residual.gte(cost)) errors.push('Residual value must be less than cost');
  if (t.inServiceDate < t.acquisitionDate) errors.push('An asset cannot be put to use before it was acquired');
  if (t.method === 'STRAIGHT_LINE') {
    if (!Number.isInteger(t.usefulLifeMonths) || t.usefulLifeMonths! < 1 || t.usefulLifeMonths! > 1200) errors.push('Useful life must be 1 to 1,200 months');
  } else if (t.method === 'WRITTEN_DOWN_VALUE') {
    const r = t.annualRate ? (() => { try { return dec(t.annualRate!); } catch { return null; } })() : null;
    if (!r || r.lte(0) || r.gt(100) || r.decimalPlaces() > 4) errors.push('Annual rate must be more than 0% and at most 100%');
  } else errors.push('Unknown depreciation method');
  if (opening) {
    if (opening.lt(0)) errors.push('Opening accumulated depreciation cannot be negative');
    if (cost && residual && opening.gt(cost.minus(residual))) errors.push('Opening accumulated depreciation cannot be more than cost less residual value');
    if (opening.gt(0) && !t.depreciatedThrough) errors.push('Say which month the opening accumulated depreciation runs to');
    if (t.depreciatedThrough && t.depreciatedThrough < t.inServiceDate.slice(0, 7)) errors.push('The opening depreciation cannot run to a month before the asset was put to use');
  }
  return errors;
}

/**
 * The schedule from the first charge month through `through` (inclusive). `posted` holds the
 * amounts already posted by month; those are used as they are.
 */
export function depreciationSchedule(t: AssetTerms, through: string, posted: Record<string, string> = {}, fiscalYearStartMonth = 4, currencyScale = 2): ScheduleRow[] {
  const cost = dec(t.cost);
  const residual = dec(t.residualValue);
  const depreciable = cost.minus(residual);
  const round = (x: Dec) => x.toDecimalPlaces(currencyScale, Decimal.ROUND_HALF_EVEN);
  const inService = t.inServiceDate.slice(0, 7);
  const stopAt = t.disposedOn ? t.disposedOn.slice(0, 7) : null;
  let accumulated = dec(t.openingAccumulated);
  let yearBase: Dec | null = null;
  const rows: ScheduleRow[] = [];
  for (let m = firstChargeMonth(t); m <= through; m = addMonth(m, 1)) {
    if (stopAt && m > stopAt) break;
    const left = depreciable.minus(accumulated);
    let charge: Dec;
    const isPosted = posted[m] !== undefined;
    if (isPosted) charge = dec(posted[m]!);
    else if (left.lte(0)) charge = new D(0);
    else if (t.method === 'STRAIGHT_LINE') {
      const life = t.usefulLifeMonths!;
      const idx = monthsBetween(inService, m);
      if (idx >= life - 1) charge = left;
      else charge = Decimal.min(round(depreciable.div(life)), left);
    } else {
      const fyStart = +m.slice(5, 7) === fiscalYearStartMonth;
      if (yearBase === null || fyStart) yearBase = cost.minus(accumulated);
      charge = Decimal.min(round(yearBase.times(dec(t.annualRate!)).div(100).div(12)), left);
    }
    accumulated = accumulated.plus(charge);
    rows.push({ month: m, charge: charge.toFixed(currencyScale), accumulated: accumulated.toFixed(currencyScale), netBookValue: cost.minus(accumulated).toFixed(currencyScale), posted: isPosted });
    if (accumulated.gte(depreciable) && !Object.keys(posted).some((k) => k > m)) break;
  }
  return rows;
}

/** The charge for one month (zero when none is due). */
export function chargeFor(t: AssetTerms, month: string, posted: Record<string, string> = {}, fiscalYearStartMonth = 4, currencyScale = 2): string {
  const row = depreciationSchedule(t, month, posted, fiscalYearStartMonth, currencyScale).find((r) => r.month === month);
  return row ? row.charge : (0).toFixed(currencyScale);
}

/** When the asset is fully depreciated (YYYY-MM), from the schedule, or null if not within 100 years. */
export function fullyDepreciatedIn(t: AssetTerms, posted: Record<string, string> = {}, fiscalYearStartMonth = 4): string | null {
  const depreciable = dec(t.cost).minus(dec(t.residualValue));
  const through = addMonth(firstChargeMonth(t), 1200);
  for (const r of depreciationSchedule(t, through, posted, fiscalYearStartMonth)) if (dec(r.accumulated).gte(depreciable)) return r.month;
  return null;
}

export interface DisposalLines {
  netBookValue: string;
  gain: string;
  lines: { role: 'PROCEEDS' | 'ACCUMULATED' | 'COST' | 'GAIN_LOSS'; debit?: string; credit?: string }[];
}

/** The entry that takes an asset off the books: proceeds in, accumulated depreciation and cost out, the difference to gain or loss. */
export function disposalEntry(cost: string, accumulated: string, proceeds: string, scale = 2): DisposalLines {
  const c = dec(cost);
  const a = dec(accumulated);
  const p = dec(proceeds);
  const nbv = c.minus(a);
  const gain = p.minus(nbv);
  const f = (x: Dec) => x.toFixed(scale);
  const lines: DisposalLines['lines'] = [];
  if (p.gt(0)) lines.push({ role: 'PROCEEDS', debit: f(p) });
  if (a.gt(0)) lines.push({ role: 'ACCUMULATED', debit: f(a) });
  lines.push({ role: 'COST', credit: f(c) });
  if (gain.gt(0)) lines.push({ role: 'GAIN_LOSS', credit: f(gain) });
  else if (gain.lt(0)) lines.push({ role: 'GAIN_LOSS', debit: f(gain.neg()) });
  return { netBookValue: f(nbv), gain: f(gain), lines };
}
