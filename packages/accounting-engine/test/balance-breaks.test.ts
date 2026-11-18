import { describe, expect, it } from 'vitest';
import { balanceBreaks, D, parseStatement } from '../src';

const CSV = `Date,Narration,Amount,Balance
01/11/2026,Opening deposit,100000.00,100000.00
03/11/2026,Rent,-25000.00,75000.00
05/11/2026,Customer receipt,40000.00,127000.00
06/11/2026,Power bill,-3000.00,124000.00
`;
const map = { date: 0, description: 1, amount: 2, balance: 3, dateFormat: 'DD/MM/YYYY' as const, hasHeader: true };

describe('missing statement lines from the running balance', () => {
  it('reads the balance column and finds the gap', () => {
    const lines = parseStatement(CSV, map, 'INR');
    expect(lines[2].balance!.toFixed()).toBe('127000');
    const r = balanceBreaks(lines);
    expect(r.checked).toBe(4);
    expect(r.order).toBe('OLDEST_FIRST');
    expect(r.breaks.map((b) => [b.previousRow, b.row, b.expected.toFixed(), b.shown.toFixed(), b.gap.toFixed()])).toEqual([[3, 4, '115000', '127000', '12000']]);
  });

  it('works out a newest-first file', () => {
    const rows = CSV.trim().split('\n');
    const lines = parseStatement([rows[0], ...rows.slice(1).reverse()].join('\n'), map, 'INR');
    const r = balanceBreaks(lines);
    expect(r.order).toBe('NEWEST_FIRST');
    expect(r.breaks).toHaveLength(1);
    expect(r.breaks[0].gap.toFixed()).toBe('12000');
  });

  it('finds nothing when the balances follow, and needs two balances to check', () => {
    const ok = [
      { row: 2, date: '2026-11-01', amount: new D('10'), balance: new D('10') },
      { row: 3, date: '2026-11-02', amount: new D('-4'), balance: new D('6') },
    ];
    expect(balanceBreaks(ok)).toEqual({ checked: 2, order: 'OLDEST_FIRST', breaks: [] });
    expect(balanceBreaks([{ ...ok[0], balance: null }, ok[1]])).toEqual({ checked: 1, order: null, breaks: [] });
    expect(parseStatement(CSV, { ...map, balance: null }, 'INR')[0].balance).toBeNull();
  });

  it('refuses a balance that is not an amount', () => {
    expect(() => parseStatement('Date,N,Amt,Bal\n01/11/2026,X,5.00,abc\n', map, 'INR')).toThrow(/Row 2: "abc" is not an amount/);
  });
});
