import { describe, expect, it } from 'vitest';
import {
  cashNextQuarter,
  cfoAssessment,
  checkSummaryFigures,
  clientProfitability,
  costIncreases,
  D,
  expensesToInvestigate,
  factsForSummary,
  lateInvoices,
  profitChange,
  projectLosses,
  runTwin,
  salaryRise,
  taxExposure,
  vendorPrices,
  type CfoAccountMonths,
  type CfoInput,
  type MonthFigures,
} from '../src';

const ym = (i: number) => {
  const t = 2024 * 12 + 10 + i; // Nov 2024 + i
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const end = (m: string) => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).toISOString().slice(0, 10);

/** 24 months, Nov 2024 to Oct 2026: revenue grows 1,000 a month; rent jumps in the last three months. */
function month(i: number, over: Partial<Record<keyof MonthFigures, string>> = {}): MonthFigures {
  const m = ym(i);
  const rent = i >= 21 ? 30000 : 20000;
  const v = {
    operatingRevenue: String(200000 + i * 1000),
    otherIncome: '0',
    costOfSales: String(80000 + i * 400),
    operatingExpenses: String(60000 + rent),
    payroll: '60000',
    depreciation: '0',
    interest: '2000',
    incomeTax: '0',
    otherExpenses: '0',
    cash: String(500000 + i * 5000),
    receivables: '240000',
    inventory: '0',
    otherCurrentAssets: '0',
    nonCurrentAssets: '300000',
    payables: '90000',
    otherCurrentLiabilities: '20000',
    nonCurrentLiabilities: '200000',
    cashChange: '5000',
    ...over,
  };
  return {
    month: m,
    from: `${m}-01`,
    to: end(m),
    days: +end(m).slice(8, 10),
    ...(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, new D(x)])) as Omit<MonthFigures, 'month' | 'from' | 'to' | 'days'>),
  };
}
const months = Array.from({ length: 24 }, (_, i) => month(i));
const acct = (code: string, name: string, type: 'REVENUE' | 'EXPENSE', subtype: string | null, f: (i: number) => number): CfoAccountMonths => ({ code, name, type, subtype, amounts: months.map((_, i) => f(i).toFixed(2)) });
const accounts = [
  acct('4100', 'Sales', 'REVENUE', 'OPERATING_REVENUE', (i) => 200000 + i * 1000),
  acct('5000', 'Cost of goods', 'EXPENSE', 'COST_OF_SALES', (i) => 80000 + i * 400),
  acct('6100', 'Salaries', 'EXPENSE', 'PAYROLL_EXPENSE', () => 60000),
  acct('6200', 'Rent', 'EXPENSE', 'OPERATING_EXPENSE', (i) => (i >= 21 ? 30000 : 20000)),
  acct('7100', 'Interest', 'EXPENSE', 'INTEREST_EXPENSE', () => 2000),
];
const base: CfoInput = {
  currency: 'INR',
  scale: 2,
  today: '2026-11-04',
  months,
  accounts,
  customers: [
    { name: 'Acme Retail', revenue12: '1500000.00', revenuePrev12: '1200000.00', overdue: '60000.00', averageDaysLate: 12, paidInvoices: 8 },
    { name: 'Bluebird', revenue12: '1000000.00', revenuePrev12: '1100000.00', overdue: '0.00', averageDaysLate: 2, paidInvoices: 6 },
  ],
  minimumCash: '100000.00',
  forecast: { horizonDays: 90, opening: '615000.00', closing: '640000.00', lowest: { date: '2026-12-01', amount: '580000.00' }, lowestLow: { date: '2026-12-10', amount: '520000.00' }, belowMinimumOn: null },
  borrowings: { count: 1, outstanding: '200000.00', repaymentsNext12: '100000.00', interestNext12: '20000.00' },
  compliance: [{ name: 'GSTR-3B for October 2026', dueDate: '2026-11-20', status: 'DUE_SOON', amount: '36000.00' }],
  alerts: { high: 0, active: 2 },
  budget: { fiscalYear: 2027, approved: true, netVariance: '15000.00', revenueVariance: '20000.00', expensesVariance: '5000.00' },
  scenarios: { total: 3, approved: 1, inReview: 1 },
};

