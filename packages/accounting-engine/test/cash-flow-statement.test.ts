import { describe, expect, it } from 'vitest';
import { buildCashFlowStatement, type AccountMovement } from '../src';

type T = AccountMovement['type'];
const acct = (code: string, type: T, subtype: string | null, name = code) => ({ accountId: `id-${code}`, code, name, type, subtype });
const A = {
  bank: acct('1100', 'ASSET', 'BANK', 'Bank'),
  cash: acct('1000', 'ASSET', 'CASH', 'Cash'),
  ar: acct('1200', 'ASSET', 'ACCOUNTS_RECEIVABLE', 'Receivables'),
  fa: acct('1500', 'ASSET', 'FIXED_ASSET', 'Equipment'),
  dep: acct('1590', 'ASSET', 'ACCUMULATED_DEPRECIATION', 'Accumulated depreciation'),
  ap: acct('2000', 'LIABILITY', 'ACCOUNTS_PAYABLE', 'Payables'),
  loan: acct('2700', 'LIABILITY', 'LONG_TERM_DEBT', 'Term loan'),
  cap: acct('3000', 'EQUITY', 'SHARE_CAPITAL', 'Share capital'),
  sales: acct('4000', 'REVENUE', 'OPERATING_REVENUE', 'Sales'),
  rent: acct('6000', 'EXPENSE', 'OPERATING_EXPENSE', 'Rent'),
  depx: acct('6800', 'EXPENSE', 'DEPRECIATION', 'Depreciation'),
};

/** Post simple two-line journals and total them per account, as the ledger would. */
function movements(journals: [keyof typeof A, keyof typeof A, string][]): AccountMovement[] {
  const t = new Map<string, { debit: bigint; credit: bigint }>();
  const cents = (s: string) => BigInt(s.replace('.', ''));
  for (const [dr, cr, amt] of journals) {
    for (const [k, side] of [[dr, 'debit'], [cr, 'credit']] as const) {
      const row = t.get(k) ?? { debit: 0n, credit: 0n };
      row[side] += cents(amt);
      t.set(k, row);
    }
  }
  const fmt = (c: bigint) => `${c / 100n}.${(c % 100n).toString().padStart(2, '0')}`;
  return (Object.keys(A) as (keyof typeof A)[]).map((k) => ({ ...A[k], debit: fmt(t.get(k)?.debit ?? 0n), credit: fmt(t.get(k)?.credit ?? 0n) }));
}

describe('statement of cash flows, indirect method (RPT-004)', () => {
  const year = movements([
    ['bank', 'cap', '100000.00'], // shares issued for cash
    ['fa', 'bank', '30000.00'], // equipment bought
    ['ar', 'sales', '50000.00'], // sales on credit
    ['bank', 'ar', '20000.00'], // customers paid
    ['rent', 'cash', '10000.00'], // rent paid in cash
    ['depx', 'dep', '3000.00'], // depreciation
    ['bank', 'loan', '25000.00'], // loan drawn
    ['rent', 'ap', '8000.00'], // rent bill not yet paid
  ]);
  const s = buildCashFlowStatement(year);

  it('starts from profit and adds back depreciation and working-capital changes', () => {
    expect(s.profit.toFixed(2)).toBe('29000.00');
    expect(s.operating.lines.map((l) => [l.code, l.group, l.amount.toFixed(2)])).toEqual([
      ['1590', 'NON_CASH', '3000.00'],
      ['1200', 'WORKING_CAPITAL', '-30000.00'],
      ['2000', 'WORKING_CAPITAL', '8000.00'],
    ]);
    expect(s.operating.total.toFixed(2)).toBe('10000.00');
  });

  it('puts asset purchases under investing and borrowing and shares under financing', () => {
    expect(s.investing.lines.map((l) => [l.code, l.amount.toFixed(2)])).toEqual([['1500', '-30000.00']]);
    expect(s.investing.total.toFixed(2)).toBe('-30000.00');
    expect(s.financing.lines.map((l) => [l.code, l.amount.toFixed(2)])).toEqual([['2700', '25000.00'], ['3000', '100000.00']]);
    expect(s.financing.total.toFixed(2)).toBe('125000.00');
  });

  it('explains exactly the change in cash and bank', () => {
    expect(s.netChange.toFixed(2)).toBe('105000.00');
    expect(s.explained.toFixed(2)).toBe('105000.00');
    expect(s.reconciles).toBe(true);
    expect(s.unclassified).toEqual([]);
  });

  it('moves between cash and bank are not cash flows', () => {
    const t = buildCashFlowStatement(movements([['cash', 'bank', '500.00']]));
    expect(t.netChange.isZero()).toBe(true);
    expect([...t.operating.lines, ...t.investing.lines, ...t.financing.lines]).toEqual([]);
  });

  it('shows a balance-sheet account with no subtype under operating, and names it', () => {
    const odd = { accountId: 'id-1800', code: '1800', name: 'Suspense', type: 'ASSET' as const, subtype: null, debit: '700.00', credit: '0.00' };
    const t = buildCashFlowStatement([...movements([]), odd, { ...A.bank, debit: '0.00', credit: '700.00' }]);
    expect(t.operating.lines.map((l) => [l.code, l.group, l.amount.toFixed(2)])).toEqual([['1800', 'UNCLASSIFIED', '-700.00']]);
    expect(t.unclassified).toEqual(['1800 Suspense']);
    expect(t.reconciles).toBe(true);
  });

  it('does not reconcile when the movements do not balance, so the screen can say so', () => {
    const broken = movements([['bank', 'sales', '100.00']]).map((m) => (m.code === '4000' ? { ...m, credit: '90.00' } : m));
    expect(buildCashFlowStatement(broken).reconciles).toBe(false);
  });
});
