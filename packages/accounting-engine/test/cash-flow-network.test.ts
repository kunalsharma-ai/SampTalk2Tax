import { describe, expect, it } from 'vitest';
import { cashNetworkGroup, cashFlowNetwork, type CashNetworkAccount, splitAmount, D } from '../src';

const accounts: CashNetworkAccount[] = [
  { id: 'bank', type: 'ASSET', subtype: 'BANK' },
  { id: 'cash', type: 'ASSET', subtype: 'CASH' },
  { id: 'ar', type: 'ASSET', subtype: 'ACCOUNTS_RECEIVABLE' },
  { id: 'ap', type: 'LIABILITY', subtype: 'ACCOUNTS_PAYABLE' },
  { id: 'gst', type: 'LIABILITY', subtype: 'TAX_PAYABLE' },
  { id: 'wages', type: 'LIABILITY', subtype: 'PAYROLL_LIABILITY' },
  { id: 'loan', type: 'LIABILITY', subtype: 'LONG_TERM_DEBT' },
  { id: 'interest', type: 'EXPENSE', subtype: 'INTEREST_EXPENSE' },
  { id: 'capital', type: 'EQUITY', subtype: 'SHARE_CAPITAL' },
  { id: 'fees', type: 'EXPENSE', subtype: 'OPERATING_EXPENSE' },
  { id: 'sales', type: 'REVENUE', subtype: 'OPERATING_REVENUE' },
  { id: 'van', type: 'ASSET', subtype: 'FIXED_ASSET' },
];
const l = (accountId: string, debit: string, credit = '0') => ({ accountId, debit, credit });
const cash = [
  { id: 'bank', name: '1120 Bank' },
  { id: 'cash', name: '1110 Petty cash' },
];

