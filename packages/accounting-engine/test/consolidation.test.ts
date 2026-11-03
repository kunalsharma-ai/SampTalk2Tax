import { describe, expect, it } from 'vitest';
import { ConsolidationError, checkTranslationRates, consolidate, type ConsolidationAccountBalance, type ConsolidationEntity } from '../src';

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
});
