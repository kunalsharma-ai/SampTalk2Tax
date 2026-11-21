import { describe, expect, it } from 'vitest';
import { engagementMoveIssue, engagementProgress, stepDoneIssue, stepReviewIssue, type EngagementState, type EngagementStep } from '../src/audit-engagements';

const step = (s: Partial<EngagementStep> = {}): EngagementStep => ({ id: 's1', status: 'OPEN', assigneeId: 'staff', doneById: null, ...s });
const eng = (e: Partial<EngagementState> = {}): EngagementState => ({ status: 'PLANNING', leadId: 'lead', reviewerId: 'rev', steps: [step()], openSamples: 0, ...e });

describe('audit engagements', () => {
  it('moves from planning to fieldwork to review to closed, by the right person', () => {
    expect(engagementMoveIssue(eng({ steps: [] }), 'FIELDWORK', 'lead', '')).toMatch(/at least one step/);
    expect(engagementMoveIssue(eng(), 'FIELDWORK', 'rev', '')).toMatch(/lead/);
    expect(engagementMoveIssue(eng(), 'REVIEW', 'lead', '')).toMatch(/cannot move/);
    expect(engagementMoveIssue(eng(), 'FIELDWORK', 'lead', '')).toBeNull();
    expect(engagementMoveIssue(eng({ status: 'FIELDWORK' }), 'REVIEW', 'lead', '')).toBe('1 step is not done yet');
    const done = [step({ status: 'DONE', doneById: 'staff' })];
    expect(engagementMoveIssue(eng({ status: 'FIELDWORK', steps: done, openSamples: 2 }), 'REVIEW', 'lead', '')).toBe('2 linked samples are still being tested');
    expect(engagementMoveIssue(eng({ status: 'FIELDWORK', steps: done }), 'REVIEW', 'lead', '')).toBeNull();
    expect(engagementMoveIssue(eng({ status: 'REVIEW', steps: done }), 'CLOSED', 'lead', 'x'.repeat(30))).toMatch(/reviewer/);
    expect(engagementMoveIssue(eng({ status: 'REVIEW', steps: done }), 'CLOSED', 'rev', 'x'.repeat(30))).toBe('1 step is not signed off yet');
    expect(engagementMoveIssue(eng({ status: 'REVIEW', steps: done }), 'FIELDWORK', 'rev', 'short')).toMatch(/needs more work/);
    expect(engagementMoveIssue(eng({ status: 'REVIEW', steps: done }), 'FIELDWORK', 'rev', 'Test two more months')).toBeNull();
    const signed = [step({ status: 'SIGNED_OFF', doneById: 'staff' })];
    expect(engagementMoveIssue(eng({ status: 'REVIEW', steps: signed }), 'CLOSED', 'rev', 'too short')).toMatch(/conclusion/);
    expect(engagementMoveIssue(eng({ status: 'REVIEW', steps: signed }), 'CLOSED', 'rev', 'Controls over payments work as designed')).toBeNull();
    expect(engagementMoveIssue(eng({ status: 'CLOSED', steps: signed }), 'REVIEW', 'rev', '')).toBe('This engagement is closed');
  });

  it('lets the assignee or lead do a step, and only the reviewer sign it off', () => {
    const f = eng({ status: 'FIELDWORK' });
    expect(stepDoneIssue(eng(), step(), 'staff', 'Checked every payment')).toMatch(/fieldwork/);
    expect(stepDoneIssue(f, step(), 'other', 'Checked every payment')).toMatch(/assigned/);
    expect(stepDoneIssue(f, step(), 'staff', 'ok')).toMatch(/10 characters/);
    expect(stepDoneIssue(f, step(), 'lead', 'Checked every payment')).toBeNull();
    expect(stepDoneIssue(f, step({ status: 'DONE' }), 'staff', 'Checked every payment')).toMatch(/already done/);
    const d = step({ status: 'DONE', doneById: 'staff' });
    expect(stepReviewIssue(f, step(), 'rev', 'SIGN_OFF', '')).toMatch(/not done/);
    expect(stepReviewIssue(f, d, 'lead', 'SIGN_OFF', '')).toMatch(/reviewer/);
    expect(stepReviewIssue(f, step({ status: 'DONE', doneById: 'rev' }), 'rev', 'SIGN_OFF', '')).toMatch(/themselves/);
    expect(stepReviewIssue(f, d, 'rev', 'REOPEN', 'no')).toMatch(/more work/);
    expect(stepReviewIssue(f, d, 'rev', 'SIGN_OFF', '')).toBeNull();
    expect(stepReviewIssue(eng({ status: 'CLOSED' }), d, 'rev', 'SIGN_OFF', '')).toMatch(/during fieldwork/);
    expect(engagementProgress([step(), d, step({ status: 'SIGNED_OFF' })])).toEqual({ steps: 3, done: 2, signedOff: 1 });
  });
});
