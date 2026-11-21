import { describe, expect, it } from 'vitest';
import { engagementMoveIssue, evidenceOverdue, evidenceReviewIssue, evidenceSubmitIssue, evidenceSummary, type EvidenceEngagement, type EvidenceRequestState } from '../src';

const eng = (e: Partial<EvidenceEngagement> = {}): EvidenceEngagement => ({ status: 'FIELDWORK', leadId: 'lead', reviewerId: 'rev', ...e });
const req = (r: Partial<EvidenceRequestState> = {}): EvidenceRequestState => ({ status: 'REQUESTED', ownerId: 'staff', submittedById: null, ...r });

describe('audit evidence requests', () => {
  it('is submitted with files by the person asked, or the lead', () => {
    expect(evidenceSubmitIssue(eng(), req(), 'other', 1, '')).toMatch(/Only the person asked/);
    expect(evidenceSubmitIssue(eng(), req(), 'staff', 0, '')).toBe('Attach at least one file first');
    expect(evidenceSubmitIssue(eng(), req(), 'staff', 2, '')).toBeNull();
    expect(evidenceSubmitIssue(eng(), req(), 'lead', 1, '')).toBeNull();
    expect(evidenceSubmitIssue(eng(), req({ status: 'SUBMITTED' }), 'staff', 1, '')).toMatch(/already submitted/);
    expect(evidenceSubmitIssue(eng({ status: 'CLOSED' }), req(), 'staff', 1, '')).toMatch(/closed/);
  });

  it('is accepted or returned by the lead or reviewer, never by whoever submitted it', () => {
    const sub = req({ status: 'SUBMITTED', submittedById: 'lead' });
    expect(evidenceReviewIssue(eng(), sub, 'staff', 'ACCEPT', '')).toMatch(/lead or reviewer/);
    expect(evidenceReviewIssue(eng(), sub, 'lead', 'ACCEPT', '')).toMatch(/Someone other/);
    expect(evidenceReviewIssue(eng(), sub, 'rev', 'RETURN', 'no')).toMatch(/what is missing/);
    expect(evidenceReviewIssue(eng(), sub, 'rev', 'ACCEPT', '')).toBeNull();
    expect(evidenceReviewIssue(eng(), req(), 'rev', 'ACCEPT', '')).toMatch(/not been submitted/);
    expect(evidenceReviewIssue(eng(), req({ status: 'ACCEPTED' }), 'rev', 'ACCEPT', '')).toMatch(/already accepted/);
  });

  it('counts overdue requests and holds the engagement until evidence is accepted', () => {
    expect(evidenceOverdue({ status: 'REQUESTED', dueDate: '2026-01-01' }, '2026-01-02')).toBe(true);
    expect(evidenceOverdue({ status: 'SUBMITTED', dueDate: '2026-01-01' }, '2026-01-02')).toBe(false);
    expect(evidenceSummary([{ status: 'REQUESTED', dueDate: '2026-01-01' }, { status: 'ACCEPTED', dueDate: '2026-01-01' }, { status: 'SUBMITTED', dueDate: '2026-02-01' }], '2026-01-15')).toEqual({ requested: 1, submitted: 1, accepted: 1, overdue: 1 });
    const done = [{ id: 's', status: 'DONE' as const, assigneeId: 'staff', doneById: 'staff' }];
    expect(engagementMoveIssue({ status: 'FIELDWORK', leadId: 'lead', reviewerId: 'rev', steps: done, openSamples: 0, openEvidence: 2 }, 'REVIEW', 'lead', '')).toBe('2 evidence requests are not accepted yet');
  });
});
