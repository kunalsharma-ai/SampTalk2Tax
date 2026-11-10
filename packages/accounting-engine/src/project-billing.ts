/**
 * Milestone billing (AR-013) and progress billing (AR-014) of sales orders.
 *
 * An order is billed one of three ways. By delivery (the default): invoices bill chosen quantities
 * of its lines. By milestones: the order's value is split into named milestones, each a share in
 * percent; invoicing a milestone bills that share of every line. By progress: each claim states how
 * complete the work is, and the invoice bills every line up to that share, less what earlier claims
 * billed. Shares are applied to line quantities, so prices, tax rates and GST stay exactly as on the
 * order, and the last share always takes the quantities left, so the order is billed in full. Each
 * invoice rounds its own lines, so the invoices together can differ from the order total by a paisa
 * per line and invoice.
 */
import { D, Dec } from './money';

export const BILLING_METHODS = ['DELIVERY', 'MILESTONES', 'PROGRESS'] as const;
export type BillingMethod = (typeof BILLING_METHODS)[number];
export const BILLING_METHOD_LABEL: Record<BillingMethod, string> = {
  DELIVERY: 'By delivery (chosen quantities)',
  MILESTONES: 'By milestones (a share of the order each)',
  PROGRESS: 'By progress (percent complete to date)',
};

export interface ShareLine {
  id: string;
  lineNo: number;
  quantity: string;
  /** Billed on invoices that are not void. */
  billed: string;
}

const dec = (s: string | Dec) => new D(s.toString());

/**
 * What to bill on each line to bring the order to `targetPercent` of every line in all. At 100 it
 * is whatever is left, so rounding never leaves a remainder. Lines already billed beyond the target
 * bill nothing.
 */
export function shareQuantities(lines: ShareLine[], targetPercent: string): { orderLineId: string; quantity: string }[] {
  const t = dec(targetPercent);
  return lines
    .map((l) => {
      const target = t.gte(100) ? dec(l.quantity) : dec(l.quantity).times(t).div(100).toDecimalPlaces(6, D.ROUND_HALF_UP);
      const left = dec(l.quantity).minus(l.billed);
      let q = target.minus(l.billed);
      if (q.gt(left)) q = left;
      return { orderLineId: l.id, quantity: q.gt(0) ? q.toFixed() : '0' };
    })
    .filter((x) => dec(x.quantity).gt(0));
}

export interface MilestoneInput {
  name: string;
  percent: string;
  dueDate?: string | null;
}

/** Problems with a milestone plan, as sentences; empty when it can be saved. */
export function milestoneIssues(ms: MilestoneInput[]): string[] {
  const issues: string[] = [];
  if (!ms.length) issues.push('Add at least one milestone');
  let total = new D(0);
  ms.forEach((m, i) => {
    const n = i + 1;
    if (!m.name.trim()) issues.push(`Milestone ${n}: give it a name`);
    const p = dec(m.percent || '0');
    if (p.lte(0)) issues.push(`Milestone ${n}: the share must be above 0%`);
    if (p.decimalPlaces() > 2) issues.push(`Milestone ${n}: use at most 2 decimal places`);
    total = total.plus(p);
  });
  if (total.gt(100)) issues.push(`The milestones add up to ${total.toFixed()}%; they can be at most 100%`);
  return issues;
}

/** Sum of the shares of milestones, as a percent string. */
export function sharesTotal(ms: { percent: string }[]): string {
  return ms.reduce((t, m) => t.plus(m.percent), new D(0)).toFixed();
}

/** Problems with a progress claim, as sentences. `previous` is the highest percent claimed on invoices that are not void. */
export function progressIssues(percent: string, previous: string): string[] {
  const p = dec(percent);
  const issues: string[] = [];
  if (p.decimalPlaces() > 2) issues.push('Use at most 2 decimal places for the percent complete');
  if (p.gt(100)) issues.push('Work cannot be more than 100% complete');
  else if (p.lte(previous)) issues.push(`Earlier claims already bill ${dec(previous).toFixed()}% complete; claim a higher percent`);
  return issues;
}
