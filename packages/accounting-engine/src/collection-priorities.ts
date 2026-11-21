import { addDays, daysBetween } from './documents';
import { D } from './money';

/**
 * Intelligent collection prioritisation (AR-034): which customers to chase first today, and how.
 * Worked out from the books and the payment predictions (AR-033), with the points behind every
 * score, so the same books always rank the same way and no AI model is needed.
 *
 * Score, 0 to 100:
 * - Money to chase (up to 40): overdue and not disputed, against the largest such amount of any
 *   customer.
 * - Age (up to 25): days the oldest overdue invoice is past due: over 90 days 25, over 60 20,
 *   over 30 15, any 8.
 * - Likely late (up to 20): the open balance's chance of being paid late, weighted by amount.
 * - Due soon and likely late (5): an invoice due in the next 7 days with an even or worse chance
 *   of being late, worth a friendly note first.
 * - Not contacted lately (up to 10): no reminder sent in the last 14 days 10, in the last 7 to
 *   14 days 5, in the last 7 days 0.
 *
 * Disputed amounts are left out of what to chase: when everything overdue is disputed, the
 * action is to settle the dispute.
 */

export interface PriorityInvoice {
  id: string;
  number: string;
  dueDate: string;
  outstanding: string;
  /** From the payment prediction, 0..100. */
  lateChance: number;
  /** Open disputes on the invoice. */
  disputed: string;
}

export interface PriorityCustomer {
  contactId: string;
  name: string;
  email: string | null;
  creditHold: boolean;
  /** The last day a reminder was sent, or null. */
  lastReminderOn: string | null;
  invoices: PriorityInvoice[];
}

export const COLLECTION_ACTIONS = ['SETTLE_DISPUTE', 'CALL_AND_HOLD', 'CALL', 'REMIND', 'NUDGE', 'WAIT'] as const;
export type CollectionAction = (typeof COLLECTION_ACTIONS)[number];
export const COLLECTION_ACTION_LABEL: Record<CollectionAction, string> = {
  SETTLE_DISPUTE: 'Settle the dispute first',
  CALL_AND_HOLD: 'Call, and consider a credit hold',
  CALL: 'Call the customer',
  REMIND: 'Send a reminder',
  NUDGE: 'Send a friendly note before it is due',
  WAIT: 'Reminded lately: give it a few days',
};

export interface PriorityFactor {
  key: 'AMOUNT' | 'AGE' | 'LIKELY_LATE' | 'DUE_SOON' | 'NOT_CONTACTED';
  label: string;
  points: number;
  max: number;
  detail: string;
}

