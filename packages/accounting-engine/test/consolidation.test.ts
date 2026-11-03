import { describe, expect, it } from 'vitest';
import { ConsolidationError, intercompanyEliminations, type IntercompanyTransaction, checkOwnershipPercent, checkTranslationRates, consolidate, type ConsolidationAccountBalance, type ConsolidationEntity } from '../src';

const a = (code: string, name: string, type: ConsolidationAccountBalance['type'], netDebit: string): ConsolidationAccountBalance => ({ code, name, type, netDebit });

// Parent (INR): sold 100,000 to Sub on credit; has 400,000 cash, capital 500,000; invested 200,000 in Sub.
const parent: ConsolidationEntity = {
  id: 'P',
  name: 'Parent Ltd',
  currency: 'INR',
  closing: [
    a('1120', 'Bank', 'ASSET', '400000.00'),
    a('1250', 'Due from group companies', 'ASSET', '100000.00'),
    a('1600', 'Investment in subsidiaries', 'ASSET', '200000.00'),
    a('3100', 'Share capital', 'EQUITY', '-500000.00'),
    a('4300', 'Intercompany sales', 'REVENUE', '-100000.00'),
    a('4100', 'Sales', 'REVENUE', '-150000.00'),
    a('6100', 'Salaries', 'EXPENSE', '50000.00'),
  ],
  period: [a('4300', 'Intercompany sales', 'REVENUE', '-100000.00'), a('4100', 'Sales', 'REVENUE', '-150000.00'), a('6100', 'Salaries', 'EXPENSE', '50000.00')],
};
// Subsidiary (INR): bought 100,000 from Parent; capital 200,000.
const sub: ConsolidationEntity = {
  id: 'S',
  name: 'Sub Pvt Ltd',
  currency: 'INR',
  closing: [
    a('1120', 'Bank', 'ASSET', '200000.00'),
    a('2150', 'Due to group companies', 'LIABILITY', '-100000.00'),
    a('3100', 'Share capital', 'EQUITY', '-200000.00'),
    a('6950', 'Intercompany purchases', 'EXPENSE', '100000.00'),
  ],
  period: [a('6950', 'Intercompany purchases', 'EXPENSE', '100000.00')],
};
const rules = [
  { id: 'r1', name: 'Receivable and payable', left: { entityId: 'P', code: '1250' }, right: { entityId: 'S', code: '2150' } },
  { id: 'r2', name: 'Sales and purchases', left: { entityId: 'P', code: '4300' }, right: { entityId: 'S', code: '6950' } },
  { id: 'r3', name: 'Investment and capital', left: { entityId: 'P', code: '1600' }, right: { entityId: 'S', code: '3100' } },
];
const row = (r: ReturnType<typeof consolidate>, code: string) => r.rows.find((x) => x.code === code)!;

