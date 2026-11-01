/**
 * Alerts and leakage checks: the rules, their settings, and the pure detectors that turn
 * ledger facts into findings. Every finding carries the figures it was raised on, so a
 * person can check it. Wording stays neutral: a check says what looks unusual and what to
 * look at, never that someone did something wrong.
 *
 * No framework or database code; amounts are decimals, never JS numbers.
 */
import { D, Dec, dec } from './money';

export const ALERT_AREAS = ['CASH', 'COMPLIANCE', 'PERFORMANCE', 'LEAKAGE', 'CONTROLS'] as const;
export type AlertArea = (typeof ALERT_AREAS)[number];
export const ALERT_SEVERITIES = ['CRITICAL', 'WARNING', 'INFO'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];
export const ALERT_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'DISMISSED', 'CLEARED'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

export class AlertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlertError';
  }
}

export interface AlertParamDef {
  key: string;
  label: string;
  unit: 'days' | 'percent' | 'amount' | 'times' | 'months';
  min: string;
  max: string;
  default: string;
  /** Whole numbers only. */
  integer: boolean;
}

export interface AlertRuleDef {
  key: AlertRuleKey;
  area: AlertArea;
  name: string;
  /** What the check looks for, in one or two sentences. */
  description: string;
  params: AlertParamDef[];
}

export const ALERT_RULE_KEYS = [
  'CASH_BELOW_MINIMUM',
  'OVERDUE_RECEIVABLES',
  'COMPLIANCE_DUE',
  'KPI_TARGET_MISSED',
  'BUDGET_OVERRUN',
  'MISSED_RECURRING_BILLING',
  'DUPLICATE_BILL',
  'DUPLICATE_PAYMENT',
  'UNUSUAL_JOURNAL',
] as const;
export type AlertRuleKey = (typeof ALERT_RULE_KEYS)[number];

const p = (key: string, label: string, unit: AlertParamDef['unit'], min: string, max: string, def: string, integer = true): AlertParamDef => ({ key, label, unit, min, max, default: def, integer });

export const ALERT_RULES: readonly AlertRuleDef[] = Object.freeze([
  {
    key: 'CASH_BELOW_MINIMUM',
    area: 'CASH',
    name: 'Cash below the minimum balance',
    description: 'The cash-flow forecast falls below the minimum balance set on the forecast page. Critical when the expected case does, a warning when only the low case does.',
    params: [p('horizonDays', 'Look ahead', 'days', '7', '365', '90')],
  },
  {
    key: 'OVERDUE_RECEIVABLES',
    area: 'CASH',
    name: 'Overdue customer invoices',
    description: 'A customer has open invoices past their due date by more than the set number of days. Critical when any is more than 90 days overdue.',
    params: [p('daysOverdue', 'Overdue by more than', 'days', '1', '365', '30'), p('minAmount', 'Customer owes at least', 'amount', '0', '9999999999999', '0', false)],
  },
  {
    key: 'COMPLIANCE_DUE',
    area: 'COMPLIANCE',
    name: 'Filings and tax payments due',
    description: 'A return or tax payment on the compliance calendar is overdue (critical) or due within the set number of days (warning) and not yet done.',
    params: [p('daysAhead', 'Due within', 'days', '1', '30', '7')],
  },
  {
    key: 'KPI_TARGET_MISSED',
    area: 'PERFORMANCE',
    name: 'KPI target missed',
    description: 'A KPI missed its target in the last complete month.',
    params: [],
  },
  {
    key: 'BUDGET_OVERRUN',
    area: 'PERFORMANCE',
    name: 'Spending over budget',
    description: 'An expense account is over the approved budget for the fiscal year to date (complete months only), by at least the set share and amount. Spending on an account with no budget counts once it reaches the amount.',
    params: [p('percent', 'Over by at least', 'percent', '0', '1000', '10', false), p('minAmount', 'and at least', 'amount', '0', '9999999999999', '10000', false)],
  },
  {
    key: 'MISSED_RECURRING_BILLING',
    area: 'LEAKAGE',
    name: 'Regular customer not billed',
    description: 'A customer invoiced in each of the months before the last complete month has no invoice in that month. It may be revenue that was not billed.',
    params: [p('months', 'Billed in each of the previous', 'months', '2', '12', '3')],
  },
  {
    key: 'DUPLICATE_BILL',
    area: 'LEAKAGE',
    name: 'Possible duplicate bill',
    description: 'Two or more posted bills from the same vendor for the same total within the set number of days. The same vendor invoice number is already refused when a bill is entered; this catches bills entered under different numbers.',
    params: [p('windowDays', 'Within', 'days', '0', '90', '7')],
  },
  {
    key: 'DUPLICATE_PAYMENT',
    area: 'LEAKAGE',
    name: 'Possible duplicate payment',
    description: 'Two or more posted payments to the same vendor for the same amount within the set number of days.',
    params: [p('windowDays', 'Within', 'days', '0', '30', '3')],
  },
  {
    key: 'UNUSUAL_JOURNAL',
    area: 'CONTROLS',
    name: 'Unusual manual journal',
    description: 'A manual journal posted in the last 90 days is much larger than the usual manual journal, or was posted long after its date.',
    params: [
      p('multiple', 'Larger than the usual journal by', 'times', '2', '100', '5', false),
      p('minAmount', 'and at least', 'amount', '0', '9999999999999', '100000', false),
      p('backdatedDays', 'Posted later than its date by more than', 'days', '1', '365', '30'),
    ],
  },
] satisfies AlertRuleDef[]);

