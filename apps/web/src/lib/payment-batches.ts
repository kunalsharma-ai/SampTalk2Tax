export type BatchStatus = 'DRAFT' | 'APPROVED' | 'PAID' | 'CANCELLED';

export interface BankState {
  hasDetails: boolean;
  verified: boolean;
  accountNumberMasked: string;
  ifsc: string;
  changedAt: string;
}

export interface BatchCan {
  prepare: boolean;
  approve: boolean;
  pay: boolean;
  editBankDetails: boolean;
  verifyBankDetails: boolean;
}

export interface BatchSummary {
  id: string;
  reference: string;
  status: BatchStatus;
  paymentDate: string;
  currency: string;
  bankAccount: { id: string; code: string; name: string } | null;
  bills: number;
  vendors: number;
  total: string;
  memo: string | null;
}

export interface PayableBill {
  id: string;
  number: string;
  vendor: { id: string; name: string };
  issueDate: string;
  dueDate: string | null;
  currency: string;
  due: string;
  inBatch: string | null;
  bank: BankState | null;
}

export interface Batch {
  id: string;
  reference: string;
  status: BatchStatus;
  paymentDate: string;
  currency: string;
  bankAccount: { id: string; code: string; name: string } | null;
  memo: string | null;
  items: { id: string; documentId: string; number: string; vendor: { id: string; name: string }; dueDate: string | null; amount: string; due: string; billStatus: string; bank: BankState | null; payment: { id: string; number: string | null } | null }[];
  total: string;
  vendors: { contactId: string; name: string; amount: string; bills: number; bank: BankState | null }[];
  issues: { documentId: string; number: string; issue: string }[];
  createdBy: string | null;
  createdById: string;
  createdAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  selfApproved: boolean;
  fileDownloadedAt: string | null;
  paidBy: string | null;
  paidAt: string | null;
  cancelledBy: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  can: BatchCan;
}

export interface VendorBankDetails {
  details: {
    accountName: string;
    accountNumberMasked: string;
    ifsc: string | null;
    bankName: string | null;
    /** DOMESTIC (IFSC) or INTERNATIONAL (AP-023). */
    kind: 'DOMESTIC' | 'INTERNATIONAL';
    swiftBic: string | null;
    bankCountry: string | null;
    bankAddress: string | null;
    routingCode: string | null;
    intermediarySwift: string | null;
    changedBy: string | null;
    changedById: string;
    changedAt: string;
    verified: boolean;
    verifiedBy: string | null;
    verifiedAt: string | null;
    verificationNote: string | null;
  } | null;
  history: { before: string | null; after: string; changedBy: string | null; changedAt: string }[];
  can: BatchCan;
}

export const BATCH_STATUS: Record<BatchStatus, { label: string; tone: 'neutral' | 'warning' | 'positive' | 'negative' | 'accent' }> = {
  DRAFT: { label: 'Draft', tone: 'neutral' },
  APPROVED: { label: 'Approved', tone: 'accent' },
  PAID: { label: 'Paid', tone: 'positive' },
  CANCELLED: { label: 'Cancelled', tone: 'negative' },
};
