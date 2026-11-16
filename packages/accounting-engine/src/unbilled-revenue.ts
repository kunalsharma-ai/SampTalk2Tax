/**
 * Unbilled revenue detection (AR-042): revenue that was earned or agreed but not yet invoiced,
 * found in the records the app already keeps: milestones completed, contract periods due, usage
 * orders left unbilled, draft invoices waiting, pro forma
 * invoices never turned into tax invoices, and regular customers not billed last month.
 *
 * Deterministic: each finding says what it rests on. Amounts are before tax, in the record's own
 * currency, as decimal strings.
 */
import { addDays, daysBetween } from './documents';
import { D, type Dec } from './money';

export const UNBILLED_SOURCES = ['MILESTONE', 'CONTRACT_PERIOD', 'DRAFT_INVOICE', 'ORDER', 'PRO_FORMA', 'REGULAR_CUSTOMER'] as const;
export type UnbilledSource = (typeof UNBILLED_SOURCES)[number];
export const UNBILLED_SOURCE_LABEL: Record<UnbilledSource, string> = {
  MILESTONE: 'Milestone completed, not invoiced',
  CONTRACT_PERIOD: 'Contract period due, not invoiced',
  DRAFT_INVOICE: 'Draft invoice not issued',
  ORDER: 'Sales order not fully billed',
  PRO_FORMA: 'Pro forma not turned into an invoice',
  REGULAR_CUSTOMER: 'Regular customer not billed last month',
};

/**
 * How sure the finding is that money is owed: CERTAIN when the terms say it is due now, LIKELY
 * when work or a promise points to it, POSSIBLE when only the pattern of past billing does.
 */
export type UnbilledConfidence = 'CERTAIN' | 'LIKELY' | 'POSSIBLE';
export const UNBILLED_CONFIDENCE: Record<UnbilledSource, UnbilledConfidence> = {
  MILESTONE: 'CERTAIN',
  CONTRACT_PERIOD: 'CERTAIN',
  DRAFT_INVOICE: 'CERTAIN',
  ORDER: 'LIKELY',
  PRO_FORMA: 'LIKELY',
  REGULAR_CUSTOMER: 'POSSIBLE',
};
export const UNBILLED_CONFIDENCE_LABEL: Record<UnbilledConfidence, string> = { CERTAIN: 'Due now', LIKELY: 'Likely', POSSIBLE: 'Possible' };

/** An order with quantity left to bill this long after its date is flagged. */
export const UNBILLED_ORDER_DAYS = 30;
/** A draft invoice dated this long ago is flagged. */
export const UNBILLED_DRAFT_DAYS = 7;

export interface UnbilledFinding {
  source: UnbilledSource;
  /** The record it is about: milestone, contract, invoice, order, pro forma or customer. */
  refId: string;
  contactId: string;
  currency: string;
  /** Before tax; null when it cannot be priced until billed. */
  amount: string | null;
  /** Since when it could have been billed. */
  since: string;
  /** What it rests on. */
  detail: string;
}

export const unbilledFingerprint = (f: Pick<UnbilledFinding, 'source' | 'refId'>) => `${f.source}:${f.refId}`;

/** The net amount still to bill on an order's lines. */
export function orderUnbilledAmount(lines: { quantity: string; billed: string; unitPrice: string }[]): string {
  return lines
    .reduce((s, l) => {
      const left = new D(l.quantity).minus(l.billed);
      return left.gt(0) ? s.plus(left.times(l.unitPrice)) : s;
    }, new D(0))
    .toDecimalPlaces(2)
    .toFixed(2);
}

/** Whether a finding stays hidden: dismissed, and not grown since (a larger amount brings it back). */
export function stillDismissed(finding: Pick<UnbilledFinding, 'amount'>, dismissal: { action: 'DISMISS' | 'RESTORE'; amount: string | null } | null): boolean {
  if (!dismissal || dismissal.action !== 'DISMISS') return false;
  if (finding.amount === null || dismissal.amount === null) return true;
  return new D(finding.amount).lte(dismissal.amount);
}

export interface UnbilledTotals {
  currency: string;
  amount: string;
  count: number;
  bySource: Partial<Record<UnbilledSource, string>>;
}

/** Totals by currency (priced findings only), largest first. */
export function unbilledTotals(findings: Pick<UnbilledFinding, 'currency' | 'amount' | 'source'>[]): UnbilledTotals[] {
  const by = new Map<string, { amount: Dec; count: number; bySource: Map<UnbilledSource, Dec> }>();
  for (const f of findings) {
    const t = by.get(f.currency) ?? { amount: new D(0), count: 0, bySource: new Map() };
    t.count++;
    if (f.amount !== null) {
      t.amount = t.amount.plus(f.amount);
      t.bySource.set(f.source, (t.bySource.get(f.source) ?? new D(0)).plus(f.amount));
    }
    by.set(f.currency, t);
  }
  return [...by]
    .map(([currency, t]) => ({ currency, amount: t.amount.toFixed(2), count: t.count, bySource: Object.fromEntries([...t.bySource].map(([s, a]) => [s, a.toFixed(2)])) }))
    .sort((a, b) => new D(b.amount).cmp(a.amount) || a.currency.localeCompare(b.currency));
}

/** Days since a finding could have been billed. */
export const unbilledAge = (since: string, today: string) => Math.max(0, daysBetween(since, today));

/** An order is flagged once this many days have passed since its date. */
export const orderFlagFrom = (orderDate: string) => addDays(orderDate, UNBILLED_ORDER_DAYS);
