/**
 * Internal audit workspace (AUDIT-001): an audit engagement with a scope, a lead who runs it and a
 * reviewer who signs it off, a work programme of steps, and the samples and findings it uses. It
 * moves from planning to fieldwork to review to closed. Each step is done by its assignee (or the
 * lead) with the work recorded, then signed off by the reviewer, who never signs off their own
 * work. A closed engagement is kept as it was closed.
 */

export const ENGAGEMENT_STATUSES = ['PLANNING', 'FIELDWORK', 'REVIEW', 'CLOSED'] as const;
export type EngagementStatus = (typeof ENGAGEMENT_STATUSES)[number];
export type StepStatus = 'OPEN' | 'DONE' | 'SIGNED_OFF';

export interface EngagementStep {
  id: string;
  status: StepStatus;
  assigneeId: string;
  doneById: string | null;
}

export interface EngagementState {
  status: EngagementStatus;
  leadId: string;
  reviewerId: string;
  steps: readonly EngagementStep[];
  /** Linked samples that are still being tested. */
  openSamples: number;
}

const MOVES: Readonly<Record<EngagementStatus, readonly EngagementStatus[]>> = {
  PLANNING: ['FIELDWORK'],
  FIELDWORK: ['REVIEW'],
  REVIEW: ['FIELDWORK', 'CLOSED'],
  CLOSED: [],
};

export function engagementStatusWords(s: EngagementStatus): string {
  return s === 'FIELDWORK' ? 'in fieldwork' : s === 'REVIEW' ? 'in review' : s.toLowerCase();
}

/** Why `userId` may not move the engagement to `to` with this note, or null when they may. */
export function engagementMoveIssue(e: EngagementState, to: EngagementStatus, userId: string, note: string): string | null {
  if (e.status === 'CLOSED') return 'This engagement is closed';
  if (!MOVES[e.status].includes(to)) return `An engagement ${engagementStatusWords(e.status)} cannot move to ${to === 'CLOSED' ? 'closed' : engagementStatusWords(to)}`;
  const byReviewer = e.status === 'REVIEW';
  if (byReviewer && userId !== e.reviewerId) return 'Only the reviewer decides on an engagement in review';
  if (!byReviewer && userId !== e.leadId) return 'Only the engagement lead moves it on';
  if (to === 'FIELDWORK' && e.status === 'PLANNING' && !e.steps.length) return 'Add at least one step to the work programme first';
  if (to === 'REVIEW') {
    const open = e.steps.filter((s) => s.status === 'OPEN').length;
    if (open) return `${open} ${open === 1 ? 'step is' : 'steps are'} not done yet`;
    if (e.openSamples) return `${e.openSamples} linked ${e.openSamples === 1 ? 'sample is' : 'samples are'} still being tested`;
  }
  if (to === 'CLOSED') {
    const left = e.steps.filter((s) => s.status !== 'SIGNED_OFF').length;
    if (left) return `${left} ${left === 1 ? 'step is' : 'steps are'} not signed off yet`;
    if (e.openSamples) return `${e.openSamples} linked ${e.openSamples === 1 ? 'sample is' : 'samples are'} still being tested`;
    if (note.trim().length < 20) return 'Write the conclusion, in at least 20 characters';
  } else if (byReviewer && note.trim().length < 10) return 'Say what needs more work, in at least 10 characters';
  return null;
}

/** Why `userId` may not mark a step done, or null when they may. */
export function stepDoneIssue(e: Pick<EngagementState, 'status' | 'leadId'>, step: EngagementStep, userId: string, work: string): string | null {
  if (e.status !== 'FIELDWORK') return 'Steps are done during fieldwork';
  if (step.status !== 'OPEN') return 'This step is already done';
  if (userId !== step.assigneeId && userId !== e.leadId) return 'Only the person the step is assigned to, or the lead, does it';
  if (work.trim().length < 10) return 'Say what was done and found, in at least 10 characters';
  return null;
}

/** Why `userId` may not sign off (or send back) a done step, or null when they may. */
export function stepReviewIssue(e: Pick<EngagementState, 'status' | 'reviewerId'>, step: EngagementStep, userId: string, decision: 'SIGN_OFF' | 'REOPEN', note: string): string | null {
  if (e.status !== 'FIELDWORK' && e.status !== 'REVIEW') return 'Steps are reviewed during fieldwork or review';
  if (userId !== e.reviewerId) return 'Only the reviewer signs off steps';
  if (step.status !== 'DONE') return step.status === 'OPEN' ? 'This step is not done yet' : 'This step is already signed off';
  if (step.doneById === userId) return 'The reviewer cannot sign off work they did themselves';
  if (decision === 'REOPEN' && note.trim().length < 10) return 'Say what needs more work, in at least 10 characters';
  return null;
}

/** How far the work programme has got. */
export function engagementProgress(steps: readonly Pick<EngagementStep, 'status'>[]): { steps: number; done: number; signedOff: number } {
  return { steps: steps.length, done: steps.filter((s) => s.status !== 'OPEN').length, signedOff: steps.filter((s) => s.status === 'SIGNED_OFF').length };
}
