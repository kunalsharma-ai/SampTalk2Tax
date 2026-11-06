import { contractPeriod, type BillingTiming, type ContractFrequency } from './contracts';
import { D } from './money';

/**
 * Revenue forecast (CRM slice 5): revenue before tax, month by month, from what the organisation
 * already knows. Four streams, each traceable to its records:
 *
 * - Contracts: every period of an active contract still to bill, in the month of its invoice
 *   date. Periods already due but not yet billed fall in the current month. An auto-renewing
 *   contract runs on past its end date; a paused one is left out.
 * - Sales orders: what is left to bill on open orders, in the current month.
 * - Pipeline: open deals in the month they are expected to close (a past date falls in the
 *   current month), at their win probability (expected) or in full (best case).
 * - Other sales: the average monthly revenue of the last three complete months from invoices
 *   not made from a contract or an order (credit notes netted). In the current month, what such
 *   invoices have already brought is taken off.
 *
 * Scenarios: committed = contracts + orders; expected = committed + weighted pipeline + other
 * sales; best case = committed + full pipeline + other sales. The current month also shows what
 * has been invoiced so far; the forecast is what is still to come.
 */

export interface ForecastContract {
  id: string;
  reference: string;
  title: string;
  customer: string;
  start: string;
  end: string | null;
  frequency: ContractFrequency;
  timing: BillingTiming;
  nextNo: number;
  autoRenew: boolean;
  /** Net value of one period. */
  perPeriod: string;
}

export interface ForecastOrder {
  id: string;
  reference: string;
  customer: string;
  /** Net value left to bill. */
  remaining: string;
}

export interface ForecastDeal {
  id: string;
  reference: string;
  name: string;
  customer: string;
  amount: string;
  probability: number;
  expectedClose: string;
}

export interface ForecastMonth {
  month: string;
  contracts: string;
  orders: string;
  pipelineWeighted: string;
  pipelineFull: string;
  otherSales: string;
  committed: string;
  expected: string;
  best: string;
}

export interface ForecastItem {
  month: string;
  stream: 'CONTRACT' | 'ORDER' | 'DEAL';
  id: string;
  reference: string;
  label: string;
  customer: string;
  amount: string;
  /** Deals: the weighted amount; others: the same as amount. */
  expected: string;
}

const RANK: Record<ForecastItem['stream'], number> = { CONTRACT: 0, ORDER: 1, DEAL: 2 };
const monthOf = (iso: string) => iso.slice(0, 7);

export function forecastMonths(today: string, count: number): string[] {
  const [y, m] = today.split('-').map(Number) as [number, number];
  return Array.from({ length: count }, (_, i) => {
    const t = y * 12 + (m - 1) + i;
    return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
  });
}

