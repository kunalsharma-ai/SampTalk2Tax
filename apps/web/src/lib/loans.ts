import type { LoanMethod, LoanRow } from '@talk2tax/accounting-engine';

export type { LoanMethod, LoanRow };
export type AccountRef = { id: string; code: string; name: string } | null;
export type EntryRef = { id: string; entryNumber: number; date: string } | null;

export interface LoanSummary {
  id: string;
  reference: string;
  name: string;
  lender: string | null;
  method: LoanMethod;
  status: 'ACTIVE' | 'CLOSED';
  principal: string;
  annualRate: string;
  installment: string;
  balance: string;
  paid: { principal: string; interest: string; charges: string; installments: number };
  next: LoanRow | null;
  overdue: { count: number; amount: string };
  remaining: { interest: string; principal: string; payment: string; installments: number };
  maturity: { current: string; nonCurrent: string };
  endsOn: string | null;
  closedOn: string | null;
  liabilityAccountId: string;
}

export interface LoanList {
  loans: (LoanSummary & { liabilityAccount: AccountRef })[];
  totals: { balance: string; current: string; nonCurrent: string; overdue: string; active: number };
  can: { manage: boolean };
}

export type LoanEventKind = 'REPAYMENT' | 'PREPAYMENT' | 'RATE_CHANGE';

export interface LoanEvent {
  id: string;
  seq: number;
  kind: LoanEventKind;
  date: string;
  installmentNo: number | null;
  principal: string;
  interest: string;
  charges: string;
  mode: string | null;
  balanceAfter: string;
  rateBefore: string;
  rateAfter: string;
  installmentBefore: string;
  installmentAfter: string;
  note: string | null;
  bankAccount: AccountRef;
  entry: EntryRef;
  status: 'POSTED' | 'REVERSED';
  reversal: { entry: EntryRef; by: string | null; at: string } | null;
  createdBy: string | null;
  canReverse: boolean;
}

export interface PaidRow {
  no: number;
  date: string;
  opening: string;
  interest: string;
  principal: string;
  payment: string;
  closing: string;
  entry: EntryRef;
}

export interface LoanDetail extends LoanSummary {
  accountNumber: string | null;
  originalRate: string;
  months: number;
  lastNo: number | null;
  disbursementDate: string;
  firstDueDate: string;
  notes: string | null;
  accounts: { liability: AccountRef; interest: AccountRef; bank: AccountRef };
  disbursementEntry: EntryRef;
  createdBy: string | null;
  events: LoanEvent[];
  paidRows: PaidRow[];
  rows: LoanRow[];
  can: { manage: boolean };
}

export interface LoanAccounts {
  liability: { id: string; code: string; name: string }[];
  interest: { id: string; code: string; name: string }[];
  bank: { id: string; code: string; name: string }[];
}

export interface Treasury {
  asOf: string;
  cash: { total: string; accounts: { id: string; code: string; name: string; kind: 'BANK' | 'CASH'; balance: string }[] };
  borrowings: LoanList['totals'];
  netCash: string;
  upcoming: (LoanRow & { loanId: string; reference: string; name: string; overdue: boolean })[];
  byMonth: { month: string; principal: string; interest: string; total: string }[];
  interestThisYear: { from: string; amount: string };
  ledger: { account: { id: string; code: string; name: string }; ledger: string; loans: string; difference: string }[];
  loans: LoanList['loans'];
  can: { manage: boolean };
}

export const METHOD: Record<LoanMethod, string> = { EMI: 'EMI (equal monthly installments)', EQUAL_PRINCIPAL: 'Equal principal plus interest' };
export const acct = (a: AccountRef) => (a ? `${a.code} ${a.name}` : '—');
export const shortMonth = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
export const today = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
