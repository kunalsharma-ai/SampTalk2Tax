import type { DocumentKind, PaymentKind } from './types';

/**
 * Sales and purchases share one set of screens. This describes the words and
 * routes that differ between them.
 */
export interface LedgerConfig {
  ledger: 'SALES' | 'PURCHASES';
  api: 'sales' | 'purchases';
  contactRole: 'customer' | 'vendor';
  contact: string;
  contacts: string;
  contactsPath: string;
  docsPath: string;
  docsTitle: string;
  charge: { kind: DocumentKind; label: string; plural: string };
  credit: { kind: DocumentKind; label: string; plural: string };
  payment: { kind: PaymentKind; label: string; plural: string; verb: string };
  paymentsPath: string;
  ageingPath: string;
  ageingTitle: string;
  balanceKey: 'receivable' | 'payable';
  managePermission: 'sales.manage' | 'purchases.manage';
  /** Account types offered first on document lines. */
  lineTypes: string[];
  reference: string;
}

export const SALES: LedgerConfig = {
  ledger: 'SALES',
  api: 'sales',
  contactRole: 'customer',
  contact: 'Customer',
  contacts: 'Customers',
  contactsPath: 'sales/customers',
  docsPath: 'sales/invoices',
  docsTitle: 'Invoices and credit notes',
  charge: { kind: 'INVOICE', label: 'Invoice', plural: 'Invoices' },
  credit: { kind: 'CREDIT_NOTE', label: 'Credit note', plural: 'Credit notes' },
  payment: { kind: 'RECEIPT', label: 'Receipt', plural: 'Receipts', verb: 'Record a receipt' },
  paymentsPath: 'sales/receipts',
  ageingPath: 'sales/ageing',
  ageingTitle: 'Receivables ageing',
  balanceKey: 'receivable',
  managePermission: 'sales.manage',
  lineTypes: ['REVENUE'],
  reference: "Customer's PO / reference",
};

export const PURCHASES: LedgerConfig = {
  ledger: 'PURCHASES',
  api: 'purchases',
  contactRole: 'vendor',
  contact: 'Vendor',
  contacts: 'Vendors',
  contactsPath: 'purchases/vendors',
  docsPath: 'purchases/bills',
  docsTitle: 'Bills and vendor credits',
  charge: { kind: 'BILL', label: 'Bill', plural: 'Bills' },
  credit: { kind: 'VENDOR_CREDIT', label: 'Vendor credit', plural: 'Vendor credits' },
  payment: { kind: 'PAYMENT', label: 'Payment', plural: 'Payments', verb: 'Record a payment' },
  paymentsPath: 'purchases/payments',
  ageingPath: 'purchases/ageing',
  ageingTitle: 'Payables ageing',
  balanceKey: 'payable',
  managePermission: 'purchases.manage',
  lineTypes: ['EXPENSE', 'ASSET'],
  reference: "Vendor's invoice number",
};

export function kindLabel(l: LedgerConfig, kind: string): string {
  return kind === l.charge.kind ? l.charge.label : kind === l.credit.kind ? l.credit.label : kind === l.payment.kind ? l.payment.label : kind;
}

export const BUCKET_LABELS: Record<string, string> = {
  current: 'Not yet due',
  days1to30: '1–30 days',
  days31to60: '31–60 days',
  days61to90: '61–90 days',
  over90: 'Over 90 days',
};
