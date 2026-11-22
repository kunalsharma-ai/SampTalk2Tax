import { daysBetween } from './documents';
import { D, Dec } from './money';
import type { MatchCode, MatchLineResult } from './purchase-orders';
import { formatAmountText, formatDateText } from './workflows';

/**
 * Automated exception investigation (AP-035). A draft bill that does not match its purchase order
 * (AP-017) cannot post until it is corrected or an approver accepts the differences. For each
 * difference this works out the likely cause from the order, the goods received and the vendor's
 * other bills, what to do next, and how much is at stake. Deterministic and explained: every cause
 * names what it compared, and nothing changes the bill.
 *
 * - Billed more than received: when what is billed can still arrive on the order, the goods are
 *   probably not received (or not entered) yet; otherwise the vendor billed more than delivered.
 * - Billed more than ordered: another bill of the same vendor on the same order line with the same
 *   quantity and price, or with the same vendor invoice number, makes a duplicate likely.
 * - Price above the order: when another posted bill of the vendor since the order date charged
 *   more than the order price for the same item, the vendor's price has probably gone up;
 *   otherwise the invoice is probably wrong.
 * - Line not on the order: a line that names an item on the order is probably just not linked to
 *   it; one that reads as freight, delivery and the like is an extra charge to confirm.
 */

export const EXCEPTION_CAUSES = [
  'POSSIBLE_DUPLICATE',
  'BILLED_MORE_THAN_DELIVERED',
  'BILLED_MORE_THAN_ORDERED',
  'PRICE_DIFFERENCE',
  'NOT_ORDERED',
  'LINE_NOT_LINKED',
  'AWAITING_DELIVERY',
  'ORDER_NOT_OPEN',
  'VENDOR_PRICE_RISE',
  'EXTRA_CHARGE',
] as const;
export type ExceptionCause = (typeof EXCEPTION_CAUSES)[number];
export const EXCEPTION_CAUSE_LABEL: Record<ExceptionCause, string> = {
  POSSIBLE_DUPLICATE: 'May repeat an earlier bill',
  BILLED_MORE_THAN_DELIVERED: 'Billed for more than was delivered',
  BILLED_MORE_THAN_ORDERED: 'Billed for more than was ordered',
  PRICE_DIFFERENCE: 'Price differs from the order',
  NOT_ORDERED: 'Item not on the order',
  LINE_NOT_LINKED: 'Line not linked to the order',
  AWAITING_DELIVERY: 'Goods not received yet',
  ORDER_NOT_OPEN: 'Order closed or cancelled',
  VENDOR_PRICE_RISE: "Vendor's price has gone up",
  EXTRA_CHARGE: 'Extra charge not on the order',
};

/** Next steps, most pressing first: the first one found on a bill is its next step. */
export const EXCEPTION_ACTIONS = ['VOID_DUPLICATE', 'ASK_CREDIT_NOTE', 'ASK_CORRECTION', 'LINK_LINE', 'RECORD_RECEIPT', 'CHECK_ORDER', 'CONFIRM_PRICE', 'CONFIRM_CHARGE'] as const;
export type ExceptionAction = (typeof EXCEPTION_ACTIONS)[number];
export const EXCEPTION_ACTION_LABEL: Record<ExceptionAction, string> = {
  VOID_DUPLICATE: 'Check for a duplicate and delete it',
  ASK_CREDIT_NOTE: 'Ask the vendor to bill only what was supplied',
  ASK_CORRECTION: 'Ask the vendor for a corrected invoice',
  LINK_LINE: 'Link the line to the order',
  RECORD_RECEIPT: 'Record the goods received, then post',
  CHECK_ORDER: 'Check the order before posting',
  CONFIRM_PRICE: 'Confirm the new price, then accept it',
  CONFIRM_CHARGE: 'Confirm the charge, then accept it',
};
const ACTION_OF: Record<ExceptionCause, ExceptionAction> = {
  POSSIBLE_DUPLICATE: 'VOID_DUPLICATE',
  BILLED_MORE_THAN_DELIVERED: 'ASK_CREDIT_NOTE',
  BILLED_MORE_THAN_ORDERED: 'ASK_CREDIT_NOTE',
  PRICE_DIFFERENCE: 'ASK_CORRECTION',
  NOT_ORDERED: 'ASK_CORRECTION',
  LINE_NOT_LINKED: 'LINK_LINE',
  AWAITING_DELIVERY: 'RECORD_RECEIPT',
  ORDER_NOT_OPEN: 'CHECK_ORDER',
  VENDOR_PRICE_RISE: 'CONFIRM_PRICE',
  EXTRA_CHARGE: 'CONFIRM_CHARGE',
};
/** Next steps after which an approver would accept the differences rather than change the bill. */
const ACCEPTABLE: ExceptionAction[] = ['CONFIRM_PRICE', 'CONFIRM_CHARGE'];

const CHARGE = /\b(freight|delivery|shipping|transport|transportation|courier|carriage|cartage|handling|loading|unloading|insurance|postage)\b/i;

