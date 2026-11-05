import { describe, expect, it } from 'vitest';
import { ACCOUNT_SUBTYPES, AccountMovement, buildBalanceSheet, buildIncomeStatement, buildStatutoryStatements, defaultStatutoryFormat, STATUTORY_FORMAT_IDS, statutoryFormat, unmappedSubtypes } from '../src';

let n = 0;
const m = (code: string, type: AccountMovement['type'], subtype: string | null, debit: string, credit = '0'): AccountMovement => ({ accountId: `a${++n}`, code, name: code, type, subtype, debit, credit });

// A small set of books: capital in, loan, a fixed asset with depreciation, sales, costs, tax.
const position: AccountMovement[] = [
  m('1120', 'ASSET', 'BANK', '900000', '310000'),
  m('1200', 'ASSET', 'ACCOUNTS_RECEIVABLE', '236000', '0'),
  m('1450', 'ASSET', 'TAX_RECEIVABLE', '9000', '0'),
  m('1510', 'ASSET', 'FIXED_ASSET', '200000', '0'),
  m('1520', 'ASSET', 'ACCUMULATED_DEPRECIATION', '0', '20000'),
  m('1999', 'ASSET', null, '5000', '0'),
  m('2100', 'LIABILITY', 'ACCOUNTS_PAYABLE', '0', '134000'),
  m('2300', 'LIABILITY', 'TAX_PAYABLE', '0', '36000'),
  m('2700', 'LIABILITY', 'LONG_TERM_DEBT', '0', '300000'),
  m('3100', 'EQUITY', 'SHARE_CAPITAL', '0', '500000'),
  m('3300', 'EQUITY', 'OWNER_DRAWINGS', '10000', '0'),
  m('4100', 'REVENUE', 'OPERATING_REVENUE', '0', '200000'),
  m('4900', 'REVENUE', 'OTHER_INCOME', '0', '5000'),
  m('5000', 'EXPENSE', 'COST_OF_SALES', '50000', '0'),
  m('6100', 'EXPENSE', 'PAYROLL_EXPENSE', '40000', '0'),
  m('6200', 'EXPENSE', 'OPERATING_EXPENSE', '12000', '0'),
  m('6800', 'EXPENSE', 'DEPRECIATION', '20000', '0'),
  m('7100', 'EXPENSE', 'INTEREST_EXPENSE', '3000', '0'),
  m('8100', 'EXPENSE', 'TAX_EXPENSE', '20000', '0'),
];
const period = position.filter((x) => x.type === 'REVENUE' || x.type === 'EXPENSE');
const v = (rows: { key: string; amount: { toFixed: (n?: number) => string } | null }[], k: string) => rows.find((r) => r.key === k)!.amount!.toFixed(2);