export function alertRule(key: string): AlertRuleDef {
  const r = ALERT_RULES.find((x) => x.key === key);
  if (!r) throw new AlertError(`Unknown check: ${key}`);
  return r;
}

const NUMBER = /^\d{1,13}(\.\d{1,4})?$/;

/**
 * A rule's settings, with defaults for anything not given. Throws AlertError naming the
 * setting when a value is missing its format or out of range.
 */
export function resolveAlertParams(rule: AlertRuleDef, given: Readonly<Record<string, unknown>> | null | undefined): Record<string, Dec> {
  const out: Record<string, Dec> = {};
  const input = given ?? {};
  for (const k of Object.keys(input)) if (!rule.params.some((x) => x.key === k)) throw new AlertError(`"${k}" is not a setting of this check`);
  for (const def of rule.params) {
    const raw = input[def.key];
    if (raw === undefined || raw === null || raw === '') {
      out[def.key] = dec(def.default);
      continue;
    }
    if (typeof raw !== 'string' || !NUMBER.test(raw.trim())) throw new AlertError(`${def.label}: enter a number such as "${def.default}"`);
    const v = dec(raw.trim());
    if (def.integer && !v.isInteger()) throw new AlertError(`${def.label}: enter a whole number`);
    if (v.lt(def.min) || v.gt(def.max)) throw new AlertError(`${def.label}: enter a value from ${def.min} to ${def.max}`);
    out[def.key] = v;
  }
  return out;
}

// ------------------------------------------------------------------ dates

const DAY = 86_400_000;
const ms = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
export const daysFrom = (from: string, to: string) => Math.round((ms(to) - ms(from)) / DAY);
const median = (xs: Dec[]): Dec | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a.comparedTo(b));
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : s[mid - 1].plus(s[mid]).div(2);
};

// ------------------------------------------------------------------ detectors

export interface DuplicateCandidate {
  id: string;
  contactId: string;
  date: string;
  amount: string | Dec;
}

export interface DuplicateGroup<T extends DuplicateCandidate> {
  contactId: string;
  amount: Dec;
  items: T[];
  /** Days between the first and the last item. */
  spanDays: number;
}

/**
 * Groups of items for the same contact and the same amount where each item falls within
 * `windowDays` of the one before it. Zero amounts are ignored.
 */
