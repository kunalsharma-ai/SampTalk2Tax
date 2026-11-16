/**
 * Financial decision memory: management decisions with the assumptions behind them and the
 * outcomes they were expected to produce, measured later against the books.
 *
 * An expected outcome is a KPI (see kpis.ts), a comparator and a target, measured in a given
 * month. Before that month is over it is not due; afterwards its value comes from the posted
 * books for that month and is compared with the target. Nothing here reads a database.
 */
import { monthLabel } from './cfo';
import { KPI_DEFINITIONS, type KpiKey, targetStatus, type TargetComparator } from './kpis';
import { dec } from './money';

export const DECISION_CATEGORIES = [
  { key: 'PRICING', label: 'Pricing' },
  { key: 'HIRING', label: 'Hiring and people' },
  { key: 'COSTS', label: 'Cost control' },
  { key: 'INVESTMENT', label: 'Investment and capital spending' },
  { key: 'FUNDING', label: 'Funding and borrowing' },
  { key: 'CREDIT', label: 'Credit and collections' },
  { key: 'SUPPLIERS', label: 'Suppliers and purchasing' },
  { key: 'GROWTH', label: 'Growth and new markets' },
  { key: 'OTHER', label: 'Other' },
] as const;
export type DecisionCategory = (typeof DECISION_CATEGORIES)[number]['key'];

export const DECISION_VERDICTS = [
  { key: 'WORKED', label: 'Worked' },
  { key: 'PARTLY', label: 'Partly worked' },
  { key: 'DID_NOT_WORK', label: 'Did not work' },
] as const;
export type DecisionVerdict = (typeof DECISION_VERDICTS)[number]['key'];

export interface ExpectedOutcome {
  kpi: KpiKey;
  comparator: TargetComparator;
  /** Decimal string in the KPI's unit (money, percent, ratio, days or months). */
  target: string;
  /** YYYY-MM: the month whose figures show whether it happened. */
  measureMonth: string;
}

export type OutcomeStatus = 'NOT_DUE' | 'MET' | 'MISSED' | 'NO_VALUE';

export interface OutcomeResult {
  status: OutcomeStatus;
  /** Actual minus baseline, in the KPI's unit, when both are known. */
  change: string | null;
  /** Whether the change is the better direction for this KPI (null when unknown or zero). */
  improved: boolean | null;
  /** A sentence that says what happened. */
  explanation: string;
}


/** The month before the one containing `date` (YYYY-MM-DD): the last full month before a decision. */
export function baselineMonthFor(date: string): string {
  const y = +date.slice(0, 4);
  const m = +date.slice(5, 7) - 1;
  const t = y * 12 + m - 1;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

/** Whether a month is over on `today` (YYYY-MM-DD), so its figures can be measured. */
export const monthIsOver = (month: string, today: string) => month < today.slice(0, 7);

function formatValue(kpi: KpiKey, v: string): string {
  const unit = KPI_DEFINITIONS.find((d) => d.key === kpi)!.unit;
  const x = dec(v);
  if (unit === 'PERCENT') return `${x.toFixed(1)}%`;
  if (unit === 'DAYS') return `${x.toFixed(1)} days`;
  if (unit === 'MONTHS') return `${x.toFixed(1)} months`;
  if (unit === 'RATIO') return x.toFixed(2);
  return x.toFixed(2);
}

/** Checks an expected outcome: its KPI, comparator, target and month. Returns an error message or null. */
export function checkOutcome(o: { kpi: string; comparator: string; target: string; measureMonth: string }, decidedOn: string): string | null {
  if (!KPI_DEFINITIONS.some((d) => d.key === o.kpi)) return `Unknown measure ${o.kpi}`;
  if (o.comparator !== 'AT_LEAST' && o.comparator !== 'AT_MOST') return 'Choose at least or at most';
  if (!/^-?\d{1,13}(\.\d{1,6})?$/.test(o.target)) return 'Enter the target as a number';
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(o.measureMonth)) return 'Enter the month to measure as YYYY-MM';
  if (o.measureMonth < decidedOn.slice(0, 7)) return 'The month to measure cannot be before the decision';
  return null;
}

/**
 * Evaluates one expected outcome. `actual` is the KPI's value for the measure month (null when
 * the books cannot give one, such as a margin in a month without revenue); `baseline` is its
 * value in the month before the decision.
 */
export function evaluateOutcome(o: ExpectedOutcome, actual: string | null, baseline: string | null, today: string, money: (v: string) => string = (v) => v): OutcomeResult {
  const def = KPI_DEFINITIONS.find((d) => d.key === o.kpi)!;
  const fmt = (v: string) => (def.unit === 'MONEY' ? money(v) : formatValue(o.kpi, v));
  const goal = `${def.label} ${o.comparator === 'AT_LEAST' ? 'of at least' : 'of at most'} ${fmt(o.target)} in ${monthLabel(o.measureMonth)}`;
  if (!monthIsOver(o.measureMonth, today)) return { status: 'NOT_DUE', change: null, improved: null, explanation: `Expected: ${goal}. Measured once ${monthLabel(o.measureMonth)} is over.` };
  const status = targetStatus(actual, o.comparator, o.target);
  if (status === 'NO_VALUE') return { status: 'NO_VALUE', change: null, improved: null, explanation: `Expected: ${goal}. The books give no value for ${monthLabel(o.measureMonth)}.` };
  const change = baseline === null ? null : dec(actual!).minus(dec(baseline));
  const improved = change === null || change.isZero() ? null : def.better === 'HIGHER' ? change.greaterThan(0) : change.lessThan(0);
  const from = baseline === null ? '' : `, against ${fmt(baseline)} before the decision`;
  return {
    status,
    change: change === null ? null : change.toFixed(def.unit === 'MONEY' ? 2 : def.unit === 'RATIO' ? 2 : 1),
    improved,
    explanation: `${status === 'MET' ? 'Met' : 'Missed'}: ${def.label.toLowerCase()} was ${fmt(actual!)} in ${monthLabel(o.measureMonth)}${from}. Expected ${o.comparator === 'AT_LEAST' ? 'at least' : 'at most'} ${fmt(o.target)}.`,
  };
}

/**
 * The verdict the measured outcomes point to: worked when every measured outcome was met,
 * did not work when none was, partly otherwise. Null while nothing can be measured yet.
 * People decide the verdict; this is only a suggestion.
 */
export function suggestVerdict(results: readonly Pick<OutcomeResult, 'status'>[]): DecisionVerdict | null {
  const measured = results.filter((r) => r.status === 'MET' || r.status === 'MISSED');
  if (!measured.length) return null;
  const met = measured.filter((r) => r.status === 'MET').length;
  return met === measured.length ? 'WORKED' : met === 0 ? 'DID_NOT_WORK' : 'PARTLY';
}

/** Search terms: lower-cased words of two or more characters, at most eight. */
export function searchTerms(q: string): string[] {
  return [...new Set(q.toLowerCase().split(/[^\p{L}\p{N}%.-]+/u).filter((w) => w.length >= 2))].slice(0, 8);
}
