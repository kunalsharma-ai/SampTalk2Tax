'use client';
import { Badge, cn } from '@talk2tax/ui';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { signOut } from '@/lib/api';
import { useOrg, useOrgs } from '@/lib/org';
import { can } from '@/lib/types';
import { Logo } from './brand';

/** perm: shown only to roles that have it (a hint; the API enforces the real check). */
const NAV: { group: string; items: { href: string; label: string; perm?: string }[] }[] = [
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
      { href: '/reports/trial-balance', label: 'Trial balance' },
      { href: '/reports/income-statement', label: 'Profit and loss' },
      { href: '/reports/profit-by-dimension', label: 'Profit by department' },
      { href: '/reports/balance-sheet', label: 'Balance sheet' },
      { href: '/reports/general-ledger', label: 'General ledger' },
      { href: '/graph', label: 'Relationship explorer' },
      { href: '/reports/kpis', label: 'KPIs' },
      { href: '/reports/management', label: 'Management reports' },
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
  { group: 'Planning', items: [{ href: '/cfo', label: 'Virtual CFO' }, { href: '/benchmarking', label: 'Benchmarking' }, { href: '/decisions', label: 'Decision memory' }, { href: '/planning/budgets', label: 'Budgets' }, { href: '/planning/budget-vs-actual', label: 'Budget vs actual' }, { href: '/planning/cash-flow', label: 'Cash-flow forecast' }, { href: '/planning/twin', label: 'Digital twin' }, { href: '/planning/recovery', label: 'Recovery planner' }] },
  { group: 'Governance', items: [{ href: '/audit', label: 'Audit trail' }, { href: '/ai-control', label: 'AI control center', perm: 'audit.read' }, { href: '/ai-activity', label: 'AI activity', perm: 'audit.read' }, { href: '/members', label: 'Team and roles' }, { href: '/settings/integrations', label: 'Integrations', perm: 'org.manage' }, { href: '/settings/approvals', label: 'Approval rules' }, { href: '/automations', label: 'Automations', perm: 'workflows.manage' }] },
];

/** Employees only claim expenses; the rest of the books is not theirs to see. */
const EMPLOYEE_NAV: typeof NAV = [{ group: 'Expenses', items: [{ href: '/expenses', label: 'My expense claims' }] }];

export function Shell({ children }: { children: ReactNode }) {
  const { org, orgId, isLoading } = useOrg();
  const orgs = useOrgs();
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const base = `/orgs/${orgId}`;

  const nav = (
    <nav aria-label="Main" className="flex flex-col gap-6">
      {(org?.role === 'EMPLOYEE' ? EMPLOYEE_NAV : NAV.filter((g) => g.group !== 'Payroll' || can(org?.role, 'payroll.read'))).map((g) => (
        <div key={g.group}>
          <p className="px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-fg-faint">{g.group}</p>
          <ul className="mt-2 flex flex-col gap-0.5">
            {g.items.filter((i) => !i.perm || can(org?.role, i.perm)).map((i) => {
              const href = `${base}${i.href}`;
              const active = i.href === '' ? pathname === base : pathname.startsWith(href);
              return (
                <li key={i.href}>
                  <Link
                    href={href}
                    onClick={() => setOpen(false)}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex items-center rounded-[var(--t2t-radius-md)] px-3 py-2 text-sm transition-colors',
                      active ? 'bg-accent/10 text-fg shadow-[inset_2px_0_0_var(--t2t-accent)]' : 'text-fg-muted hover:bg-surface-hover hover:text-fg',
                    )}
                  >
                    {i.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[256px_1fr] print:block">
      <aside className={cn('fixed inset-y-0 left-0 z-30 w-64 overflow-y-auto border-r border-line bg-surface/95 p-4 backdrop-blur lg:sticky lg:top-0 lg:block lg:h-screen print:hidden', open ? 'block' : 'hidden')}>
        <div className="flex h-10 items-center px-2">
          <Link href="/">
            <Logo />
          </Link>
        </div>
        <div className="mt-6">{nav}</div>
      </aside>
      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-20 flex print:hidden h-14 items-center gap-3 border-b border-line bg-bg/80 px-4 backdrop-blur lg:px-8">
          <button className="rounded p-2 text-fg-muted hover:text-fg lg:hidden" onClick={() => setOpen((v) => !v)} aria-label="Toggle navigation" aria-expanded={open}>
            ☰
          </button>
          <label className="sr-only" htmlFor="org-switch">
            Organisation
          </label>
          <select
            id="org-switch"
            className="min-w-0 max-w-[55vw] truncate rounded-[var(--t2t-radius-md)] border border-line bg-surface px-3 py-1.5 text-sm text-fg"
            value={orgId}
            onChange={(e) => (e.target.value === '__new' ? router.push('/onboarding') : router.push(`/orgs/${e.target.value}`))}
          >
            {(orgs.data ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
            <option value="__new">+ New organisation…</option>
          </select>
          <span className="hidden items-center gap-2 sm:flex">
            {org ? <Badge tone="violet">{org.role}</Badge> : null}
            {org?.isDemo ? <Badge tone="warning">Synthetic demo data</Badge> : null}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Link href={`/orgs/${orgId}/account`} className="rounded px-3 py-1.5 text-sm text-fg-muted hover:bg-surface-hover hover:text-fg">
              Security
            </Link>
            <button className="rounded px-3 py-1.5 text-sm text-fg-muted hover:bg-surface-hover hover:text-fg" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </header>
        {org?.isDemo ? <p className="border-b border-warning/30 bg-warning/10 px-4 py-1.5 text-center text-xs text-warning sm:hidden">Synthetic demo data</p> : null}
        <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 lg:px-8">
          {isLoading ? <p className="text-sm text-fg-muted">Loading…</p> : !org ? <p className="text-sm text-fg-muted">Organisation not found or you do not have access.</p> : children}
        </main>
      </div>
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-sm text-fg-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
