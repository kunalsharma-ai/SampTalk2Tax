export type DeferralKind = 'PREPAID_EXPENSE' | 'DEFERRED_REVENUE';
export type DeferralMethod = 'EVEN' | 'DAILY';
export type ScheduleStatus = 'ACTIVE' | 'COMPLETED' | 'ENDED';
export type AccountRef = { id: string; code: string; name: string };
export type EntryRef = { id: string; entryNumber: number; date: string } | null;

export interface ScheduleRow {
  id: string;
  kind: DeferralKind;
  reference: string;
  name: string;
  counterparty: string | null;
  status: ScheduleStatus;
  method: DeferralMethod;
  amount: string;
  released: string;
  remaining: string;
  startDate: string;
  endDate: string;
  firstMonth: string;
  lastMonth: string;
  releasedThrough: string | null;
  balanceAccount: AccountRef | null;
  pnlAccount: AccountRef | null;
}

export interface ScheduleList {
  schedules: ScheduleRow[];
  totals: { prepaid: string; deferred: string };
  can: { manage: boolean };
}

export interface ScheduleDetail extends Omit<ScheduleRow, 'releasedThrough' | 'balanceAccount' | 'pnlAccount'> {
  months: number;
  accounts: { balance: AccountRef | null; pnl: AccountRef | null };
  termsFixed: boolean;
  initialEntry: EntryRef;
  end: { date: string; amount: string; note: string | null; by: string; entry: EntryRef } | null;
  schedule: { month: string; amount: string; released: string; remaining: string; posted: boolean }[];
  postings: { month: string; amount: string; runMonth: string; runStatus: 'POSTED' | 'REVERSED'; entry: EntryRef; reversal: EntryRef; postedBy: string }[];
  createdBy: string;
  createdAt: string;
  can: { manage: boolean };
}

export interface ReleasesView {
  currentMonth: string;
  lastPosted: string | null;
  nextMonth: string | null;
  month: string | null;
  monthName: string | null;
  period: { name: string; status: string } | null;
  alreadyPosted: boolean;
  preview: { scheduleId: string; kind: DeferralKind; reference: string; name: string; month: string; amount: string; catchUp: boolean }[];
  previewTotals: { prepaid: string; deferred: string; total: string };
  runs: { id: string; month: string; monthName: string; status: 'POSTED' | 'REVERSED'; total: string; lines: number; entry: EntryRef; reversal: EntryRef; postedBy: string; postedAt: string; reversedBy: string | null; reversedAt: string | null; canReverse: boolean }[];
  can: { manage: boolean };
}

export interface AccrualRow {
  id: string;
  reference: string;
  kind: 'EXPENSE' | 'INCOME';
  description: string;
  counterparty: string | null;
  month: string;
  monthName: string;
  amount: string;
  pnlAccount: AccountRef | null;
  balanceAccount: AccountRef | null;
  status: 'POSTED' | 'CANCELLED';
  entry: EntryRef;
  reversal: EntryRef;
  cancel: { note: string | null; by: string; at: string; entry: EntryRef; reversal: EntryRef } | null;
  createdBy: string;
  createdAt: string;
}

export interface AccrualList {
  accruals: AccrualRow[];
  totals: { expense: string; income: string };
  can: { manage: boolean };
}

export interface DeferralAccounts {
  prepaid: AccountRef[];
  deferred: AccountRef[];
  expense: AccountRef[];
  revenue: AccountRef[];
  accruedLiability: AccountRef[];
  accruedIncome: AccountRef[];
  funding: AccountRef[];
  any: AccountRef[];
}

export const KIND: Record<DeferralKind, string> = { PREPAID_EXPENSE: 'Prepaid expense', DEFERRED_REVENUE: 'Deferred revenue' };
export const METHOD: Record<DeferralMethod, string> = { EVEN: 'Evenly by month', DAILY: 'By days' };
export const STATUS: Record<ScheduleStatus, string> = { ACTIVE: 'Releasing', COMPLETED: 'Fully released', ENDED: 'Ended early' };
export const shortMonth = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
export const acct = (a: AccountRef | null) => (a ? `${a.code} ${a.name}` : '—');
export const today = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
