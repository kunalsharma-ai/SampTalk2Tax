/**
 * Saved report views (RPT-028, RPT-029, RPT-037): a report with its filters kept under a name,
 * for the person who saved it or shared with everyone in the organisation who can read reports.
 * Dates are kept either as fixed dates or as a period relative to the day the view is opened
 * ("last month", "this fiscal year to date"), so a view saved once stays useful.
 */
import { addDays } from './documents';
import { addMonth, monthEnd } from './fixed-assets';
import { fiscalYearStartFor } from './report-schedules';

/** Reports a view can be saved for, with the filters each one takes. */
export const VIEW_REPORTS = {
  'trial-balance': { title: 'Trial balance', dates: 'AS_OF', filters: [] },
  'income-statement': { title: 'Profit and loss', dates: 'RANGE', filters: ['basis', 'departmentId', 'projectId'] },
  'balance-sheet': { title: 'Balance sheet', dates: 'AS_OF', filters: [] },
  'cash-flow-statement': { title: 'Cash flow statement', dates: 'RANGE', filters: [] },
  'vendor-spend': { title: 'Vendor spend', dates: 'RANGE', filters: [] },
} as const;
export type ViewReport = keyof typeof VIEW_REPORTS;
export const VIEW_REPORT_KEYS = Object.keys(VIEW_REPORTS) as ViewReport[];

/** Periods for reports over a range of dates. */
export const RANGE_PRESETS = [
  { id: 'THIS_MONTH', name: 'This month to date' },
  { id: 'LAST_MONTH', name: 'Last month' },
  { id: 'THIS_QUARTER', name: 'This fiscal quarter to date' },
  { id: 'LAST_QUARTER', name: 'Last fiscal quarter' },
  { id: 'FY_TO_DATE', name: 'This fiscal year to date' },
  { id: 'LAST_FY', name: 'Last fiscal year' },
  { id: 'FIXED', name: 'The exact dates chosen' },
] as const;
/** Dates for reports at one date. */
export const AS_OF_PRESETS = [
  { id: 'TODAY', name: 'Today' },
  { id: 'END_OF_LAST_MONTH', name: 'End of last month' },
  { id: 'END_OF_LAST_QUARTER', name: 'End of last fiscal quarter' },
  { id: 'END_OF_LAST_FY', name: 'End of last fiscal year' },
  { id: 'FIXED', name: 'The exact date chosen' },
] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number]['id'];
export type AsOfPreset = (typeof AS_OF_PRESETS)[number]['id'];

export interface ViewFilters {
  dates: { preset: RangePreset | AsOfPreset; from?: string | null; to?: string | null };
  basis?: 'ACCRUAL' | 'CASH' | null;
  departmentId?: string | null;
  projectId?: string | null;
}

/** The concrete parameters a view opens with on a given day. */
export interface ResolvedView {
  from: string | null;
  /** The end date, or the as-of date for a report at one date. */
  to: string;
  basis: 'ACCRUAL' | 'CASH' | null;
  departmentId: string | null;
  projectId: string | null;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const validIso = (s: unknown): s is string => typeof s === 'string' && ISO.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** The fiscal quarter (start month) that `date` falls in. */
function fiscalQuarterStart(date: string, fyStartMonth: number): string {
  const fyStart = fiscalYearStartFor(date, fyStartMonth).slice(0, 7);
  let q = fyStart;
  while (addMonth(q, 3) <= date.slice(0, 7)) q = addMonth(q, 3);
  return `${q}-01`;
}

/** Problems with the filters for a report, in words for the person saving the view. */
export function viewFilterIssues(report: ViewReport, f: ViewFilters): string[] {
  const def = VIEW_REPORTS[report];
  const out: string[] = [];
  const presets: readonly string[] = (def.dates === 'RANGE' ? RANGE_PRESETS : AS_OF_PRESETS).map((p) => p.id);
  if (!presets.includes(f.dates?.preset)) out.push(`Choose one of the periods offered for the ${def.title.toLowerCase()}`);
  else if (f.dates.preset === 'FIXED') {
    if (!validIso(f.dates.to)) out.push(def.dates === 'RANGE' ? 'Give the end date' : 'Give the date');
    if (def.dates === 'RANGE') {
      if (!validIso(f.dates.from)) out.push('Give the start date');
      else if (validIso(f.dates.to) && f.dates.from! > f.dates.to!) out.push('The start date must be on or before the end date');
    }
  }
  const allowed: readonly string[] = def.filters;
  for (const k of ['basis', 'departmentId', 'projectId'] as const) {
    if (f[k] != null && !allowed.includes(k)) out.push(`The ${def.title.toLowerCase()} does not take a ${k} filter`);
  }
  if (f.basis != null && f.basis !== 'ACCRUAL' && f.basis !== 'CASH') out.push('Basis is accrual or cash');
  return out;
}

/** The dates and filters a view opens with on `today`. */
export function resolveView(report: ViewReport, f: ViewFilters, today: string, fyStartMonth: number): ResolvedView {
  const rest = { basis: f.basis ?? null, departmentId: f.departmentId ?? null, projectId: f.projectId ?? null };
  const month = today.slice(0, 7);
  const fy = fiscalYearStartFor(today, fyStartMonth);
  const quarter = fiscalQuarterStart(today, fyStartMonth);
  const lastQuarterStart = `${addMonth(quarter.slice(0, 7), -3)}-01`;
  const lastFyStart = `${addMonth(fy.slice(0, 7), -12)}-01`;
  if (VIEW_REPORTS[report].dates === 'AS_OF') {
    const p = f.dates.preset as AsOfPreset;
    const to = p === 'TODAY' ? today : p === 'END_OF_LAST_MONTH' ? monthEnd(addMonth(month, -1)) : p === 'END_OF_LAST_QUARTER' ? addDays(quarter, -1) : p === 'END_OF_LAST_FY' ? addDays(fy, -1) : f.dates.to!;
    return { from: null, to, ...rest };
  }
  switch (f.dates.preset as RangePreset) {
    case 'THIS_MONTH':
      return { from: `${month}-01`, to: today, ...rest };
    case 'LAST_MONTH':
      return { from: `${addMonth(month, -1)}-01`, to: monthEnd(addMonth(month, -1)), ...rest };
    case 'THIS_QUARTER':
      return { from: quarter, to: today, ...rest };
    case 'LAST_QUARTER':
      return { from: lastQuarterStart, to: addDays(quarter, -1), ...rest };
    case 'FY_TO_DATE':
      return { from: fy, to: today, ...rest };
    case 'LAST_FY':
      return { from: lastFyStart, to: addDays(fy, -1), ...rest };
    default:
      return { from: f.dates.from!, to: f.dates.to!, ...rest };
  }
}

/** Only the filters the report takes, with fixed dates kept only for the FIXED preset. */
export function normaliseViewFilters(report: ViewReport, f: ViewFilters): ViewFilters {
  const def = VIEW_REPORTS[report];
  const fixed = f.dates.preset === 'FIXED';
  const out: ViewFilters = { dates: { preset: f.dates.preset, from: fixed && def.dates === 'RANGE' ? (f.dates.from ?? null) : null, to: fixed ? (f.dates.to ?? null) : null } };
  for (const k of def.filters) {
    const v = f[k as keyof ViewFilters];
    if (v != null && v !== '') (out as unknown as Record<string, unknown>)[k] = v;
  }
  return out;
}
