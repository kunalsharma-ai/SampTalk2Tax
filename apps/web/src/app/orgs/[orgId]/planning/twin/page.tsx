'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import type { Scenario, Template } from '@/lib/twin';
import { DRIVERS, STATUS } from '@/lib/twin';
import { can } from '@/lib/types';

/** Saved what-if scenarios, ready-made starting points, and picking scenarios to compare. */
export default function TwinPage() {
  const { org, orgId } = useOrg();
  const router = useRouter();
  const list = useQuery({ queryKey: ['twin-scenarios', orgId], queryFn: () => api<{ items: Scenario[] }>(`/v1/orgs/${orgId}/twin/scenarios`) });
  const templates = useQuery({ queryKey: ['twin-templates', orgId], queryFn: () => api<Template[]>(`/v1/orgs/${orgId}/twin/templates`) });
  const [picked, setPicked] = useState<string[]>([]);
  if (!org) return null;
  const manage = can(org.role, 'scenarios.manage');
  const base = `/orgs/${orgId}/planning/twin`;
  return (
    <>
      <PageHeader
        title="Digital twin"
        description="What-if scenarios played forward from your actual books. Hypothetical only: nothing is posted to the ledger."
        actions={<Link href={`${base}/new`}><Button>{manage ? 'New scenario' : 'Try a scenario'}</Button></Link>}
      />
      <ErrorAlert title="Could not load scenarios" error={list.error} />
      <Card className="mb-4">
        <CardHeader title="Planning board" description="Saved scenarios by where they are in approval. Each one is re-run against the latest actual figures every time you open it." />
        {list.data && !list.data.items.length ? <EmptyState title="No scenarios yet">Start from a template below or build one from scratch.</EmptyState> : null}
        {list.data?.items.length ? (
          <>
            <div className="grid grid-cols-1 gap-3 p-3 md:grid-cols-2 2xl:grid-cols-4" aria-label="Planning board">
              {(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'] as const).map((st) => {
                const items = list.data.items.filter((s) => s.status === st);
                return (
                  <section key={st} aria-label={STATUS[st].label} className="rounded-md border border-line bg-surface-hover/40 p-2">
                    <div className="mb-2 flex items-center justify-between px-1">
                      <Badge tone={STATUS[st].tone}>{STATUS[st].label}</Badge>
                      <span className="text-xs text-fg-muted">{items.length}</span>
                    </div>
                    {!items.length ? <p className="px-1 pb-2 text-xs text-fg-muted">None</p> : null}
                    <ul className="space-y-2">
                      {items.map((s) => (
                        <li key={s.id} className="rounded-md border border-line bg-surface p-3">
                          <div className="flex items-start gap-2">
                            <input
                              type="checkbox"
                              className="mt-1"
                              aria-label={`Compare ${s.name}`}
                              checked={picked.includes(s.id)}
                              disabled={!picked.includes(s.id) && picked.length >= 5}
                              onChange={(e) => setPicked((p) => (e.target.checked ? [...p, s.id] : p.filter((x) => x !== s.id)))}
                            />
                            <div className="min-w-0">
                              <Link className="font-medium text-accent hover:underline" href={`${base}/${s.id}`}>{s.name}</Link>
                              {s.description ? <div className="text-xs text-fg-muted">{s.description}</div> : null}
                              <div className="mt-1 text-xs text-fg-muted">{s.drivers.length ? s.drivers.map((d) => DRIVERS[d.kind]?.title ?? d.kind).join(', ') : 'No changes'}</div>
                              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                                <span>v{s.version} · {s.horizonMonths} months · {date(s.updatedAt.slice(0, 10))}</span>
                                {s.openNotes ? <Badge tone="accent">{s.openNotes} open note{s.openNotes === 1 ? '' : 's'}</Badge> : null}
                              </div>
                              {st === 'SUBMITTED' && s.people?.submittedBy ? <div className="mt-1 text-xs text-fg-muted">Submitted by {s.people.submittedBy}</div> : null}
                              {(st === 'APPROVED' || st === 'REJECTED') && s.people?.decidedBy ? <div className="mt-1 text-xs text-fg-muted">{st === 'APPROVED' ? 'Approved' : 'Rejected'} by {s.people.decidedBy}</div> : null}
                            </div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
            <div className="flex items-center gap-3 p-3">
              <Button variant="secondary" disabled={!picked.length} onClick={() => router.push(`${base}/compare?ids=${picked.join(',')}`)}>Compare {picked.length ? `${picked.length} ` : ''}with no change</Button>
              <span className="text-xs text-fg-muted">Pick up to five.</span>
            </div>
          </>
        ) : null}
      </Card>
      <Card className="p-4">
        <CardHeader title="Start from a template" description="Placeholder figures to adjust to your own business." />
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-3" aria-label="Templates">
          {templates.data?.map((t) => (
            <li key={t.key} className="rounded-md border border-line p-3">
              <div className="font-medium text-fg">{t.name}</div>
              <p className="mt-1 text-sm text-fg-muted">{t.description}</p>
              <Link className="mt-2 inline-block text-sm text-accent hover:underline" href={`${base}/new?template=${t.key}`}>Use this template</Link>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
