import { D, type Dec } from './money';

/**
 * Financial dependencies (DASH-037): who the business depends on for its money. Revenue from
 * customers, spending with vendors, cash held in each bank or cash account and what is owed to
 * lenders, each as a group of parties with their shares, how concentrated the group is
 * (Herfindahl–Hirschman index of the shares, 0 to 10,000) and the single dependencies worth
 * watching. Pure: the caller reads the books.
 */
export const DEPENDENCY_GROUPS = ['CUSTOMERS', 'VENDORS', 'CASH', 'BORROWING'] as const;
export type DependencyGroup = (typeof DEPENDENCY_GROUPS)[number];
export type DependencySeverity = 'CRITICAL' | 'HIGH' | 'WATCH';
export type ConcentrationLevel = 'LOW' | 'MODERATE' | 'HIGH';

export interface DependencyParty {
  id: string;
  name: string;
  amount: string;
}

/** Shares at or above these make a single party a dependency worth watching. */
export const DEPENDENCY_THRESHOLDS: Record<DependencyGroup, { watch: number; high: number; critical: number }> = {
  CUSTOMERS: { watch: 15, high: 25, critical: 40 },
  VENDORS: { watch: 20, high: 30, critical: 50 },
  CASH: { watch: 75, high: 90, critical: 101 },
  BORROWING: { watch: 50, high: 75, critical: 101 },
};

const pct = (part: Dec, total: Dec) => (total.gt(0) ? Number(part.div(total).times(100).toDecimalPlaces(1)) : 0); // not money: a share
export const concentrationLevel = (hhi: number): ConcentrationLevel => (hhi < 1500 ? 'LOW' : hhi <= 2500 ? 'MODERATE' : 'HIGH');

function group(key: DependencyGroup, parties: readonly DependencyParty[], top: number, scale: number) {
  const list = parties.map((p) => ({ ...p, value: new D(p.amount) })).filter((p) => p.value.gt(0));
  list.sort((a, b) => b.value.comparedTo(a.value) || a.name.localeCompare(b.name));
  const total = list.reduce((t, p) => t.plus(p.value), new D(0));
  const shares = list.map((p) => (total.gt(0) ? p.value.div(total).times(100) : new D(0)));
  const hhi = Math.round(Number(shares.reduce((t, s) => t.plus(s.times(s)), new D(0)))); // not money: an index
  const head = list.slice(0, top);
  const rest = list.slice(top).reduce((t, p) => t.plus(p.value), new D(0));
  return {
    group: key,
    total: total.toFixed(scale),
    count: list.length,
    hhi,
    concentration: list.length ? concentrationLevel(hhi) : null,
    largestShare: list.length ? pct(list[0]!.value, total) : null,
    parties: head.map((p) => ({ id: p.id, name: p.name, amount: p.value.toFixed(scale), share: pct(p.value, total) })),
    others: { count: list.length - head.length, amount: rest.toFixed(scale), share: pct(rest, total) },
  };
}

export function financialDependencies(input: { customers: readonly DependencyParty[]; vendors: readonly DependencyParty[]; cash: readonly DependencyParty[]; borrowing: readonly DependencyParty[]; top?: number; scale: number }) {
  const top = input.top ?? 6;
  const groups = {
    CUSTOMERS: group('CUSTOMERS', input.customers, top, input.scale),
    VENDORS: group('VENDORS', input.vendors, top, input.scale),
    CASH: group('CASH', input.cash, top, input.scale),
    BORROWING: group('BORROWING', input.borrowing, top, input.scale),
  };
  const dependencies: { group: DependencyGroup; id: string; name: string; share: number; amount: string; severity: DependencySeverity; reason: string }[] = [];
  for (const g of DEPENDENCY_GROUPS) {
    const t = DEPENDENCY_THRESHOLDS[g];
    // One account holding all the cash, or all the borrowing, is only worth a mention when there is more than one.
    if ((g === 'CASH' || g === 'BORROWING') && groups[g].count < 2) continue;
    for (const p of groups[g].parties) {
      const severity: DependencySeverity | null = p.share >= t.critical ? 'CRITICAL' : p.share >= t.high ? 'HIGH' : p.share >= t.watch ? 'WATCH' : null;
      if (!severity) continue;
      const reason =
        g === 'CUSTOMERS' ? `${p.share}% of revenue comes from ${p.name}` : g === 'VENDORS' ? `${p.share}% of spending goes to ${p.name}` : g === 'CASH' ? `${p.share}% of cash sits in ${p.name}` : `${p.share}% of borrowing is owed on ${p.name}`;
      dependencies.push({ group: g, id: p.id, name: p.name, share: p.share, amount: p.amount, severity, reason });
    }
  }
  // Borrowing larger than the cash held is a dependency on lenders as a whole.
  const cash = new D(groups.CASH.total);
  const owed = new D(groups.BORROWING.total);
  if (owed.gt(0) && owed.gt(cash)) dependencies.push({ group: 'BORROWING', id: 'ALL', name: 'All borrowing', share: pct(owed, cash.gt(0) ? cash : owed), amount: owed.toFixed(input.scale), severity: cash.gt(0) && owed.gt(cash.times(2)) ? 'CRITICAL' : 'HIGH', reason: cash.gt(0) ? `Borrowing is ${owed.div(cash).toDecimalPlaces(1).toFixed()} times the cash held` : 'There is borrowing and no cash held' });
  const rank: Record<DependencySeverity, number> = { CRITICAL: 0, HIGH: 1, WATCH: 2 };
  dependencies.sort((a, b) => rank[a.severity] - rank[b.severity] || b.share - a.share || a.name.localeCompare(b.name)); // not money: ordering
  return { groups, dependencies };
}
