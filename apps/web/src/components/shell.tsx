'use client';
import { Badge, cn } from '@talk2tax/ui';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { signOut } from '@/lib/api';
import { setOrganisationTimeZone } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { useOrg, useOrgs } from '@/lib/org';
import { Logo } from './brand';
import { navFor } from '@/lib/nav';
import type { DataRegion } from '@/lib/types';

export function Shell({ children }: { children: ReactNode }) {
  const { org, orgId, isLoading } = useOrg();
  const orgs = useOrgs();
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const t = useT();
  const base = `/orgs/${orgId}`;
  // Moments are shown in the organisation's time zone unless the person chose their own.
  setOrganisationTimeZone(org?.timeZone ?? null);

  const elsewhere = org && org.dataRegion && !org.dataRegion.here ? org.dataRegion : null;
  const nav = elsewhere ? null : (
    <nav aria-label={t('Main')} className="flex flex-col gap-6">
      {navFor(org).map((g) => (
        <div key={g.group}>
          <p className="px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-fg-faint">{t(g.group)}</p>
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
                    {t(i.label)}
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
          <button className="rounded p-2 text-fg-muted hover:text-fg lg:hidden" onClick={() => setOpen((v) => !v)} aria-label={t('Toggle navigation')} aria-expanded={open}>
            ☰
          </button>
          <label className="sr-only" htmlFor="org-switch">
            {t('Organisation')}
          </label>
          <select
            id="org-switch"
            className="min-w-0 max-w-[55vw] truncate rounded-[var(--t2t-radius-md)] border border-line bg-surface px-3 py-1.5 text-sm text-fg"
            value={orgId}
            onChange={(e) => (e.target.value === '__new' ? router.push('/onboarding') : router.push(`/orgs/${e.target.value}`))}
          >
            {(orgs.data ?? []).map((o) => (
              <option key={o.id} value={o.id}>
                {o.dataRegion && !o.dataRegion.here ? `${o.name} (${o.dataRegion.name})` : o.name}
              </option>
            ))}
            <option value="__new">{t('+ New organisation…')}</option>
          </select>
          <span className="hidden items-center gap-2 sm:flex">
            {org ? <Badge tone="violet">{t(org.role)}</Badge> : null}
            {org?.isDemo ? <Badge tone="warning">{t('Synthetic demo data')}</Badge> : null}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Link href={`/orgs/${orgId}/account`} className="rounded px-3 py-1.5 text-sm text-fg-muted hover:bg-surface-hover hover:text-fg">
              {t('Account')}
            </Link>
            <button className="rounded px-3 py-1.5 text-sm text-fg-muted hover:bg-surface-hover hover:text-fg" onClick={() => void signOut()}>
              {t('Sign out')}
            </button>
          </div>
        </header>
        {org?.isDemo ? <p className="border-b border-warning/30 bg-warning/10 px-4 py-1.5 text-center text-xs text-warning sm:hidden">{t('Synthetic demo data')}</p> : null}
        <main id="main" key={org?.timeZone ?? ""} className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 lg:px-8">
          {isLoading ? <p className="text-sm text-fg-muted">{t('Loading…')}</p> : !org ? <p className="text-sm text-fg-muted">{t('Organisation not found or you do not have access.')}</p> : elsewhere ? <RegionElsewhere orgId={org.id} name={org.name} region={elsewhere} /> : children}
        </main>
      </div>
    </div>
  );
}

/** An organisation whose data lives in another region is served only there. */
function RegionElsewhere({ orgId, name, region }: { orgId: string; name: string; region: DataRegion }) {
  const t = useT();
  return (
    <section aria-label={t('Kept in another region')} className="mx-auto max-w-xl rounded-[var(--t2t-radius-lg)] border border-line bg-surface p-6">
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fg-faint">{t('Kept in another region')}</p>
      <h1 className="mt-2 text-xl font-semibold text-fg">{name}</h1>
      <p className="mt-3 text-sm text-fg-muted">
        {t('This organisation’s data is kept in {region}, so it is opened there and not on this server. Nothing about it is read or changed here.', { region: region.name })}
      </p>
      {region.appUrl ? (
        <a className="mt-5 inline-flex h-10 items-center rounded-[var(--t2t-radius-md)] bg-[image:var(--t2t-gradient-brand)] px-4 text-sm font-semibold text-[#050a18] hover:brightness-110" href={`${region.appUrl.replace(/\/$/, '')}/orgs/${orgId}`}>
          {t('Open it in {region}', { region: region.name })}
        </a>
      ) : (
        <p className="mt-4 text-sm text-fg-muted">{t('Ask your administrator for the address of that region.')}</p>
      )}
    </section>
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