describe('Cash-flow network (DASH-024)', () => {
  it('groups the other side of a cash movement by its account', () => {
    const g = (id: string) => cashNetworkGroup(accounts.find((a) => a.id === id));
    expect(['ar', 'sales', 'ap', 'fees', 'gst', 'wages', 'loan', 'interest', 'capital', 'van'].map(g)).toEqual([
      'CUSTOMERS',
      'CUSTOMERS',
      'VENDORS',
      'VENDORS',
      'TAX',
      'PAYROLL',
      'FINANCING',
      'FINANCING',
      'OWNERS',
      'ASSETS',
    ]);
    expect(cashNetworkGroup(undefined)).toBe('OTHER');
  });

  it('splits an amount in proportion and leaves the rounding on the largest part', () => {
    expect(splitAmount(new D('100'), [new D('1'), new D('2')], 2).map(String)).toEqual(['33.33', '66.67']);
    expect(() => splitAmount(new D('1'), [new D('0')], 2)).toThrow();
  });

  it('follows each month’s cash in and out of each account, and money moved between them', () => {
    const n = cashFlowNetwork({
      cash,
      accounts,
      scale: 2,
      months: ['2026-04', '2026-05'],
      entries: [
        // A customer pays 1,180 into the bank, less a 10 bank fee.
        { month: '2026-04', lines: [l('bank', '1170'), l('fees', '10'), l('ar', '0', '1180')] },
        // Bills paid: vendor 500 and GST 180 in one payment.
        { month: '2026-04', lines: [l('ap', '500'), l('gst', '180'), l('bank', '0', '680')] },
        // 200 drawn from the bank into petty cash.
        { month: '2026-05', lines: [l('cash', '200'), l('bank', '0', '200')] },
        // Salaries, loan repayment with interest, owner puts money in, a van bought, a cash sale.
        { month: '2026-05', lines: [l('wages', '300'), l('bank', '0', '300')] },
        { month: '2026-05', lines: [l('loan', '90'), l('interest', '10'), l('bank', '0', '100')] },
        { month: '2026-05', lines: [l('bank', '1000'), l('capital', '0', '1000')] },
        { month: '2026-05', lines: [l('van', '400'), l('bank', '0', '400')] },
        { month: '2026-05', lines: [l('cash', '50'), l('sales', '0', '50')] },
        // Outside the months asked for: left out.
        { month: '2026-06', lines: [l('bank', '5'), l('sales', '0', '5')] },
        // Not a cash movement at all.
        { month: '2026-05', lines: [l('ar', '100'), l('sales', '0', '100')] },
      ],
    });
    expect(n.months[0]).toEqual({
      month: '2026-04',
      flows: [
        { from: 'group:CUSTOMERS', to: 'cash:bank', amount: '1170.00' },
        { from: 'cash:bank', to: 'group:VENDORS', amount: '500.00' },
        { from: 'cash:bank', to: 'group:TAX', amount: '180.00' },
      ],
      inflow: '1170.00',
      outflow: '680.00',
      net: '490.00',
    });
    const may = Object.fromEntries(n.months[1].flows.map((f) => [`${f.from}>${f.to}`, f.amount]));
    expect(may).toEqual({
      'group:OWNERS>cash:bank': '1000.00',
      'cash:bank>group:ASSETS': '400.00',
      'cash:bank>group:PAYROLL': '300.00',
      'cash:bank>cash:cash': '200.00',
      'cash:bank>group:FINANCING': '100.00',
      'group:CUSTOMERS>cash:cash': '50.00',
    });
    // A transfer is neither money in nor money out of the business.
    expect(n.months[1]).toMatchObject({ inflow: '1050.00', outflow: '800.00', net: '250.00' });
    expect(n.total).toMatchObject({ month: 'ALL', inflow: '2220.00', outflow: '1480.00', net: '740.00' });
    expect(n.nodes.map((x) => [x.key, x.inflow, x.outflow])).toEqual([
      ['cash:bank', '2170.00', '1680.00'],
      ['cash:cash', '250.00', '0.00'],
      ['group:CUSTOMERS', '0.00', '1220.00'],
      ['group:VENDORS', '500.00', '0.00'],
      ['group:PAYROLL', '300.00', '0.00'],
      ['group:TAX', '180.00', '0.00'],
      ['group:FINANCING', '100.00', '0.00'],
      ['group:OWNERS', '0.00', '1000.00'],
      ['group:ASSETS', '400.00', '0.00'],
    ]);
  });

  it('keeps each cash account’s flows equal to its movement, with a transfer that pays a fee', () => {
    const n = cashFlowNetwork({ cash, accounts, scale: 2, months: ['2026-04'], entries: [{ month: '2026-04', lines: [l('cash', '95'), l('fees', '5'), l('bank', '0', '100')] }] });
    expect(n.months[0].flows).toEqual([
      { from: 'cash:bank', to: 'cash:cash', amount: '95.00' },
      { from: 'cash:bank', to: 'group:VENDORS', amount: '5.00' },
    ]);
  });

  it('splits a payment over several kinds of account to the cent', () => {
    const n = cashFlowNetwork({
      cash,
      accounts,
      scale: 2,
      months: ['2026-04'],
      entries: [{ month: '2026-04', lines: [l('ap', '1'), l('gst', '1'), l('wages', '1'), l('bank', '0', '1'), l('loan', '0', '2')] }],
    });
    const sum = n.months[0].flows.reduce((t, f) => t.plus(f.amount), new D(0));
    // 1.00 of cash out over three equal parts (the loan paid the other 2.00).
    expect(sum.toFixed(2)).toBe('1.00');
    expect(n.months[0].flows.map((f) => f.amount).sort()).toEqual(['0.33', '0.33', '0.34']);
  });

  it('draws the busiest cash accounts and joins the rest', () => {
    const many = Array.from({ length: 4 }, (_, i) => ({ id: `b${i}`, name: `Bank ${i}` }));
    const accs = [...accounts, ...many.map((m) => ({ id: m.id, type: 'ASSET' as const, subtype: 'BANK' }))];
    const n = cashFlowNetwork({
      cash: many,
      accounts: accs,
      scale: 2,
      months: ['2026-04'],
      maxCashNodes: 3,
      entries: many.map((m, i) => ({ month: '2026-04', lines: [l(m.id, String((i + 1) * 100)), l('sales', '0', String((i + 1) * 100))] })),
    });
    expect(n.nodes.filter((x) => x.kind === 'CASH').map((x) => [x.key, x.name, x.inflow])).toEqual([
      ['cash:b2', 'Bank 2', '300.00'],
      ['cash:b3', 'Bank 3', '400.00'],
      ['cash:others', '2 other cash accounts', '300.00'],
    ]);
  });

  it('shows empty months as no flows', () => {
    const n = cashFlowNetwork({ cash, accounts, scale: 0, months: ['2026-04'], entries: [] });
    expect(n.nodes.map((x) => [x.key, x.inflow])).toEqual([
      ['cash:bank', '0'],
      ['cash:cash', '0'],
    ]);
    expect({ months: n.months, total: n.total }).toEqual({
      months: [{ month: '2026-04', flows: [], inflow: '0', outflow: '0', net: '0' }],
      total: { month: 'ALL', flows: [], inflow: '0', outflow: '0', net: '0' },
    });
  });
});
