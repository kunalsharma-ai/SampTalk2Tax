import type { AgeingBucket } from '@talk2tax/accounting-engine';

export type Rates = Record<AgeingBucket, string>;
type Acc = { id: string; code: string; name: string } | null;

export interface ProvisionPreview {
  buckets: { bucket: AgeingBucket; open: string; rate: string; provision: string; invoices: number }[];
  specific: { open: string; provision: string; invoices: number };
  open: string;
  total: string;
}

export interface BadDebtInvoice {
  id: string;
  number: string;
  contactId: string;
  contactName: string;
  date: string;
  dueDate: string;
  daysOverdue: number;
  bucket: AgeingBucket;
  currency: string;
  foreignOpen: string;
  open: string;
  doubtful: { percent: string; reason: string } | null;
  provision: string;
}

export interface WriteOff {
  id: string;
  reference: string;
  invoice: { id: string; number: string | null };
  contact: { id: string; name: string };
  date: string;
  currency: string;
  amount: string;
  functionalAmount: string;
  account: Acc;
  reason: string;
  status: 'ACTIVE' | 'REVERSED';
  journalEntryId: string;
  reversedOn: string | null;
  reversalReason: string | null;
  reversalJournalEntryId: string | null;
}

export interface BadDebtOverview {
  asOf: string;
  currency: string;
  settings: { expenseAccount: Acc; allowanceAccount: Acc; rates: Rates; updatedAt: string } | null;
  suggestedAccounts: { expenseAccount: Acc; allowanceAccount: Acc } | null;
  defaultRates: Rates;
  labels: Record<AgeingBucket, string>;
  preview: ProvisionPreview & { carried: string; adjustment: string };
  invoices: BadDebtInvoice[];
  provisions: { id: string; reference: string; asOf: string; required: string; carried: string; adjustment: string; journalEntryId: string | null; memo: string | null; result: ProvisionPreview; createdAt: string }[];
  writeOffs: WriteOff[];
  can: { manage: boolean; markDoubtful: boolean };
}
