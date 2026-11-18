import { describe, expect, it } from 'vitest';
import { bankWatch, type WatchedAccount } from '../src';

const acc = (p: Partial<WatchedAccount>): WatchedAccount => ({ id: 'a', code: '1120', name: 'Operating', subtype: 'BANK', ledgerBalance: '50000', unmatchedLines: 0, lastReconciled: '2026-11-01', firstActivity: '2026-01-01', ...p });
const run = (a: WatchedAccount[], min = '10000') => bankWatch(a, '2026-11-18', { minBalance: min, unreconciledDays: 45 }).map((f) => [f.accountId, f.code, f.severity, f.days]);

describe('bank account watch', () => {
  it('flags overdrawn and low balances', () => {
    expect(run([acc({ id: 'od', ledgerBalance: '-1' }), acc({ id: 'low', ledgerBalance: '9999.99' }), acc({ id: 'ok', ledgerBalance: '10000' })])).toEqual([
      ['od', 'OVERDRAWN', 'CRITICAL', null],
      ['low', 'LOW_BALANCE', 'WARNING', null],
    ]);
    expect(run([acc({ ledgerBalance: '5' })], '0')).toEqual([]);
  });

  it('flags accounts not reconciled for too long, from the first activity when never reconciled', () => {
    expect(run([acc({ id: 'stale', lastReconciled: '2026-10-01' }), acc({ id: 'never', lastReconciled: null, firstActivity: '2026-09-01' }), acc({ id: 'new', lastReconciled: null, firstActivity: '2026-11-10' })])).toEqual([
      ['stale', 'NOT_RECONCILED', 'WARNING', 48],
      ['never', 'NOT_RECONCILED', 'WARNING', 78],
    ]);
  });

  it('leaves cash in hand and unused accounts out of the reconciliation check', () => {
    expect(run([acc({ subtype: 'CASH', lastReconciled: null }), acc({ firstActivity: null, lastReconciled: null })])).toEqual([]);
  });

  it('does not watch the balance of an account never used', () => {
    expect(run([acc({ id: 'box', subtype: 'CASH', ledgerBalance: '0', firstActivity: null })])).toEqual([]);
    expect(run([acc({ id: 'box', subtype: 'CASH', ledgerBalance: '0' })])).toEqual([['box', 'LOW_BALANCE', 'WARNING', null]]);
  });
});