describe('virtual CFO assessment', () => {
  const a = cfoAssessment(base);
  const find = (k: string) => a.findings.find((f) => f.key === k)!;

  it('scores health out of 100 from five stated rules', () => {
    expect(a.health.components.map((c) => c.key)).toEqual(['LIQUIDITY', 'PROFITABILITY', 'WORKING_CAPITAL', 'GROWTH', 'SOLVENCY']);
    expect(a.health.score).toBe(a.health.components.reduce((s, c) => s + c.points, 0));
    expect(a.health.score).toBeGreaterThanOrEqual(50);
    for (const c of a.health.components) expect(c.reason).toMatch(/points/);
    expect(a.headline).toContain(`${a.health.score} out of 100`);
  });

  it('covers every area, and each finding carries its period, method, assumptions, confidence and sources', () => {
    expect(a.findings.map((f) => f.key)).toEqual(['LIQUIDITY', 'PROFITABILITY', 'WORKING_CAPITAL', 'GROWTH', 'COSTS', 'DEBT', 'CAPITAL', 'RISK', 'PLANNING']);
    for (const f of a.findings) {
      expect(f.period.label).not.toBe('');
      expect(f.method.length).toBeGreaterThan(20);
      expect(['HIGH', 'MEDIUM', 'LOW']).toContain(f.confidence);
      expect(f.sources.length).toBeGreaterThan(0);
      expect(f.summary).not.toMatch(/undefined|NaN/);
    }
  });

  it('works out the ratios from the figures', () => {
    const liq = find('LIQUIDITY');
    // Current assets 615,000 + 240,000 = 855,000; current liabilities 110,000.
    expect(liq.figures.find((x) => x.label === 'Current ratio')!.value).toBe('7.77');
    expect(liq.verdict).toBe('GOOD');
    const wc = find('WORKING_CAPITAL');
    // Revenue Aug-Oct 2026: 221,000 + 222,000 + 223,000 = 666,000 over 92 days.
    expect(wc.figures.find((x) => x.label === 'Days sales outstanding')!.value).toBe('33');
    const g = find('GROWTH');
    expect(g.figures.find((x) => x.label === 'Change on the same months last year')!.value).toBe('5.7');
    expect(g.summary).toContain('Acme Retail');
  });

  it('flags a cost line that grew and recommends reviewing it, with who approves', () => {
    const c = costIncreases(base);
    expect(c.map((x) => x.code)).toEqual(['6200']);
    expect(c[0].increase).toBe('10000.00');
    const costs = find('COSTS');
    // Operating expenses up 12.5% while revenue grew 1.4%.
    expect(costs.verdict).toBe('ACT');
    expect(costs.actions[0]).toMatchObject({ text: expect.stringContaining('Rent'), approval: expect.any(String) });
    expect(a.recommendations.some((r) => r.area === 'COSTS')).toBe(true);
  });

  it('needs action when the forecast falls below the minimum balance', () => {
    const r = cfoAssessment({ ...base, forecast: { ...base.forecast!, lowest: { date: '2026-12-01', amount: '40000.00' } } });
    const liq = r.findings.find((f) => f.key === 'LIQUIDITY')!;
    expect(liq.verdict).toBe('ACT');
    expect(liq.summary).toContain('₹60,000.00 short of the minimum balance');
    expect(r.recommendations[0]).toMatchObject({ priority: 'HIGH', path: '/planning/recovery' });
    expect(r.findings.find((f) => f.key === 'RISK')!.verdict).toBe('ACT');
  });

  it('handles a new organisation with nothing posted', () => {
    const empty = Array.from({ length: 24 }, (_, i) => month(i, { operatingRevenue: '0', costOfSales: '0', operatingExpenses: '0', payroll: '0', interest: '0', cash: '0', receivables: '0', payables: '0', otherCurrentLiabilities: '0', nonCurrentAssets: '0', nonCurrentLiabilities: '0', cashChange: '0' }));
    const r = cfoAssessment({ ...base, months: empty, accounts: [], customers: [], forecast: null, borrowings: null, budget: null });
    expect(r.findings.find((f) => f.key === 'PROFITABILITY')!.verdict).toBe('NO_DATA');
    for (const f of r.findings) expect(f.summary).not.toMatch(/undefined|NaN/);
  });
});