export function revenueForecast(input: {
  today: string;
  months: number;
  contracts: ForecastContract[];
  orders: ForecastOrder[];
  deals: ForecastDeal[];
  /** Average monthly other sales over the last three complete months. */
  otherRunRate: string;
  /** Other sales already invoiced this month. */
  otherSoFar: string;
  /** All revenue invoiced so far this month (for display). */
  actualSoFar: string;
  scale: number;
}) {
  const months = forecastMonths(input.today, input.months);
  const first = months[0]!;
  const last = months.at(-1)!;
  const place = (iso: string) => (monthOf(iso) < first ? first : monthOf(iso));
  const items: ForecastItem[] = [];
  const s = input.scale;

  for (const c of input.contracts) {
    for (let n = c.nextNo, guard = 0; guard < 400; n++, guard++) {
      const p = contractPeriod(c.start, c.frequency, n, c.timing);
      if (!c.autoRenew && c.end && p.start > c.end) break;
      const m = place(p.billDate);
      if (m > last) break;
      const amt = new D(c.perPeriod).toFixed(s);
      items.push({ month: m, stream: 'CONTRACT', id: c.id, reference: c.reference, label: `${c.title}, period ${n}`, customer: c.customer, amount: amt, expected: amt });
    }
  }
  for (const o of input.orders) {
    if (new D(o.remaining).lte(0)) continue;
    const amt = new D(o.remaining).toFixed(s);
    items.push({ month: first, stream: 'ORDER', id: o.id, reference: o.reference, label: 'Left to bill', customer: o.customer, amount: amt, expected: amt });
  }
  for (const d of input.deals) {
    const m = place(d.expectedClose);
    if (m > last) continue;
    items.push({ month: m, stream: 'DEAL', id: d.id, reference: d.reference, label: `${d.name} (${d.probability}%)`, customer: d.customer, amount: new D(d.amount).toFixed(s), expected: new D(d.amount).times(d.probability).div(100).toDecimalPlaces(s, D.ROUND_HALF_EVEN).toFixed(s) });
  }

  const run = D.max(new D(input.otherRunRate), 0);
  const firstOther = D.max(run.minus(input.otherSoFar), 0);
  const sum = (m: string, stream: ForecastItem['stream'], k: 'amount' | 'expected') => items.filter((i) => i.month === m && i.stream === stream).reduce((t, i) => t.plus(i[k]), new D(0));
  const rows: ForecastMonth[] = months.map((m) => {
    const contracts = sum(m, 'CONTRACT', 'amount');
    const orders = sum(m, 'ORDER', 'amount');
    const weighted = sum(m, 'DEAL', 'expected');
    const full = sum(m, 'DEAL', 'amount');
    const other = m === first ? firstOther : run;
    const committed = contracts.plus(orders);
    return {
      month: m,
      contracts: contracts.toFixed(s),
      orders: orders.toFixed(s),
      pipelineWeighted: weighted.toFixed(s),
      pipelineFull: full.toFixed(s),
      otherSales: other.toFixed(s),
      committed: committed.toFixed(s),
      expected: committed.plus(weighted).plus(other).toFixed(s),
      best: committed.plus(full).plus(other).toFixed(s),
    };
  });
  const total = (k: keyof Omit<ForecastMonth, 'month'>) => rows.reduce((t, r) => t.plus(r[k]), new D(0)).toFixed(s);
  return {
    months: rows,
    totals: { contracts: total('contracts'), orders: total('orders'), pipelineWeighted: total('pipelineWeighted'), pipelineFull: total('pipelineFull'), otherSales: total('otherSales'), committed: total('committed'), expected: total('expected'), best: total('best') },
    actualSoFar: new D(input.actualSoFar).toFixed(s),
    items: items.sort((a, b) => a.month.localeCompare(b.month) || RANK[a.stream] - RANK[b.stream] || a.reference.localeCompare(b.reference)),
  };
}

/**
 * How a saved forecast compares with what happened, for months that are over. The forecast for
 * its first month is what was still to come plus what had been invoiced by then, so it compares
 * with the whole month's revenue. WAPE = sum of |actual − forecast| ÷ sum of actual.
 */
export function revenueForecastAccuracy(saved: { month: string; expected: string; committed: string }[], firstMonthActualSoFar: string, actual: Map<string, string>, currentMonth: string, scale: number) {
  const rows = saved
    .filter((m) => m.month < currentMonth)
    .map((m, i) => {
      const add = i === 0 && m.month === saved[0]!.month ? new D(firstMonthActualSoFar) : new D(0);
      const forecast = new D(m.expected).plus(add);
      const committed = new D(m.committed).plus(add);
      const a = new D(actual.get(m.month) ?? 0);
      const variance = a.minus(forecast);
      return { month: m.month, forecast: forecast.toFixed(scale), committed: committed.toFixed(scale), actual: a.toFixed(scale), variance: variance.toFixed(scale), variancePct: forecast.gt(0) ? variance.div(forecast).toDecimalPlaces(4).toFixed() : null };
    });
  const act = rows.reduce((t, r) => t.plus(r.actual), new D(0));
  const err = rows.reduce((t, r) => t.plus(new D(r.variance).abs()), new D(0));
  return { months: rows, wape: act.gt(0) ? err.div(act).toDecimalPlaces(4).toFixed() : null };
}
