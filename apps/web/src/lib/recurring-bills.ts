import type { RecurringFrequency } from '@talk2tax/accounting-engine';

export interface RecurringBillLine {
  lineNo: number;
  accountId: string;
  account: { code: string; name: string } | null;
  description: string | null;
  quantity: string;
  unitPrice: string;
  amount: string;
  taxRateId: string | null;
  hsnCode: string | null;
  departmentId: string | null;
  projectId: string | null;
}

export interface RecurringBillSchedule {
  frequency: RecurringFrequency;
  startDate: string;
  endDate: string | null;
  monthEnd: boolean;
  postMode: 'DRAFT' | 'POST';
  status: 'ACTIVE' | 'PAUSED' | 'ENDED';
  nextRunNo: number;
  runsTotal: number | null;
  description: string;
  nextRun: { no: number; date: string; reference: string | null } | null;
  dueNow: number;
  lastError: string | null;
  lastErrorAt: string | null;
}

export interface RecurringBill {
  id: string;
  number: number;
  reference: string;
  name: string;
  contact: { id: string; name: string };
  vendorReference: string | null;
  memo: string | null;
  placeOfSupply: string | null;
  reverseCharge: boolean;
  withholdingSectionId: string | null;
  dueDays: number | null;
  subtotal: string;
  currency: string;
  lines: RecurringBillLine[];
  schedule: RecurringBillSchedule;
  createdAt: string;
  updatedAt: string;
}

export interface RecurringBillRun {
  id: string;
  runNo: number;
  date: string;
  posted: boolean;
  by: string;
  createdAt: string;
  bill: { id: string; number: string | null; status: 'DRAFT' | 'POSTED' | 'VOID'; total: string; reference: string | null; dueDate: string } | null;
}

export interface RecurringBillDetail extends RecurringBill {
  upcoming: { no: number; date: string; reference: string | null }[];
  runs: RecurringBillRun[];
}

export interface RecurringBillList {
  items: (RecurringBill & { runs: number })[];
  counts: { active: number; paused: number; ended: number; all: number };
  can: { manage: boolean; post: boolean };
}

/** The badge words for a recurring bill's status. */
export function recurringBillStatus(s: Pick<RecurringBillSchedule, 'status' | 'postMode'>): { label: string; tone: 'positive' | 'warning' | 'neutral' } {
  if (s.status === 'PAUSED') return { label: 'Paused', tone: 'warning' };
  if (s.status === 'ENDED') return { label: 'Ended', tone: 'neutral' };
  return { label: s.postMode === 'POST' ? 'Active · posts' : 'Active · drafts', tone: 'positive' };
}
