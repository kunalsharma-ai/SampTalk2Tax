import { describe, expect, it } from 'vitest';
import { allocateAmount, allocationLines, allocationTargetIssues, D } from '../src';

const T = [
  { id: 'sales', percent: '50' },
  { id: 'ops', percent: '33.3333' },
  { id: 'admin', percent: '16.6667' },
];

describe('cost allocation', () => {
  it('checks the shares', () => {
    expect(allocationTargetIssues(T, null)).toEqual([]);
    expect(allocationTargetIssues([{ id: 'a', percent: '100' }], null)).toEqual(['Spread the cost to at least two cost centres']);
    expect(allocationTargetIssues([{ id: 'a', percent: '60' }, { id: 'b', percent: '30' }], null)).toEqual(['The shares add up to 90 percent, not 100']);
    expect(allocationTargetIssues([{ id: 'a', percent: '50' }, { id: 'a', percent: '50' }], 'a')).toEqual(['The cost centre the cost comes from cannot also receive it', 'Each cost centre appears once']);
    expect(allocationTargetIssues([{ id: 'a', percent: '0' }, { id: 'b', percent: 'x' }], null)).toEqual(expect.arrayContaining(['Each share is more than 0 and at most 100 percent', 'x is not a percentage']));
  });

  it('splits an amount so the parts add up exactly, the remainder on the largest share', () => {
    const parts = allocateAmount('100.00', T);
    expect(parts.map((p) => p.amount.toFixed(2))).toEqual(['50.00', '33.33', '16.67']);
    const odd = allocateAmount('0.10', [{ id: 'a', percent: '33.3333' }, { id: 'b', percent: '33.3333' }, { id: 'c', percent: '33.3334' }]);
    expect(odd.map((p) => p.amount.toFixed(2))).toEqual(['0.03', '0.03', '0.04']);
    expect(odd.reduce((s, p) => s.plus(p.amount), new D(0)).toFixed(2)).toBe('0.10');
  });

  it('moves each account out of the source and into the targets, balanced', () => {
    const lines = allocationLines([{ accountId: 'rent', net: '60000' }, { accountId: 'power', net: '0' }, { accountId: 'refund', net: '-300' }], null, T.slice(0, 2).map((t, i) => ({ ...t, percent: i ? '50' : '50' })), 'Rent split');
    expect(lines.map((l) => [l.accountId, l.departmentId, l.debit ?? '', l.credit ?? ''])).toEqual([
      ['rent', null, '', '60000.00'],
      ['rent', 'sales', '30000.00', ''],
      ['rent', 'ops', '30000.00', ''],
      ['refund', null, '300.00', ''],
      ['refund', 'sales', '', '150.00'],
      ['refund', 'ops', '', '150.00'],
    ]);
    const dr = lines.reduce((s, l) => s.plus(l.debit ?? 0), new D(0));
    const cr = lines.reduce((s, l) => s.plus(l.credit ?? 0), new D(0));
    expect(dr.equals(cr)).toBe(true);
  });
});
