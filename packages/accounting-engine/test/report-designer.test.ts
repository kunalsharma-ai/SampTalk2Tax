import { describe, expect, it } from 'vitest';
import { checkCommentary, checkReportLayout, dashboardData, describeLayout, layoutWidgets, monthFigures, reportFacts, type SubtypeTotals } from '../src';

const t = (type: SubtypeTotals['type'], subtype: string | null, debit: string, credit = '0'): SubtypeTotals => ({ type, subtype, debit, credit });
const month = (m: string, rev: string, cos: string, bank: string) => monthFigures({ month: m, from: `${m}-01`, to: `${m}-28` }, [t('REVENUE', 'OPERATING_REVENUE', '0', rev), t('EXPENSE', 'COST_OF_SALES', cos)], [t('ASSET', 'BANK', bank)], '0');
const months = [month('2026-08', '80000', '40000', '300000'), month('2026-09', '100000', '40000', '320000'), month('2026-10', '150000', '60000', '410000')];

const layout = {
  sections: [
    { type: 'HEADING', text: ' Monthly results ' },
    { type: 'COMMENTARY', instruction: 'How sales and margins moved, in three sentences.' },
    { type: 'WIDGET', widget: { type: 'STAT', title: 'Revenue', metric: 'revenue', compare: 'PREVIOUS_MONTH' } },
    { type: 'WIDGET', widget: { type: 'TABLE', title: 'Profit and loss', metrics: ['revenue', 'costOfSales', 'grossProfit'], months: 2 } },
    { type: 'TEXT', text: 'Prepared by the finance team.' },
  ],
};

describe('report designer', () => {
  it('checks layouts and explains every problem', () => {
    const ok = checkReportLayout(layout);
    expect(ok.issues).toEqual([]);
    expect(ok.layout.sections[0]).toEqual({ type: 'HEADING', text: 'Monthly results' });
    expect(layoutWidgets(ok.layout).widgets.map((w) => w.title)).toEqual(['Revenue', 'Profit and loss']);
    expect(describeLayout(ok.layout)).toEqual([
      'Heading: Monthly results',
      'Commentary: How sales and margins moved, in three sentences.',
      'Revenue: Revenue for the month, against the month before',
      'Profit and loss: table of Revenue, Cost of sales, Gross profit for 2 months',
      'Text: Prepared by the finance team.',
    ]);
    expect(checkReportLayout({ sections: [] }).issues).toEqual(['Add at least one section']);
    expect(
      checkReportLayout({ sections: [{ type: 'HEADING', text: '' }, { type: 'CHART' }, { type: 'COMMENTARY' }, { type: 'WIDGET', widget: { type: 'STAT', title: 'x', metric: 'ebitda' } }] }).issues,
    ).toEqual([
      'Section 1: write the heading',
      'Section 2: choose a kind of section (heading, text, commentary or figures)',
      'Section 3: say what the commentary should cover',
      'Section 4: "ebitda" is not an approved metric',
    ]);
    expect(checkReportLayout({ sections: [{ type: 'TEXT', text: 'Words only' }] }).issues).toEqual(['Add at least one section of figures, so the report has something to report']);
  });

  it('turns the figures into facts, and rejects commentary quoting numbers not in them', () => {
    const { layout: l } = checkReportLayout(layout);
    const data = dashboardData(layoutWidgets(l), months, 2, () => null);
    const facts = reportFacts(l, data, '2026-10', 'INR');
    expect(facts).toContain('- Revenue: Revenue for 2026-10 is INR 150000.00; 2026-09 was INR 100000.00, a change of INR 50000.00.');
    expect(facts).toContain('  - 2026-10: Revenue INR 150000.00; Cost of sales INR 60000.00; Gross profit INR 90000.00');
    expect(checkCommentary('Revenue rose by ₹50,000 to ₹1,50,000, and gross profit reached ₹90,000.00 in month 10.', facts)).toEqual([]);
    expect(checkCommentary('Revenue rose 50% to ₹1,50,000 and should reach ₹2,00,000 next month.', facts)).toEqual(['50', '200000']);
  });
});
