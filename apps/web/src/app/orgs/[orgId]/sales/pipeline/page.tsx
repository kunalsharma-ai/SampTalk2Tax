'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DEAL_STAGE_LABEL, OPEN_DEAL_STAGES } from '@talk2tax/accounting-engine';
import { Badge, Button, Card, CardHeader, EmptyState, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { StageBadge } from '@/components/crm/bits';
import { useOwners } from '@/components/crm/lead-dialog';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import type { Deal, DealList, DealStage } from '@/lib/crm';
import { date, money } from '@/lib/format';
import { useOrg } from '@/lib/org';

const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });

export default function PipelinePage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const [view, setView] = useState<'open' | 'closed'>('open');
  const [ownerId, setOwnerId] = useState('');
  const owners = useOwners(orgId);
  const qs = new URLSearchParams({ view, ...(ownerId ? { ownerId } : {}) }).toString();
  const list = useQuery({ queryKey: ['crm-deals', orgId, view, ownerId], queryFn: () => api<DealList>(`/v1/orgs/${orgId}/crm/deals?${qs}`) });
  const move = useMutation({
    mutationFn: ({ id, stage }: { id: string; stage: DealStage }) => api(`/v1/orgs/${orgId}/crm/deals/${id}/stage`, { method: 'POST', body: { stage } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['crm-deals', orgId] }),
  });
  if (!org) return null;
  const cur = org.functionalCurrency;
  const r = list.data;
  const peak = r ? Math.max(1, ...r.byCloseMonth.months.map((m) => +m.weighted), +r.byCloseMonth.later.weighted) : 1;
  return (
    <>
      <PageHeader
        title="Pipeline"
        description="Deals being worked on, by stage. Each stage carries a win probability, so the weighted value is what the pipeline is likely to bring in."
        actions={
          <>
            <Link href={`/orgs/${orgId}/sales/leads`}><Button variant="secondary">Leads</Button></Link>
            {r?.can.manage ? <Link href={`/orgs/${orgId}/sales/pipeline/new`}><Button>Add a deal</Button></Link> : null}
          </>
        }
      />
      <ErrorAlert title="Could not load the pipeline" error={list.error} />
      <ErrorAlert title="Could not move the deal" error={move.error} />
      {r ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label="Open pipeline" value={<Money value={r.summary.open.amount} currency={cur} />} tone="accent" sub={`${r.summary.open.count} open ${r.summary.open.count === 1 ? 'deal' : 'deals'}`} />
            <Stat label="Weighted" value={<Money value={r.summary.open.weighted} currency={cur} />} tone="violet" sub="Amount × win probability" />
            <Stat label="Past expected close" value={<Money value={r.summary.overdue.amount} currency={cur} />} tone={r.summary.overdue.count ? 'warning' : 'positive'} sub={`${r.summary.overdue.count} still open`} />
            <Stat
              label={`Win rate, last ${r.summary.window.days} days`}
              value={r.summary.window.winRate === null ? '—' : `${r.summary.window.winRate}%`}
              tone="positive"
              sub={`${r.summary.window.won} won (${money(r.summary.window.wonAmount, cur)}) · ${r.summary.window.lost} lost${r.summary.window.averageDaysToWin !== null ? ` · ${r.summary.window.averageDaysToWin} days to win` : ''}`}
            />
          </div>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Button size="sm" variant={view === 'open' ? 'primary' : 'secondary'} aria-pressed={view === 'open'} onClick={() => setView('open')}>Open deals</Button>
            <Button size="sm" variant={view === 'closed' ? 'primary' : 'secondary'} aria-pressed={view === 'closed'} onClick={() => setView('closed')}>Won and lost</Button>
            <Select aria-label="Owner" className="ml-auto w-56" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
              <option value="">Everyone&apos;s deals</option>
              {owners.data?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </Select>
          </div>
          {view === 'open' ? (
            r.deals.length ? (
              <div className="grid gap-3 lg:grid-cols-4" aria-label="Pipeline board">
                {OPEN_DEAL_STAGES.map((stage) => {
                  const s = r.summary.stages.find((x) => x.stage === stage)!;
                  const deals = r.deals.filter((d) => d.stage === stage);
                  return (
                    <section key={stage} aria-label={DEAL_STAGE_LABEL[stage]} className="flex flex-col gap-2 rounded-[var(--t2t-radius-md)] border border-line bg-surface/50 p-3">
                      <header>
                        <p className="text-sm font-semibold">{DEAL_STAGE_LABEL[stage]} <span className="text-fg-faint">· {s.count}</span></p>
                        <p className="text-xs text-fg-muted"><Money value={s.amount} currency={cur} /> · weighted <Money value={s.weighted} currency={cur} /></p>
                      </header>
                      {deals.map((d) => <DealCard key={d.id} d={d} orgId={orgId} cur={cur} canMove={r.can.manage} onMove={(stage) => move.mutate({ id: d.id, stage })} />)}
                      {deals.length === 0 ? <p className="py-4 text-center text-xs text-fg-faint">No deals</p> : null}
                    </section>
                  );
                })}
              </div>
            ) : (
              <Card><EmptyState title="No open deals">Add a deal for a customer, or convert a qualified lead. Move it through the stages until it is won or lost.</EmptyState></Card>
            )
          ) : r.deals.length ? (
            <Card className="overflow-x-auto">
              <Table aria-label="Closed deals">
                <thead><tr><Th>Deal</Th><Th>Customer</Th><Th numeric>Amount</Th><Th>Closed</Th><Th>Outcome</Th></tr></thead>
                <tbody>
                  {r.deals.map((d) => (
                    <Tr key={d.id}>
                      <Td><Link className="font-medium text-accent hover:underline" href={`/orgs/${orgId}/sales/pipeline/${d.id}`}>{d.reference} {d.name}</Link>{d.lostReason ? <span className="block text-xs text-fg-faint">{d.lostReason}</span> : null}</Td>
                      <Td className="text-sm">{d.contact?.name}</Td>
                      <Td numeric><Money value={d.amount} currency={cur} /></Td>
                      <Td className="whitespace-nowrap text-sm">{d.closedOn ? date(d.closedOn) : '—'}</Td>
                      <Td><StageBadge stage={d.stage} /></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          ) : (
            <Card><EmptyState title="Nothing won or lost yet" /></Card>
          )}
          {view === 'open' ? (
            <Card className="mt-6">
              <CardHeader title="Weighted value by expected close month" description="Open deals only. Deals past their expected close date count in this month until they are won, lost or given a new date." />
              <Table aria-label="Weighted by close month">
                <thead><tr><Th>Month</Th><Th numeric>Deals</Th><Th numeric>Amount</Th><Th numeric>Weighted</Th><Th className="w-1/3"><span className="sr-only">Bar</span></Th></tr></thead>
                <tbody>
                  {[...r.byCloseMonth.months.map((m) => ({ ...m, label: monthName(m.month) })), { ...r.byCloseMonth.later, label: 'Later' }].map((m) => (
                    <Tr key={m.label}>
                      <Td className="text-sm">{m.label}</Td>
                      <Td numeric>{m.count}</Td>
                      <Td numeric><Money value={m.amount} currency={cur} /></Td>
                      <Td numeric className="font-medium"><Money value={m.weighted} currency={cur} /></Td>
                      <Td><div className="h-2 rounded-full bg-violet/70" style={{ width: `${(+m.weighted / peak) * 100}%` }} /></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          ) : null}
        </>
      ) : null}
    </>
  );
}

function DealCard({ d, orgId, cur, canMove, onMove }: { d: Deal; orgId: string; cur: string; canMove: boolean; onMove: (s: DealStage) => void }) {
  return (
    <Card className="p-3 text-sm">
      <Link className="font-medium text-accent hover:underline" href={`/orgs/${orgId}/sales/pipeline/${d.id}`}>{d.name}</Link>
      <p className="text-xs text-fg-muted">{d.reference} · {d.contact?.name}</p>
      <p className="mt-1 flex items-baseline justify-between"><Money value={d.amount} currency={cur} /><span className="text-xs text-fg-faint">{d.probability}%</span></p>
      <p className="mt-1 flex flex-wrap items-center gap-1 text-xs text-fg-muted">
        Close {date(d.expectedCloseDate)}
        {d.overdue ? <Badge tone="warning">Past date</Badge> : null}
        {d.owner ? <span>· {d.owner.name}</span> : null}
      </p>
      {canMove ? (
        <Select aria-label={`Move ${d.reference}`} className="mt-2 h-8 text-xs" value={d.stage} onChange={(e) => onMove(e.target.value as DealStage)}>
          {OPEN_DEAL_STAGES.map((s) => <option key={s} value={s}>{DEAL_STAGE_LABEL[s]}</option>)}
          <option value="WON">Won</option>
        </Select>
      ) : null}
    </Card>
  );
}
