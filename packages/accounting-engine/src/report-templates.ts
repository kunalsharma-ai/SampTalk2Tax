/**
 * Report templates (RPT-030): ready-made layouts for the report designer, so a first management
 * pack takes a click. A template only fills the designer: the design it creates is the
 * organisation's own, checked like any other layout, and every figure still comes from the books.
 */
import type { ReportLayout } from './report-designer';

export interface ReportTemplate {
  id: string;
  name: string;
  /** Who the report is for and what it covers. */
  description: string;
  layout: ReportLayout;
}

const stat = (title: string, metric: string, compare = 'PREVIOUS_MONTH') => ({ type: 'WIDGET' as const, widget: { type: 'STAT', title, size: 'SMALL', metric, compare } as never });
const line = (title: string, metrics: string[], months = 12) => ({ type: 'WIDGET' as const, widget: { type: 'LINE', title, size: 'LARGE', metrics, months } as never });
const bar = (title: string, metrics: string[], months = 6) => ({ type: 'WIDGET' as const, widget: { type: 'BAR', title, size: 'LARGE', metrics, months } as never });
const table = (title: string, metrics: string[], months = 3) => ({ type: 'WIDGET' as const, widget: { type: 'TABLE', title, size: 'LARGE', metrics, months } as never });
const heading = (text: string) => ({ type: 'HEADING' as const, text });
const commentary = (instruction: string) => ({ type: 'COMMENTARY' as const, instruction });

export const REPORT_TEMPLATES: readonly ReportTemplate[] = [
  {
    id: 'MANAGEMENT_PACK',
    name: 'Monthly management pack',
    description: 'For the owners and managers each month: results, margins, cash and working capital, with commentary on what moved.',
    layout: {
      sections: [
        heading('Results for the month'),
        stat('Revenue', 'revenue'),
        stat('Gross profit', 'grossProfit'),
        stat('Net income', 'netIncome'),
        commentary('Explain how revenue, gross profit and net income moved against the previous month.'),
        table('Profit and loss', ['revenue', 'costOfSales', 'grossProfit', 'operatingExpenses', 'operatingProfit', 'netIncome'], 3),
        heading('Margins'),
        line('Margins over the year', ['grossMargin', 'operatingMargin', 'netMargin'], 12),
        heading('Cash and working capital'),
        stat('Cash and bank', 'cash'),
        stat('Receivables', 'receivables'),
        stat('Payables', 'payables'),
        commentary('Comment on cash, what customers owe and what is owed to suppliers.'),
      ],
    },
  },
  {
    id: 'BOARD_REPORT',
    name: 'Board report',
    description: 'For the board: headline results against the same month last year, the year so far, liquidity and cash runway.',
    layout: {
      sections: [
        heading('Headline results'),
        stat('Revenue', 'revenue', 'SAME_MONTH_LAST_YEAR'),
        stat('Operating profit', 'operatingProfit', 'SAME_MONTH_LAST_YEAR'),
        stat('Net margin', 'netMargin', 'SAME_MONTH_LAST_YEAR'),
        commentary('Summarise the results against the same month last year for the board, in a few sentences.'),
        bar('Revenue and operating profit', ['revenue', 'operatingProfit'], 12),
        heading('Liquidity'),
        stat('Current ratio', 'currentRatio'),
        stat('Cash runway', 'runway'),
        stat('Liabilities to equity', 'debtToEquity'),
        commentary('Comment on liquidity and cash runway, and anything the board should watch.'),
      ],
    },
  },
  {
    id: 'INVESTOR_UPDATE',
    name: 'Investor update',
    description: 'For investors: growth, margins and cash burn over the last months, with a short narrative.',
    layout: {
      sections: [
        heading('Growth'),
        line('Revenue', ['revenue'], 12),
        stat('Revenue', 'revenue', 'SAME_MONTH_LAST_YEAR'),
        commentary('Describe revenue growth over the last months for investors.'),
        heading('Margins and cash'),
        line('Gross and net margin', ['grossMargin', 'netMargin'], 12),
        stat('Net cash flow', 'netCashFlow'),
        stat('Cash and bank', 'cash'),
        stat('Cash runway', 'runway'),
        commentary('Comment on margins, cash flow and runway.'),
      ],
    },
  },
  {
    id: 'CASH_AND_COLLECTIONS',
    name: 'Cash and collections',
    description: 'For the finance team: cash, collection and payment days, and the customers who owe the most.',
    layout: {
      sections: [
        heading('Cash'),
        stat('Cash and bank', 'cash'),
        stat('Net cash flow', 'netCashFlow'),
        line('Cash over the year', ['cash'], 12),
        heading('Collections and payments'),
        stat('Days sales outstanding', 'dso'),
        stat('Days payables outstanding', 'dpo'),
        { type: 'WIDGET', widget: { type: 'TOP_CUSTOMERS', title: 'Largest customers', size: 'MEDIUM', count: 5, months: 3 } as never },
        commentary('Comment on collections and payment days and what to chase.'),
      ],
    },
  },
];

export function reportTemplate(id: string): ReportTemplate | undefined {
  return REPORT_TEMPLATES.find((t) => t.id === id);
}
