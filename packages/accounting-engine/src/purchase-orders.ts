/**
 * Purchase orders, goods receipts and bill matching (AP-015, AP-016, AP-017).
 *
 * A purchase order records what was ordered from a vendor and at what price. Goods receipts record
 * what arrived. A bill whose lines point at order lines is matched before it posts: two-way
 * matching compares the bill with the order (price and quantity ordered); three-way matching also
 * compares it with what was received. A bill with a difference beyond the order's tolerances is an
 * exception: it posts only after someone records why it is accepted.
 */
import { D, Dec } from './money';

export type PurchaseOrderStatus = 'DRAFT' | 'ISSUED' | 'CLOSED' | 'CANCELLED';
export type PurchaseOrderState = 'DRAFT' | 'ISSUED' | 'PARTLY_RECEIVED' | 'RECEIVED' | 'BILLED' | 'CLOSED' | 'CANCELLED';
export type PurchaseOrderAction = 'EDIT' | 'DELETE' | 'ISSUE' | 'RECEIVE' | 'BILL' | 'CLOSE' | 'CANCEL';
export type MatchMode = 'TWO_WAY' | 'THREE_WAY';

export const PURCHASE_ORDER_STATE_LABEL: Record<PurchaseOrderState, string> = {
  DRAFT: 'Draft',
  ISSUED: 'Issued',
  PARTLY_RECEIVED: 'Partly received',
  RECEIVED: 'Received',
  BILLED: 'Billed',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',
};

export const MATCH_MODE_LABEL: Record<MatchMode, string> = {
  TWO_WAY: 'Two-way (bill against order)',
  THREE_WAY: 'Three-way (bill against order and goods received)',
};

export const purchaseOrderRef = (n: number) => `PO-${String(n).padStart(4, '0')}`;
export const goodsReceiptRef = (n: number) => `GRN-${String(n).padStart(4, '0')}`;

export class PurchaseOrderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface PoLineProgress {
  quantity: string;
  /** Received on goods receipts that are not cancelled. */
  received: string;
  /** On bills that are not void (drafts count: what they bill is reserved). */
  billed: string;
}

const dec = (s: string | Dec) => new D(s.toString());

/** Where an order stands, from its stored status and its lines' progress. */
export function purchaseOrderState(status: PurchaseOrderStatus, mode: MatchMode, lines: PoLineProgress[]): PurchaseOrderState {
  if (status !== 'ISSUED') return status;
  if (lines.length && lines.every((l) => dec(l.billed).gte(l.quantity))) return 'BILLED';
  if (mode === 'TWO_WAY') return 'ISSUED';
  const received = lines.filter((l) => dec(l.received).gt(0));
  if (!received.length) return 'ISSUED';
  return lines.every((l) => dec(l.received).gte(l.quantity)) ? 'RECEIVED' : 'PARTLY_RECEIVED';
}

/** Throws PurchaseOrderError when `action` is not allowed in `state`. */
export function purchaseOrderAllows(state: PurchaseOrderState, action: PurchaseOrderAction): void {
  const live: PurchaseOrderState[] = ['ISSUED', 'PARTLY_RECEIVED', 'RECEIVED', 'BILLED'];
  const ok: Record<PurchaseOrderAction, PurchaseOrderState[]> = {
    EDIT: ['DRAFT'],
    DELETE: ['DRAFT'],
    ISSUE: ['DRAFT'],
    // A billed order can still receive goods (bills sometimes arrive before the goods).
    RECEIVE: live,
    BILL: ['ISSUED', 'PARTLY_RECEIVED', 'RECEIVED'],
    CLOSE: live,
    CANCEL: ['ISSUED'],
  };
  if (ok[action].includes(state)) return;
  const why: Record<PurchaseOrderState, string> = {
    DRAFT: 'This purchase order is still a draft; issue it to the vendor first',
    ISSUED: 'This purchase order is issued; its lines can no longer change',
    PARTLY_RECEIVED: action === 'CANCEL' ? 'Goods are received against this order; close it instead of cancelling' : 'This purchase order is issued; its lines can no longer change',
    RECEIVED: action === 'CANCEL' ? 'Goods are received against this order; close it instead of cancelling' : 'This purchase order is issued; its lines can no longer change',
    BILLED: action === 'BILL' ? 'Everything on this order is billed' : action === 'CANCEL' ? 'This order is billed; close it instead of cancelling' : 'This purchase order is issued; its lines can no longer change',
    CLOSED: 'This purchase order is closed',
    CANCELLED: 'This purchase order is cancelled',
  };
  throw new PurchaseOrderError('PURCHASE_ORDER_STATE', why[state]);
}

