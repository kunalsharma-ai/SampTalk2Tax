import { describe, expect, it } from 'vitest';
import { yearEndClosing, yearEndStatus, yearProfit } from '../src/year-end';

const acc = (id: string, code: string, type: 'REVENUE' | 'EXPENSE', debit: string, credit: string) => ({ accountId: id, code, name: `Account ${code}`, type, debit, credit });

describe('year-end closing', () => {
  it('brings each revenue and expense account to nil and credits the profit to retained earnings', () => {
    const c = yearEndClosing([acc('e1', '6200', 'EXPENSE', '300000', '0'), acc('r1', '4100', 'REVENUE', '1000', '501000.51'), acc('e2', '5000', 'EXPENSE', '120000.25', '250')], 're', 'FY 2025-26', 'INR');
    expect(c.lines.map((l) => [l.accountId, l.debit, l.credit])).toEqual([
      ['r1', '500000.51', '0.00'],
      ['e2', '0.00', '119750.25'],
      ['e1', '0.00', '300000.00'],
      ['re', '0.00', '80250.26'],
    ]);
    expect(c.toRetainedEarnings).toBe('80250.26');
    expect(c.accounts).toBe(3);
    expect(c.lines[3].description).toBe('FY 2025-26: profit to retained earnings');
  });

  it('charges a loss to retained earnings, and posts nothing when every account is already nil', () => {
    const loss = yearEndClosing([acc('r1', '4100', 'REVENUE', '0', '100'), acc('e1', '6200', 'EXPENSE', '250', '0')], 're', 'FY 2025', 'USD');
    expect(loss.lines.at(-1)).toMatchObject({ accountId: 're', debit: '150.00', credit: '0.00', description: 'FY 2025: loss to retained earnings' });
    expect(loss.toRetainedEarnings).toBe('-150.00');
    const done = yearEndClosing([acc('r1', '4100', 'REVENUE', '100', '100'), acc('e1', '6200', 'EXPENSE', '0', '0')], 're', 'FY 2025', 'USD');
    expect(done).toEqual({ lines: [], toRetainedEarnings: '0.00', accounts: 0 });
  });

  it('balances revenue against expenses exactly, with no retained-earnings line when they net to nil', () => {
    const c = yearEndClosing([acc('r1', '4100', 'REVENUE', '0', '500'), acc('e1', '6200', 'EXPENSE', '500', '0')], 're', 'FY', 'INR');
    expect(c.lines).toHaveLength(2);
    expect(c.toRetainedEarnings).toBe('0.00');
    const sum = (k: 'debit' | 'credit') => c.lines.reduce((s, l) => s + Number(l[k]), 0);
    expect(sum('debit')).toBe(sum('credit'));
  });

  it('refuses a revenue or expense account as retained earnings', () => {
    expect(() => yearEndClosing([acc('r1', '4100', 'REVENUE', '0', '1')], 'r1', 'FY', 'INR')).toThrow(/equity account/);
  });

  it('reports the profit and where the year stands', () => {
    expect(yearProfit([{ debit: '10', credit: '35.5' }, { debit: '40', credit: '0' }], 'INR')).toBe('-14.50');
    expect(yearEndStatus({ hasActiveClose: false, accountsLeft: 0 })).toBe('NOTHING_TO_CLOSE');
    expect(yearEndStatus({ hasActiveClose: false, accountsLeft: 3 })).toBe('NOT_CLOSED');
    expect(yearEndStatus({ hasActiveClose: true, accountsLeft: 0 })).toBe('CLOSED');
    expect(yearEndStatus({ hasActiveClose: true, accountsLeft: 1 })).toBe('OUT_OF_DATE');
  });
});
