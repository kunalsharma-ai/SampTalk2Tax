import type { MatchMode, PurchaseOrderState, PurchaseOrderStatus } from '@talk2tax/accounting-engine';
import type { SalesContact, SalesLine } from './sales-orders';

export type { MatchMode, PurchaseOrderState, PurchaseOrderStatus };

export interface PurchaseOrderLine extends SalesLine {
  received: string;
  billed: string;
  toReceive: string;
  toBill: string;
}

export interface PurchaseOrder {
  id: string;
  reference: string;
  status: PurchaseOrderStatus;
  state: PurchaseOrderState;
  contact: SalesContact | null;
  orderDate: string;
  expectedDate: string | null;
  late: boolean;
  placeOfSupply: string | null;
  vendorReference: string | null;
  terms: string | null;
  memo: string | null;
  currency: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  matchMode: MatchMode;
  priceTolerancePercent: string;
  quantityTolerancePercent: string;
  toBill: string;
  toReceive: string;
  issuedAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
}

export interface PurchaseOrderList {
  orders: PurchaseOrder[];
  totals: { open: number; drafts: number; late: number; toReceive: string; toBill: string };
  can: { manage: boolean; acceptDifferences: boolean };
}

export interface GoodsReceipt {
  id: string;
  reference: string;
  receiptDate: string;
  deliveryNote: string | null;
  memo: string | null;
  status: 'RECORDED' | 'CANCELLED';
  cancelledAt: string | null;
  cancelReason: string | null;
  recordedBy: string | null;
  createdAt: string;
  lines: { orderLineId: string; lineNo: number; quantity: string; rejected: string; note: string | null }[];
}

export type BillMatchStatus = 'MATCHED' | 'ACCEPTED' | 'EXCEPTION';

export interface PurchaseOrderDetail extends PurchaseOrder {
  lines: PurchaseOrderLine[];
  receipts: GoodsReceipt[];
  bills: { id: string; number: string | null; status: 'DRAFT' | 'POSTED' | 'VOID'; issueDate: string; vendorInvoice: string | null; total: string; match: BillMatchStatus | null }[];
  can: { manage: boolean; acceptDifferences: boolean };
}

export type MatchCode = 'NOT_ON_ORDER' | 'PRICE_ABOVE_ORDER' | 'MORE_THAN_ORDERED' | 'MORE_THAN_RECEIVED' | 'ORDER_NOT_OPEN';

export interface BillMatch {
  match: {
    status: 'MATCHED' | 'EXCEPTION';
    mode: MatchMode;
    order: { id: string; reference: string; status: PurchaseOrderStatus; matchMode: MatchMode; priceTolerancePercent: string; quantityTolerancePercent: string };
    lines: {
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
    }[];
    accepted: { reason: string; acceptedBy: string | null; acceptedAt: string } | null;
    acceptances: { reason: string; acceptedBy: string | null; acceptedAt: string }[];
  } | null;
  documentStatus?: 'DRAFT' | 'POSTED' | 'VOID';
  can: { manage: boolean; acceptDifferences: boolean };
}
