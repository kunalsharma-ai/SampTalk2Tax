import { describe, expect, it } from 'vitest';
import { checkDashboard, dashboardData, describeDashboard, metricSeries, monthFigures, monthsNeeded, type SubtypeTotals } from '../src';

const t = (type: SubtypeTotals['type'], subtype: string | null, debit: string, credit = '0'): SubtypeTotals => ({ type, subtype, debit, credit });
const ym = (k: number) => {
  const m = 1 + ((k - 1) % 12);
  const y = 2025 + Math.floor((k - 1) / 12);
  return `${y}-${String(m).padStart(2, '0')}`;
};
// 14 months, Jan 2025 to Feb 2026: revenue 100,000 + 10,000 a month; cost of sales 40%; bank grows by profit.
const months = Array.from({ length: 14 }, (_, i) => {
  const rev = 100000 + 10000 * i;
  const cos = rev * 0.4;
  const bank = 200000 + 10000 * i;
  const m = ym(i + 1);
  return monthFigures({ month: m, from: `${m}-01`, to: `${m}-28` }, [t('REVENUE', 'OPERATING_REVENUE', '0', String(rev)), t('EXPENSE', 'COST_OF_SALES', String(cos))], [t('ASSET', 'BANK', String(bank)), t('LIABILITY', 'ACCOUNTS_PAYABLE', '0', '50000')], '10000');
});

const good = {
  widgets: [
    { type: 'STAT', title: ' Revenue ', metric: 'revenue', compare: 'SAME_MONTH_LAST_YEAR' },
    { type: 'LINE', title: 'Revenue and gross profit', metrics: ['revenue', 'grossProfit'], months: 6 },
    { type: 'TABLE', title: 'Margins', metrics: ['grossMargin', 'currentRatio'], months: 3 },
    { type: 'TOP_CUSTOMERS', title: 'Biggest customers', count: 5, months: 12 },
  ],
};

describe('dashboards', () => {
  it('checks a configuration and explains every problem', () => {
    const ok = checkDashboard(good);
    expect(ok.issues).toEqual([]);
    expect(ok.config.widgets[0]).toEqual({ type: 'STAT', title: 'Revenue', size: 'SMALL', metric: 'revenue', compare: 'SAME_MONTH_LAST_YEAR' });
    expect(ok.config.widgets[1]).toMatchObject({ size: 'MEDIUM', months: 6 });
    expect(monthsNeeded(ok.config)).toBe(15);

    expect(checkDashboard({ widgets: [] }).issues).toEqual(['Add at least one widget']);
    const bad = checkDashboard({
      widgets: [
        { type: 'PIE', title: 'x' },
        { type: 'LINE', title: 'Mixed', metrics: ['revenue', 'grossMargin', 'revenue', 'ebitda'], months: 40 },
        { type: 'STAT', title: '', metric: 'profitability' },
        { type: 'TOP_CUSTOMERS', title: 'Top', count: 50 },
      ],
    }).issues;
    expect(bad).toEqual([
      'Widget 1: choose a kind of widget (figure, line chart, bar chart, table, top customers)',
      'Widget 2: Revenue is chosen twice',
      'Widget 2: "ebitda" is not an approved metric',
      'Widget 2: a chart can only show metrics measured the same way; these mix amounts and percentages',
      'Widget 2: Months must be a whole number from 3 to 24',
      'Widget 3: give the widget a title',
      'Widget 3: "profitability" is not an approved metric',
      'Widget 4: Number of customers must be a whole number from 3 to 10',
    ]);
  });

  it('works out each widget from the posted month figures', () => {
    const { config } = checkDashboard(good);
    const customers = () => ({ type: 'TOP_CUSTOMERS' as const, from: '2025-03-01', to: '2026-02-28', total: '100.00', rows: [{ id: 'a', name: 'Acme', revenue: '100.00', share: '100.0' }], others: { count: 0, revenue: '0.00', share: null } });
    const [stat, line, table, top] = dashboardData(config, months, 2, customers);
    // Feb 2026 revenue 230,000 against Feb 2025's 110,000.
    expect(stat).toMatchObject({ type: 'STAT', value: '230000.00', month: '2026-02', compareMonth: '2025-02', compareValue: '110000.00', change: '120000.00', better: true });
    expect(line).toMatchObject({ type: 'LINE' });
    if (line!.type !== 'LINE') throw new Error();
    expect(line.rows.map((r) => r.month)).toEqual(['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02']);
    expect(line.rows[5]!.values).toEqual({ revenue: '230000.00', grossProfit: '138000.00' });
    if (table!.type !== 'TABLE') throw new Error();
    // 330,000 bank ÷ 50,000 payables.
    expect(table.rows[2]!.values).toEqual({ grossMargin: '60.0', currentRatio: '6.60' });
    expect(top).toMatchObject({ type: 'TOP_CUSTOMERS', total: '100.00' });
    // Without access to sales, the customer widget says why it is empty.
    expect(dashboardData(config, months, 2, () => null)[3]).toEqual({ type: 'UNAVAILABLE', reason: 'Showing customers needs access to sales' });
    // A KPI with no value says why.
    const empty = dashboardData(checkDashboard({ widgets: [{ type: 'STAT', title: 'Margin', metric: 'grossMargin', compare: 'NONE' }] }).config, [monthFigures({ month: '2026-02', from: '2026-02-01', to: '2026-02-28' }, [], [], '0')], 2, () => null)[0];
    expect(empty).toMatchObject({ value: null, reason: 'No revenue in the month', compareMonth: null, change: null });
    expect(metricSeries(months).cash.at(-1)).toEqual({ month: '2026-02', value: '330000.00' });
  });

  it('describes a dashboard in words', () => {
    expect(describeDashboard(checkDashboard(good).config)).toEqual([
      'Revenue: Revenue for the month, against the same month last year',
      'Revenue and gross profit: line chart of Revenue, Gross profit over 6 months',
      'Margins: table of Gross margin, Current ratio for 3 months',
      'Biggest customers: the 5 largest customers by revenue over 12 months',
    ]);
  });
});
