import { describe, expect, it } from 'vitest';
import { findingCloseIssue, findingMoveIssue, findingOverdue, passClearsFailure } from '../src';

describe('audit findings and remediation (AUDIT-011, AUDIT-012)', () => {
  it('lets the remediation owner move a finding forward, with a note', () => {
    expect(findingMoveIssue('OPEN', 'IN_PROGRESS', 'Started reconciling the bank')).toBeNull();
    expect(findingMoveIssue('IN_PROGRESS', 'READY_FOR_REVIEW', 'Reconciled to the month end')).toBeNull();
    expect(findingMoveIssue('READY_FOR_REVIEW', 'IN_PROGRESS', 'Reviewer asked for more')).toBeNull();
    expect(findingMoveIssue('IN_PROGRESS', 'OPEN', 'Going back to the start')).toMatch(/cannot move to open/);
    expect(findingMoveIssue('CLOSED', 'IN_PROGRESS', 'Reopening this one')).toBe('This finding is closed');
    expect(findingMoveIssue('OPEN', 'IN_PROGRESS', 'short')).toMatch(/10 characters/);
  });

  it('is closed by someone else once ready, and after a later passing test when it came from one', () => {
    const f = { status: 'READY_FOR_REVIEW' as const, ownerId: 'a', raisedFromTest: { periodKey: '2026-10' } };
    expect(findingCloseIssue({ ...f, status: 'IN_PROGRESS' }, 'b', { periodKey: '2026-10' }, 'Checked the reconciliation')).toMatch(/ready for review first/);
    expect(findingCloseIssue(f, 'a', { periodKey: '2026-10' }, 'Checked the reconciliation')).toMatch(/other than the remediation owner/);
    expect(findingCloseIssue(f, 'b', null, 'Checked the reconciliation')).toMatch(/later test/);
    expect(findingCloseIssue(f, 'b', { periodKey: '2026-10' }, 'ok')).toMatch(/10 characters/);
    expect(findingCloseIssue(f, 'b', { periodKey: '2026-10' }, 'Checked the reconciliation')).toBeNull();
    expect(findingCloseIssue({ ...f, raisedFromTest: null }, 'b', null, 'Checked the new procedure')).toBeNull();
  });

  it('counts a pass recorded after the failure, for that period or a later one', () => {
    const failed = { periodKey: '2026-10', testedAt: '2026-11-05T10:00:00.000Z' };
    expect(passClearsFailure({ periodKey: '2026-10', testedAt: '2026-11-09T10:00:00.000Z' }, failed)).toBe(true);
    expect(passClearsFailure({ periodKey: '2026-11', testedAt: '2026-12-03T10:00:00.000Z' }, failed)).toBe(true);
    expect(passClearsFailure({ periodKey: '2026-09', testedAt: '2026-11-09T10:00:00.000Z' }, failed)).toBe(false);
    expect(passClearsFailure({ periodKey: '2026-10', testedAt: '2026-11-01T10:00:00.000Z' }, failed)).toBe(false);
  });

  it('is overdue after its due date until closed', () => {
    expect(findingOverdue({ status: 'OPEN', dueDate: '2026-11-20' }, '2026-11-21')).toBe(true);
    expect(findingOverdue({ status: 'OPEN', dueDate: '2026-11-21' }, '2026-11-21')).toBe(false);
    expect(findingOverdue({ status: 'CLOSED', dueDate: '2026-11-01' }, '2026-11-21')).toBe(false);
  });
});