export interface ExceptionBillLine extends MatchLineResult {
  description: string | null;
}

export interface ExceptionBill {
  id: string;
  number: string;
  /** The vendor's invoice number. */
  reference: string | null;
  issueDate: string;
  currency: string;
  order: { reference: string; status: string; orderDate: string; lines: { lineNo: number; description: string | null; quantity: string; unitPrice: string; received: string }[] };
  lines: ExceptionBillLine[];
}

/** The vendor's other bills (not void) that the investigation compares with. */
export interface RelatedBill {
  id: string;
  number: string;
  reference: string | null;
  issueDate: string;
  status: string;
  sameOrder: boolean;
  lines: { orderLineNo: number | null; description: string | null; quantity: string; unitPrice: string }[];
}

export interface ExceptionFinding {
  /** Null for the order as a whole. */
  lineNo: number | null;
  code: MatchCode;
  cause: ExceptionCause;
  causeLabel: string;
  action: ExceptionAction;
  actionLabel: string;
  explanation: string;
  /** In the bill's currency. */
  amount: string;
  evidence: { id: string; number: string }[];
}

export interface BillInvestigation {
  findings: ExceptionFinding[];
  /** The largest finding on each line, added up: what the differences come to. */
  atStake: string;
  nextAction: ExceptionAction;
  nextActionLabel: string;
  /** Every difference is one an approver would accept once confirmed. */
  acceptable: boolean;
  daysHeld: number;
}

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const refKey = (s: string | null | undefined) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const qty = (x: Dec) => x.toFixed();
const pctOf = (part: Dec, whole: Dec) => (whole.isZero() ? '0' : part.div(whole).times(100).toDecimalPlaces(1, D.ROUND_HALF_UP).toFixed());

