import { daysBetween } from './documents';
import { D, dec, Dec, minorUnits } from './money';

/**
 * Customer invoice disputes (AR-025). A customer who queries an invoice (the price, the quantity,
 * goods not received...) is recorded as a dispute on that invoice, with the amount in question, an
 * owner and a target date. While a dispute is open the invoice is held out of payment reminders and
 * overdue-invoice workflows. It is resolved with a credit note, by the customer paying after all,
 * by a write-off, or by the customer withdrawing it. A dispute moves no money; the credit note or
 * the write-off does.
 */

export const DISPUTE_REASONS = ['PRICE', 'QUANTITY', 'QUALITY', 'NOT_RECEIVED', 'DUPLICATE', 'TAX', 'OTHER'] as const;
export type DisputeReason = (typeof DISPUTE_REASONS)[number];
export const DISPUTE_REASON_LABEL: Record<DisputeReason, string> = {
  PRICE: 'Price or rate',
  QUANTITY: 'Quantity',
  QUALITY: 'Quality or damage',
  NOT_RECEIVED: 'Not received',
  DUPLICATE: 'Billed twice',
  TAX: 'Tax',
  OTHER: 'Other',
};

export const DISPUTE_OUTCOMES = ['CREDIT_NOTE', 'CUSTOMER_PAYS', 'WRITTEN_OFF', 'WITHDRAWN'] as const;
export type DisputeOutcome = (typeof DISPUTE_OUTCOMES)[number];
export const DISPUTE_OUTCOME_LABEL: Record<DisputeOutcome, string> = {
  CREDIT_NOTE: 'Credit note issued',
  CUSTOMER_PAYS: 'Invoice stands, customer pays',
  WRITTEN_OFF: 'Written off',
  WITHDRAWN: 'Withdrawn by the customer',
};

export const disputeRef = (n: number) => `DS-${String(n).padStart(4, '0')}`;

/** What is wrong with a dispute about to be raised (or changed) on an invoice with `open` still due. */
export function disputeIssues(p: { amount: string; open: string; currency: string; description: string; targetDate?: string | null; today: string }): string[] {
  const issues: string[] = [];
  if (!p.description.trim()) issues.push('Say what the customer disputes');
  if (p.targetDate && p.targetDate < p.today) issues.push('The target date cannot be in the past');
  let a: Dec;
  try {
    a = dec(p.amount);
  } catch {
    return [...issues, `${p.amount} is not an amount`];
  }
  if (a.lte(0)) issues.push('The disputed amount must be more than zero');
  else if (a.gt(dec(p.open))) issues.push(`The disputed amount is more than the ${dec(p.open).toFixed(minorUnits(p.currency))} ${p.currency} still due on the invoice`);
  else if (a.decimalPlaces() > minorUnits(p.currency)) issues.push(`${p.amount} has more decimals than ${p.currency} allows`);
  return issues;
}

/**
 * What is wrong with a resolution. A credit-note outcome names the credit note (posted, same
 * customer, same currency, dated on or after the invoice); `creditNote` carries its facts.
 */
export function resolutionIssues(p: {
  outcome: DisputeOutcome;
  note: string;
  creditNote?: { status: string; contactMatches: boolean; currencyMatches: boolean } | null;
}): string[] {
  const issues: string[] = [];
  if (!p.note.trim()) issues.push('Say how the dispute was settled');
  if (p.outcome === 'CREDIT_NOTE') {
    if (!p.creditNote) issues.push('Choose the credit note that settles the dispute');
    else {
      if (p.creditNote.status !== 'POSTED') issues.push('The credit note must be posted');
      if (!p.creditNote.contactMatches) issues.push('The credit note is for a different customer');
      if (!p.creditNote.currencyMatches) issues.push('The credit note is in a different currency');
    }
  } else if (p.creditNote) issues.push('Only a credit-note outcome takes a credit note');
  return issues;
}

/** Days a dispute has been open (to `today`) or took to resolve. */
export function disputeAge(openedOn: string, resolvedOn: string | null, today: string): number {
  return Math.max(0, daysBetween(openedOn, resolvedOn ?? today));
}

export interface DisputeSummaryRow {
  status: 'OPEN' | 'RESOLVED';
  amount: string;
  openedOn: string;
  resolvedOn: string | null;
  targetDate: string | null;
  outcome: DisputeOutcome | null;
}

/** Totals for the disputes page: what is open, how old, how long disputes take, how they end. */
export function disputeSummary(rows: DisputeSummaryRow[], today: string, currency: string) {
  const scale = minorUnits(currency);
  const open = rows.filter((r) => r.status === 'OPEN');
  const resolved = rows.filter((r) => r.status === 'RESOLVED');
  const outcomes = Object.fromEntries(DISPUTE_OUTCOMES.map((o) => [o, resolved.filter((r) => r.outcome === o).length])) as Record<DisputeOutcome, number>;
  return {
    open: open.length,
    openAmount: open.reduce((s, r) => s.plus(dec(r.amount)), new D(0)).toFixed(scale),
    pastTarget: open.filter((r) => r.targetDate != null && r.targetDate < today).length,
    oldestOpenDays: open.length ? Math.max(...open.map((r) => disputeAge(r.openedOn, null, today))) : null,
    resolved: resolved.length,
    averageDaysToResolve: resolved.length ? Math.round(resolved.reduce((t, r) => t + disputeAge(r.openedOn, r.resolvedOn, today), 0) / resolved.length) : null,
    outcomes,
  };
}
