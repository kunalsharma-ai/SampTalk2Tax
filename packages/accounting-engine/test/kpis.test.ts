import { describe, expect, it } from 'vitest';
import { computeKpis, concentration, D, kpiChange, kpiSeries, monthFigures, plFigures, plFromAmounts, SubtypeTotals, targetStatus } from '../src';

const t = (type: SubtypeTotals['type'], subtype: string | null, debit: string, credit = '0'): SubtypeTotals => ({ type, subtype, debit, credit });
const sep = { month: '2026-09', from: '2026-09-01', to: '2026-09-30' };
const movements = [
  t('REVENUE', 'OPERATING_REVENUE', '0', '100000'),
  t('REVENUE', 'OTHER_INCOME', '0', '1000'),
  t('EXPENSE', 'COST_OF_SALES', '40000'),
  t('EXPENSE', 'OPERATING_EXPENSE', '20000'),
  t('EXPENSE', 'PAYROLL_EXPENSE', '15000'),
  t('EXPENSE', 'DEPRECIATION', '5000'),
  t('EXPENSE', 'INTEREST_EXPENSE', '2000'),
  t('EXPENSE', 'TAX_EXPENSE', '3000'),
  t('EXPENSE', 'FX_GAIN_LOSS', '500'),
];
const balances = [
  t('ASSET', 'CASH', '50000'),
  t('ASSET', 'BANK', '150000'),
  t('ASSET', 'ACCOUNTS_RECEIVABLE', '120000'),
  t('ASSET', 'INVENTORY', '30000'),
  t('ASSET', 'PREPAID', '10000'),
  t('ASSET', 'FIXED_ASSET', '100000'),
  t('ASSET', 'ACCUMULATED_DEPRECIATION', '0', '20000'),
  t('LIABILITY', 'ACCOUNTS_PAYABLE', '0', '60000'),
  t('LIABILITY', 'TAX_PAYABLE', '0', '20000'),
  t('LIABILITY', 'LONG_TERM_DEBT', '0', '100000'),
  // Equity and P&L balances do not enter the ratios directly.
  t('EQUITY', 'SHARE_CAPITAL', '0', '244500'),
];
const byKey = (k: ReturnType<typeof computeKpis>) => Object.fromEntries(k.map((x) => [x.key, x]));

describe('grouping the ledger', () => {
  it('groups movements and balances by subtype', () => {
    const m = monthFigures(sep, movements, balances, '-30000');
    expect(m.days).toBe(30);
    expect(m.operatingExpenses.toFixed(2)).toBe('40000.00');
    expect(m.otherExpenses.toFixed(2)).toBe('500.00');
    expect(m.cash.toFixed(2)).toBe('200000.00');
    expect(m.nonCurrentAssets.toFixed(2)).toBe('80000.00');
    expect(m.payables.toFixed(2)).toBe('60000.00');
    expect(m.otherCurrentLiabilities.toFixed(2)).toBe('20000.00');
    const pl = plFigures(m);
    expect([pl.grossProfit, pl.operatingProfit, pl.netIncome].map((x) => x.toFixed(2))).toEqual(['60000.00', '20000.00', '15500.00']);
  });

  it('treats an asset without a subtype as non-current and a liability without one as current', () => {
    const m = monthFigures(sep, [], [t('ASSET', null, '500'), t('LIABILITY', null, '0', '700')], '0');
    expect(m.nonCurrentAssets.toFixed(2)).toBe('500.00');
    expect(m.otherCurrentLiabilities.toFixed(2)).toBe('700.00');
  });

  it('groups budget amounts into the same lines', () => {
    const pl = plFromAmounts([
      { type: 'REVENUE', subtype: 'OPERATING_REVENUE', amount: '1000' },
      { type: 'EXPENSE', subtype: 'COST_OF_SALES', amount: '300' },
      { type: 'EXPENSE', subtype: 'PAYROLL_EXPENSE', amount: '200' },
    ]);
    expect([pl.grossProfit, pl.operatingExpenses, pl.netIncome].map((x) => x.toFixed(2))).toEqual(['700.00', '200.00', '500.00']);
  });
});

