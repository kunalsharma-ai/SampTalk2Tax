import { describe, expect, it } from 'vitest';
import { taxNoticeIssues, taxNoticeUrgency } from '../src';

const base = { authority: 'GST' as const, reference: 'ZD2711250012345', subject: 'Mismatch in GSTR-1 and GSTR-3B', receivedOn: '2026-11-01' };

describe('tax notices', () => {
  it('are checked as entered', () => {
    expect(taxNoticeIssues({ ...base, section: 'ASMT-10', responseDue: '2026-12-01', demand: '125000.50' }, 'INR', '2026-11-17')).toEqual([]);
    expect(taxNoticeIssues({ ...base, reference: ' ', subject: '', receivedOn: '2026-11-20', responseDue: '2026-11-10', demand: '1.005' }, 'INR', '2026-11-17')).toEqual([
      'Enter the notice number (DIN, ARN or reference on the letter)',
      'Say what the notice is about',
      'The notice cannot be received in the future',
      'The reply cannot be due before the notice was received',
      'The amount demanded has at most 2 decimal places',
    ]);
    expect(taxNoticeIssues({ ...base, demand: '-5' }, 'INR', '2026-11-17')).toEqual(['The amount demanded cannot be negative']);
  });

  it('are overdue, due soon or upcoming while open', () => {
    expect(taxNoticeUrgency({ status: 'OPEN', responseDue: '2026-11-16' }, '2026-11-17')).toEqual({ urgency: 'OVERDUE', daysLeft: -1 });
    expect(taxNoticeUrgency({ status: 'OPEN', responseDue: '2026-11-24' }, '2026-11-17')).toEqual({ urgency: 'DUE_SOON', daysLeft: 7 });
    expect(taxNoticeUrgency({ status: 'OPEN', responseDue: '2026-11-25' }, '2026-11-17')).toEqual({ urgency: 'UPCOMING', daysLeft: 8 });
    expect(taxNoticeUrgency({ status: 'OPEN', responseDue: null }, '2026-11-17')).toEqual({ urgency: 'NO_DEADLINE', daysLeft: null });
    expect(taxNoticeUrgency({ status: 'RESPONDED', responseDue: '2026-11-01' }, '2026-11-17')).toEqual({ urgency: 'DONE', daysLeft: null });
  });
});
