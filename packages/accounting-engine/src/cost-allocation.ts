import { D, type Dec } from './money';

/**
 * Cost allocation (GL-024): shared costs booked to one cost centre (or to none) are spread to the
 * cost centres that use them by fixed percentages, such as rent by floor area. The amounts are
 * rounded to the currency and any rounding difference goes to the largest share, so the allocated
 * amounts always add up to the cost exactly.
 */

export interface AllocationTarget {
  id: string;
  percent: string;
}

/** Problems with a rule's targets, or an empty list. */
export function allocationTargetIssues(targets: readonly AllocationTarget[], sourceId: string | null): string[] {
  const issues: string[] = [];
  if (targets.length < 2) issues.push('Spread the cost to at least two cost centres');
  const seen = new Set<string>();
  let sum = new D(0);
  for (const t of targets) {
    let p: Dec;
    try {
      p = new D(t.percent);
    } catch {
      issues.push(`${t.percent || '(blank)'} is not a percentage`);
      continue;
    }
    if (!p.isFinite() || p.lte(0) || p.gt(100)) issues.push(`Each share is more than 0 and at most 100 percent`);
    else if (p.decimalPlaces() > 4) issues.push('Use at most four decimal places in a share');
    if (seen.has(t.id)) issues.push('Each cost centre appears once');
    if (sourceId !== null && t.id === sourceId) issues.push('The cost centre the cost comes from cannot also receive it');
    seen.add(t.id);
    sum = sum.plus(p.isFinite() ? p : 0);
  }
  if (targets.length >= 2 && !sum.equals(100)) issues.push(`The shares add up to ${sum.toFixed()} percent, not 100`);
  return [...new Set(issues)];
}

/** Splits an amount by the targets' percentages; the parts add up to the amount exactly. */
export function allocateAmount(amount: Dec | string, targets: readonly AllocationTarget[], scale = 2): { id: string; amount: Dec }[] {
  const total = new D(amount.toString()).toDecimalPlaces(scale);
  const parts = targets.map((t) => ({ id: t.id, percent: new D(t.percent), amount: total.times(t.percent).div(100).toDecimalPlaces(scale) }));
  const diff = total.minus(parts.reduce((s, p) => s.plus(p.amount), new D(0)));
  if (!diff.isZero() && parts.length) {
    const largest = parts.reduce((m, p) => (p.percent.gt(m.percent) ? p : m), parts[0]!);
    largest.amount = largest.amount.plus(diff);
  }
  return parts.map((p) => ({ id: p.id, amount: p.amount }));
}

export interface AllocationLine {
  accountId: string;
  debit?: string;
  credit?: string;
  departmentId: string | null;
  description: string;
}

/**
 * The journal lines that move each account's net cost from the source to the targets: a credit
 * on the source for the whole amount and a debit on each target for its share (the other way round
 * for a net credit). Accounts with nothing to move are skipped.
 */
export function allocationLines(costs: readonly { accountId: string; net: Dec | string }[], sourceId: string | null, targets: readonly AllocationTarget[], label: string, scale = 2): AllocationLine[] {
  const lines: AllocationLine[] = [];
  for (const c of costs) {
    const net = new D(c.net.toString()).toDecimalPlaces(scale);
    if (net.isZero()) continue;
    const abs = net.abs().toFixed(scale);
    const out = net.isPositive() ? { credit: abs } : { debit: abs };
    lines.push({ accountId: c.accountId, ...out, departmentId: sourceId, description: `${label}: allocated out` });
    for (const p of allocateAmount(net.abs(), targets, scale)) {
      if (p.amount.isZero()) continue;
      const v = p.amount.toFixed(scale);
      lines.push({ accountId: c.accountId, ...(net.isPositive() ? { debit: v } : { credit: v }), departmentId: p.id, description: `${label}: allocated in` });
    }
  }
  return lines;
}
