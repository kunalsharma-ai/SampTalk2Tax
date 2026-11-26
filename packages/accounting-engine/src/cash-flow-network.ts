import { D, type Dec } from './money';

/**
 * Cash-flow network (DASH-024): where cash came from and where it went, month by month, from
 * posted journal entries. Each entry that moves a cash or bank account is split across the
 * other side of the entry: cash in comes from the accounts credited, cash out goes to the
 * accounts debited, in proportion to their amounts. Those accounts are grouped (customers and
 * income, vendors and spending, payroll, tax, lenders, owners, assets bought or sold, other),
 * and money moved only between cash accounts is a transfer. Pure: the caller reads the books.
 */
export const CASH_NETWORK_GROUPS = ['CUSTOMERS', 'VENDORS', 'PAYROLL', 'TAX', 'FINANCING', 'OWNERS', 'ASSETS', 'OTHER'] as const;
export type CashNetworkGroup = (typeof CASH_NETWORK_GROUPS)[number];

export interface CashNetworkAccount {
  id: string;
  type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
  subtype: string | null;
}
export interface CashNetworkEntry {
  /** YYYY-MM of the entry date. */
  month: string;
  lines: { accountId: string; debit: string; credit: string }[];
}
export interface CashNetworkInput {
  /** Cash and bank accounts, in the order to show them. */
  cash: { id: string; name: string }[];
  accounts: CashNetworkAccount[];
  entries: CashNetworkEntry[];
  /** Months to report, in order (YYYY-MM). */
  months: string[];
  /** Decimal places of the functional currency. */
  scale: number;
  /** At most this many cash accounts are drawn; the rest are joined as one. */
  maxCashNodes?: number;
}

/** A flow between a group and a cash account (`cash:<id>`), or between two cash accounts. */
export interface CashFlowEdge {
  from: string;
  to: string;
  amount: string;
}
export interface CashFlowMonth {
  month: string;
  flows: CashFlowEdge[];
  inflow: string;
  outflow: string;
  net: string;
}
export interface CashNetworkNode {
  key: string;
  kind: 'CASH' | 'GROUP';
  name: string;
  inflow: string;
  outflow: string;
}
export interface CashFlowNetwork {
  nodes: CashNetworkNode[];
  months: CashFlowMonth[];
  total: CashFlowMonth;
}

export const OTHER_CASH = 'cash:others';

/** Which group the other side of a cash movement belongs to, from its account. */
export function cashNetworkGroup(a: CashNetworkAccount | undefined): CashNetworkGroup {
  if (!a) return 'OTHER';
  const s = a.subtype ?? '';
  if (s === 'ACCOUNTS_RECEIVABLE' || a.type === 'REVENUE') return 'CUSTOMERS';
  if (s === 'PAYROLL_LIABILITY' || s === 'PAYROLL_EXPENSE' || s === 'EMPLOYEE_REIMBURSEMENTS') return 'PAYROLL';
  if (s === 'TAX_PAYABLE' || s === 'TAX_RECEIVABLE' || s === 'TAX_EXPENSE') return 'TAX';
  if (s === 'LONG_TERM_DEBT' || s === 'CREDIT_CARD' || s === 'INTEREST_EXPENSE') return 'FINANCING';
  if (a.type === 'EQUITY') return 'OWNERS';
  if (s === 'FIXED_ASSET') return 'ASSETS';
  if (s === 'ACCOUNTS_PAYABLE' || a.type === 'EXPENSE' || s === 'INVENTORY' || s === 'PREPAID') return 'VENDORS';
  return 'OTHER';
}

/** Splits `amount` over `weights` in proportion, rounded to `scale`, the rounding left on the largest weight. */
export function splitAmount(amount: Dec, weights: Dec[], scale: number): Dec[] {
  const total = weights.reduce((t, w) => t.plus(w), new D(0));
  if (total.lte(0)) throw new Error('Weights must add up to more than zero');
  const parts = weights.map((w) => amount.times(w).div(total).toDecimalPlaces(scale));
  let largest = 0;
  weights.forEach((w, i) => {
    if (w.gt(weights[largest])) largest = i;
  });
  parts[largest] = parts[largest].plus(amount.minus(parts.reduce((t, p) => t.plus(p), new D(0))));
  return parts;
}

type Bucket = Map<string, Dec>;
const add = (b: Bucket, k: string, v: Dec) => b.set(k, (b.get(k) ?? new D(0)).plus(v));
const edgeKey = (from: string, to: string) => `${from}>${to}`;

