/** Expense reports (EXP-017). */

export type ReportStatus = 'SUBMITTED' | 'APPROVED' | 'REIMBURSED';

export interface ExpenseGroupFigures {
  claims: number;
  lines: number;
  net: string;
  tax: string;
  total: string;
  share: string;
}

export interface ExpenseReportData {
  from: string;
  to: string;
  currency: string;
  scope: 'all' | 'mine';
  statuses: ReportStatus[];
  totals: { claims: number; lines: number; net: string; tax: string; total: string };
  byCategory: (ExpenseGroupFigures & { accountId: string; code: string | null; name: string })[];
  byMonth: (ExpenseGroupFigures & { month: string })[];
  byPerson: (ExpenseGroupFigures & { claimantId: string; name: string })[];
  byStatus: (ExpenseGroupFigures & { status: ReportStatus })[];
  byMerchant: (ExpenseGroupFigures & { merchant: string })[];
}

export const REPORT_STATUS_LABEL: Record<ReportStatus, string> = { SUBMITTED: 'Waiting for approval', APPROVED: 'Approved, not yet paid', REIMBURSED: 'Reimbursed' };

export function monthLabel(ym: string): string {
  return new Date(`${ym}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}
