/** The main navigation. Labels are English; the shell translates them. */
import { countrySupports, type CapabilityKey } from '@talk2tax/accounting-engine';
import { can, type Org } from './types';

/**
 * perm: shown only to roles that have it (a hint; the API enforces the real check).
 * needs: shown only where the organisation's country module supports it (the API refuses too).
 * flag: shown once the organisation's flags are known and this one is on (the API refuses it when off).
 */
export type PlanFeature = 'AI' | 'PAYROLL' | 'MULTI_CURRENCY' | 'CONSOLIDATION';
/** plan: a module the organisation's plan must include to use it (shown with "Upgrade" otherwise; past records stay readable). */
export interface NavItem { href: string; label: string; perm?: string; needs?: CapabilityKey; plan?: PlanFeature; locked?: boolean; flag?: string }
export const NAV: { group: string; items: NavItem[] }[] = [
  { group: 'Overview', items: [{ href: '', label: 'Dashboard' }, { href: '/copilot', label: 'Copilot', plan: 'AI' }, { href: '/alerts', label: 'Alerts' }, { href: '/approvals', label: 'Approvals' }, { href: '/tasks', label: 'My tasks' }] },
  {
    group: 'Sales',
    items: [
      { href: '/sales/leads', label: 'Leads' },
      { href: '/sales/pipeline', label: 'Pipeline' },
      { href: '/sales/quotes', label: 'Quotations' },
      { href: '/sales/orders', label: 'Sales orders' },
      { href: '/sales/pro-formas', label: 'Pro forma invoices' },
      { href: '/sales/retainers', label: 'Retainers' },
      { href: '/sales/contracts', label: 'Contracts' },
      { href: '/sales/customers', label: 'Customers' },
      { href: '/sales/onboarding', label: 'Customer onboarding' },
      { href: '/sales/customer-insights', label: 'Customer insights', perm: 'reports.read' },
      { href: '/sales/revenue-forecast', label: 'Revenue forecast', perm: 'reports.read' },
      { href: '/sales/revenue-recognition', label: 'Revenue recognition' },
      { href: '/sales/unbilled-revenue', label: 'Unbilled revenue' },
      { href: '/sales/invoices', label: 'Invoices' },
      { href: '/sales/receipts', label: 'Receipts' },
      { href: '/sales/payment-links', label: 'Payment links' },
      { href: '/sales/ageing', label: 'Receivables ageing' },
      { href: '/sales/disputes', label: 'Disputes' },
      { href: '/sales/bad-debts', label: 'Bad debts' },
      { href: '/sales/collections', label: 'Collections', perm: 'collections.manage', plan: 'AI' },
      { href: '/settings/invoice-templates', label: 'Invoice templates' },
      { href: '/settings/signature', label: 'My signature', perm: 'documents.sign' },
    ],
  },
  {
    group: 'Purchases',
    items: [
      { href: '/purchases/vendors', label: 'Vendors' },
      { href: '/purchases/onboarding', label: 'Vendor onboarding' },
      { href: '/purchases/vendor-performance', label: 'Vendor performance' },
      { href: '/purchases/supplier-tax', label: 'Supplier tax checks' },
      { href: '/purchases/vendor-risk', label: 'Vendor risk' },
      { href: '/purchases/vendor-invoices', label: 'Vendor invoices' },
      { href: '/purchases/orders', label: 'Purchase orders' },
      { href: '/purchases/bills', label: 'Bills' },
      { href: '/purchases/payments', label: 'Payments' },
      { href: '/purchases/recurring-bills', label: 'Recurring bills' },
      { href: '/purchases/payment-schedule', label: 'Payment schedule' },
      { href: '/purchases/payment-batches', label: 'Payment batches' },
      { href: '/purchases/international-payments', label: 'International payments' },
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
      { href: '/payroll/runs', label: 'Pay runs', needs: 'PAYROLL', plan: 'PAYROLL' },
      { href: '/payroll/employees', label: 'Employees', needs: 'PAYROLL', plan: 'PAYROLL' },
      { href: '/settings/payroll', label: 'Payroll settings', needs: 'PAYROLL', plan: 'PAYROLL' },
    ],
  },
  {
    group: 'Accounting',
    items: [
      { href: '/journals', label: 'Journals' },
      { href: '/journal-templates', label: 'Journal templates' },
      { href: '/accounts', label: 'Chart of accounts' },
      { href: '/fixed-assets', label: 'Fixed assets' },
      { href: '/deferrals', label: 'Prepaid and deferred' },
      { href: '/accruals', label: 'Accruals' },
      { href: '/dimensions', label: 'Departments and projects' },
      { href: '/close', label: 'Month-end close' },
      { href: '/year-end', label: 'Year-end close' },
      { href: '/periods', label: 'Fiscal periods' },
      { href: '/fx', label: 'Exchange rates', plan: 'MULTI_CURRENCY' },
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
      { href: '/reports/statutory', label: 'Statutory statements' },
      { href: '/reports/general-ledger', label: 'General ledger' },
      { href: '/graph', label: 'Relationship explorer' },
      { href: '/reports/kpis', label: 'KPIs' },
      { href: '/reports/management', label: 'Management reports' },
      { href: '/reports/designer', label: 'Report designer' },
      { href: '/consolidation', label: 'Group consolidation', plan: 'CONSOLIDATION' },
    ],
  },
  {
    group: 'Tax',
    items: [
      { href: '/tax/compliance', label: 'Compliance calendar', needs: 'COMPLIANCE_CALENDAR' },
      { href: '/tax/gst-returns', label: 'GST returns', needs: 'SALES_TAX_RETURNS' },
      { href: '/tax/e-invoices', label: 'E-invoices', needs: 'E_INVOICING' },
      { href: '/tax/e-way-bills', label: 'E-way bills', needs: 'TRANSPORT_DOCUMENTS' },
      { href: '/tax/tds-tcs', label: 'TDS and TCS', needs: 'WITHHOLDING' },
      { href: '/settings/gst', label: 'GST settings', needs: 'SALES_TAX_RETURNS' },
      { href: '/settings/e-invoicing', label: 'E-invoicing settings', needs: 'E_INVOICING' },
      { href: '/settings/e-way-bills', label: 'E-way bill settings', needs: 'TRANSPORT_DOCUMENTS' },
      { href: '/settings/tds-tcs', label: 'TDS/TCS settings', needs: 'WITHHOLDING' },
      { href: '/settings/tax-rates', label: 'Tax rates' },
      { href: '/settings/country-module', label: 'Country module' },
    ],
  },
  { group: 'Planning', items: [{ href: '/cfo', label: 'Virtual CFO' }, { href: '/benchmarking', label: 'Benchmarking', flag: 'benchmarking' }, { href: '/decisions', label: 'Decision memory' }, { href: '/planning/budgets', label: 'Budgets' }, { href: '/planning/budget-vs-actual', label: 'Budget vs actual' }, { href: '/planning/cash-flow', label: 'Cash-flow forecast' }, { href: '/planning/twin', label: 'Digital twin' }, { href: '/planning/recovery', label: 'Recovery planner' }, { href: '/planning/forecast-lab', label: 'Forecast lab', flag: 'forecast-lab' }, { href: '/planning/disasters', label: 'Disaster simulation', flag: 'disaster-simulation' }, { href: '/planning/impact', label: 'Business impact' }, { href: '/planning/opportunities', label: 'Growth opportunities', flag: 'opportunities' }] },
  { group: 'Governance', items: [{ href: '/audit', label: 'Audit trail' }, { href: '/ai-control', label: 'AI control center', perm: 'audit.read' }, { href: '/ai-activity', label: 'AI activity', perm: 'audit.read' }, { href: '/members', label: 'Team and roles' }, { href: '/settings/subscription', label: 'Subscription' }, { href: '/settings/usage', label: 'Usage' }, { href: '/settings/integrations', label: 'Integrations', perm: 'org.manage' }, { href: '/settings/payment-gateways', label: 'Payment gateways', perm: 'org.manage' }, { href: '/settings/approvals', label: 'Approval rules' }, { href: '/automations', label: 'Automations', perm: 'workflows.manage' }, { href: '/governance/policies', label: 'Policy studio' }, { href: '/guide', label: 'Feature guide' }, { href: '/support', label: 'Help and support' }] },
];

/** Employees only claim expenses; the rest of the books is not theirs to see. */
export const EMPLOYEE_NAV: typeof NAV = [{ group: 'Expenses', items: [{ href: '/expenses', label: 'My expense claims' }] }, { group: 'Help', items: [{ href: '/guide', label: 'Feature guide' }, { href: '/support', label: 'Help and support' }] }];


/** The navigation an organisation sees: its role's items, in its country, without empty groups. */
export function navFor(org: (Pick<Org, 'role' | 'countryCode'> & { subscription?: Org['subscription'] }) | undefined, flags?: Record<string, boolean>) {
  if (org?.role === 'EMPLOYEE') return EMPLOYEE_NAV;
  const features = org?.subscription?.plan.features;
  return NAV.filter((g) => g.group !== 'Payroll' || can(org?.role, 'payroll.read'))
    .map((g) => ({
      ...g,
      items: g.items
        .filter((i) => (!i.perm || can(org?.role, i.perm)) && (!i.needs || (!!org && countrySupports(org.countryCode, i.needs))) && (!i.flag || flags?.[i.flag] === true))
        .map((i) => (i.plan && features && !features.includes(i.plan) ? { ...i, locked: true } : i)),
    }))
    .filter((g) => g.items.length > 0);
}