/** Quantity of a line still to bill: what was received (three-way) or ordered (two-way), less what is billed. */
export function quantityToBill(mode: MatchMode, l: PoLineProgress): string {
  const basis = mode === 'THREE_WAY' ? dec(l.received) : dec(l.quantity);
  const left = basis.minus(l.billed);
  return (left.gt(0) ? left : new D(0)).toFixed();
}

/** Quantity of a line still to receive. */
export function quantityToReceive(l: PoLineProgress): string {
  const left = dec(l.quantity).minus(l.received);
  return (left.gt(0) ? left : new D(0)).toFixed();
}

/** Most that may be received or billed against `quantity` with a tolerance in percent. */
export function withTolerance(quantity: string | Dec, tolerancePercent: string | Dec): Dec {
  return dec(quantity).times(dec(tolerancePercent).div(100).plus(1));
}

/**
 * Problems with a goods receipt, as sentences; empty when it can be recorded. Receiving more than
 * ordered is refused beyond the order's quantity tolerance.
 */
export function receiptIssues(
  lines: { id: string; lineNo: number; quantity: string; received: string }[],
  request: { orderLineId: string; quantity: string; rejected?: string | null }[],
  quantityTolerancePercent: string,
): string[] {
  const issues: string[] = [];
  if (!request.length) issues.push('Enter the quantity received on at least one line');
  const seen = new Set<string>();
  for (const r of request) {
    const l = lines.find((x) => x.id === r.orderLineId);
    if (!l) {
      issues.push('A received line is not on this purchase order');
      continue;
    }
    if (seen.has(l.id)) issues.push(`Line ${l.lineNo} is entered twice`);
    seen.add(l.id);
    const q = dec(r.quantity);
    const rej = dec(r.rejected || '0');
    if (q.lt(0) || rej.lt(0)) issues.push(`Line ${l.lineNo}: quantities cannot be negative`);
    if (q.isZero() && rej.isZero()) issues.push(`Line ${l.lineNo}: enter the quantity accepted or rejected`);
    if (q.decimalPlaces() > 6 || rej.decimalPlaces() > 6) issues.push(`Line ${l.lineNo}: use at most 6 decimal places`);
    const most = withTolerance(l.quantity, quantityTolerancePercent);
    if (dec(l.received).plus(q).gt(most)) {
      const left = most.minus(l.received);
      issues.push(`Line ${l.lineNo}: only ${(left.gt(0) ? left : new D(0)).toFixed()} more can be received (ordered ${dec(l.quantity).toFixed()}, received ${dec(l.received).toFixed()})`);
    }
  }
  return issues;
}

export type MatchCode = 'NOT_ON_ORDER' | 'PRICE_ABOVE_ORDER' | 'MORE_THAN_ORDERED' | 'MORE_THAN_RECEIVED' | 'ORDER_NOT_OPEN';

export interface MatchBillLine {
  lineNo: number;
  description?: string | null;
  quantity: string;
  unitPrice: string;
  /** Null when the bill line is not for an order line (for example freight added by the vendor). */
  order: {
    lineNo: number;
    quantity: string;
    unitPrice: string;
    received: string;
    /** Billed on other bills that are not void. */
    billedElsewhere: string;
  } | null;
}

