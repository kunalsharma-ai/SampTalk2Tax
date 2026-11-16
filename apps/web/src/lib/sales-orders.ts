import type { DealStage, OrderBilling, QuoteState, QuoteStatus } from '@talk2tax/accounting-engine';

export type { OrderBilling, QuoteState, QuoteStatus };

export interface SalesContact { id: string; name: string; email: string | null; gstin: string | null }
export interface SalesDealRef { id: string; reference: string; name: string; stage: DealStage }

export interface SalesLine {
  id: string;
  lineNo: number;
  description: string | null;
  account: { id: string; code: string; name: string } | null;
  quantity: string;
  unitPrice: string;
  tax: { id: string; name: string; rate: string } | null;
  hsnCode: string | null;
  netAmount: string;
  taxAmount: string;
}

export interface Quote {
  id: string;
  reference: string;
  number: number;
  revision: number;
  status: QuoteStatus;
  state: QuoteState;
  contact: SalesContact | null;
  deal: SalesDealRef | null;
  issueDate: string;
  validUntil: string;
  placeOfSupply: string | null;
  customerReference: string | null;
  terms: string | null;
  memo: string | null;
  currency: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  sentAt: string | null;
  decidedAt: string | null;
  declineReason: string | null;
  orderId: string | null;
  createdAt: string;
}

export interface QuoteList {
  quotes: Quote[];
  totals: { drafts: number; awaiting: { count: number; total: string }; expired: number; accepted: { count: number; total: string }; acceptanceRate: number | null };
  can: { manage: boolean };
}

export interface QuoteDetail extends Quote {
  lines: SalesLine[];
  revisions: { id: string; reference: string; state: QuoteState; total: string }[];
  order: { id: string; reference: string } | null;
  can: { manage: boolean };
}

export interface Order {
  id: string;
  reference: string;
  contact: SalesContact | null;
  deal: SalesDealRef | null;
  quoteId: string | null;
  orderDate: string;
  placeOfSupply: string | null;
  customerReference: string | null;
  memo: string | null;
  currency: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  toBill: string;
  status: 'OPEN' | 'CANCELLED';
  billing: OrderBilling;
  cancelReason: string | null;
  cancelledAt: string | null;
  createdAt: string;
}

export interface OrderList { orders: Order[]; totals: { open: number; toBill: string }; can: { manage: boolean } }

export interface OrderDetail extends Order {
  lines: (SalesLine & { billed: string; remaining: string })[];
  quote: { id: string; reference: string } | null;
  invoices: { id: string; number: string | null; status: string; issueDate: string; total: string; lines: { lineNo: number; quantity: string }[] }[];
  can: { manage: boolean; cancel: boolean };
}

/** What the quotation and order forms send. */
export interface SalesLineInput { accountId: string; description: string | null; quantity: string; unitPrice: string; taxRateId: string | null; hsnCode: string | null }