export function cashFlowNetwork(input: CashNetworkInput): CashFlowNetwork {
  const max = Math.max(1, input.maxCashNodes ?? 6);
  const accounts = new Map(input.accounts.map((a) => [a.id, a]));
  const cashIds = new Set(input.cash.map((c) => c.id));
  // The busiest cash accounts get their own node; the rest are joined.
  const activity = new Map<string, Dec>();
  for (const e of input.entries) for (const l of e.lines) if (cashIds.has(l.accountId)) add(activity, l.accountId, new D(l.debit).plus(l.credit));
  const ranked = [...input.cash].sort((a, b) => (activity.get(b.id) ?? new D(0)).comparedTo(activity.get(a.id) ?? new D(0)) || input.cash.indexOf(a) - input.cash.indexOf(b));
  const own = new Set((input.cash.length > max ? ranked.slice(0, max - 1) : ranked).map((c) => c.id));
  const cashNode = (id: string) => (own.has(id) ? `cash:${id}` : OTHER_CASH);

  const perMonth = new Map<string, Bucket>(input.months.map((m) => [m, new Map()]));
  for (const e of input.entries) {
    const bucket = perMonth.get(e.month);
    if (!bucket) continue;
    const cashNet = new Map<string, Dec>();
    const other = new Map<CashNetworkGroup, Dec>();
    for (const l of e.lines) {
      const net = new D(l.debit).minus(l.credit);
      if (cashIds.has(l.accountId)) add(cashNet as Bucket, cashNode(l.accountId), net);
      else add(other as unknown as Bucket, cashNetworkGroup(accounts.get(l.accountId)), net);
    }
    const ins = [...cashNet].filter(([, v]) => v.gt(0));
    const outs = [...cashNet].filter(([, v]) => v.lt(0)).map(([k, v]) => [k, v.negated()] as [string, Dec]);
    if (!ins.length && !outs.length) continue;
    const sources = [...other].filter(([, v]) => v.lt(0)).map(([k, v]) => [k, v.negated()] as [CashNetworkGroup, Dec]);
    const sinks = [...other].filter(([, v]) => v.gt(0));
    // Between cash accounts first: what one cash node lost and another gained in the same entry.
    const inLeft = new Map(ins);
    const outLeft = new Map(outs);
    if (ins.length && outs.length) {
      for (const [to] of ins) {
        for (const [from] of outs) {
          const a = D.min(inLeft.get(to)!, outLeft.get(from)!);
          if (a.lte(0)) continue;
          // Only what the other side of the entry does not explain is a transfer.
          const explained = sources.reduce((t, [, v]) => t.plus(v), new D(0));
          const transfer = D.max(new D(0), a.minus(explained));
          if (transfer.gt(0)) {
            add(bucket, edgeKey(from, to), transfer);
            inLeft.set(to, inLeft.get(to)!.minus(transfer));
            outLeft.set(from, outLeft.get(from)!.minus(transfer));
          }
        }
      }
    }
    for (const [to, amount] of inLeft) {
      if (amount.lte(0)) continue;
      if (!sources.length) add(bucket, edgeKey('group:OTHER', to), amount);
      else
        splitAmount(
          amount,
          sources.map(([, v]) => v),
          input.scale,
        ).forEach((p, i) => p.gt(0) && add(bucket, edgeKey(`group:${sources[i][0]}`, to), p));
    }
    for (const [from, amount] of outLeft) {
      if (amount.lte(0)) continue;
      if (!sinks.length) add(bucket, edgeKey(from, 'group:OTHER'), amount);
      else
        splitAmount(
          amount,
          sinks.map(([, v]) => v),
          input.scale,
        ).forEach((p, i) => p.gt(0) && add(bucket, edgeKey(from, `group:${sinks[i][0]}`), p));
    }
  }

  const summarise = (month: string, bucket: Bucket): CashFlowMonth => {
    const flows = [...bucket]
      .filter(([, v]) => !v.isZero())
      .map(([k, v]) => {
        const [from, to] = k.split('>');
        return { from, to, amount: v };
      })
      .sort((a, b) => b.amount.comparedTo(a.amount) || (a.from + a.to < b.from + b.to ? -1 : 1));
    const inflow = flows.filter((f) => f.from.startsWith('group:')).reduce((t, f) => t.plus(f.amount), new D(0));
    const outflow = flows.filter((f) => f.to.startsWith('group:')).reduce((t, f) => t.plus(f.amount), new D(0));
    const fx = (d: Dec) => d.toFixed(input.scale);
    return { month, flows: flows.map((f) => ({ from: f.from, to: f.to, amount: fx(f.amount) })), inflow: fx(inflow), outflow: fx(outflow), net: fx(inflow.minus(outflow)) };
  };
  const months = input.months.map((m) => summarise(m, perMonth.get(m)!));
  const all: Bucket = new Map();
  for (const b of perMonth.values()) for (const [k, v] of b) add(all, k, v);
  const total = summarise('ALL', all);

  const nodeIn = new Map<string, Dec>();
  const nodeOut = new Map<string, Dec>();
  for (const f of total.flows) {
    add(nodeOut, f.from, new D(f.amount));
    add(nodeIn, f.to, new D(f.amount));
  }
  const nodes: CashNetworkNode[] = [];
  const fx = (k: string, m: Map<string, Dec>) => (m.get(k) ?? new D(0)).toFixed(input.scale);
  for (const c of input.cash) if (own.has(c.id)) nodes.push({ key: `cash:${c.id}`, kind: 'CASH', name: c.name, inflow: fx(`cash:${c.id}`, nodeIn), outflow: fx(`cash:${c.id}`, nodeOut) });
  if (input.cash.some((c) => !own.has(c.id)))
    nodes.push({ key: OTHER_CASH, kind: 'CASH', name: `${input.cash.length - own.size} other cash accounts`, inflow: fx(OTHER_CASH, nodeIn), outflow: fx(OTHER_CASH, nodeOut) });
  for (const g of CASH_NETWORK_GROUPS) {
    const k = `group:${g}`;
    if (nodeIn.has(k) || nodeOut.has(k)) nodes.push({ key: k, kind: 'GROUP', name: g, inflow: fx(k, nodeIn), outflow: fx(k, nodeOut) });
  }
  return { nodes, months, total };
}
