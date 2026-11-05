/** The main navigation. Labels are English; the shell translates them. */
/** perm: shown only to roles that have it (a hint; the API enforces the real check). */
export const NAV: { group: string; items: { href: string; label: string; perm?: string }[] }[] = [
  { group: 'Overview', items: [{ href: '', label: 'Dashboard' }, { href: '/copilot', label: 'Copilot' }, { href: '/alerts', label: 'Alerts' }, { href: '/approvals', label: 'Approvals' }, { href: '/tasks', label: 'My tasks' }] },
  {
    group: 'Sales',
    items: [
      { href: '/sales/customers', label: 'Customers' },
      { href: '/sales/invoices', label: 'Invoices' },
      { href: '/sales/receipts', label: 'Receipts' },
      { href: '/sales/ageing', label: 'Receivables ageing' },
      { href: '/sales/collections', label: 'Collections', perm: 'collections.manage' },
      { href: '/settings/invoice-templates', label: 'Invoice templates' },
      { href: '/settings/signature', label: 'My signature', perm: 'documents.sign' },
    ],
  },
  {
    group: 'Purchases',
    items: [
      { href: '/purchases/vendors', label: 'Vendors' },
      { href: '/purchases/bills', label: 'Bills' },
      { href: '/purchases/payments', label: 'Payments' },
      { href: '/purchases/ageing', label: 'Payables ageing' },
    ],
  },
  {
    group: 'Banking',
    items: [
      { href: '/banking', label: 'Bank accounts' },
      { href: '/treasury', label: 'Treasury' },
      { href: '/loans', label: 'Loans' },
    ],
  },
  { group: 'Expenses', items: [{ href: '/expenses', label: 'Expense claims' }] },
  {
    group: 'Payroll',
    items: [
      { href: '/payroll/runs', label: 'Pay runs' },
      { href: '/payroll/employees', label: 'Employees' },
      { href: '/settings/payroll', label: 'Payroll settings' },
    ],
  },
  {
    group: 'Accounting',
    items: [
      { href: '/journals', label: 'Journals' },
      { href: '/accounts', label: 'Chart of accounts' },
      { href: '/fixed-assets', label: 'Fixed assets' },
      { href: '/deferrals', label: 'Prepaid and deferred' },
      { href: '/accruals', label: 'Accruals' },
      { href: '/dimensions', label: 'Departments and projects' },
      { href: '/close', label: 'Month-end close' },
      { href: '/periods', label: 'Fiscal periods' },
    ],
  },
  {
    group: 'Reports',
    items: [
      { href: '/reports/dashboards', label: 'Dashboards' },
      { href: '/reports/trial-balance', label: 'Trial balance' },
      { href: '/reports/income-statement', label: 'Profit and loss' },
      { href: '/reports/profit-by-dimension', label: 'Profit by department' },
      { href: '/reports/balance-sheet', label: 'Balance sheet' },
      { href: '/reports/general-ledger', label: 'General ledger' },
      { href: '/graph', label: 'Relationship explorer' },
      { href: '/reports/kpis', label: 'KPIs' },
      { href: '/reports/management', label: 'Management reports' },
      { href: '/reports/designer', label: 'Report designer' },
      { href: '/consolidation', label: 'Group consolidation' },
    ],
  },
  {
    group: 'Tax',
    items: [
      { href: '/tax/compliance', label: 'Compliance calendar' },
      { href: '/tax/gst-returns', label: 'GST returns' },
      { href: '/tax/e-invoices', label: 'E-invoices' },
      { href: '/tax/e-way-bills', label: 'E-way bills' },
      { href: '/tax/tds-tcs', label: 'TDS and TCS' },
      { href: '/settings/gst', label: 'GST settings' },
      { href: '/settings/e-invoicing', label: 'E-invoicing settings' },
      { href: '/settings/e-way-bills', label: 'E-way bill settings' },
      { href: '/settings/tds-tcs', label: 'TDS/TCS settings' },
      { href: '/settings/tax-rates', label: 'Tax rates' },
    ],
  },
  { group: 'Planning', items: [{ href: '/cfo', label: 'Virtual CFO' }, { href: '/benchmarking', label: 'Benchmarking' }, { href: '/decisions', label: 'Decision memory' }, { href: '/planning/budgets', label: 'Budgets' }, { href: '/planning/budget-vs-actual', label: 'Budget vs actual' }, { href: '/planning/cash-flow', label: 'Cash-flow forecast' }, { href: '/planning/twin', label: 'Digital twin' }, { href: '/planning/recovery', label: 'Recovery planner' }, { href: '/planning/forecast-lab', label: 'Forecast lab' }, { href: '/planning/disasters', label: 'Disaster simulation' }, { href: '/planning/impact', label: 'Business impact' }, { href: '/planning/opportunities', label: 'Growth opportunities' }] },
  { group: 'Governance', items: [{ href: '/audit', label: 'Audit trail' }, { href: '/ai-control', label: 'AI control center', perm: 'audit.read' }, { href: '/ai-activity', label: 'AI activity', perm: 'audit.read' }, { href: '/members', label: 'Team and roles' }, { href: '/settings/integrations', label: 'Integrations', perm: 'org.manage' }, { href: '/settings/approvals', label: 'Approval rules' }, { href: '/automations', label: 'Automations', perm: 'workflows.manage' }, { href: '/governance/policies', label: 'Policy studio' }] },
];

/** Employees only claim expenses; the rest of the books is not theirs to see. */
export const EMPLOYEE_NAV: typeof NAV = [{ group: 'Expenses', items: [{ href: '/expenses', label: 'My expense claims' }] }];