describe('virtual CFO questions', () => {
  it('explains why profit changed, account by account', () => {
    const r = profitChange(base);
    // Oct against Sep 2026: revenue +1,000, cost of goods +400; rent unchanged (both 30,000).
    expect(r.figures.find((x) => x.label === 'Change')!.value).toBe('600.00');
    expect(r.title).toBe('Net profit rose in Oct 2026');
    expect(r.table!.rows[0]).toMatchObject({ account: '4100 Sales', effect: '1000.00' });
    expect(r.question).toBe('Why did profit change last month?');
    const jul = profitChange({ ...base, months: months.slice(0, 22), accounts: accounts.map((a) => ({ ...a, amounts: a.amounts.slice(0, 22) })) });
    // Aug 2026: rent up 10,000.
    expect(jul.summary).toMatch(/fell by ₹9,400\.00/);
    expect(jul.summary).toContain('6200 Rent (up ₹10,000.00)');
  });

  it('ranks clients by revenue and says plainly that profit per client is not known', () => {
    const r = clientProfitability(base);
    expect(r.confidence).toBe('LOW');
    expect(r.summary).toContain('not by profit');
    expect(r.table!.rows[0]).toMatchObject({ client: 'Acme Retail', share: '60.0', change: '25.0' });
  });

  it('lists projects that lost money', () => {
    const r = projectLosses({ currency: 'INR', scale: 2, from: '2025-11-01', to: '2026-10-31', projects: [{ code: 'P1', name: 'Warehouse', revenue: '100.00', expenses: '250.00', net: '-150.00', margin: '-150.0' }, { code: 'P2', name: 'Export', revenue: '500.00', expenses: '100.00', net: '400.00', margin: '80.0' }, { code: null, name: 'Not assigned', revenue: '0', expenses: '900', net: '-900', margin: null }] });
    expect(r.title).toBe('1 project is losing money');
    expect(r.summary).toContain('Warehouse lost ₹150.00');
  });

  it('works out the cash needed next quarter from the forecast', () => {
    const r = cashNextQuarter({ ...base, forecast: { ...base.forecast!, lowest: { date: '2026-12-01', amount: '70000.00' }, lowestLow: { date: '2026-12-10', amount: '20000.00' } }, twin: null });
    expect(r.figures.find((x) => x.label === 'Cash needed (forecast)')!.value).toBe('30000.00');
    expect(r.figures.find((x) => x.label === 'Cash needed if customers pay late')!.value).toBe('80000.00');
    expect(r.verdict).toBe('ACT');
    expect(r.actions[0].approval).toMatch(/Owner/);
  });

  it('points at expenses above their recent average and at leakage alerts', () => {
    const spiked = accounts.map((a) => (a.code === '6200' ? { ...a, amounts: a.amounts.map((x, i) => (i === 23 ? '60000.00' : x)) } : a));
    const r = expensesToInvestigate({ ...base, accounts: spiked, leakage: [{ title: 'Possible duplicate bill GP-1', amount: '12000.00', severity: 'HIGH' }] });
    expect(r.table!.rows.map((x) => x.item)).toEqual(['6200 Rent', 'Alert: Possible duplicate bill GP-1']);
    // 60,000 against the average of Feb to Jul 2026 (4 × 20,000 + 2 × 30,000) ÷ 6.
    expect(r.table!.rows[0].over).toBe('36666.67');
  });

  it('measures a 10% salary rise on the digital twin', () => {
    const baseline = { months: months.slice(-6).map((m) => ({ month: m.month, revenue: m.operatingRevenue.toFixed(2), otherIncome: '0.00', costOfSales: m.costOfSales.toFixed(2), payroll: '60000.00', otherOperating: m.operatingExpenses.minus(m.payroll).toFixed(2), depreciation: '0.00', interest: '2000.00', incomeTax: '0.00', otherExpenses: '0.00', cash: m.cash.toFixed(2), receivables: '240000.00', payables: '90000.00' })), currency: 'INR', scale: 2 };
    const b = runTwin({ baseline, drivers: [], horizonMonths: 12 });
    const w = runTwin({ baseline, drivers: [{ kind: 'EXPENSE_CHANGE', target: 'PAYROLL', percent: '10', fromMonth: 1 }], horizonMonths: 12 });
    const r = salaryRise({ currency: 'INR', scale: 2, base: b, withRise: w, percent: '10' });
    expect(r.figures[0].value).toBe('6000.00');
    expect(new D(r.figures[1].value!).minus(r.figures[2].value!).toNumber()).toBeGreaterThan(70000);
    expect(r.actions[0].approval).toBe('Owner approval for a pay rise');
  });

  it('finds vendors charging more for the same item', () => {
    const r = vendorPrices({
      currency: 'INR',
      scale: 2,
      today: '2026-11-04',
      lines: [
        { vendor: 'Granite Parts', item: 'Steel sheet', date: '2026-03-10', quantity: '10', unitPrice: '100.00' },
        { vendor: 'Granite Parts', item: 'steel sheet ', date: '2026-10-10', quantity: '20', unitPrice: '112.00' },
        { vendor: 'Office Hub', item: 'Paper', date: '2026-03-10', quantity: '5', unitPrice: '50.00' },
        { vendor: 'Office Hub', item: 'Paper', date: '2026-10-10', quantity: '5', unitPrice: '51.00' },
      ],
    });
    expect(r.table!.rows).toEqual([{ vendor: 'Granite Parts', item: 'Steel sheet', before: '100.00', recent: '112.00', change: '12.0', extra: '240.00' }]);
  });

  it('adds up tax owed and statutory items overdue or due soon', () => {
    const r = taxExposure({ ...base, compliance: [...base.compliance, { name: 'TDS deposit for September 2026', dueDate: '2026-10-07', status: 'OVERDUE', amount: '8000.00' }], payable: [{ code: '2200', name: 'GST payable', balance: '36000.00' }, { code: '2210', name: 'TDS payable', balance: '8000.00' }] });
    expect(r.title).toBe('₹44,000.00 of tax is owed per the ledger');
    expect(r.verdict).toBe('ACT');
    expect(r.summary).toContain('1 filing or payment is overdue, with ₹8,000.00 still to pay');
  });

  it('predicts late invoices from each customer’s record', () => {
    const r = lateInvoices({
      currency: 'INR',
      scale: 2,
      today: '2026-11-04',
      invoices: [
        { number: 'INV-1', customer: 'Acme Retail', dueDate: '2026-09-20', balance: '50000.00', averageDaysLate: 12, paidInvoices: 8 },
        { number: 'INV-2', customer: 'Bluebird', dueDate: '2026-11-30', balance: '30000.00', averageDaysLate: 2, paidInvoices: 6 },
        { number: 'INV-3', customer: 'Slowpay', dueDate: '2026-11-25', balance: '20000.00', averageDaysLate: 40, paidInvoices: 4 },
      ],
    });
    expect(r.table!.rows.map((x) => [x.invoice, x.risk])).toEqual([
      ['INV-1', 'High'],
      ['INV-3', 'High'],
    ]);
    expect(r.table!.rows[1].expected).toBe('4 Jan 2027');
  });
});

describe('AI summary figure check', () => {
  const a = cfoAssessment(base);
  const facts = factsForSummary(a, 2);

  it('accepts a summary that only copies figures from the facts', () => {
    const cash = a.findings[0].figures[0].value!; // 615000.00
    expect(facts).toContain('₹6,15,000.00');
    expect(cash).toBe('615000.00');
    expect(checkSummaryFigures(`Cash is ₹6,15,000.00 (₹6,15,000 rounded), health ${a.health.score} out of 100, over 3 months.`, facts)).toEqual([]);
  });

  it('rejects any figure that is not in the facts', () => {
    expect(checkSummaryFigures('Cash is ₹7,00,000 and margin 42.5%.', facts)).toEqual(['700000', '42.5']);
    // 100 is not shortened to 1 when checking.
    expect(checkSummaryFigures('Score 100.', 'Score 1.')).toEqual(['100']);
  });
});
