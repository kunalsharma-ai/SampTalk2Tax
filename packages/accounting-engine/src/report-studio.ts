import { SCHEDULED_REPORTS } from './report-schedules';
import { VIEW_REPORTS } from './report-views';

/**
 * The reporting studio (RPT-001): every report Talk2Tax produces in one catalogue, grouped by
 * what it is for, with the question it answers, where it lives, the permission it needs, and
 * which of the studio's tools (saved views, exports, schedules) it supports.
 */
export const STUDIO_CATEGORIES = ['STATEMENTS', 'LEDGER', 'MANAGEMENT', 'DASHBOARDS', 'TAX', 'PEOPLE', 'AUDIT', 'STAKEHOLDERS', 'BUILD'] as const;
export type StudioCategory = (typeof STUDIO_CATEGORIES)[number];
export const STUDIO_CATEGORY_NAME: Record<StudioCategory, string> = {
  STATEMENTS: 'Financial statements',
  LEDGER: 'Ledgers and balances',
  MANAGEMENT: 'Management and analysis',
  DASHBOARDS: 'Dashboards',
  TAX: 'Tax',
  PEOPLE: 'Payroll and expenses',
  AUDIT: 'Audit and controls',
  STAKEHOLDERS: 'Executives, investors and the board',
  BUILD: 'Build your own',
};

export type StudioExport = 'PDF' | 'XLSX' | 'CSV';
export interface StudioReport {
  key: string;
  name: string;
  category: StudioCategory;
  question: string;
  href: string;
  permission: 'reports.read' | 'payroll.read' | 'audit.read' | 'expenses.read';
  exports: readonly StudioExport[];
}

const ALL: readonly StudioExport[] = ['PDF', 'XLSX', 'CSV'];
const CSV: readonly StudioExport[] = ['CSV'];

