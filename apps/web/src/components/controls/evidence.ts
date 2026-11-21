/** Shapes the audit evidence API returns (AUDIT-003). */
type Person = { id: string; name: string };
export type EvidenceStatus = 'REQUESTED' | 'SUBMITTED' | 'ACCEPTED';
export interface EvidenceRequest {
  id: string;
  reference: string;
  engagement: { id: string; reference: string; name: string; status: string };
  title: string;
  details: string;
  owner: Person;
  dueDate: string;
  overdue: boolean;
  status: EvidenceStatus;
  files: { attachmentId: string; fileName: string; sha256: string }[];
  submittedBy: Person | null;
  submittedAt: string | null;
  acceptedBy: Person | null;
  acceptedAt: string | null;
  history: { at: string; by: Person; action: string; note: string }[];
  requestedBy: Person;
  requestedAt: string;
  canUpload: boolean;
  canReview: boolean;
  mine: boolean;
}

export const EVIDENCE_STATUS: Record<EvidenceStatus, { label: string; tone: 'neutral' | 'warning' | 'positive' }> = {
  REQUESTED: { label: 'Requested', tone: 'neutral' },
  SUBMITTED: { label: 'Submitted, to check', tone: 'warning' },
  ACCEPTED: { label: 'Accepted', tone: 'positive' },
};
