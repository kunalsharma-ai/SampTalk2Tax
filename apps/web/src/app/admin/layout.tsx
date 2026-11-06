'use client';
import { Badge, cn } from '@talk2tax/ui';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { Logo } from '@/components/brand';
import { signOut } from '@/lib/api';
import { ROLE_LABEL, useMeWithRole } from '@/lib/admin';
import { MaintenanceBanner } from '@/components/maintenance-banner';

const NAV = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/support', label: 'Support' },
  { href: '/admin/organisations', label: 'Organisations' },
  { href: '/admin/people', label: 'People' },
  { href: '/admin/subscriptions', label: 'Subscriptions' },
  { href: '/admin/invoices', label: 'Invoices' },
  { href: '/admin/usage', label: 'Usage' },
  { href: '/admin/plans', label: 'Plans' },
  { href: '/admin/payments', label: 'Payments' },
  { href: '/admin/announcements', label: 'Announcements' },
  { href: '/admin/system', label: 'System health' },
  { href: '/admin/errors', label: 'Errors' },
  { href: '/admin/flags', label: 'Feature flags' },
  { href: '/admin/maintenance', label: 'Maintenance' },
];

/** Platform administration: for the people who run Talk2Tax. Never an organisation's books. */
export default function AdminLayout({ children }: { children: ReactNode }) {
  const me = useMeWithRole();
  const pathname = usePathname();
  const role = me.data?.user.platformRole ?? null;
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[256px_1fr]">
      <aside className="border-b border-line bg-surface/95 p-4 lg:sticky lg:top-0 lg:h-screen lg:border-b-0 lg:border-r">
        <div className="flex h-10 items-center gap-2 px-2">
          <Link href="/"><Logo /></Link>
        </div>
        <p className="mt-6 px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-fg-faint">Platform administration</p>
        <nav aria-label="Platform administration" className="mt-2">
          <ul className="flex flex-wrap gap-0.5 lg:flex-col">
            {NAV.map((i) => {
              const active = i.href === '/admin' ? pathname === '/admin' : pathname.startsWith(i.href);
              return (
                <li key={i.href}>
                  <Link href={i.href} aria-current={active ? 'page' : undefined} className={cn('flex rounded-[var(--t2t-radius-md)] px-3 py-2 text-sm', active ? 'bg-accent/10 text-fg shadow-[inset_2px_0_0_var(--t2t-accent)]' : 'text-fg-muted hover:bg-surface-hover hover:text-fg')}>
                    {i.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </aside>
      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-bg/80 px-4 backdrop-blur lg:px-8">
          {role ? <Badge tone="violet">{ROLE_LABEL[role]}</Badge> : null}
          <span className="hidden text-sm text-fg-muted sm:inline">{me.data?.user.email}</span>
          <div className="ml-auto flex items-center gap-1">
            <Link href="/" className="rounded px-3 py-1.5 text-sm text-fg-muted hover:bg-surface-hover hover:text-fg">My organisations</Link>
            <button className="rounded px-3 py-1.5 text-sm text-fg-muted hover:bg-surface-hover hover:text-fg" onClick={() => void signOut()}>Sign out</button>
          </div>
        </header>
        <MaintenanceBanner />
        <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 lg:px-8">
          {me.isLoading ? <p className="text-sm text-fg-muted">Loading…</p> : !role ? <p className="text-sm text-fg-muted">Platform administration is only for the people who run Talk2Tax.</p> : children}
        </main>
      </div>
    </div>
  );
}
