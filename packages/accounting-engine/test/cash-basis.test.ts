import { describe, expect, it } from 'vitest';
import { buildIncomeStatement, cashBasisMovements } from '../src';

const accounts = [
  { accountId: 'bank', code: '1120', name: 'Bank', type: 'ASSET' as const },
  { accountId: 'ar', code: '1200', name: 'Receivables', type: 'ASSET' as const },
  { accountId: 'gst', code: '2200', name: 'GST payable', type: 'LIABILITY' as const },
  { accountId: 'sales', code: '4000', name: 'Sales', type: 'REVENUE' as const },
  { accountId: 'fees', code: '6600', name: 'Fees', type: 'EXPENSE' as const },
  { accountId: 'bankfee', code: '6900', name: 'Bank charges', type: 'EXPENSE' as const },
];
// Invoice 1180 = 1000 sales + 180 GST.
const invoice = [
  { accountId: 'ar', debit: '1180', credit: '0' },
  { accountId: 'sales', debit: '0', credit: '1000' },
  { accountId: 'gst', debit: '0', credit: '180' },
];

describe('cash-basis profit and loss', () => {
  it('counts the paid share of an invoice, net of tax, and direct cash spending in full', () => {
    const m = cashBasisMovements(accounts, [{ accountId: 'bankfee', debit: '25', credit: '0' }, { accountId: 'bank', debit: '0', credit: '25' }], [{ lines: invoice, settled: '590', total: '1180' }]);
    const is = buildIncomeStatement(m);
    expect(is.totalRevenue.toFixed(2)).toBe('500.00');
    expect(is.totalExpenses.toFixed(2)).toBe('25.00');
    expect(is.netIncome.toFixed(2)).toBe('475.00');
    // Balance sheet accounts never appear.
    expect(m.find((x) => x.accountId === 'gst')!.credit.toString()).toBe('0');
  });

  it('adds up several settlements, never more than the whole, and skips empty ones', () => {
    const bill = [{ accountId: 'fees', debit: '300', credit: '0' }];
    const m = cashBasisMovements(accounts, [], [
      { lines: bill, settled: '100', total: '300' },
      { lines: bill, settled: '200', total: '300' },
      { lines: invoice, settled: '5000', total: '1180' },
      { lines: invoice, settled: '10', total: '0' },
    ]);
    const is = buildIncomeStatement(m);
    expect(is.totalExpenses.toFixed(2)).toBe('300.00');
    expect(is.totalRevenue.toFixed(2)).toBe('1000.00');
  });

  it('keeps exact shares until the report rounds them', () => {
    const m = cashBasisMovements(accounts, [], [{ lines: invoice, settled: '100', total: '300' }]);
    expect(buildIncomeStatement(m).totalRevenue.toFixed(2)).toBe('333.33');
  });
});