export interface CollectionPriority {
  contactId: string;
  name: string;
  email: string | null;
  creditHold: boolean;
  rank: number;
  score: number;
  action: CollectionAction;
  open: string;
  overdue: string;
  disputed: string;
  /** Overdue and not disputed. */
  toChase: string;
  oldestOverdueDays: number;
  overdueInvoices: number;
  lastReminderOn: string | null;
  factors: PriorityFactor[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Customers with something to chase (an overdue balance not wholly disputed, or an invoice due in
 * the next 7 days likely to be late), ranked. Customers with nothing to chase are left out.
 */
export function collectionPriorities(customers: PriorityCustomer[], asOf: string, minorUnits: number): CollectionPriority[] {
  const soon = addDays(asOf, 7);
  const rows = customers.map((c) => {
    let open = new D(0);
    let overdue = new D(0);
    let disputedOverdue = new D(0);
    let disputed = new D(0);
    let weightedChance = new D(0);
    let oldest = 0;
    let overdueCount = 0;
    let dueSoonLikelyLate = 0;
    for (const i of c.invoices) {
      const o = new D(i.outstanding);
      if (o.lte(0)) continue;
      const dis = D.min(o, new D(i.disputed));
      open = open.plus(o);
      disputed = disputed.plus(dis);
      weightedChance = weightedChance.plus(o.times(i.lateChance));
      if (i.dueDate < asOf) {
        overdue = overdue.plus(o);
        disputedOverdue = disputedOverdue.plus(dis);
        overdueCount++;
        oldest = Math.max(oldest, daysBetween(i.dueDate, asOf));
      } else if (i.dueDate <= soon && i.lateChance >= 50) {
        dueSoonLikelyLate++;
      }
    }
    return { c, open, overdue, disputed, toChase: overdue.minus(disputedOverdue), chance: open.gt(0) ? weightedChance.div(open) : new D(0), oldest, overdueCount, dueSoonLikelyLate };
  });
  const live = rows.filter((r) => r.overdue.gt(0) || r.dueSoonLikelyLate > 0);
  const largest = live.reduce((m, r) => D.max(m, r.toChase), new D(0));

  const out = live.map((r) => {
    const factors: PriorityFactor[] = [];
    const amountPts = largest.gt(0) ? r.toChase.div(largest).times(40).toDecimalPlaces(0).toNumber() : 0;
    factors.push({ key: 'AMOUNT', label: 'Money to chase', points: amountPts, max: 40, detail: r.toChase.gt(0) ? `Overdue and not disputed, against the most owed by any customer` : r.overdue.gt(0) ? 'Everything overdue is disputed' : 'Nothing overdue yet' });
    const d = r.oldest;
    const agePts = d > 90 ? 25 : d > 60 ? 20 : d > 30 ? 15 : d > 0 ? 8 : 0;
    factors.push({ key: 'AGE', label: 'Oldest overdue invoice', points: agePts, max: 25, detail: d > 0 ? `${plural(d, 'day')} past due` : 'Nothing overdue' });
    const chance = r.chance.toDecimalPlaces(0).toNumber();
    factors.push({ key: 'LIKELY_LATE', label: 'Chance of paying late', points: Math.round((chance * 20) / 100), max: 20, detail: `${chance}% of the open balance, weighted by amount` });
    factors.push({ key: 'DUE_SOON', label: 'Due soon and likely late', points: r.dueSoonLikelyLate ? 5 : 0, max: 5, detail: r.dueSoonLikelyLate ? `${plural(r.dueSoonLikelyLate, 'invoice')} due in the next 7 days likely to be late` : 'Nothing due in the next 7 days likely to be late' });
    const since = r.c.lastReminderOn ? daysBetween(r.c.lastReminderOn, asOf) : null;
    const contactPts = since == null || since > 14 ? 10 : since > 7 ? 5 : 0;
    factors.push({ key: 'NOT_CONTACTED', label: 'Not contacted lately', points: contactPts, max: 10, detail: since == null ? 'No reminder sent yet' : `Last reminder ${plural(since, 'day')} ago` });
    const score = factors.reduce((s, f) => s + f.points, 0);

    let action: CollectionAction;
    if (r.overdue.gt(0) && r.toChase.lte(0)) action = 'SETTLE_DISPUTE';
    else if (since != null && since <= 7) action = 'WAIT';
    else if (d > 60) action = r.c.creditHold ? 'CALL' : 'CALL_AND_HOLD';
    else if (d > 30) action = 'CALL';
    else if (d > 0) action = 'REMIND';
    else action = 'NUDGE';
    return {
      contactId: r.c.contactId,
      name: r.c.name,
      email: r.c.email,
      creditHold: r.c.creditHold,
      rank: 0,
      score,
      action,
      open: r.open.toFixed(minorUnits),
      overdue: r.overdue.toFixed(minorUnits),
      disputed: r.disputed.toFixed(minorUnits),
      toChase: r.toChase.toFixed(minorUnits),
      oldestOverdueDays: d,
      overdueInvoices: r.overdueCount,
      lastReminderOn: r.c.lastReminderOn,
      factors,
    };
  });
  out.sort((a, b) => b.score - a.score || new D(b.toChase).cmp(a.toChase) || a.name.localeCompare(b.name));
  out.forEach((r, k) => (r.rank = k + 1));
  return out;
}
