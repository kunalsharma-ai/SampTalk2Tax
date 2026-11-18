export type BillCheckSeverity = 'HIGH' | 'MEDIUM' | 'LOW';
export interface BillCheckFinding { code: string; severity: BillCheckSeverity; label: string; detail: string; relatedIds: string[] }
export interface BillCheck {
  documentId: string;
  number: string | null;
  reference: string | null;
  status: 'DRAFT' | 'POSTED' | 'VOID';
  issueDate: string;
  vendorId: string;
  vendor: string;
  currency: string;
  total: string;
  findings: BillCheckFinding[];
  highest: BillCheckSeverity | null;
  review: { note: string; by: string | null; at: string; current: boolean } | null;
}
export interface BillCheckList { summary: { toReview: number; high: number; reviewed: number; checked: number }; items: BillCheck[] }

export const SEVERITY_LABEL: Record<BillCheckSeverity, string> = { HIGH: 'Check first', MEDIUM: 'Worth a look', LOW: 'For information' };
export const SEVERITY_TONE: Record<BillCheckSeverity, 'negative' | 'warning' | 'neutral'> = { HIGH: 'negative', MEDIUM: 'warning', LOW: 'neutral' };
