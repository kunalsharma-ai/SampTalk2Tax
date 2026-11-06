import { D } from './money';

/**
 * Quotations and sales orders (CRM slice 2). A quotation is offered to a customer and valid until
 * a date; accepting it turns it into a sales order, which is then billed by one or more invoices,
 * in full or in parts. These are the rules the server applies and the web shows.
 *
 * Quotation: DRAFT (editable) → SENT (fixed) → ACCEPTED or DECLINED. A sent quotation past its
 * valid-until date reads as EXPIRED and cannot be accepted. Revising a sent, expired or declined
 * quotation makes a draft revision with the same number; sending that revision marks the one
 * before it SUPERSEDED.
 *
 * Sales order: OPEN until every line is billed, or CANCELLED (with a reason) while nothing on it
 * is billed. Billing never exceeds an order line's quantity.
 */

export const QUOTE_STATUSES = ['DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'SUPERSEDED'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];
/** What a quotation shows: its stored status, or EXPIRED for a sent one past its date. */
export type QuoteState = QuoteStatus | 'EXPIRED';
export const QUOTE_STATE_LABEL: Record<QuoteState, string> = { DRAFT: 'Draft', SENT: 'Sent', ACCEPTED: 'Accepted', DECLINED: 'Declined', SUPERSEDED: 'Superseded', EXPIRED: 'Expired' };

export type OrderStatus = 'OPEN' | 'CANCELLED';
export type OrderBilling = 'NOT_BILLED' | 'PARTLY_BILLED' | 'BILLED';
export const ORDER_BILLING_LABEL: Record<OrderBilling, string> = { NOT_BILLED: 'Not billed', PARTLY_BILLED: 'Partly billed', BILLED: 'Billed' };

export class SalesOrderError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function quoteState(status: QuoteStatus, validUntil: string, today: string): QuoteState {
  return status === 'SENT' && validUntil < today ? 'EXPIRED' : status;
}

type QuoteAction = 'EDIT' | 'SEND' | 'ACCEPT' | 'DECLINE' | 'REVISE';

/** Whether an action is allowed on a quotation in its current state; throws with a reason if not. */
export function quoteAllows(status: QuoteStatus, validUntil: string, today: string, action: QuoteAction): void {
  const s = quoteState(status, validUntil, today);
  const no = (code: string, message: string): never => {
    throw new SalesOrderError(code, message);
  };
  switch (action) {
    case 'EDIT':
      if (s !== 'DRAFT') no('QUOTE_NOT_DRAFT', 'Only a draft quotation can be changed; revise it to make a new version');
      return;
    case 'SEND':
      if (s !== 'DRAFT') no('QUOTE_NOT_DRAFT', 'Only a draft quotation can be marked sent');
      if (validUntil < today) no('QUOTE_EXPIRED', 'Set a valid-until date from today before sending');
      return;
    case 'ACCEPT':
      if (s === 'EXPIRED') no('QUOTE_EXPIRED', 'This quotation has expired; revise it with a new date');
      if (s !== 'SENT') no('QUOTE_NOT_SENT', s === 'DRAFT' ? 'Mark the quotation sent before recording the answer' : `This quotation is ${QUOTE_STATE_LABEL[s].toLowerCase()}`);
      return;
    case 'DECLINE':
      if (s !== 'SENT' && s !== 'EXPIRED') no('QUOTE_NOT_SENT', s === 'DRAFT' ? 'Mark the quotation sent before recording the answer' : `This quotation is ${QUOTE_STATE_LABEL[s].toLowerCase()}`);
      return;
    case 'REVISE':
      if (s !== 'SENT' && s !== 'EXPIRED' && s !== 'DECLINED') no('QUOTE_NOT_REVISABLE', s === 'DRAFT' ? 'Edit the draft instead' : `A ${QUOTE_STATE_LABEL[s].toLowerCase()} quotation cannot be revised`);
      return;
  }
}

export interface OrderLineBilling {
  quantity: string;
  billed: string;
}

/** What is left to bill on a line (never negative). */
export function remainingToBill(l: OrderLineBilling): string {
  const r = new D(l.quantity).minus(l.billed);
  return (r.isNegative() ? new D(0) : r).toFixed();
}

/** An order's billing state from its lines. */
export function orderBilling(lines: OrderLineBilling[]): OrderBilling {
  const billed = lines.filter((l) => new D(l.billed).gt(0));
  if (!billed.length) return 'NOT_BILLED';
  return lines.every((l) => new D(l.billed).gte(l.quantity)) ? 'BILLED' : 'PARTLY_BILLED';
}

/**
 * Check a billing request against an order: each quantity positive, at most what is left on its
 * line, each line once. Returns the problems found (empty when fine).
 */
export function billingIssues(lines: (OrderLineBilling & { id: string; lineNo: number })[], request: { orderLineId: string; quantity: string }[]): string[] {
  const issues: string[] = [];
  if (!request.length) issues.push('Choose at least one line to bill');
  const seen = new Set<string>();
  for (const r of request) {
    const l = lines.find((x) => x.id === r.orderLineId);
    if (!l) {
      issues.push('A line to bill is not on this order');
      continue;
    }
    if (seen.has(r.orderLineId)) issues.push(`Line ${l.lineNo} is listed twice`);
    seen.add(r.orderLineId);
    const q = new D(r.quantity);
    const left = new D(remainingToBill(l));
    if (q.lte(0)) issues.push(`Line ${l.lineNo}: bill a quantity above 0`);
    else if (q.gt(left)) issues.push(`Line ${l.lineNo}: only ${left.toFixed()} left to bill`);
  }
  return issues;
}
