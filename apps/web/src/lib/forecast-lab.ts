/** Types for the forecast evaluation lab. */
export type LabSeries = 'revenue' | 'costOfSales' | 'operatingExpenses' | 'netIncome' | 'netCashFlow';
export interface Stats { count: number; mae: string | null; wape: string | null; bias: string | null; within10: string | null }
export interface ModelResult {
  model: string;
  stats: Stats;
  byHorizon: { horizon: number; stats: Stats }[];
  points: { month: string; horizon: number; forecast: string; actual: string }[];
  rank: number | null;
  note: string | null;
}
export interface SeriesBacktest { series: LabSeries; months: string[]; actuals: { month: string; value: string }[]; models: ModelResult[]; best: string | null; summary: string }
export interface Forecast { series: LabSeries; model: string; month: string; horizon: number; value: string; actual?: string | null }
export interface Tracking { series: LabSeries; models: { model: string; stats: Stats }[]; best: string | null }
export interface LabMeta {
  series: { key: LabSeries; label: string; description: string }[];
  models: { key: string; label: string; minHistory: number; description: string }[];
  horizons: number[];
  windows: number[];
}
export interface LabOverview {
  currency: string;
  baseMonth: string;
  window: number;
  historyMonths: number;
  firstMonth: string | null;
  series: SeriesBacktest[];
  ahead: Forecast[];
  tracking: { runs: number; series: Tracking[] };
  meta: LabMeta;
}
export interface LabRunItem { id: string; number: string; baseMonth: string; window: number; note: string | null; createdBy: string | null; createdAt: string; best: Record<LabSeries, string | null>; forecastMonths: string[]; measuredMonths: string[] }
export interface LabRun {
  id: string;
  number: string;
  baseMonth: string;
  window: number;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  currency: string;
  results: Record<LabSeries, { best: string | null; summary: string; months: string[]; models: Omit<ModelResult, 'points'>[] }>;
  forecasts: Forecast[];
  tracking: Tracking[];
  meta: LabMeta;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthName = (m: string) => `${MONTHS[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;
export const pct = (v: string | null) => (v === null ? '—' : `${v}%`);
