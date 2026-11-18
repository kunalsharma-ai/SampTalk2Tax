import { D, type Dec } from './money';

/**
 * Expense reporting (EXP-017): claim lines summed by category (expense account), month, person,
 * status and merchant over a date range. Every figure is a sum of the lines as claimed; nothing
 * is estimated. Lines are dated by the day the expense happened, not when it was claimed.
 */

export interface ExpenseReportLine {
  claimId: string;
  claimantId: string;
  status: string;
  /** YYYY-MM-DD, the day of the expense. */
  date: string;
  accountId: string;
  merchant: string | null;
  net: string;
  tax: string;
  amount: string;
}

export interface ExpenseGroup {
  key: string;
  claims: number;
  lines: number;
  net: Dec;
  tax: Dec;
  total: Dec;
  /** Share of the report total, as a percentage with one decimal. */
  share: string;
}

export interface ExpenseReport {
  totals: { claims: number; lines: number; net: Dec; tax: Dec; total: Dec };
  byCategory: ExpenseGroup[];
  byMonth: ExpenseGroup[];
  byPerson: ExpenseGroup[];
  byStatus: ExpenseGroup[];
  byMerchant: ExpenseGroup[];
}

const norm = (m: string | null) => (m ?? '').trim().replace(/\s+/g, ' ');

/** Sums the lines dated from `from` to `to` (inclusive) into groups, largest first (months in order). */
export function expenseReport(lines: readonly ExpenseReportLine[], from: string, to: string, opts: { merchants?: number } = {}): ExpenseReport {
  const inRange = lines.filter((l) => l.date >= from && l.date <= to);
  const groups = (keyOf: (l: ExpenseReportLine) => string | null) => {
    const m = new Map<string, { claims: Set<string>; lines: number; net: Dec; tax: Dec; total: Dec }>();
    for (const l of inRange) {
      const k = keyOf(l);
      if (k === null) continue;
      const g = m.get(k) ?? { claims: new Set<string>(), lines: 0, net: new D(0), tax: new D(0), total: new D(0) };
      g.claims.add(l.claimId);
      g.lines += 1;
      g.net = g.net.plus(l.net);
      g.tax = g.tax.plus(l.tax);
      g.total = g.total.plus(l.amount);
      m.set(k, g);
    }
    return m;
  };
  const total = inRange.reduce((s, l) => s.plus(l.amount), new D(0));
  const out = (m: ReturnType<typeof groups>, order: 'total' | 'key' = 'total'): ExpenseGroup[] =>
    [...m.entries()]
      .map(([key, g]) => ({ key, claims: g.claims.size, lines: g.lines, net: g.net, tax: g.tax, total: g.total, share: total.isZero() ? '0.0' : g.total.div(total).times(100).toFixed(1) }))
      .sort((a, b) => (order === 'key' ? a.key.localeCompare(b.key) : b.total.comparedTo(a.total) || a.key.localeCompare(b.key)));
  const merchantNames = new Map<string, string>();
  for (const l of inRange) {
    const n = norm(l.merchant);
    if (n && !merchantNames.has(n.toLowerCase())) merchantNames.set(n.toLowerCase(), n);
  }
  const byMerchant = out(groups((l) => (norm(l.merchant) ? norm(l.merchant).toLowerCase() : null)))
    .slice(0, opts.merchants ?? 10)
    .map((g) => ({ ...g, key: merchantNames.get(g.key)! }));
  return {
    totals: {
      claims: new Set(inRange.map((l) => l.claimId)).size,
      lines: inRange.length,
      net: inRange.reduce((s, l) => s.plus(l.net), new D(0)),
      tax: inRange.reduce((s, l) => s.plus(l.tax), new D(0)),
      total,
    },
    byCategory: out(groups((l) => l.accountId)),
    byMonth: out(groups((l) => l.date.slice(0, 7)), 'key'),
    byPerson: out(groups((l) => l.claimantId)),
    byStatus: out(groups((l) => l.status)),
    byMerchant,
  };
}
