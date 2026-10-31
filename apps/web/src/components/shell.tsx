'use client';
import { Badge, cn } from '@talk2tax/ui';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { signOut } from '@/lib/api';
import { useOrg, useOrgs } from '@/lib/org';
import { Logo } from './brand';

const NAV: { group: string; items: { href: string; label: string }[] }[] = [
  { group: 'Overview', items: [{ href: '', label: 'Dashboard' }] },
  {
    group: 'Sales',
    items: [
      { href: '/sales/customers', label: 'Customers' },
      { href: '/sales/invoices', label: 'Invoices' },
      { href: '/sales/receipts', label: 'Receipts' },
      { href: '/sales/ageing', label: 'Receivables ageing' },
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
    group: 'Accounting',
    items: [
      { href: '/journals', label: 'Journals' },
      { href: '/accounts', label: 'Chart of accounts' },
      { href: '/periods', label: 'Fiscal periods' },
    ],
  },
  {
    group: 'Reports',
    items: [
      { href: '/reports/trial-balance', label: 'Trial balance' },
      { href: '/reports/income-statement', label: 'Profit and loss' },
      { href: '/reports/balance-sheet', label: 'Balance sheet' },
      { href: '/reports/general-ledger', label: 'General ledger' },
    ],
  },
  { group: 'Governance', items: [{ href: '/audit', label: 'Audit trail' }, { href: '/members', label: 'Team and roles' }, { href: '/settings/tax-rates', label: 'Tax rates' }] },
];

export function Shell({ children }: { children: ReactNode }) {
  const { org, orgId, isLoading } = useOrg();
  const orgs = useOrgs();
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const base = `/orgs/${orgId}`;

  const nav = (
    <nav aria-label="Main" className="flex flex-col gap-6">
      {NAV.map((g) => (
        <div key={g.group}>
          <p className="px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-fg-faint">{g.group}</p>
          <ul className="mt-2 flex flex-col gap-0.5">
            {g.items.map((i) => {
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
    <div className="min-h-screen lg:grid lg:grid-cols-[256px_1fr]">
      <aside className={cn('fixed inset-y-0 left-0 z-30 w-64 overflow-y-auto border-r border-line bg-surface/95 p-4 backdrop-blur lg:sticky lg:top-0 lg:block lg:h-screen', open ? 'block' : 'hidden')}>
        <div className="flex h-10 items-center px-2">
          <Link href="/">
            <Logo />
          </Link>
        </div>
        <div className="mt-6">{nav}</div>
      </aside>
      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-bg/80 px-4 backdrop-blur lg:px-8">
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
          <div className="ml-auto shrink-0">
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