describe('statutory formats', () => {
  it('place every subtype on exactly one line of each statement', () => {
    for (const id of STATUTORY_FORMAT_IDS) {
      expect(unmappedSubtypes(id)).toEqual([]);
      const f = statutoryFormat(id);
      for (const st of [f.balanceSheet, f.profitAndLoss]) {
        const all = st.flatMap((r) => r.subtypes ?? []);
        expect(new Set(all).size).toBe(all.length);
        expect(st.filter((r) => r.takesUnclosedProfit).length).toBe(st === f.balanceSheet ? 1 : 0);
        for (const r of st) for (const [k] of r.sum ?? []) expect(st.findIndex((x) => x.key === k)).toBeLessThan(st.indexOf(r));
      }
      for (const key of Object.values(f.fallback)) expect([...f.balanceSheet, ...f.profitAndLoss].find((r) => r.key === key)?.kind).toBe('LINE');
      expect(f.sources.length).toBeGreaterThan(0);
    }
    expect(Object.values(ACCOUNT_SUBTYPES).flat().length).toBeGreaterThan(30);
  });

  it('pick the country layout, IFRS elsewhere', () => {
    expect(defaultStatutoryFormat('IN')).toBe('IN_SCHEDULE_III');
    expect(defaultStatutoryFormat('gb')).toBe('GB_COMPANIES_ACT');
    expect(defaultStatutoryFormat('AE')).toBe('IFRS_IAS1');
  });

  it('build Schedule III that balances and agrees with the books', () => {
    const s = buildStatutoryStatements('IN_SCHEDULE_III', position, period);
    const bs = s.balanceSheet.rows;
    const pl = s.profitAndLoss.rows;
    expect(v(pl, 'REVENUE')).toBe('200000.00');
    expect(v(pl, 'TOTAL_INCOME')).toBe('205000.00');
    expect(v(pl, 'TOTAL_EXPENSES')).toBe('125000.00');
    expect(v(pl, 'PBT')).toBe('80000.00');
    expect(v(pl, 'PROFIT')).toBe('60000.00');
    expect(s.profitAgrees).toBe(true);
    expect(v(bs, 'PPE')).toBe('180000.00');
    expect(v(bs, 'CASH')).toBe('590000.00');
    expect(v(bs, 'ST_LOANS_ADVANCES')).toBe('9000.00');
    // Drawings reduce reserves; the year's profit is in them.
    expect(v(bs, 'RESERVES')).toBe('50000.00');
    expect(v(bs, 'TOTAL_A')).toBe('1020000.00');
    expect(v(bs, 'TOTAL_EL')).toBe('1020000.00');
    expect(s.balanced).toBe(true);
    // The account with no subtype is placed by type and listed.
    expect(s.unclassified).toEqual([{ accountId: expect.any(String), code: '1999', name: '1999', type: 'ASSET', subtype: null, placedOn: 'OTHER_CA' }]);
    expect(v(bs, 'OTHER_CA')).toBe('5000.00');
    expect(bs.find((r) => r.key === 'PPE')!.accounts.map((a) => a.code)).toEqual(['1510', '1520']);
    // Same totals as the plain reports.
    const plain = buildBalanceSheet(position);
    expect(plain.totalAssets.toFixed(2)).toBe('1020000.00');
    expect(buildIncomeStatement(period).netIncome.toFixed(2)).toBe('60000.00');
  });

  it('build the UK formats with net assets equal to shareholders’ funds', () => {
    const s = buildStatutoryStatements('GB_COMPANIES_ACT', position, period);
    const bs = s.balanceSheet.rows;
    expect(v(bs, 'TOTAL_FA')).toBe('180000.00');
    expect(v(bs, 'DEBTORS')).toBe('250000.00');
    expect(v(bs, 'CREDITORS_1Y')).toBe('170000.00');
    expect(v(bs, 'NET_CA')).toBe('670000.00');
    expect(v(bs, 'NET_ASSETS')).toBe('550000.00');
    expect(v(bs, 'SHAREHOLDERS_FUNDS')).toBe('550000.00');
    expect(s.balanced).toBe(true);
    const pl = s.profitAndLoss.rows;
    expect(v(pl, 'GROSS_PROFIT')).toBe('150000.00');
    expect(v(pl, 'OPERATING_PROFIT')).toBe('83000.00');
    expect(v(pl, 'PROFIT')).toBe('60000.00');
  });

  it('keep profit from earlier periods in equity, and show a loss', () => {
    // P&L period is only part of the history: the rest is still in the balance sheet.
    const loss = [m('4100', 'REVENUE', 'OPERATING_REVENUE', '0', '1000'), m('6200', 'EXPENSE', 'OPERATING_EXPENSE', '4000', '0')];
    const s = buildStatutoryStatements('IFRS_IAS1', position, loss);
    expect(v(s.profitAndLoss.rows, 'PROFIT')).toBe('-3000.00');
    expect(s.profitAgrees).toBe(true);
    expect(s.balanced).toBe(true);
    expect(s.unclosedProfit.toFixed(2)).toBe('60000.00');
  });
});
