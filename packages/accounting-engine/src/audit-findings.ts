/**
 * Audit findings and remediation (AUDIT-011, AUDIT-012): a problem found by a control test, a
 * segregation-of-duties review or a person, with a remediation owner, a plan and a due date. The
 * owner works it through to ready for review; someone else closes it, and a finding raised from a
 * failed control test closes only once a later test of that control has passed.
 */

export const FINDING_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
export const FINDING_STATUSES = ['OPEN', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'CLOSED'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/** Days to fix a finding by severity, for the due date offered when it is raised. */
export const FINDING_DAYS_TO_FIX: Readonly<Record<FindingSeverity, number>> = { HIGH: 14, MEDIUM: 30, LOW: 60 };

/** Where the remediation owner may move a finding from each status (closing is a separate step). */
const OWNER_MOVES: Readonly<Record<FindingStatus, readonly FindingStatus[]>> = {
  OPEN: ['IN_PROGRESS', 'READY_FOR_REVIEW'],
  IN_PROGRESS: ['READY_FOR_REVIEW'],
  READY_FOR_REVIEW: ['IN_PROGRESS'],
  CLOSED: [],
};

/** Why a progress update is not allowed, or null when it is. */
export function findingMoveIssue(from: FindingStatus, to: FindingStatus, note: string): string | null {
  if (!OWNER_MOVES[from].includes(to)) return from === 'CLOSED' ? 'This finding is closed' : `A finding that is ${statusWords(from)} cannot move to ${statusWords(to)}`;
  if (note.trim().length < 10) return 'Say what was done, in at least 10 characters';
  return null;
}

/** Why someone may not close a finding, or null when they may. */
export function findingCloseIssue(
  f: { status: FindingStatus; ownerId: string; raisedFromTest: { periodKey: string } | null },
  closerId: string,
  laterPass: { periodKey: string } | null,
  note: string,
): string | null {
  if (f.status === 'CLOSED') return 'This finding is already closed';
  if (f.status !== 'READY_FOR_REVIEW') return 'The remediation owner marks the finding ready for review first';
  if (f.ownerId === closerId) return 'Someone other than the remediation owner closes the finding';
  if (f.raisedFromTest && !laterPass) return 'A later test of the control must pass before the finding is closed';
  if (note.trim().length < 10) return 'Say what you checked, in at least 10 characters';
  return null;
}

/** Whether an open finding is past its due date on `today`. */
export function findingOverdue(f: { status: FindingStatus; dueDate: string }, today: string): boolean {
  return f.status !== 'CLOSED' && f.dueDate < today;
}

export function statusWords(s: FindingStatus): string {
  return s === 'READY_FOR_REVIEW' ? 'ready for review' : s === 'IN_PROGRESS' ? 'in progress' : s.toLowerCase();
}

/**
 * Whether a passing test clears a finding raised from a failed one: it was recorded after the
 * failure, for the same period (tested again once fixed) or a later one. Keys of one frequency
 * sort in time order (2026-10, 2026-Q2, FY2026), so comparing them as text is enough.
 */
export function passClearsFailure(pass: { periodKey: string; testedAt: string }, failed: { periodKey: string; testedAt: string }): boolean {
  return pass.testedAt > failed.testedAt && pass.periodKey >= failed.periodKey;
}
