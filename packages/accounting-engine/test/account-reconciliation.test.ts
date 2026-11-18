import { describe, expect, it } from 'vitest';
import { D, naturalBalance, reconcileAccount, reconItemIssues, reconState } from '../src';

describe('account reconciliation', () => {
  it('reads balances in the natural sign of the account', () => {
    expect(naturalBalance('ASSET', new D('500'), new D('120')).toFixed(2)).toBe('380.00');
    expect(naturalBalance('LIABILITY', new D('500'), new D('120')).toFixed(2)).toBe('-380.00');
    expect(naturalBalance('EQUITY', new D('0'), new D('1000')).toFixed(2)).toBe('1000.00');
  });

  it('explains the ledger balance with supporting balances and reconciling items', () => {
    const r = reconcileAccount('18000.00', [
      { amount: '12000', kind: 'SUPPORT' },
      { amount: '6500.00', kind: 'SUPPORT' },
      { amount: '-500', kind: 'RECONCILING' },
    ]);
    expect([r.supported.toFixed(2), r.reconciling.toFixed(2), r.explained.toFixed(2), r.difference.toFixed(2), r.balanced]).toEqual(['18500.00', '-500.00', '18000.00', '0.00', true]);
    const short = reconcileAccount('18000.00', [{ amount: '17999.99', kind: 'SUPPORT' }]);
    expect([short.difference.toFixed(2), short.balanced]).toEqual(['0.01', false]);
    expect(reconcileAccount('0', []).balanced).toBe(true);
  });

  it('checks the items as entered', () => {
    expect(reconItemIssues([{ description: 'Loan statement', amount: '100.50', kind: 'SUPPORT' }])).toEqual([]);
    expect(reconItemIssues([
      { description: ' ', amount: '1', kind: 'SUPPORT' },
      { description: 'x', amount: 'abc', kind: 'SUPPORT' },
      { description: 'y', amount: '1.005', kind: 'RECONCILING' },
      { description: 'z', amount: '0', kind: 'SUPPORT' },
    ])).toEqual(['Item 1: say what it is', 'Item 2: the amount abc is not a number', 'Item 3: use at most 2 decimal places', 'Item 4: an item of nil does not explain anything']);
  });

  it('flags sign-offs the ledger has moved away from', () => {
    expect(reconState(null, '10')).toBe('NOT_STARTED');
    expect(reconState({ status: 'DRAFT', ledgerBalance: '5' }, '10')).toBe('DRAFT');
    expect(reconState({ status: 'PREPARED', ledgerBalance: '10.00' }, '10')).toBe('PREPARED');
    expect(reconState({ status: 'REVIEWED', ledgerBalance: '10' }, '10')).toBe('REVIEWED');
    expect(reconState({ status: 'REVIEWED', ledgerBalance: '10' }, '12')).toBe('CHANGED');
  });
});
