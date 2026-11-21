/** Shapes the internal audit workspace API returns (AUDIT-001). */
type Person = { id: string; name: string };
export type EngagementStatus = 'PLANNING' | 'FIELDWORK' | 'REVIEW' | 'CLOSED';
export interface Progress {
  steps: number;
  done: number;
  signedOff: number;
}
export interface EngagementSummary {
  id: string;
  reference: string;
  name: string;
  scopeFrom: string;
  scopeTo: string;
  lead: Person;
  reviewer: Person;
  status: EngagementStatus;
  progress: Progress;
  mine: boolean;
}
export interface EngagementStep {
  id: string;
  title: string;
  assignee: Person;
  status: 'OPEN' | 'DONE' | 'SIGNED_OFF';
  work: string | null;
  doneBy: Person | null;
  doneAt: string | null;
  signedOffBy: Person | null;
  signedOffAt: string | null;
  canDo: boolean;
  canReview: boolean;
}
export interface Engagement extends Omit<EngagementSummary, 'mine'> {
  objective: string;
  steps: EngagementStep[];
  samples: { id: string; reference: string; name: string; status: 'OPEN' | 'COMPLETED'; progress: { tested: number; exceptions: number; remaining: number } }[];
  findings: { id: string; reference: string; title: string; severity: 'LOW' | 'MEDIUM' | 'HIGH'; status: string }[];
  evidence: { id: string; reference: string; title: string; owner: Person; dueDate: string; status: 'REQUESTED' | 'SUBMITTED' | 'ACCEPTED'; overdue: boolean; files: number }[];
  conclusion: string | null;
  history: { at: string; by: Person; action: string; note: string }[];
  createdBy: Person;
  createdAt: string;
  closedAt: string | null;
  canPlan: boolean;
  canLink: boolean;
  isLead: boolean;
  isReviewer: boolean;
}

export const ENGAGEMENT_STATUS: Record<EngagementStatus, { label: string; tone: 'neutral' | 'warning' | 'accent' | 'positive' }> = {
  PLANNING: { label: 'Planning', tone: 'neutral' },
  FIELDWORK: { label: 'Fieldwork', tone: 'warning' },
  REVIEW: { label: 'In review', tone: 'accent' },
  CLOSED: { label: 'Closed', tone: 'positive' },
};
export const STEP_STATUS: Record<EngagementStep['status'], { label: string; tone: 'neutral' | 'warning' | 'positive' }> = {
  OPEN: { label: 'To do', tone: 'neutral' },
  DONE: { label: 'Done, awaiting sign-off', tone: 'warning' },
  SIGNED_OFF: { label: 'Signed off', tone: 'positive' },
};
