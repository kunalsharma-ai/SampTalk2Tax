import { describe, expect, it } from 'vitest';
import { replayComparison, replayIssue, replaySummary } from '../src';

describe('financial transaction replay (AUDIT-017)', () => {
  const then = [
    { accountId: 'bank', debit: '1000.00', credit: '0' },
    { accountId: 'capital', debit: '0', credit: '1000.00' },
  ];
  const now = [
    { accountId: 'bank', debit: '1000.00', credit: '250.00' },
    { accountId: 'capital', debit: '0', credit: '1000.00' },
    { accountId: 'rent', debit: '200.00', credit: '0' },
    { accountId: 'fees', debit: '50.00', credit: '0' },
  ];

  it('sets each balance then beside now, changed accounts first', () => {
    const rows = replayComparison(then, now);
    expect(rows).toEqual([
      { accountId: 'bank', recorded: '1000.00', current: '750.00', change: '-250.00' },
      { accountId: 'rent', recorded: '0.00', current: '200.00', change: '200.00' },
      { accountId: 'fees', recorded: '0.00', current: '50.00', change: '50.00' },
      { accountId: 'capital', recorded: '-1000.00', current: '-1000.00', change: '0.00' },
    ]);
    expect(replaySummary(rows)).toEqual({ accounts: 4, changedAccounts: 3, recordedBalances: true, currentBalances: true, netChange: '250.00' });
  });

  it('adds up several sums for one account and shows nothing changed when nothing was posted since', () => {
    const rows = replayComparison([...then, { accountId: 'bank', debit: '5.00', credit: '5.00' }], then);
    expect(rows.every((r) => r.change === '0.00')).toBe(true);
    expect(replaySummary(rows).changedAccounts).toBe(0);
    expect(replayComparison([], [])).toEqual([]);
  });

  it('replays only past moments and real dates', () => {
    const now = new Date('2026-11-21T10:00:00Z');
    expect(replayIssue(new Date('2026-11-20T10:00:00Z'), '2026-10-31', now)).toBeNull();
    expect(replayIssue(new Date('2026-11-22T10:00:00Z'), '2026-10-31', now)).toMatch(/in the past/);
    expect(replayIssue(new Date('nope'), '2026-10-31', now)).toMatch(/date and time/);
    expect(replayIssue(new Date('2026-11-20T10:00:00Z'), '2026-13-45', now)).toMatch(/YYYY-MM-DD/);
  });
});
