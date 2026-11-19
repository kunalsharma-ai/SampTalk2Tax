import { describe, expect, it } from 'vitest';
import { RETENTION_CATEGORIES, retentionCutoff, retentionProblems, statutoryRecords } from '../src';

describe('data retention', () => {
  it('checks periods against each kind of data', () => {
    expect(RETENTION_CATEGORIES.map((c) => [c.key, c.minDays])).toEqual([
      ['COPILOT_CONVERSATIONS', 90],
      ['CRM_WEBHOOK_DELIVERIES', 30],
    ]);
    expect(retentionProblems('COPILOT_CONVERSATIONS', null)).toEqual([]);
    expect(retentionProblems('COPILOT_CONVERSATIONS', 90)).toEqual([]);
    expect(retentionProblems('COPILOT_CONVERSATIONS', 89)).toEqual(['Copilot conversations: the shortest period is 90 days']);
    expect(retentionProblems('CRM_WEBHOOK_DELIVERIES', 3651)).toEqual(['CRM webhook delivery log: the longest period is 3650 days; choose Keep to keep it for good']);
    expect(retentionProblems('CRM_WEBHOOK_DELIVERIES', 45.5)).toEqual(['Use a whole number of days']);
    expect(retentionProblems('JOURNALS', 30)).toEqual(['Not a kind of data with a retention period: JOURNALS']);
  });

  it('works out the cutoff, and lists what the law requires to be kept', () => {
    expect(retentionCutoff(90, new Date('2026-11-19T00:00:00Z')).toISOString()).toBe('2026-08-21T00:00:00.000Z');
    expect(statutoryRecords('IN').map((r) => r.basis)).toEqual(['Companies Act, 2013, section 128(5)', 'CGST Act, 2017, section 36', 'Income-tax Rules, 1962, rule 6F(5)']);
    expect(statutoryRecords('US')).toHaveLength(1);
  });
});
