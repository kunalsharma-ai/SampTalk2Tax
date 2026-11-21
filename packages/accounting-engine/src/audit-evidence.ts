/**
 * Audit evidence management (AUDIT-003): within an internal audit engagement, the lead asks a
 * member for evidence (a PBC list item) with a due date. The member attaches the files and submits
 * them; the lead or reviewer, never the person who submitted, accepts them or returns them with
 * what is missing. Accepted evidence is kept exactly as accepted, with each file's SHA-256.
 */

export const EVIDENCE_STATUSES = ['REQUESTED', 'SUBMITTED', 'ACCEPTED'] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

export interface EvidenceRequestState {
  status: EvidenceStatus;
  ownerId: string;
  submittedById: string | null;
}
export interface EvidenceEngagement {
  status: 'PLANNING' | 'FIELDWORK' | 'REVIEW' | 'CLOSED';
  leadId: string;
  reviewerId: string;
}

/** Why `userId` may not submit the evidence with these files and note, or null when they may. */
export function evidenceSubmitIssue(e: EvidenceEngagement, r: EvidenceRequestState, userId: string, files: number, note: string): string | null {
  if (e.status === 'CLOSED') return 'The engagement is closed';
  if (r.status !== 'REQUESTED') return r.status === 'ACCEPTED' ? 'This evidence is already accepted' : 'This evidence is already submitted';
  if (userId !== r.ownerId && userId !== e.leadId) return 'Only the person asked for the evidence, or the lead, submits it';
  if (files < 1) return 'Attach at least one file first';
  if (note.trim().length > 1000) return 'Keep the note under 1000 characters';
  return null;
}

/** Why `userId` may not accept or return the submitted evidence, or null when they may. */
export function evidenceReviewIssue(e: EvidenceEngagement, r: EvidenceRequestState, userId: string, decision: 'ACCEPT' | 'RETURN', note: string): string | null {
  if (e.status === 'CLOSED') return 'The engagement is closed';
  if (userId !== e.leadId && userId !== e.reviewerId) return 'Only the engagement lead or reviewer accepts evidence';
  if (r.status !== 'SUBMITTED') return r.status === 'ACCEPTED' ? 'This evidence is already accepted' : 'This evidence has not been submitted yet';
  if (r.submittedById === userId) return 'Someone other than the person who submitted it accepts the evidence';
  if (decision === 'RETURN' && note.trim().length < 10) return 'Say what is missing, in at least 10 characters';
  return null;
}

/** Whether evidence not yet submitted is past its due date on `today`. */
export function evidenceOverdue(r: { status: EvidenceStatus; dueDate: string }, today: string): boolean {
  return r.status === 'REQUESTED' && r.dueDate < today;
}

/** Counts by status, with how many are overdue. */
export function evidenceSummary(list: readonly { status: EvidenceStatus; dueDate: string }[], today: string): { requested: number; submitted: number; accepted: number; overdue: number } {
  return {
    requested: list.filter((r) => r.status === 'REQUESTED').length,
    submitted: list.filter((r) => r.status === 'SUBMITTED').length,
    accepted: list.filter((r) => r.status === 'ACCEPTED').length,
    overdue: list.filter((r) => evidenceOverdue(r, today)).length,
  };
}
