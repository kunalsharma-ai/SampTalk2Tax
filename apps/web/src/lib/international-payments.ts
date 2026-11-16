export type RemitStatus = 'DRAFT' | 'APPROVED' | 'SENT' | 'PAID' | 'CANCELLED';
export type Charges = 'OUR' | 'SHA' | 'BEN';
export type Form15Part = 'NONE' | 'A' | 'B' | 'C' | 'D';

export const REMIT_STATUS: Record<RemitStatus, { label: string; tone: 'neutral' | 'accent' | 'warning' | 'positive' | 'negative' }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  APPROVED: { label: 'Approved', tone: 'accent' },
  SENT: { label: 'Sent to bank', tone: 'warning' },
  PAID: { label: 'Paid', tone: 'positive' },
  CANCELLED: { label: 'Cancelled', tone: 'negative' },
};

export const CHARGES: Record<Charges, string> = {
  OUR: 'We pay all charges (OUR)',
  SHA: 'Shared (SHA)',
  BEN: 'Vendor pays all charges (BEN)',
};

export const FORM15_LABEL: Record<Form15Part, string> = {
  NONE: 'Not required',
  A: 'Form 15CA Part A',
  B: 'Form 15CA Part B',
  C: 'Form 15CA Part C, after Form 15CB',
  D: 'Form 15CA Part D',
};

export interface PurposeCode {
  code: string;
  label: string;
  noForm15: boolean;
}

export interface RemitListRow {
  id: string;
  reference: string;
  vendor: { id: string; name: string };
  status: RemitStatus;
  paymentDate: string;
  currency: string;
  amount: string;
  purposeCode: string | null;
  form15Part: Form15Part;
  inr: string | null;
  paid: boolean;
}

export interface RemitList {
  payments: RemitListRow[];
  counts: Record<RemitStatus, number>;
  purposeCodes: PurposeCode[];
  charges: Record<Charges, string>;
  can: { manage: boolean; approve: boolean; pay: boolean };
}

export interface ForeignBill {
  id: string;
  number: string;
  vendorInvoice: string | null;
  vendor: { id: string; name: string };
  issueDate: string;
  dueDate: string | null;
  currency: string;
  due: string;
  inPayment: string | null;
  bank: { international: boolean; verified: boolean; swiftBic: string | null; bankCountry: string | null } | null;
}

export interface Remittance {
  id: string;
  reference: string;
  status: RemitStatus;
  vendor: { id: string; name: string; email: string | null };
  bankAccount: { id: string; code: string; name: string };
  paymentDate: string;
  currency: string;
  amount: string;
  estimateRate: string | null;
  estimateInr: string | null;
  functionalCurrency: string;
  purposeCode: string | null;
  purpose: string | null;
  charges: Charges;
  taxableInIndia: boolean;
  hasTaxOrder: boolean;
  form15: { part: Form15Part; needs15cb: boolean; reason: string; inrThisYear: string; inrBefore: string; ack: string | null; cb: string | null; applies: boolean };
  memo: string | null;
  items: { documentId: string; number: string; vendorInvoice: string | null; currency: string; status: string; total: string; due: string; amount: string }[];
  bank: { kind: string; verified: boolean; accountName: string; accountMasked: string; swiftBic: string | null; bankCountry: string | null; bankName: string | null; routingCode: string | null } | null;
  issues: string[];
  createdBy: string | null;
  createdAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  selfApproved: boolean;
  sentBy: string | null;
  sentAt: string | null;
  paidRate: string | null;
  paidInr: string | null;
  bankReference: string | null;
  payment: { id: string; number: string } | null;
  paidBy: string | null;
  paidAt: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  mine: boolean;
  can: { manage: boolean; approve: boolean; pay: boolean };
}