describe('consolidation', () => {
  it('adds entities by account code and keeps every column at zero', () => {
    const r = consolidate({ currency: 'INR', entities: [parent, sub], rules: [] });
    expect(r.balanced).toBe(true);
    expect(row(r, '1120')).toMatchObject({ amounts: ['400000.00', '200000.00'], elimination: '0.00', consolidated: '600000.00' });
    expect(row(r, '3100').consolidated).toBe('-700000.00');
    expect(r.incomeStatement).toMatchObject({ totalRevenue: '250000.00', totalExpenses: '150000.00', netIncome: '100000.00' });
    expect(r.balanceSheet).toMatchObject({ totalAssets: '900000.00', totalLiabilities: '100000.00', periodEarnings: '100000.00', totalEquity: '800000.00', balanced: true });
    expect(r.entities.map((e) => e.netIncome)).toEqual(['200000.00', '-100000.00']);
  });

  it('eliminates intercompany balances, sales and the investment', () => {
    const r = consolidate({ currency: 'INR', entities: [parent, sub], rules });
    expect(r.balanced).toBe(true);
    expect(r.eliminations.every((e) => e.matched)).toBe(true);
    expect(row(r, '1250')).toMatchObject({ elimination: '-100000.00', consolidated: '0.00' });
    expect(row(r, '2150')).toMatchObject({ elimination: '100000.00', consolidated: '0.00' });
    expect(row(r, '4300').consolidated).toBe('0.00');
    expect(row(r, '6950').consolidated).toBe('0.00');
    expect(row(r, '3100').consolidated).toBe('-500000.00');
    expect(r.rows.some((x) => x.kind === 'INTERCOMPANY_DIFFERENCE')).toBe(false);
    // Group profit is unchanged by intercompany trade; the balance sheet shrinks.
    expect(r.incomeStatement).toMatchObject({ totalRevenue: '150000.00', totalExpenses: '50000.00', netIncome: '100000.00' });
    expect(r.incomeStatement.revenue.map((l) => l.code)).toEqual(['4100']);
    expect(r.balanceSheet).toMatchObject({ totalAssets: '600000.00', totalLiabilities: '0.00', totalEquity: '600000.00', balanced: true });
  });

  it('shows a mismatch as an intercompany difference and still balances', () => {
    const s2 = { ...sub, closing: sub.closing.map((x) => (x.code === '2150' ? { ...x, netDebit: '-90000.00' } : x.code === '1120' ? { ...x, netDebit: '190000.00' } : x)) };
    const r = consolidate({ currency: 'INR', entities: [parent, s2], rules: [rules[0]!] });
    expect(r.eliminations[0]).toMatchObject({ difference: '10000.00', matched: false, problem: null });
    const d = r.rows.find((x) => x.kind === 'INTERCOMPANY_DIFFERENCE')!;
    expect(d).toMatchObject({ elimination: '10000.00', consolidated: '10000.00', type: 'EQUITY' });
    expect(r.balanced).toBe(true);
    expect(r.balanceSheet.balanced).toBe(true);
  });

  it('reports a rule whose account is missing', () => {
    const r = consolidate({ currency: 'INR', entities: [parent, sub], rules: [{ id: 'x', name: 'Loan', left: { entityId: 'P', code: '1700' }, right: { entityId: 'S', code: '2150' } }] });
    expect(r.eliminations[0]!.matched).toBe(false);
    expect(r.eliminations[0]!.problem).toMatch(/Parent Ltd has no balance on account 1700/);
    expect(r.balanced).toBe(true);
  });

  it('translates a foreign entity and puts the difference in the translation reserve', () => {
    // USD subsidiary: capital 10,000 at historical 80; earned 1,000 at average 82; closing 85.
    const us: ConsolidationEntity = {
      id: 'U',
      name: 'US Inc',
      currency: 'USD',
      rates: { closing: '85', average: '82', historical: '80' },
      closing: [a('1120', 'Bank', 'ASSET', '11000.00'), a('3100', 'Share capital', 'EQUITY', '-10000.00'), a('4100', 'Sales', 'REVENUE', '-1500.00'), a('6100', 'Salaries', 'EXPENSE', '500.00')],
      period: [a('4100', 'Sales', 'REVENUE', '-1500.00'), a('6100', 'Salaries', 'EXPENSE', '500.00')],
    };
    const r = consolidate({ currency: 'INR', entities: [parent, us], rules: [] });
    expect(row(r, '1120').amounts[1]).toBe('935000.00'); // 11,000 × 85
    expect(row(r, '3100').amounts[1]).toBe('-800000.00'); // × 80
    expect(row(r, '4100').amounts[1]).toBe('-123000.00'); // × 82
    // 935,000 − 800,000 − 123,000 + 41,000 = 53,000 → reserve −53,000 (a credit, a gain).
    const reserve = r.rows.find((x) => x.kind === 'TRANSLATION_RESERVE')!;
    expect(reserve.amounts).toEqual(['0.00', '-53000.00']);
    expect(r.entities[1]).toMatchObject({ translationReserve: '-53000.00', netIncome: '82000.00' });
    expect(r.balanced).toBe(true);
    expect(r.balanceSheet.balanced).toBe(true);
    expect(r.balanceSheet.equity.find((l) => l.kind === 'TRANSLATION_RESERVE')!.amount).toBe('53000.00');
  });

  it('carries earnings before the period at the historical rate', () => {
    const us: ConsolidationEntity = {
      id: 'U',
      name: 'US Inc',
      currency: 'USD',
      rates: { closing: '2', average: '2', historical: '1.5' },
      // 300 profit in earlier periods, 100 this period.
      closing: [a('1120', 'Bank', 'ASSET', '400.00'), a('4100', 'Sales', 'REVENUE', '-400.00')],
      period: [a('4100', 'Sales', 'REVENUE', '-100.00')],
    };
    const r = consolidate({ currency: 'INR', entities: [us], rules: [] });
    expect(r.rows.find((x) => x.kind === 'EARNINGS_BROUGHT_FORWARD')!.amounts).toEqual(['-450.00']);
    expect(r.rows.find((x) => x.kind === 'TRANSLATION_RESERVE')!.amounts).toEqual(['-150.00']);
    expect(r.balanced).toBe(true);
    expect(r.balanceSheet).toMatchObject({ totalAssets: '800.00', totalEquity: '800.00', periodEarnings: '200.00', balanced: true });
  });

  it('refuses a foreign entity without rates, bad rates and duplicates', () => {
    const us = { id: 'U', name: 'US Inc', currency: 'USD', closing: [], period: [] };
    expect(() => consolidate({ currency: 'INR', entities: [us], rules: [] })).toThrow(ConsolidationError);
    try {
      consolidate({ currency: 'INR', entities: [{ ...us, rates: { closing: '0', average: 'x', historical: '80' } }, parent, parent], rules: [] });
    } catch (e) {
      expect((e as ConsolidationError).issues).toEqual(['US Inc: The closing rate must be a number above zero', 'US Inc: The average rate must be a number above zero', 'Parent Ltd is in the group twice']);
    }
    expect(() => consolidate({ currency: 'INR', entities: [], rules: [] })).toThrow(/at least one/);
    expect(checkTranslationRates({ closing: '83.25', average: '82.9', historical: '75' })).toEqual([]);
  });

  it('shows the outside shareholders of a partly owned entity within equity', () => {
    const r = consolidate({ currency: 'INR', entities: [parent, { ...sub, ownershipPercent: '80' }], rules: rules.slice(0, 2) });
    expect(r.balanced).toBe(true);
    const s = r.entities[1]!;
    // Sub's net assets: bank 200,000 less payable 100,000; its loss for the period is 100,000.
    expect(s).toMatchObject({ ownershipPercent: '80', netAssets: '100000.00', nonControllingNetAssets: '20000.00', nonControllingProfit: '-20000.00' });
    expect(r.entities[0]).toMatchObject({ ownershipPercent: '100', nonControllingNetAssets: '0.00', nonControllingProfit: '0.00' });
    expect(r.incomeStatement).toMatchObject({ netIncome: '100000.00', attributableToOwners: '120000.00', attributableToNonControlling: '-20000.00' });
    expect(r.balanceSheet).toMatchObject({ totalEquity: '800000.00', nonControllingInterests: '20000.00', equityAttributableToOwners: '780000.00', balanced: true });
    // Fully owned: nothing to split.
    const full = consolidate({ currency: 'INR', entities: [parent, sub], rules });
    expect(full.balanceSheet.nonControllingInterests).toBe('0.00');
    expect(full.incomeStatement.attributableToOwners).toBe(full.incomeStatement.netIncome);
  });

  it('takes the outside share of translated net assets and rounds it', () => {
    const fze: ConsolidationEntity = {
      id: 'F',
      name: 'Trading FZE',
      currency: 'AED',
      closing: [a('1120', 'Bank', 'ASSET', '1000.00'), a('3100', 'Share capital', 'EQUITY', '-900.00'), a('4100', 'Sales', 'REVENUE', '-100.00')],
      period: [a('4100', 'Sales', 'REVENUE', '-100.00')],
      rates: { closing: '23', average: '22.5', historical: '22' },
      ownershipPercent: '66.6667',
    };
    const r = consolidate({ currency: 'INR', entities: [parent, fze], rules: [] });
    const f = r.entities[1]!;
    expect(f.netAssets).toBe('23000.00');
    expect(f.nonControllingNetAssets).toBe('7666.66'); // 23,000 × 33.3333%
    expect(f.nonControllingProfit).toBe('750.00'); // 2,250 × 33.3333% = 749.999…
    expect(r.balanceSheet.balanced).toBe(true);
  });

  it('checks ownership percentages', () => {
    expect(checkOwnershipPercent('100')).toEqual([]);
    expect(checkOwnershipPercent('0.0001')).toEqual([]);
    for (const bad of ['0', '100.0001', '101', '-5', '50.12345', 'abc', '']) expect(checkOwnershipPercent(bad)).toHaveLength(1);
    expect(() => consolidate({ currency: 'INR', entities: [parent, { ...sub, ownershipPercent: '0' }], rules: [] })).toThrow(ConsolidationError);
  });

  describe('intercompany ledger', () => {
    const codes = { fromReceivableCode: '1250', toPayableCode: '2160', fromRevenueCode: '4300', toExpenseCode: '6950' };
    const txns: IntercompanyTransaction[] = [
      { id: 't1', kind: 'CHARGE', fromEntityId: 'P', toEntityId: 'S', date: '2026-05-10', amount: '50000.00', toAmount: '50000.00', ...codes },
      { id: 't2', kind: 'CHARGE', fromEntityId: 'P', toEntityId: 'S', date: '2026-06-10', reversedOn: '2026-06-20', amount: '9000.00', toAmount: '9000.00', ...codes },
      { id: 't3', kind: 'SETTLEMENT', fromEntityId: 'P', toEntityId: 'S', date: '2026-07-01', amount: '20000.00', toAmount: '20000.00', fromReceivableCode: '1250', toPayableCode: '2160' },
      { id: 't4', kind: 'CHARGE', fromEntityId: 'P', toEntityId: 'S', date: '2027-01-05', amount: '7000.00', toAmount: '7000.00', ...codes },
    ];
    const names = new Map([['P', 'Parent Ltd'], ['S', 'Sub Pvt Ltd']]);

    it('nets charges, settlements and reversals into balance and period eliminations', () => {
      const le = intercompanyEliminations(txns, { from: '2026-04-01', to: '2026-12-31' }, names);
      expect(le).toEqual([
        { id: 'ic-balance:P:S:1250:2160', name: 'Intercompany balance: Sub Pvt Ltd owes Parent Ltd', basis: 'BALANCE', left: { entityId: 'P', code: '1250', netDebit: '30000' }, right: { entityId: 'S', code: '2160', netDebit: '-30000' } },
        { id: 'ic-charges:P:S:4300:6950', name: 'Intercompany charges: Parent Ltd to Sub Pvt Ltd', basis: 'PERIOD', left: { entityId: 'P', code: '4300', netDebit: '-50000' }, right: { entityId: 'S', code: '6950', netDebit: '50000' } },
      ]);
      // A later period sees the opening balance but only its own charges.
      const q4 = intercompanyEliminations(txns, { from: '2027-01-01', to: '2027-03-31' }, names);
      expect(q4.map((e) => [e.basis, e.left.netDebit])).toEqual([['BALANCE', '37000'], ['PERIOD', '-7000']]);
      // A reversal in a later period than its charge.
      const split = intercompanyEliminations(txns, { from: '2026-06-15', to: '2026-06-30' }, names);
      expect(split.find((e) => e.basis === 'PERIOD')!.left.netDebit).toBe('9000');
    });

    it('removes exactly the posted amounts, leaving the rest of the accounts', () => {
      const p: ConsolidationEntity = {
        id: 'P',
        name: 'Parent Ltd',
        currency: 'INR',
        closing: [a('1120', 'Bank', 'ASSET', '20000.00'), a('1250', 'Due from group companies', 'ASSET', '30000.00'), a('4300', 'Intercompany sales', 'REVENUE', '-50000.00')],
        period: [a('4300', 'Intercompany sales', 'REVENUE', '-50000.00')],
      };
      const s2: ConsolidationEntity = {
        id: 'S',
        name: 'Sub Pvt Ltd',
        currency: 'AED',
        rates: { closing: '23', average: '22', historical: '21' },
        // In AED: the 50,000 INR charge was booked as 2,200 AED, 20,000 settled as 880 AED. A 100 AED payable to an outside supplier shares the account.
        closing: [a('1120', 'Bank', 'ASSET', '-880.00'), a('2160', 'Due to group companies', 'LIABILITY', '-1420.00'), a('6950', 'Intercompany purchases', 'EXPENSE', '2300.00')],
        period: [a('6950', 'Intercompany purchases', 'EXPENSE', '2300.00')],
      };
      const t: IntercompanyTransaction[] = [
        { id: 'x1', kind: 'CHARGE', fromEntityId: 'P', toEntityId: 'S', date: '2026-05-10', amount: '50000.00', toAmount: '2200.00', ...codes },
        { id: 'x2', kind: 'SETTLEMENT', fromEntityId: 'P', toEntityId: 'S', date: '2026-07-01', amount: '20000.00', toAmount: '880.00', fromReceivableCode: '1250', toPayableCode: '2160' },
      ];
      const r = consolidate({ currency: 'INR', entities: [p, s2], rules: [], ledger: intercompanyEliminations(t, { from: '2026-04-01', to: '2026-12-31' }, names) });
      expect(r.balanced).toBe(true);
      const bal = r.eliminations.find((e) => e.ruleId.startsWith('ic-balance'))!;
      // 1,320 AED at the closing rate 23 is 30,360: the 360 is the exchange movement since booking.
      expect(bal).toMatchObject({ source: 'LEDGER', left: { amount: '30000.00' }, right: { amount: '-30360.00' }, difference: '-360.00', matched: false });
      const chg = r.eliminations.find((e) => e.ruleId.startsWith('ic-charges'))!;
      expect(chg).toMatchObject({ left: { amount: '-50000.00' }, right: { amount: '48400.00' }, difference: '-1600.00' });
      // Only the intercompany part of the payable is removed: 100 AED to the outside supplier stays.
      expect(row(r, '2160').consolidated).toBe('-2300.00');
      expect(row(r, '1250').consolidated).toBe('0.00');
      expect(row(r, '4300').consolidated).toBe('0.00');
      expect(row(r, '6950').consolidated).toBe('2200.00');
    });
  });
});
