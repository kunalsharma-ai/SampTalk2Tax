/** Month-end close, as the API returns it. */
export type CloseStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'CLOSED';

export interface ClosePeriodRow {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  periodStatus: 'OPEN' | 'LOCKED' | 'CLOSED';
  closeStatus: CloseStatus;
  closedBy: string | null;
  closedAt: string | null;
  current: boolean;
}

export interface CloseCheckView {
  key: string;
  severity: 'BLOCKING' | 'WARNING';
  ok: boolean;
  label: string;
  detail: string;
  count: number;
  link: string | null;
  task: { id: string; status: 'OPEN' | 'DONE' | 'CANCELLED' } | null;
}

export interface CloseAdjustmentView {
  id: string;
  reviewId: string;
  status: 'READY' | 'POSTED' | 'REJECTED' | 'SUPERSEDED';
  description: string;
  reason: string;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  reverseNextPeriod: boolean;
  proposedLines: { accountCode: string; debit?: string; credit?: string; description?: string }[];
  resolved: { date: string; description: string; total: string; reverseOn: string | null; lines: { accountCode: string; accountName: string; debit: string; credit: string; description: string }[] } | null;
  checks: { ok: boolean; label: string }[];
  canPost: boolean;
  journal: { id: string; number: number | null } | null;
  reversal: { id: string; number: number | null } | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
}

export interface CloseTotals {
  currency: string;
  revenue: string;
  expenses: string;
  netProfit: string;
  assets: string;
  liabilities: string;
  trialBalanceDebit: string;
  trialBalanceCredit: string;
  journalsPosted: number;
}

export interface CloseView {
  period: { id: string; name: string; startDate: string; endDate: string; status: 'OPEN' | 'LOCKED' | 'CLOSED' };
  nextPeriod: { id: string; name: string } | null;
  close: { id: string; status: 'IN_PROGRESS' | 'CLOSED'; startedBy: string; startedAt: string } | null;
  checks: CloseCheckView[];
  readiness: { blocking: number; warnings: number; noteRequired: boolean };
  ai: { configured: boolean; enabled: boolean; model: string; canChangeAi: boolean };
  review: {
    id: string;
    status: 'RUNNING' | 'DONE' | 'FAILED';
    startedBy: string;
    createdAt: string;
    finishedAt: string | null;
    summary: string | null;
    findings: { title: string; detail: string }[];
    model: string;
    servedModel: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
    errorCode: string | null;
    errorMessage: string | null;
    shown: { accounts: number };
  } | null;
  adjustments: CloseAdjustmentView[];
  certifications: {
    id: string;
    certifiedBy: string;
    certifiedAt: string;
    note: string | null;
    totals: CloseTotals;
    warningsAccepted: string[];
    reopenedBy: string | null;
    reopenedAt: string | null;
    reopenReason: string | null;
  }[];
  can: { manage: boolean; post: boolean; close: boolean };
}

export const CLOSE_STATUS: Record<CloseStatus, { label: string; tone: 'neutral' | 'warning' | 'positive' }> = {
  NOT_STARTED: { label: 'Not started', tone: 'neutral' },
  IN_PROGRESS: { label: 'In progress', tone: 'warning' },
  CLOSED: { label: 'Closed', tone: 'positive' },
};

export const ADJUSTMENT_STATUS: Record<CloseAdjustmentView['status'], { label: string; tone: 'neutral' | 'warning' | 'positive' | 'negative' }> = {
  READY: { label: 'To review', tone: 'warning' },
  POSTED: { label: 'Posted', tone: 'positive' },
  REJECTED: { label: 'Rejected', tone: 'neutral' },
  SUPERSEDED: { label: 'Superseded', tone: 'neutral' },
};
