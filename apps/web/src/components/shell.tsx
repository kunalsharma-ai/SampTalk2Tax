'use client';
import { Badge, cn } from '@talk2tax/ui';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { signOut } from '@/lib/api';
import { dateTime, setOrganisationTimeZone } from '@/lib/format';
import { useT } from '@/lib/i18n';
import { useOrg, useOrgs } from '@/lib/org';
import { Logo } from './brand';
import { navFor } from '@/lib/nav';
import type { DataRegion, SubscriptionAccess } from '@/lib/types';
import { useAnnouncements, useMeWithRole } from '@/lib/admin';
import { useOrgFlags } from '@/lib/operations';
import { MaintenanceBanner } from './maintenance-banner';

export function Shell({ children }: { children: ReactNode }) {
  const { org, orgId, isLoading } = useOrg();
  const orgs = useOrgs();
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const t = useT();
  const me = useMeWithRole();
  const announcements = useAnnouncements();
  const flags = useOrgFlags(org ? orgId : undefined);
  const base = `/orgs/${orgId}`;
  // Moments are shown in the organisation's time zone unless the person chose their own.
  setOrganisationTimeZone(org?.timeZone ?? null);

  const elsewhere = org && org.dataRegion && !org.dataRegion.here ? org.dataRegion : null;
  const nav = elsewhere ? null : (
    <nav aria-label={t('Main')} className="flex flex-col gap-6">
      {navFor(org, flags.data).map((g) => (
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
                    {i.locked ? <span className="ml-auto rounded-full border border-accent/40 px-1.5 text-[10px] font-medium text-accent">{t('Upgrade')}</span> : null}
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
            {org?.viaSupport ? <option value={org.id}>{org.name}</option> : null}
            <option value="__new">{t('+ New organisation…')}</option>
          </select>
          <span className="hidden items-center gap-2 sm:flex">
            {org ? <Badge tone="violet">{t(org.role)}</Badge> : null}
            {org?.isDemo ? <Badge tone="warning">{t('Synthetic demo data')}</Badge> : null}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {me.data?.user.platformRole ? (
              <Link href="/admin" className="rounded px-3 py-1.5 text-sm text-fg-muted hover:bg-surface-hover hover:text-fg">
                {t('Platform admin')}
              </Link>
            ) : null}
            <Link href={`/orgs/${orgId}/account`} className="rounded px-3 py-1.5 text-sm text-fg-muted hover:bg-surface-hover hover:text-fg">
              {t('Account')}
            </Link>
            <button className="rounded px-3 py-1.5 text-sm text-fg-muted hover:bg-surface-hover hover:text-fg" onClick={() => void signOut()}>
              {t('Sign out')}
            </button>
          </div>
        </header>
        <MaintenanceBanner />
        {(announcements.data ?? []).map((a) => (
          <p key={a.id} role="status" className={cn('border-b px-4 py-2 text-center text-sm print:hidden', a.tone === 'WARNING' ? 'border-warning/30 bg-warning/10 text-warning' : 'border-accent/30 bg-accent/10 text-fg')} data-testid="announcement">
            {a.message}
          </p>
        ))}
        {org?.viaSupport ? (
          <p role="alert" className="border-b border-violet/30 bg-violet/10 px-4 py-2 text-center text-sm text-fg print:hidden" data-testid="support-access-banner">
            {t('You are reading {name} through its support access, until {until}. Nothing can be changed, and the organisation sees every page you open.', { name: org.name, until: dateTime(org.viaSupport.expiresAt) })}{' '}
            <Link className="text-accent hover:underline" href="/admin/support">{t('Back to the support queue')}</Link>
          </p>
        ) : null}
        {org?.subscription ? <PlanBanner orgId={org.id} access={org.subscription.access} /> : null}
        {org?.suspended ? (
          <p role="alert" className="border-b border-negative/30 bg-negative/10 px-4 py-2 text-center text-sm text-negative print:hidden" data-testid="suspended-banner">
            {t('This organisation is suspended: {reason}. You can read and export its records, but nothing can be changed.', { reason: org.suspended.reason })}
          </p>
        ) : null}
        {org?.isDemo ? <p className="border-b border-warning/30 bg-warning/10 px-4 py-1.5 text-center text-xs text-warning sm:hidden">{t('Synthetic demo data')}</p> : null}
        <main id="main" key={org?.timeZone ?? ""} className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 lg:px-8">
          {isLoading ? <p className="text-sm text-fg-muted">{t('Loading…')}</p> : !org ? <p className="text-sm text-fg-muted">{t('Organisation not found or you do not have access.')}</p> : elsewhere ? <RegionElsewhere orgId={org.id} name={org.name} region={elsewhere} /> : children}
        </main>
      </div>
    </div>
  );
}

/** A trial running out, a grace week, or books that are read-only until a plan is chosen. */
function PlanBanner({ orgId, access }: { orgId: string; access: SubscriptionAccess }) {
  const t = useT();
  const link = <Link className="font-medium underline" href={`/orgs/${orgId}/settings/subscription`}>{t('Choose a plan')}</Link>;
  if (access.level === 'READ_ONLY') {
    const why = access.state === 'TRIAL_ENDED' ? t('The free trial has ended.') : access.state === 'CANCELLED' ? t('The subscription was cancelled.') : t('The subscription has lapsed.');
    return <p role="alert" data-testid="plan-banner" className="border-b border-negative/30 bg-negative/10 px-4 py-2 text-center text-sm text-negative print:hidden">{why} {t('Your records can be read and exported, but nothing can be changed.')} {link}</p>;
  }
  if ((access.state === 'TRIAL' && (access.daysLeft ?? 99) <= 5) || access.state === 'GRACE' || access.state === 'CANCELLING') {
    const text = access.state === 'TRIAL' ? t('The free trial ends in {n} days.', { n: access.daysLeft ?? 0 }) : access.state === 'GRACE' ? t('Payment is due: the books become read-only in {n} days.', { n: access.daysLeft ?? 0 }) : t('The subscription ends in {n} days.', { n: access.daysLeft ?? 0 });
    return <p role="status" data-testid="plan-banner" className="border-b border-warning/30 bg-warning/10 px-4 py-2 text-center text-sm text-warning print:hidden">{text} {link}</p>;
  }
  return null;
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