export const STUDIO_REPORTS: readonly StudioReport[] = [
  {
    key: 'income-statement',
    name: 'Profit and loss',
    category: 'STATEMENTS',
    question: 'What did we earn and spend in a period, on an accrual or cash basis, for a department or project?',
    href: '/reports/income-statement',
    permission: 'reports.read',
    exports: ALL,
  },
  { key: 'balance-sheet', name: 'Balance sheet', category: 'STATEMENTS', question: 'What do we own and owe on a day?', href: '/reports/balance-sheet', permission: 'reports.read', exports: ALL },
  {
    key: 'cash-flow-statement',
    name: 'Cash flow statement',
    category: 'STATEMENTS',
    question: 'Where did cash come from and go in a period?',
    href: '/reports/cash-flow-statement',
    permission: 'reports.read',
    exports: [],
  },
  {
    key: 'statutory',
    name: 'Statutory statements',
    category: 'STATEMENTS',
    question: 'What do the statements look like in the format the law asks for?',
    href: '/reports/statutory',
    permission: 'reports.read',
    exports: [],
  },
  {
    key: 'trial-balance',
    name: 'Trial balance',
    category: 'LEDGER',
    question: 'Do debits equal credits, and what is each account’s balance on a day?',
    href: '/reports/trial-balance',
    permission: 'reports.read',
    exports: ALL,
  },
  {
    key: 'general-ledger',
    name: 'General ledger',
    category: 'LEDGER',
    question: 'Which entries make up an account’s balance?',
    href: '/reports/general-ledger',
    permission: 'reports.read',
    exports: ALL,
  },
  { key: 'receivables-ageing', name: 'Receivables ageing', category: 'LEDGER', question: 'Who owes us, and how late is it?', href: '/sales/ageing', permission: 'reports.read', exports: ALL },
  { key: 'payables-ageing', name: 'Payables ageing', category: 'LEDGER', question: 'Whom do we owe, and when is it due?', href: '/purchases/ageing', permission: 'reports.read', exports: ALL },
  {
    key: 'profit-by-dimension',
    name: 'Profit by department or project',
    category: 'MANAGEMENT',
    question: 'Which departments and projects make money?',
    href: '/reports/profit-by-dimension',
    permission: 'reports.read',
    exports: ALL,
  },
  {
    key: 'department-performance',
    name: 'Department performance',
    category: 'MANAGEMENT',
    question: 'How is each department doing against its budget and last year?',
    href: '/reports/department-performance',
    permission: 'reports.read',
    exports: [],
  },
  { key: 'vendor-spend', name: 'Vendor spend', category: 'MANAGEMENT', question: 'Where does our money go, by vendor?', href: '/reports/vendor-spend', permission: 'reports.read', exports: [] },
  { key: 'kpis', name: 'KPIs', category: 'MANAGEMENT', question: 'How are the key ratios moving month by month?', href: '/reports/kpis', permission: 'reports.read', exports: [] },
  {
    key: 'management',
    name: 'Management reports',
    category: 'MANAGEMENT',
    question: 'What does the monthly management pack say?',
    href: '/reports/management',
    permission: 'reports.read',
    exports: [],
  },
  {
    key: 'visuals',
    name: 'Financial visuals',
    category: 'MANAGEMENT',
    question: 'What do revenue, costs and cash look like as charts?',
    href: '/reports/visuals',
    permission: 'reports.read',
    exports: [],
  },
  { key: 'timeline', name: 'Financial timeline', category: 'MANAGEMENT', question: 'What happened to the business, in order?', href: '/reports/timeline', permission: 'reports.read', exports: [] },
  {
    key: 'dependencies',
    name: 'Financial dependencies',
    category: 'MANAGEMENT',
    question: 'How much do we rely on a few customers, vendors, banks or lenders?',
    href: '/reports/dependencies',
    permission: 'reports.read',
    exports: [],
  },
  { key: 'risk-monitor', name: 'Risk monitor', category: 'MANAGEMENT', question: 'Where is financial risk building up?', href: '/reports/risk-monitor', permission: 'reports.read', exports: [] },
  { key: 'dashboards', name: 'Dashboards', category: 'DASHBOARDS', question: 'What are today’s headline figures?', href: '/reports/dashboards', permission: 'reports.read', exports: [] },
  {
    key: 'role-dashboards',
    name: 'Role dashboards',
    category: 'DASHBOARDS',
    question: 'What does each role — from CEO to auditor — need to see?',
    href: '/reports/role-dashboards',
    permission: 'reports.read',
    exports: [],
  },
  { key: 'tax', name: 'Tax report', category: 'TAX', question: 'How much tax did we charge, pay and owe in a period?', href: '/reports/tax', permission: 'reports.read', exports: CSV },
  {
    key: 'payroll',
    name: 'Payroll report',
    category: 'PEOPLE',
    question: 'What did pay runs cost, month by month and person by person?',
    href: '/reports/payroll',
    permission: 'payroll.read',
    exports: CSV,
  },
  {
    key: 'expense-evidence',
    name: 'Expense audit evidence',
    category: 'PEOPLE',
    question: 'Does every expense claim have its receipts and approvals?',
    href: '/expenses/evidence',
    permission: 'expenses.read',
    exports: CSV,
  },
  { key: 'audit', name: 'Audit report', category: 'AUDIT', question: 'What did audits find, and what is still open?', href: '/reports/audit', permission: 'audit.read', exports: CSV },
  {
    key: 'executive',
    name: 'Executive report',
    category: 'STAKEHOLDERS',
    question: 'How did the period go, in a page for leadership?',
    href: '/reports/executive',
    permission: 'reports.read',
    exports: [],
  },
  {
    key: 'investor',
    name: 'Investor report',
    category: 'STAKEHOLDERS',
    question: 'What should investors and the board see, without naming customers?',
    href: '/reports/investor',
    permission: 'reports.read',
    exports: [],
  },
  {
    key: 'designer',
    name: 'Report designer',
    category: 'BUILD',
    question: 'Build your own report: choose metrics, rows and columns, and keep versions.',
    href: '/reports/designer',
    permission: 'reports.read',
    exports: [],
  },
  { key: 'schedules', name: 'Scheduled reports', category: 'BUILD', question: 'Email a report to people on a schedule.', href: '/reports/schedules', permission: 'reports.read', exports: [] },
];

const VIEWABLE = new Set<string>(Object.keys(VIEW_REPORTS));
const SCHEDULABLE = new Set<string>(SCHEDULED_REPORTS);

/** Whether a report can be kept as a saved view, and sent on a schedule. */
export function studioTools(key: string) {
  return { savedViews: VIEWABLE.has(key), schedules: SCHEDULABLE.has(key) };
}

export function isStudioReport(key: string) {
  return STUDIO_REPORTS.some((r) => r.key === key);
}

/** Reports whose name, question or category contains every word searched for (case does not matter). */
export function searchStudio<T extends Pick<StudioReport, 'name' | 'question' | 'category'>>(reports: readonly T[], q: string): T[] {
  const words = q
    .toLowerCase()
    .split(' ')
    .map((w) => w.trim())
    .filter(Boolean)
    .slice(0, 8);
  if (!words.length) return [...reports];
  return reports.filter((r) => {
    const text = `${r.name} ${r.question} ${STUDIO_CATEGORY_NAME[r.category]}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}
