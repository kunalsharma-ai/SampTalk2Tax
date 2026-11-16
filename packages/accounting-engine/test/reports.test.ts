import { describe, expect, it } from 'vitest';
import {
  AccountMovement,
  AccountType,
  D,
  Dec,
  PostingAccount,
  buildAccountLedger,
  buildBalanceSheet,
  buildIncomeStatement,
  buildTrialBalance,
  validateJournal,
} from '../src';

const chart: { id: string; code: string; name: string; type: AccountType }[] = [
  { id: 'cash', code: '1110', name: 'Cash', type: 'ASSET' },
  { id: 'ar', code: '1200', name: 'AR', type: 'ASSET' },
  { id: 'ap', code: '2100', name: 'AP', type: 'LIABILITY' },
  { id: 'cap', code: '3100', name: 'Capital', type: 'EQUITY' },
  { id: 'rev', code: '4100', name: 'Sales', type: 'REVENUE' },
  { id: 'rent', code: '6200', name: 'Rent', type: 'EXPENSE' },
];

function movements(entries: { accountId: string; debit: Dec; credit: Dec }[]): AccountMovement[] {
  return chart.map((a) => {
    const mine = entries.filter((e) => e.accountId === a.id);
    return {
      accountId: a.id,
      code: a.code,
      name: a.name,
      type: a.type,
      debit: mine.reduce((s, e) => s.plus(e.debit), new D(0)),
      credit: mine.reduce((s, e) => s.plus(e.credit), new D(0)),
    };
  });
}

describe('reports', () => {
  const lines = [
    { accountId: 'cash', debit: new D('50000'), credit: new D(0) },
    { accountId: 'cap', debit: new D(0), credit: new D('50000') },
    { accountId: 'ar', debit: new D('11800'), credit: new D(0) },
    { accountId: 'rev', debit: new D(0), credit: new D('11800') },
    { accountId: 'rent', debit: new D('15000'), credit: new D(0) },
    { accountId: 'ap', debit: new D(0), credit: new D('15000') },
  ];

  it('builds a balanced trial balance', () => {
    const tb = buildTrialBalance(movements(lines));
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit.toFixed(2)).toBe('76800.00');
    const rev = tb.rows.find((r) => r.code === '4100')!;
    expect(rev.balance.toFixed(2)).toBe('11800.00');
    expect(rev.netCredit.toFixed(2)).toBe('11800.00');
  });

  it('builds an income statement and a balance sheet that ties out', () => {
    const is = buildIncomeStatement(movements(lines));
    expect(is.netIncome.toFixed(2)).toBe('-3200.00');
    const bs = buildBalanceSheet(movements(lines));
    expect(bs.totalAssets.toFixed(2)).toBe('61800.00');
    expect(bs.unclosedEarnings.toFixed(2)).toBe('-3200.00');
    expect(bs.balanced).toBe(true);
  });

  it('computes a running ledger balance on the normal side', () => {
    const rows = buildAccountLedger('LIABILITY', new D('100'), [
      { date: '2026-01-02', entryNumber: 2, journalId: 'b', debit: '40', credit: '0' },
      { date: '2026-01-01', entryNumber: 1, journalId: 'a', debit: '0', credit: '60' },
    ]);
    expect(rows.map((r) => r.runningBalance.toFixed(0))).toEqual(['160', '120']);
  });

  it('property: any set of valid journals yields a balanced TB and balance sheet', () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const accounts = new Map<string, PostingAccount>(chart.map((a) => [a.id, { ...a, isPostable: true, isActive: true }]));
    const posted: { accountId: string; debit: Dec; credit: Dec }[] = [];
    for (let j = 0; j < 300; j++) {
      const n = 2 + Math.floor(rnd() * 5);
      const raw = Array.from({ length: n - 1 }, () => ({
        accountId: chart[Math.floor(rnd() * chart.length)].id,
        amt: new D(Math.floor(rnd() * 10_000_000)).dividedBy(100),
        side: rnd() < 0.5 ? 'debit' : 'credit',
      })).filter((r) => !r.amt.isZero());
      if (raw.length === 0) continue;
      const net = raw.reduce((s, r) => (r.side === 'debit' ? s.plus(r.amt) : s.minus(r.amt)), new D(0));
      if (net.isZero()) continue;
      const lines = raw.map((r) => ({ accountId: r.accountId, [r.side]: r.amt.toFixed(2) }));
      lines.push({ accountId: chart[Math.floor(rnd() * chart.length)].id, [net.isPositive() ? 'credit' : 'debit']: net.abs().toFixed(2) });
      const v = validateJournal(lines, { functionalCurrency: 'USD', accounts });
      posted.push(...v.lines.map((l) => ({ accountId: l.accountId, debit: l.functionalDebit, credit: l.functionalCredit })));
    }
    expect(posted.length).toBeGreaterThan(500);
    expect(buildTrialBalance(movements(posted)).balanced).toBe(true);
    expect(buildBalanceSheet(movements(posted)).balanced).toBe(true);
  });
});
