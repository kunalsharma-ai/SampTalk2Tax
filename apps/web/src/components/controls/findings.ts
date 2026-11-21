/** Shapes the audit findings API returns (AUDIT-011, AUDIT-012). */
export type FindingStatus = 'OPEN' | 'IN_PROGRESS' | 'READY_FOR_REVIEW' | 'CLOSED';
type Person = { id: string; name: string };
export interface Finding {
  id: string;
  reference: string;
  title: string;
  description: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  source: 'CONTROL_TEST' | 'MANUAL';
  control: { id: string; title: string } | null;
  testPeriodKey: string | null;
  owner: Person;
  plan: string;
  dueDate: string;
  overdue: boolean;
  status: FindingStatus;
  updates: { at: string; by: Person; status: FindingStatus; note: string }[];
  raisedBy: Person;
  raisedAt: string;
  closedBy: Person | null;
  closedAt: string | null;
  canUpdate: boolean;
  canClose: boolean;
}

export const FINDING_STATUS: Record<FindingStatus, { label: string; tone: 'positive' | 'negative' | 'warning' | 'neutral' | 'accent' }> = {
  OPEN: { label: 'Open', tone: 'warning' },
  IN_PROGRESS: { label: 'In progress', tone: 'accent' },
  READY_FOR_REVIEW: { label: 'Ready for review', tone: 'accent' },
  CLOSED: { label: 'Closed', tone: 'positive' },
};
export const SEVERITY: Record<Finding['severity'], { label: string; tone: 'negative' | 'warning' | 'neutral' }> = {
  HIGH: { label: 'High', tone: 'negative' },
  MEDIUM: { label: 'Medium', tone: 'warning' },
  LOW: { label: 'Low', tone: 'neutral' },
};
