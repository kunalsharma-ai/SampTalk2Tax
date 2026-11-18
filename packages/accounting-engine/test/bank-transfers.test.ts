import { describe, expect, it } from 'vitest';
import { D, suggestTransfers } from '../src';

const accounts = [
  { id: 'hdfc', code: '1120', name: 'HDFC Current Account' },
  { id: 'icici', code: '1130', name: 'ICICI Savings' },
  { id: 'cash', code: '1110', name: 'Petty Cash' },
];
const line = (id: string, accountId: string, date: string, amount: string, text = 'Synthetic') => ({ id, accountId, date, amount: new D(amount), text });

describe('transfers between own accounts', () => {
  it('pairs money out of one account with the same amount into another within three days', () => {
    const s = suggestTransfers(
      [line('o1', 'hdfc', '2026-11-10', '-50000', 'NEFT to ICICI sweep'), line('i1', 'icici', '2026-11-11', '50000', 'NEFT from HDFC'), line('x', 'hdfc', '2026-11-11', '50000', 'Customer receipt')],
      accounts,
    );
    expect(s).toEqual([
      { outLineId: 'o1', inLineId: 'i1', fromAccountId: 'hdfc', toAccountId: 'icici', days: 1, score: 90, reasons: ['Same amount out and in', '1 day apart', 'Described as a transfer', 'Names the other account'], unique: true },
    ]);
  });

  it('ignores the same account, other amounts and lines too far apart', () => {
    expect(suggestTransfers([line('o', 'hdfc', '2026-11-10', '-100'), line('i', 'hdfc', '2026-11-10', '100')], accounts)).toEqual([]);
    expect(suggestTransfers([line('o', 'hdfc', '2026-11-10', '-100'), line('i', 'icici', '2026-11-10', '100.01')], accounts)).toEqual([]);
    expect(suggestTransfers([line('o', 'hdfc', '2026-11-10', '-100'), line('i', 'icici', '2026-11-14', '100')], accounts)).toEqual([]);
  });

  it('uses each line once, the best pair first, and says when there was a choice', () => {
    const s = suggestTransfers(
      [line('o', 'hdfc', '2026-11-10', '-2000', 'Cash withdrawal'), line('far', 'icici', '2026-11-12', '2000'), line('near', 'cash', '2026-11-10', '2000', 'Cash from bank')],
      accounts,
    );
    expect(s.map((x) => [x.outLineId, x.inLineId, x.unique])).toEqual([['o', 'near', false]]);
  });
});