export function findDuplicates<T extends DuplicateCandidate>(items: readonly T[], windowDays: number): DuplicateGroup<T>[] {
  const by = new Map<string, T[]>();
  for (const it of items) {
    const a = dec(it.amount);
    if (a.isZero()) continue;
    const k = `${it.contactId}|${a.toFixed()}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(it);
  }
  const groups: DuplicateGroup<T>[] = [];
  for (const list of by.values()) {
    list.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    let run: T[] = [list[0]];
    const flush = () => {
      if (run.length > 1) groups.push({ contactId: run[0].contactId, amount: dec(run[0].amount), items: run, spanDays: daysFrom(run[0].date, run[run.length - 1].date) });
    };
    for (let i = 1; i < list.length; i++) {
      if (daysFrom(run[run.length - 1].date, list[i].date) <= windowDays) run.push(list[i]);
      else {
        flush();
        run = [list[i]];
      }
    }
    flush();
  }
  return groups.sort((a, b) => a.items[0].date.localeCompare(b.items[0].date));
}

export interface JournalFact {
  id: string;
  /** The journal's date. */
  date: string;
  /** The day it was posted (in the organisation's time zone). */
  postedOn: string;
  total: string | Dec;
}

export interface UnusualJournal {
  id: string;
  total: Dec;
  /** The median manual journal in the history window, or null with fewer than 5 of them. */
  typical: Dec | null;
  reasons: { code: 'LARGE' | 'BACKDATED'; text: string }[];
}

/** Fewer manual journals than this in the history and size is not judged. */
export const MIN_JOURNAL_HISTORY = 5;

/**
 * Manual journals that are at least `multiple` times the median of `history` and at least
 * `minAmount`, or that were posted more than `backdatedDays` after their date.
 */
export function unusualJournals(journals: readonly JournalFact[], history: readonly (string | Dec)[], params: { multiple: Dec; minAmount: Dec; backdatedDays: number }): UnusualJournal[] {
  const typical = history.length >= MIN_JOURNAL_HISTORY ? median(history.map((h) => dec(h))) : null;
  const out: UnusualJournal[] = [];
  for (const j of journals) {
    const total = dec(j.total);
    const reasons: UnusualJournal['reasons'] = [];
    if (typical && typical.gt(0) && total.gte(params.minAmount) && total.gte(typical.times(params.multiple))) {
      reasons.push({ code: 'LARGE', text: `${total.div(typical).toDecimalPlaces(1).toFixed(1)} times the usual manual journal` });
    }
    const late = daysFrom(j.date, j.postedOn);
    if (late > params.backdatedDays) reasons.push({ code: 'BACKDATED', text: `Posted ${late} days after its date` });
    if (reasons.length) out.push({ id: j.id, total, typical, reasons });
  }
  return out;
}

export interface MonthlyBilling {
  contactId: string;
  /** YYYY-MM */
  month: string;
  /** Invoiced in the month, before tax. */
  amount: string | Dec;
}

export interface MissedBilling {
  contactId: string;
  month: string;
  history: { month: string; amount: Dec }[];
  /** The median of the months before. */
  typical: Dec;
}

function shiftMonth(month: string, by: number): string {
  const y = +month.slice(0, 4);
  const m = +month.slice(5, 7) - 1 + by;
  return `${y + Math.floor(m / 12)}-${String((((m % 12) + 12) % 12) + 1).padStart(2, '0')}`;
}

/**
 * Customers invoiced (a positive amount) in each of the `lookback` months before `month`
 * and not at all in `month`.
 */
export function missedRecurringBilling(rows: readonly MonthlyBilling[], month: string, lookback: number): MissedBilling[] {
  const before = Array.from({ length: lookback }, (_, i) => shiftMonth(month, -(lookback - i)));
  const by = new Map<string, Map<string, Dec>>();
  for (const r of rows) {
    if (!by.has(r.contactId)) by.set(r.contactId, new Map());
    const m = by.get(r.contactId)!;
    m.set(r.month, (m.get(r.month) ?? new D(0)).plus(dec(r.amount)));
  }
  const out: MissedBilling[] = [];
  for (const [contactId, months] of by) {
    if ((months.get(month) ?? new D(0)).gt(0)) continue;
    const history = before.map((m) => ({ month: m, amount: months.get(m) ?? new D(0) }));
    if (!history.every((h) => h.amount.gt(0))) continue;
    out.push({ contactId, month, history, typical: median(history.map((h) => h.amount))! });
  }
  return out.sort((a, b) => b.typical.comparedTo(a.typical) || a.contactId.localeCompare(b.contactId));
}

export interface BudgetFact {
  accountId: string;
  budget: string | Dec;
  actual: string | Dec;
}

export interface BudgetOverrun {
  accountId: string;
  budget: Dec;
  actual: Dec;
  over: Dec;
  /** Share over the budget, one decimal; null when there is no budget. */
  percent: string | null;
}

/** Expense accounts over budget by at least `percent` and `minAmount`, or unbudgeted spending of at least `minAmount`. */
export function budgetOverruns(rows: readonly BudgetFact[], params: { percent: Dec; minAmount: Dec }): BudgetOverrun[] {
  const out: BudgetOverrun[] = [];
  for (const r of rows) {
    const budget = dec(r.budget);
    const actual = dec(r.actual);
    const over = actual.minus(budget);
    if (over.lte(0) || over.lt(params.minAmount)) continue;
    if (budget.gt(0)) {
      const pct = over.div(budget).times(100);
      if (pct.lt(params.percent)) continue;
      out.push({ accountId: r.accountId, budget, actual, over, percent: pct.toDecimalPlaces(1).toFixed(1) });
    } else {
      out.push({ accountId: r.accountId, budget, actual, over, percent: null });
    }
  }
  return out.sort((a, b) => b.over.comparedTo(a.over));
}

export interface OpenInvoiceFact {
  id: string;
  contactId: string;
  number: string;
  dueDate: string;
  open: string | Dec;
}

export interface OverdueCustomer<T extends OpenInvoiceFact> {
  contactId: string;
  total: Dec;
  oldestDays: number;
  invoices: (T & { daysOverdue: number })[];
}

/** Customers whose open invoices more than `days` overdue add up to at least `minAmount` (and more than zero). */
export function overdueByCustomer<T extends OpenInvoiceFact>(items: readonly T[], today: string, days: number, minAmount: Dec): OverdueCustomer<T>[] {
  const by = new Map<string, OverdueCustomer<T>>();
  for (const it of items) {
    const late = daysFrom(it.dueDate, today);
    const open = dec(it.open);
    if (late <= days || open.lte(0)) continue;
    if (!by.has(it.contactId)) by.set(it.contactId, { contactId: it.contactId, total: new D(0), oldestDays: 0, invoices: [] });
    const c = by.get(it.contactId)!;
    c.total = c.total.plus(open);
    c.oldestDays = Math.max(c.oldestDays, late);
    c.invoices.push({ ...it, daysOverdue: late });
  }
  return [...by.values()]
    .filter((c) => c.total.gte(minAmount))
    .map((c) => ({ ...c, invoices: c.invoices.sort((a, b) => b.daysOverdue - a.daysOverdue || a.number.localeCompare(b.number)) }))
    .sort((a, b) => b.total.comparedTo(a.total));
}

// ------------------------------------------------------------------ keeping alerts in step

export interface ExistingAlert {
  id: string;
  rule: string;
  fingerprint: string;
  status: AlertStatus;
}

export interface AlertSync {
  /** Findings with no alert yet. */
  create: { rule: string; fingerprint: string }[];
  /** Alerts found again: refresh their figures. `reopen` when the alert had cleared. */
  refresh: { id: string; fingerprint: string; reopen: boolean }[];
  /** Open or acknowledged alerts no longer found. */
  clear: string[];
}

/**
 * How a scan's findings change the stored alerts of the rules it ran:
 * a new finding opens an alert; a cleared alert found again reopens; an open or
 * acknowledged alert not found clears; a dismissed alert stays dismissed either way.
 * Alerts of rules not in `rulesRun` are left alone.
 */
export function syncAlerts(existing: readonly ExistingAlert[], found: readonly { rule: string; fingerprint: string }[], rulesRun: readonly string[]): AlertSync {
  const ran = new Set(rulesRun);
  const key = (r: string, f: string) => `${r}\u0000${f}`;
  const have = new Map(existing.filter((e) => ran.has(e.rule)).map((e) => [key(e.rule, e.fingerprint), e]));
  const seen = new Set<string>();
  const out: AlertSync = { create: [], refresh: [], clear: [] };
  for (const f of found) {
    const k = key(f.rule, f.fingerprint);
    if (seen.has(k)) continue;
    seen.add(k);
    const e = have.get(k);
    if (!e) out.create.push({ rule: f.rule, fingerprint: f.fingerprint });
    else out.refresh.push({ id: e.id, fingerprint: f.fingerprint, reopen: e.status === 'CLEARED' });
  }
  for (const [k, e] of have) if (!seen.has(k) && (e.status === 'OPEN' || e.status === 'ACKNOWLEDGED')) out.clear.push(e.id);
  return out;
}

export const SEVERITY_ORDER: Readonly<Record<AlertSeverity, number>> = Object.freeze({ CRITICAL: 0, WARNING: 1, INFO: 2 });