/** The likely cause and next step for each difference between a bill and its purchase order. */
export function investigateBillExceptions(input: { bill: ExceptionBill; related: RelatedBill[]; today: string; scale: number }): BillInvestigation {
  const { bill, scale } = input;
  const money = (x: Dec) => formatAmountText(x.toFixed(scale), bill.currency);
  const findings: ExceptionFinding[] = [];
  const add = (lineNo: number | null, code: MatchCode, cause: ExceptionCause, explanation: string, amount: Dec, evidence: { id: string; number: string }[] = []) =>
    findings.push({ lineNo, code, cause, causeLabel: EXCEPTION_CAUSE_LABEL[cause], action: ACTION_OF[cause], actionLabel: EXCEPTION_ACTION_LABEL[ACTION_OF[cause]], explanation, amount: amount.toFixed(scale), evidence });
  const open = bill.order.status === 'ISSUED';
  const others = input.related.filter((r) => r.id !== bill.id && r.status !== 'VOID');
  // Quantities billed so far by order line, in line order, as the match counts them.
  const running = new Map<number, Dec>();

  for (const l of bill.lines) {
    const q = new D(l.quantity);
    const price = new D(l.unitPrice);
    const codes = new Set(l.exceptions.map((e) => e.code));
    let total = q;
    if (l.orderLineNo !== null) {
      total = (running.get(l.orderLineNo) ?? new D(l.billedElsewhere ?? 0)).plus(q);
      running.set(l.orderLineNo, total);
    }
    if (codes.has('NOT_ON_ORDER')) {
      const name = norm(l.description);
      const like = name.length >= 4 ? bill.order.lines.find((o) => { const n = norm(o.description); return n.length >= 4 && (n === name || n.includes(name) || name.includes(n)); }) : undefined;
      if (like) add(l.lineNo, 'NOT_ON_ORDER', 'LINE_NOT_LINKED', `Line ${l.lineNo} (${l.description}) looks like order line ${like.lineNo} (${like.description}) of ${bill.order.reference} but is not linked to it.`, q.times(price));
      else if (CHARGE.test(l.description ?? '')) add(l.lineNo, 'NOT_ON_ORDER', 'EXTRA_CHARGE', `Line ${l.lineNo} (${l.description}) is a charge that ${bill.order.reference} does not include; check that the order's terms allow it.`, q.times(price));
      else add(l.lineNo, 'NOT_ON_ORDER', 'NOT_ORDERED', `Line ${l.lineNo}${l.description ? ` (${l.description})` : ''} is for something not on ${bill.order.reference}.`, q.times(price));
      continue;
    }
    const ordered = new D(l.ordered ?? 0);
    const received = new D(l.received ?? 0);
    const orderPrice = new D(l.orderPrice ?? 0);

    if (codes.has('MORE_THAN_ORDERED')) {
      const over = D.min(q, total.minus(ordered));
      const me = refKey(bill.reference);
      const dup = others.find(
        (r) => (me && refKey(r.reference) === me) || (r.sameOrder && r.lines.some((x) => x.orderLineNo === l.orderLineNo && new D(x.quantity).eq(q) && new D(x.unitPrice).eq(price))),
      );
      if (dup) {
        const why = me && refKey(dup.reference) === me ? `has the same vendor invoice number (${dup.reference})` : `bills the same ${qty(q)} at ${money(price)} on order line ${l.orderLineNo}`;
        add(l.lineNo, 'MORE_THAN_ORDERED', 'POSSIBLE_DUPLICATE', `${dup.number} of ${formatDateText(dup.issueDate)} ${why}; with this bill ${qty(total)} would be billed against ${qty(ordered)} ordered.`, q.times(price), [{ id: dup.id, number: dup.number }]);
      } else {
        add(l.lineNo, 'MORE_THAN_ORDERED', 'BILLED_MORE_THAN_ORDERED', `Line ${l.lineNo}: ${qty(total)} billed in all against ${qty(ordered)} ordered on ${bill.order.reference}; ${qty(over)} more than ordered.`, over.times(price));
      }
    }
    if (codes.has('MORE_THAN_RECEIVED') && !codes.has('MORE_THAN_ORDERED')) {
      const short = D.min(q, total.minus(received));
      const due = D.max(ordered.minus(received), new D(0));
      if (open && due.gte(short)) {
        const age = daysBetween(bill.issueDate, input.today);
        add(l.lineNo, 'MORE_THAN_RECEIVED', 'AWAITING_DELIVERY', `Line ${l.lineNo}: ${qty(short)} of what is billed is not received yet, and ${qty(due)} more are still due on ${bill.order.reference} (ordered ${qty(ordered)}, received ${qty(received)}). The goods may not have arrived or their receipt may not be recorded${age > 30 ? `; the bill is ${age} days old` : ''}.`, short.times(price)); // not money: age is days
      } else {
        add(l.lineNo, 'MORE_THAN_RECEIVED', 'BILLED_MORE_THAN_DELIVERED', `Line ${l.lineNo}: ${qty(total)} billed in all against ${qty(received)} received${open ? `, and only ${qty(due)} more can still arrive on ${bill.order.reference}` : ` on ${bill.order.reference}, which is no longer open`}.`, short.times(price));
      }
    }
    if (codes.has('PRICE_ABOVE_ORDER')) {
      const diff = price.minus(orderPrice);
      const names = new Set([norm(l.description), norm(bill.order.lines.find((o) => o.lineNo === l.orderLineNo)?.description)].filter((n) => n.length >= 3));
      const seen = others
        .filter((r) => r.status === 'POSTED' && r.issueDate >= bill.order.orderDate)
        .flatMap((r) => r.lines.filter((x) => names.has(norm(x.description)) && new D(x.unitPrice).gt(orderPrice)).map((x) => ({ r, price: new D(x.unitPrice) })))
        .sort((a, b) => b.r.issueDate.localeCompare(a.r.issueDate) || b.price.comparedTo(a.price));
      const top = seen[0];
      if (top) {
        add(l.lineNo, 'PRICE_ABOVE_ORDER', 'VENDOR_PRICE_RISE', `Line ${l.lineNo}: ${money(price)} against the order price of ${money(orderPrice)} (${pctOf(diff, orderPrice)}% more). ${top.r.number} of ${formatDateText(top.r.issueDate)} also charged ${money(top.price)}, so the vendor's price seems to have gone up since the order of ${formatDateText(bill.order.orderDate)}.`, diff.times(q), [{ id: top.r.id, number: top.r.number }]);
      } else {
        add(l.lineNo, 'PRICE_ABOVE_ORDER', 'PRICE_DIFFERENCE', `Line ${l.lineNo}: ${money(price)} against the order price of ${money(orderPrice)} (${pctOf(diff, orderPrice)}% more), and no other bill from the vendor since the order charged more.`, diff.times(q));
      }
    }
  }
  if (bill.lines.some((l) => l.exceptions.some((e) => e.code === 'ORDER_NOT_OPEN'))) {
    add(null, 'ORDER_NOT_OPEN', 'ORDER_NOT_OPEN', `${bill.order.reference} is ${bill.order.status === 'CANCELLED' ? 'cancelled' : 'closed'}, so nothing more should be billed on it.`, new D(0));
  }

  const perLine = new Map<number, Dec>();
  for (const f of findings) if (f.lineNo !== null) perLine.set(f.lineNo, D.max(perLine.get(f.lineNo) ?? new D(0), new D(f.amount)));
  const atStake = [...perLine.values()].reduce((s, x) => s.plus(x), new D(0));
  const actions = new Set(findings.map((f) => f.action));
  const nextAction = EXCEPTION_ACTIONS.find((a) => actions.has(a)) ?? 'CHECK_ORDER';
  return {
    findings: findings.sort((a, b) => EXCEPTION_ACTIONS.indexOf(a.action) - EXCEPTION_ACTIONS.indexOf(b.action) || (a.lineNo ?? 0) - (b.lineNo ?? 0)),
    atStake: atStake.toFixed(scale),
    nextAction,
    nextActionLabel: EXCEPTION_ACTION_LABEL[nextAction],
    acceptable: findings.length > 0 && findings.every((f) => ACCEPTABLE.includes(f.action)),
    daysHeld: Math.max(0, daysBetween(bill.issueDate, input.today)), // not money: days
  };
}
