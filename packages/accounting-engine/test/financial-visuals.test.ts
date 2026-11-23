import { describe, expect, it } from 'vitest';
import { expenseGroup, expenseHeatmap, expenseTreemap, incomeSankey, plWaterfall, type VisualAccount, type VisualAmount } from '../src';

const acc = (id: string, code: string, name: string, type: 'REVENUE' | 'EXPENSE', subtype: string | null): VisualAccount => ({ id, code, name, type, subtype });
const ACCOUNTS = [
  acc('sales', '4100', 'Sales Revenue', 'REVENUE', 'OPERATING_REVENUE'),
  acc('svc', '4200', 'Service Revenue', 'REVENUE', 'OPERATING_REVENUE'),
  acc('oth', '4900', 'Other Income', 'REVENUE', 'OTHER_INCOME'),
  acc('cos', '5000', 'Cost of Sales', 'EXPENSE', 'COST_OF_SALES'),
  acc('pay', '6100', 'Salaries and Wages', 'EXPENSE', 'PAYROLL_EXPENSE'),
  acc('rent', '6200', 'Rent', 'EXPENSE', 'OPERATING_EXPENSE'),
  acc('soft', '6400', 'Software', 'EXPENSE', 'OPERATING_EXPENSE'),
  acc('int', '7100', 'Interest Expense', 'EXPENSE', 'INTEREST_EXPENSE'),
  acc('tax', '8100', 'Income Tax Expense', 'EXPENSE', 'TAX_EXPENSE'),
];
const A = (accountId: string, month: string, amount: string): VisualAmount => ({ accountId, month, amount });
const AMOUNTS = [
  A('sales', '2026-09', '60000'), A('sales', '2026-10', '40000.50'), A('svc', '2026-10', '20000'), A('oth', '2026-10', '1000'),
  A('cos', '2026-09', '30000'), A('cos', '2026-10', '15000'), A('pay', '2026-10', '25000'), A('rent', '2026-09', '8000'), A('rent', '2026-10', '8000'),
  A('soft', '2026-10', '1200'), A('soft', '2026-10', '-200'), A('int', '2026-10', '500'), A('tax', '2026-10', '7000'),
];

describe('financial visuals', () => {
  it('groups expense subtypes, with unknown ones as operating costs', () => {
    expect(expenseGroup('COST_OF_SALES')).toBe('COST_OF_SALES');
    expect(expenseGroup('FX_GAIN_LOSS')).toBe('FINANCE');
    expect(expenseGroup('SOMETHING_NEW')).toBe('OPERATING');
    expect(expenseGroup(null)).toBe('OPERATING');
  });

  it('walks revenue down to net profit', () => {
    const w = plWaterfall(ACCOUNTS, AMOUNTS);
    expect(w.map((s) => `${s.label} ${s.kind} ${s.amount} ${s.from}->${s.to}`)).toEqual([
      'Revenue START 120000.50 0.00->120000.50',
      'Cost of sales DOWN -45000.00 120000.50->75000.50',
      'Gross profit SUBTOTAL 75000.50 0.00->75000.50',
      'People DOWN -25000.00 75000.50->50000.50',
      'Operating costs DOWN -17000.00 50000.50->33000.50',
      'Operating profit SUBTOTAL 33000.50 0.00->33000.50',
      'Other income UP 1000.00 33000.50->34000.50',
      'Interest and exchange DOWN -500.00 34000.50->33500.50',
      'Profit before tax SUBTOTAL 33500.50 0.00->33500.50',
      'Income tax DOWN -7000.00 33500.50->26500.50',
      'Net profit SUBTOTAL 26500.50 0.00->26500.50',
    ]);
    expect(w[1]!.accountIds).toEqual(['cos']);
    expect(w[4]!.accountIds.sort()).toEqual(['rent', 'soft']);
  });

  it('balances the Sankey: what comes in goes out, and a loss flows in', () => {
    const s = incomeSankey(ACCOUNTS, AMOUNTS, { perGroup: 1 });
    const into = (i: number) => s.links.filter((l) => l.target === i).reduce((a, l) => a + Number(l.amount), 0); // not money: test arithmetic
    const outOf = (i: number) => s.links.filter((l) => l.source === i).reduce((a, l) => a + Number(l.amount), 0); // not money: test arithmetic
    const hub = s.nodes.findIndex((n) => n.kind === 'INCOME');
    expect(into(hub)).toBeCloseTo(outOf(hub));
    expect(s.income).toBe('121000.50');
    expect(s.profit).toBe('26500.50');
    expect(s.nodes.map((n) => n.label)).toContain('Other operating costs');
    const loss = incomeSankey(ACCOUNTS, [A('sales', '2026-10', '100'), A('rent', '2026-10', '250'), A('svc', '2026-10', '-20')]);
    expect(loss.profit).toBe('-150.00');
    expect(loss.leftOut).toEqual([{ accountId: 'svc', amount: '-20.00' }]);
    const lossNode = loss.nodes.findIndex((n) => n.kind === 'LOSS');
    expect(loss.links.find((l) => l.source === lossNode)!.amount).toBe('150.00');
    expect(loss.nodes.some((n) => n.kind === 'PROFIT')).toBe(false);
  });

  it('draws a heatmap of the largest expense accounts by month', () => {
    const h = expenseHeatmap(ACCOUNTS, AMOUNTS, ['2026-09', '2026-10'], 3);
    expect(h.rows.map((r) => `${r.code} ${r.total}`)).toEqual(['5000 45000.00', '6100 25000.00', '6200 16000.00']);
    expect(h.max).toBe('30000.00');
    expect(h.rows[0]!.cells).toEqual([{ month: '2026-09', amount: '30000.00', intensity: 1 }, { month: '2026-10', amount: '15000.00', intensity: 0.5 }]);
    expect(h.rows[1]!.cells[0]).toEqual({ month: '2026-09', amount: '0.00', intensity: 0 });
  });

  it('builds a treemap of spending by group with shares', () => {
    const t = expenseTreemap(ACCOUNTS, AMOUNTS);
    expect(t.total).toBe('94500.00');
    expect(t.groups.map((g) => `${g.label} ${g.amount} ${g.share}`)).toEqual(['Cost of sales 45000.00 47.6', 'People 25000.00 26.5', 'Operating costs 17000.00 18', 'Income tax 7000.00 7.4', 'Interest and exchange 500.00 0.5']);
    expect(t.groups[2]!.accounts.map((a) => `${a.code} ${a.amount}`)).toEqual(['6200 16000.00', '6400 1000.00']);
  });
});
