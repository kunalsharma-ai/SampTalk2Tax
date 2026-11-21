/**
 * Financial transaction replay (AUDIT-017): the books as they were recorded at a past moment,
 * set beside the books now, for the same dates. The ledger only grows (a posted entry is never
 * changed; corrections are new entries), so replaying every entry posted by that moment gives
 * exactly what anyone could have seen then. The difference is the entries posted since, dated
 * on or before the cut-off: late postings, reversals and corrections into earlier periods.
 */
import { D } from './money';

export interface AccountSums {
  accountId: string;
  /** Functional-currency sums, as decimal strings. */
  debit: string;
  credit: string;
}

export interface ReplayRow {
  accountId: string;
  /** Debits minus credits, as recorded at the moment replayed. */
  recorded: string;
  /** Debits minus credits now. */
  current: string;
  /** current minus recorded. */
  change: string;
}

/** Each account's balance then and now, changed accounts first (largest change first), then by account. */
export function replayComparison(recorded: AccountSums[], current: AccountSums[], order: (a: string, b: string) => number = (a, b) => (a < b ? -1 : a > b ? 1 : 0)): ReplayRow[] {
  const bal = (list: AccountSums[]) => {
    const m = new Map<string, InstanceType<typeof D>>();
    for (const r of list) m.set(r.accountId, (m.get(r.accountId) ?? new D(0)).plus(r.debit).minus(r.credit));
    return m;
  };
  const then = bal(recorded);
  const now = bal(current);
  const ids = [...new Set([...then.keys(), ...now.keys()])];
  const rows = ids.map((id) => {
    const r = then.get(id) ?? new D(0);
    const c = now.get(id) ?? new D(0);
    return { accountId: id, recorded: r.toFixed(2), current: c.toFixed(2), change: c.minus(r).toFixed(2), size: c.minus(r).abs() };
  });
  rows.sort((a, b) => b.size.cmp(a.size) || order(a.accountId, b.accountId));
  return rows.map(({ size: _size, ...r }) => r);
}

/** Totals of a replay: whether both sides balance, and how many accounts moved. */
export function replaySummary(rows: ReplayRow[]) {
  const sum = (k: 'recorded' | 'current') => rows.reduce((t, r) => t.plus(r[k]), new D(0));
  return {
    accounts: rows.length,
    changedAccounts: rows.filter((r) => !new D(r.change).isZero()).length,
    recordedBalances: sum('recorded').isZero(),
    currentBalances: sum('current').isZero(),
    netChange: rows.reduce((t, r) => t.plus(new D(r.change).abs()), new D(0)).div(2).toFixed(2),
  };
}

/** A moment to replay must be in the past, and the cut-off date a real date. */
export function replayIssue(asOf: Date, through: string, now: Date): string | null {
  if (Number.isNaN(asOf.getTime())) return 'Give the moment to replay as a date and time';
  if (asOf.getTime() > now.getTime()) return 'The moment to replay must be in the past';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(through) || Number.isNaN(Date.parse(`${through}T00:00:00Z`))) return 'Give the last date to include as YYYY-MM-DD';
  return null;
}