describe('KPIs', () => {
  it('computes every KPI with its components', () => {
    const k = byKey(computeKpis([monthFigures(sep, movements, balances, '-30000')]));
    expect(Object.fromEntries(Object.entries(k).map(([key, v]) => [key, v.value]))).toEqual({
      revenue: '100000.00',
      grossMargin: '60.0',
      operatingMargin: '20.0',
      netMargin: '15.3', // 15,500 ÷ 1,01,000
      opexRatio: '40.0',
      currentRatio: '4.50', // 3,60,000 ÷ 80,000
      quickRatio: '4.00',
      workingCapital: '280000.00',
      debtToEquity: '0.69', // 1,80,000 ÷ 2,60,000
      dso: '36.0', // 1,20,000 ÷ 1,00,000 × 30
      dpo: '30.0', // 60,000 ÷ (40,000 + 40,000 − 15,000 − 5,000) × 30
      netCashFlow: '-30000.00',
      runway: '6.7', // 2,00,000 ÷ 30,000
    });
    expect(k.currentRatio.components).toEqual([{ label: 'Current assets', amount: '360000.00' }, { label: 'Current liabilities', amount: '80000.00' }]);
  });

  it('gives a reason instead of a number when one cannot be computed', () => {
    const m = monthFigures(sep, [], [t('ASSET', 'BANK', '1000'), t('LIABILITY', 'LONG_TERM_DEBT', '0', '5000')], '500');
    const k = byKey(computeKpis([m]));
    expect(k.grossMargin).toMatchObject({ value: null, reason: 'No revenue in the month' });
    expect(k.currentRatio).toMatchObject({ value: null, reason: 'No current liabilities' });
    expect(k.debtToEquity).toMatchObject({ value: null, reason: 'Equity is zero or negative' });
    expect(k.runway).toMatchObject({ value: null, reason: 'Cash is not falling' });
    expect(k.revenue.value).toBe('0.00');
  });

  it('uses the last three months for trailing measures, and each month its own window in the series', () => {
    const month = (n: number, rev: string, change: string, ar: string) =>
      monthFigures({ month: `2026-0${n}`, from: `2026-0${n}-01`, to: `2026-0${n}-${n === 6 || n === 9 ? 30 : 31}` }, [t('REVENUE', 'OPERATING_REVENUE', '0', rev)], [t('ASSET', 'BANK', '90000'), t('ASSET', 'ACCOUNTS_RECEIVABLE', ar)], change);
    const months = [month(5, '10000', '5000', '0'), month(6, '20000', '-10000', '0'), month(7, '30000', '-20000', '0'), month(8, '40000', '0', '45000')];
    const k = byKey(computeKpis(months));
    // Jun–Aug: 90,000 revenue over 92 days
    expect(k.dso.value).toBe('46.0');
    expect(k.netCashFlow.value).toBe('-10000.00');
    expect(k.runway.value).toBe('9.0');
    const s = kpiSeries(months);
    expect(s.netCashFlow.map((x) => x.value)).toEqual(['5000.00', '-2500.00', '-8333.33', '-10000.00']);
    expect(s.runway.map((x) => x.value)).toEqual([null, '36.0', '10.8', '9.0']);
  });
});

describe('targets, changes and concentration', () => {
  it('checks targets and changes in the right direction', () => {
    expect(targetStatus('36.0', 'AT_MOST', '45')).toBe('MET');
    expect(targetStatus('1.20', 'AT_LEAST', '1.5')).toBe('MISSED');
    expect(targetStatus(null, 'AT_LEAST', '1')).toBe('NO_VALUE');
    expect(kpiChange('dso', '36.0', '40.5')).toEqual({ change: '-4.5', improved: true });
    expect(kpiChange('grossMargin', '58.0', '60.0')).toEqual({ change: '-2.0', improved: false });
    expect(kpiChange('revenue', '100.00', '100.00')).toEqual({ change: '0.00', improved: null });
    expect(kpiChange('revenue', null, '1')).toEqual({ change: null, improved: null });
  });

  it('ranks customers by revenue with their shares', () => {
    const c = concentration(
      [
        { id: 'a', name: 'A', revenue: '500' },
        { id: 'b', name: 'B', revenue: '250' },
        { id: 'c', name: 'C', revenue: '125' },
        { id: 'd', name: 'D', revenue: '125' },
        { id: 'z', name: 'Zero', revenue: '0' },
      ],
      2,
    );
    expect(c).toEqual({
      total: '1000.00',
      customers: 4,
      top: [
        { id: 'a', name: 'A', revenue: '500.00', share: '50.0' },
        { id: 'b', name: 'B', revenue: '250.00', share: '25.0' },
      ],
      others: { count: 2, revenue: '250.00', share: '25.0' },
      largestShare: '50.0',
      topFiveShare: '75.0',
    });
    expect(concentration([]).largestShare).toBeNull();
    expect(new D(c.total).toFixed(0)).toBe('1000');
  });
});
