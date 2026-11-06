'use client';
import { Badge, Card, CardHeader, EmptyState, Input } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/shell';
import { pageHelp } from '@/lib/help';
import { useT } from '@/lib/i18n';
import { navFor } from '@/lib/nav';
import { useOrgFlags } from '@/lib/operations';
import { useOrg } from '@/lib/org';

/** Every page in the menu with what it is for, how to use it and where it fits: the help behind each (i), in one list. */
export default function FeatureGuidePage() {
  const { org, orgId } = useOrg();
  const flags = useOrgFlags(orgId);
  const t = useT();
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const groups = navFor(org, flags.data)
    .map((g) => ({
      group: g.group,
      items: g.items
        .map((i) => ({ ...i, help: pageHelp(i.href.replace(/^\//, '')) }))
        .filter((i) => i.help && (!needle || [i.label, t(i.label), g.group, t(g.group), i.help.what, i.help.how, i.help.where].some((s) => s.toLowerCase().includes(needle)))),
    }))
    .filter((g) => g.items.length > 0);
  return (
    <>
      <PageHeader title="Feature guide" description="What every part of Talk2Tax is for, how to use it and where it fits. The same help is behind the (i) beside each page and section title." />
      <div className="mb-6 max-w-md">
        <label htmlFor="guide-search" className="mb-1 block text-xs font-medium text-fg-muted">{t('Search the guide')}</label>
        <Input id="guide-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('For example GST, forecast or payslip')} />
      </div>
      {groups.length === 0 ? (
        <EmptyState title={t('Nothing matches')}>{t('Try another word.')}</EmptyState>
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <Card key={g.group} aria-label={t(g.group)}>
              <CardHeader title={t(g.group)} help={null} />
              <ul className="divide-y divide-line">
                {g.items.map((i) => (
                  <li key={i.href} className="px-5 py-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/orgs/${orgId}${i.href}`} className="font-semibold text-fg hover:text-accent">{t(i.label)}</Link>
                      {i.locked ? <Badge tone="warning">{t('Not in your plan')}</Badge> : null}
                    </div>
                    <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-3">
                      {([['What it is for', i.help!.what], ['How to use it', i.help!.how], ['Where it fits', i.help!.where]] as const).map(([label, text]) => (
                        <div key={label}>
                          <dt className="text-[11px] font-semibold uppercase tracking-wide text-fg-faint">{t(label)}</dt>
                          <dd className="mt-0.5 leading-relaxed text-fg-muted">{t(text)}</dd>
                        </div>
                      ))}
                    </dl>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
