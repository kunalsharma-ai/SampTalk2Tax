import { describe, expect, it } from 'vitest';
import { aiLaneFor, aiWorkLimitIssues, mayStartAiWork, nextAiWork, type AiWork } from '../src/ai-work-lanes';

const limits = { total: 4, background: 2, perOrg: 2 };
const i = (orgId: string): AiWork => ({ orgId, lane: 'INTERACTIVE' });
const b = (orgId: string): AiWork => ({ orgId, lane: 'BACKGROUND' });

describe('AI work lanes', () => {
  it('puts runs, reminders and reviews in the background and people in front', () => {
    expect(aiLaneFor('BANK_MATCHING')).toBe('BACKGROUND');
    expect(aiLaneFor('CLOSE_REVIEW')).toBe('BACKGROUND');
    expect(aiLaneFor('COPILOT')).toBe('INTERACTIVE');
    expect(aiLaneFor('OTHER')).toBe('INTERACTIVE');
  });

  it('keeps room for people when background work is full', () => {
    const running = [b('o1'), b('o2')];
    expect(mayStartAiWork(running, b('o3'), limits)).toBe(false);
    expect(mayStartAiWork(running, i('o3'), limits)).toBe(true);
    expect(mayStartAiWork([...running, i('o3'), i('o4')], i('o5'), limits)).toBe(false);
  });

  it('keeps one organisation from taking every call', () => {
    expect(mayStartAiWork([i('o1'), i('o1')], i('o1'), limits)).toBe(false);
    expect(mayStartAiWork([i('o1'), i('o1')], i('o2'), limits)).toBe(true);
  });

  it('starts people first, then background, and skips a call that cannot start', () => {
    expect(nextAiWork([b('o2'), i('o2')], [], limits)).toBe(1);
    // o1 is at its limit, so the o2 call behind it starts.
    expect(nextAiWork([i('o1'), i('o2')], [i('o1'), i('o1')], limits)).toBe(1);
    expect(nextAiWork([b('o3')], [b('o1'), b('o2')], limits)).toBe(-1);
    expect(nextAiWork([], [], limits)).toBe(-1);
  });

  it('checks the limits leave room for people', () => {
    expect(aiWorkLimitIssues(limits)).toEqual([]);
    expect(aiWorkLimitIssues({ total: 4, background: 4, perOrg: 1 })).toEqual(['Background AI calls must leave room for people: allow fewer than the total']);
    expect(aiWorkLimitIssues({ total: 1, background: 0, perOrg: 0 })).toHaveLength(3);
  });
});
