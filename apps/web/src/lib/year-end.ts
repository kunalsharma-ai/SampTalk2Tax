export type YearEndStatus = 'NOTHING_TO_CLOSE' | 'NOT_CLOSED' | 'CLOSED' | 'OUT_OF_DATE';

export interface FiscalYearEnd {
  fiscalYear: number;
  label: string;
  startDate: string;
  endDate: string;
  ended: boolean;
  lastPeriod: { id: string; name: string; status: 'OPEN' | 'LOCKED' | 'CLOSED' };
  periods: { open: number; locked: number; closed: number };
  profit: string;
  closedToRetainedEarnings: string;
  leftToClose: string;
  accountsLeft: number;
  status: YearEndStatus;
}

export interface YearEndClose {
  id: string;
  reference: string;
  fiscalYear: number;
  label: string;
  closingDate: string;
  retainedEarningsAccount: { id: string; code: string; name: string };
  profit: string;
  toRetainedEarnings: string;
  accounts: number;
  journalEntryId: string;
  memo: string | null;
  status: 'ACTIVE' | 'REVERSED';
  reversedOn: string | null;
  reversalReason: string | null;
  reversalJournalEntryId: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface YearEndOverview {
  currency: string;
  years: FiscalYearEnd[];
  closes: YearEndClose[];
  retainedEarningsAccountId: string | null;
  can: { close: boolean };
}

export interface YearEndPreview {
  fiscalYear: number;
  closingDate: string;
  profit: string;
  toRetainedEarnings: string;
  lines: { accountId: string; account: string | null; debit: string; credit: string; description: string }[];
}

export const YEAR_END_STATUS: Record<YearEndStatus, { label: string; tone: 'neutral' | 'warning' | 'positive' | 'negative' }> = {
  NOTHING_TO_CLOSE: { label: 'Nothing to close', tone: 'neutral' },
  NOT_CLOSED: { label: 'Not closed', tone: 'warning' },
  CLOSED: { label: 'Closed', tone: 'positive' },
  OUT_OF_DATE: { label: 'Changed since closing', tone: 'negative' },
};
