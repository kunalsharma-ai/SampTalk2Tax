import { D, Dec, dec } from '@talk2tax/accounting-engine';

/**
 * Tax liability forecast (TAX-048): the tax payments the compliance calendar expects in the
 * coming months, each with an amount and how sure it is.
 *
 * - KNOWN: the period is over and the books say what is owed (GST left after set-off, TDS/TCS
 *   deducted and not deposited, payroll dues of a posted pay run not paid yet).
 * - PLAN: the advance tax plan says what the instalment needs.
 * - AVERAGE: the period has not ended; the average of the last three periods with history, with a
 *   likely range of one standard deviation of the last six (never below zero).
 * - NO_HISTORY: nothing to go on yet.
 *
 * Amounts are decimal strings in the organisation's currency. Nothing here pays or files anything.
 */

export type TaxForecastMethod = 'KNOWN' | 'PLAN' | 'AVERAGE' | 'NO_HISTORY';
export const TAX_FORECAST_METHOD_LABEL: Record<TaxForecastMethod, string> = { KNOWN: 'From the books', PLAN: 'From the advance tax plan', AVERAGE: 'Recent average', NO_HISTORY: 'No history yet' };
export const TAX_FORECAST_MAX_MONTHS = 6;
const RECENT = 3; // not money
const SPREAD = 6; // not money

export interface TaxForecastObligation {
  key: string;
  kind: string;
  name: string;
  area: string;
  period: string;
  periodLabel: string;
  dueDate: string;
  /** What the books say is owed, once the period is over. */
  known?: string | null;
  /** The advance tax plan's amount for this instalment. */
  plan?: string | null;
  /** Past amounts of the same obligation, oldest first, one per period. */
  history?: string[];
  /** Something the forecast should say about where the figure came from. */
  note?: string | null;
}

export interface TaxForecastItem {
  key: string;
  kind: string;
  name: string;
  area: string;
  period: string;
  periodLabel: string;
  dueDate: string;
  method: TaxForecastMethod;
  amount: string;
  low: string;
  high: string;
  basis: string;
}

export function taxLiabilityForecast(obligations: readonly TaxForecastObligation[], opts: { scale?: number; money?: (amount: string) => string } = {}) {
  const scale = opts.scale ?? 2;
  const fx = (d: Dec) => d.toDecimalPlaces(scale, D.ROUND_HALF_EVEN).toFixed(scale);
  const show = opts.money ?? ((a: string) => a);
  const items: TaxForecastItem[] = obligations.map((o) => {
    const base = { key: o.key, kind: o.kind, name: o.name, area: o.area, period: o.period, periodLabel: o.periodLabel, dueDate: o.dueDate };
    const note = o.note ? ` ${o.note}` : '';
    if (o.known != null) {
      const a = fx(D.max(dec(o.known), 0));
      return { ...base, method: 'KNOWN', amount: a, low: a, high: a, basis: `${o.periodLabel} is over; the books show ${show(a)} to pay.${note}` };
    }
    if (o.plan != null) {
      const a = fx(D.max(dec(o.plan), 0));
      return { ...base, method: 'PLAN', amount: a, low: a, high: a, basis: `The advance tax plan needs ${show(a)} by this instalment.${note}` };
    }
    const hist = (o.history ?? []).map((h) => dec(h));
    if (!hist.length) return { ...base, method: 'NO_HISTORY', amount: fx(new D(0)), low: fx(new D(0)), high: fx(new D(0)), basis: `No earlier ${o.name} amounts to go on yet.${note}` };
    const recent = hist.slice(-RECENT);
    const avg = recent.reduce((s, h) => s.plus(h), new D(0)).div(recent.length);
    const spreadOf = hist.slice(-SPREAD);
    const mean = spreadOf.reduce((s, h) => s.plus(h), new D(0)).div(spreadOf.length);
    const sd = spreadOf.reduce((s, h) => s.plus(h.minus(mean).pow(2)), new D(0)).div(spreadOf.length).sqrt();
    const amount = D.max(avg, 0);
    return {
      ...base,
      method: 'AVERAGE',
      amount: fx(amount),
      low: fx(D.max(amount.minus(sd), 0)),
      high: fx(amount.plus(sd)),
      basis: `Average of the last ${recent.length} ${recent.length === 1 ? 'period' : 'periods'} (${recent.map((h) => show(fx(h))).join(', ')}); ${o.periodLabel} has not ended yet.${note}`,
    };
  });
  items.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.name.localeCompare(b.name));
  const byMonth = new Map<string, { month: string; amount: Dec; low: Dec; high: Dec; known: Dec; count: number }>();
  for (const i of items) {
    const m = i.dueDate.slice(0, 7);
    const row = byMonth.get(m) ?? { month: m, amount: new D(0), low: new D(0), high: new D(0), known: new D(0), count: 0 };
    row.amount = row.amount.plus(i.amount);
    row.low = row.low.plus(i.low);
    row.high = row.high.plus(i.high);
    if (i.method === 'KNOWN' || i.method === 'PLAN') row.known = row.known.plus(i.amount);
    row.count += 1; // not money
    byMonth.set(m, row);
  }
  const months = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)).map((r) => ({ month: r.month, amount: fx(r.amount), low: fx(r.low), high: fx(r.high), known: fx(r.known), payments: r.count }));
  const sum = (k: 'amount' | 'low' | 'high') => fx(items.reduce((s, i) => s.plus(i[k]), new D(0)));
  const knownTotal = fx(items.filter((i) => i.method === 'KNOWN' || i.method === 'PLAN').reduce((s, i) => s.plus(i.amount), new D(0)));
  return { items, months, totals: { amount: sum('amount'), low: sum('low'), high: sum('high'), known: knownTotal } };
}