export interface MatchLineResult {
  lineNo: number;
  orderLineNo: number | null;
  quantity: string;
  unitPrice: string;
  ordered: string | null;
  orderPrice: string | null;
  received: string | null;
  billedElsewhere: string | null;
  status: 'MATCHED' | 'EXCEPTION';
  exceptions: { code: MatchCode; message: string }[];
}

export interface MatchResult {
  status: 'MATCHED' | 'EXCEPTION';
  mode: MatchMode;
  lines: MatchLineResult[];
  /** Stable text of the exceptions, so an acceptance applies only to the differences it was given for. */
  fingerprint: string;
}

/**
 * Match a bill against its purchase order (and goods received, three-way). Several bill lines can
 * bill one order line: their quantities add up in line order.
 */
export function matchBill(input: {
  mode: MatchMode;
  priceTolerancePercent: string;
  quantityTolerancePercent: string;
  orderOpen: boolean;
  lines: MatchBillLine[];
}): MatchResult {
  const running = new Map<number, Dec>();
  const lines: MatchLineResult[] = input.lines.map((l) => {
    const exceptions: MatchLineResult['exceptions'] = [];
    const o = l.order;
    if (!o) {
      exceptions.push({ code: 'NOT_ON_ORDER', message: `Line ${l.lineNo} is not on the purchase order` });
    } else {
      const before = running.get(o.lineNo) ?? dec(o.billedElsewhere);
      const total = before.plus(l.quantity);
      running.set(o.lineNo, total);
      if (!input.orderOpen) exceptions.push({ code: 'ORDER_NOT_OPEN', message: 'The purchase order is closed or cancelled' });
      const priceLimit = withTolerance(o.unitPrice, input.priceTolerancePercent);
      if (dec(l.unitPrice).gt(priceLimit)) {
        exceptions.push({ code: 'PRICE_ABOVE_ORDER', message: `Line ${l.lineNo}: price ${dec(l.unitPrice).toFixed()} is above the order price ${dec(o.unitPrice).toFixed()}` });
      }
      if (total.gt(withTolerance(o.quantity, input.quantityTolerancePercent))) {
        exceptions.push({ code: 'MORE_THAN_ORDERED', message: `Line ${l.lineNo}: billing ${total.toFixed()} in all against ${dec(o.quantity).toFixed()} ordered` });
      }
      if (input.mode === 'THREE_WAY' && total.gt(withTolerance(o.received, input.quantityTolerancePercent))) {
        exceptions.push({ code: 'MORE_THAN_RECEIVED', message: `Line ${l.lineNo}: billing ${total.toFixed()} in all against ${dec(o.received).toFixed()} received` });
      }
    }
    return {
      lineNo: l.lineNo,
      orderLineNo: o?.lineNo ?? null,
      quantity: dec(l.quantity).toFixed(),
      unitPrice: dec(l.unitPrice).toFixed(),
      ordered: o ? dec(o.quantity).toFixed() : null,
      orderPrice: o ? dec(o.unitPrice).toFixed() : null,
      received: o ? dec(o.received).toFixed() : null,
      billedElsewhere: o ? dec(o.billedElsewhere).toFixed() : null,
      status: exceptions.length ? 'EXCEPTION' : 'MATCHED',
      exceptions,
    };
  });
  const all = lines.flatMap((l) => l.exceptions.map((e) => e.message));
  return { status: all.length ? 'EXCEPTION' : 'MATCHED', mode: input.mode, lines, fingerprint: all.join('\n') };
}

/** Problems with an order's tolerances, as sentences. */
export function toleranceIssues(t: { priceTolerancePercent: string; quantityTolerancePercent: string }): string[] {
  const issues: string[] = [];
  for (const [label, v] of [
    ['Price tolerance', t.priceTolerancePercent],
    ['Quantity tolerance', t.quantityTolerancePercent],
  ] as const) {
    const n = dec(v);
    if (n.lt(0) || n.gt(100)) issues.push(`${label} must be between 0 and 100 percent`);
    if (n.decimalPlaces() > 2) issues.push(`${label} uses at most 2 decimal places`);
  }
  return issues;
}
