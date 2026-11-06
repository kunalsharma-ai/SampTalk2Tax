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

export type ContractStatus = 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ENDED' | 'CANCELLED';
export type ContractFrequency = 'MONTHLY' | 'QUARTERLY' | 'HALF_YEARLY' | 'YEARLY';

export interface Contract {
  id: string;
  reference: string;
  title: string;
  status: ContractStatus;
  contact: SalesContact | null;
  deal: SalesDealRef | null;
  frequency: ContractFrequency;
  timing: 'ADVANCE' | 'ARREARS';
  startDate: string;
  endDate: string | null;
  autoRenew: boolean;
  renewalMonths: number | null;
  noticeDays: number;
  paymentTermsDays: number | null;
  placeOfSupply: string | null;
  customerReference: string | null;
  memo: string | null;
  currency: string;
  subtotal: string;
  taxTotal: string;
  total: string;
  monthlyValue: string;
  renewal: 'ROLLING' | 'RUNNING' | 'RENEWAL_DUE' | 'PAST_END' | null;
  nextBill: { periodNo: number; date: string; start: string; end: string } | null;
  periodsBilled: number;
  lastError: string | null;
  lastErrorAt: string | null;
  activatedAt: string | null;
  cancelReason: string | null;
  cancelledAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

export interface ContractList {
  today: string;
  contracts: Contract[];
  summary: { active: number; paused: number; mrr: string; arr: string; renewalsDue: number; endingIn30Days: number; billingProblems: number };
  can: { manage: boolean };
}

export interface ContractDetail extends Contract {
  lines: SalesLine[];
  periods: { id: string; periodNo: number; start: string; end: string; status: 'BILLED' | 'SKIPPED'; invoice: { id: string; number: string | null; status: string; total: string; issueDate: string } | null; canBillAgain: boolean }[];
  upcoming: { periodNo: number; start: string; end: string; billDate: string }[];
  events: { id: string; kind: string; body: string; actor: { id: string; name: string } | null; createdAt: string }[];
  can: { manage: boolean };
}
