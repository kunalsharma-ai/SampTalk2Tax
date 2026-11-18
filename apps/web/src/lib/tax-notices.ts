export type TaxAuthority = 'GST' | 'INCOME_TAX' | 'TDS' | 'PF' | 'ESI' | 'PROFESSIONAL_TAX' | 'OTHER';
export type TaxNoticeStatus = 'OPEN' | 'RESPONDED' | 'CLOSED';
export type TaxNoticeOutcome = 'DROPPED' | 'DEMAND_PAID' | 'APPEALED' | 'OTHER';
export type TaxNoticeUrgency = 'OVERDUE' | 'DUE_SOON' | 'UPCOMING' | 'NO_DEADLINE' | 'DONE';

export const AUTHORITIES: Record<TaxAuthority, string> = { GST: 'GST', INCOME_TAX: 'Income tax', TDS: 'TDS / TCS', PF: 'Provident fund', ESI: 'ESI', PROFESSIONAL_TAX: 'Professional tax', OTHER: 'Other' };
export const OUTCOMES: Record<TaxNoticeOutcome, string> = { DROPPED: 'Dropped with no demand', DEMAND_PAID: 'Demand paid', APPEALED: 'Appealed', OTHER: 'Other' };

export interface TaxNoticeSummary {
  id: string;
  authority: TaxAuthority;
  authorityLabel: string;
  reference: string;
  section: string | null;
  subject: string;
  period: string | null;
  receivedOn: string;
  responseDue: string | null;
  demand: string | null;
  status: TaxNoticeStatus;
  outcome: TaxNoticeOutcome | null;
  outcomeLabel: string | null;
  assigneeId: string | null;
  assignee: string | null;
  urgency: TaxNoticeUrgency;
  daysLeft: number | null;
}
export interface TaxNotice extends TaxNoticeSummary {
  history: { id: string; kind: 'RECEIVED' | 'UPDATED' | 'NOTE' | 'FILE' | 'RESPONDED' | 'CLOSED' | 'REOPENED'; on: string; text: string | null; by: string | null; at: string }[];
  files: { id: string; fileName: string; contentType: string; sizeBytes: number; sha256: string; uploadedBy: string | null; createdAt: string }[];
}
export interface TaxNoticeList {
  today: string;
  summary: { open: number; overdue: number; dueSoon: number; responded: number; closed: number };
  items: TaxNoticeSummary[];
}
