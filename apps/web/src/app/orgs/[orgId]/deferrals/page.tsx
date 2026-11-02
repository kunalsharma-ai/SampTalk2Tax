'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, EmptyState, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { acct, KIND, METHOD, shortMonth, STATUS, type DeferralKind, type ScheduleList } from '@/lib/deferrals';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

export default function DeferralsPage() {
  const { org, orgId } = useOrg();
  const [kind, setKind] = useState<DeferralKind | ''>('');
  const [status, setStatus] = useState<'OPEN' | 'DONE' | ''>('OPEN');
  const q = useQuery({ queryKey: ['deferrals', orgId], queryFn: () => api<ScheduleList>(`/v1/orgs/${orgId}/deferrals`) });
  if (!org) return null;
  const cur = org.functionalCurrency;
  const r = q.data;
  const rows = (r?.schedules ?? []).filter((s) => (!kind || s.kind === kind) && (!status || (status === 'OPEN' ? s.status === 'ACTIVE' : s.status !== 'ACTIVE')));
  const count = (k: DeferralKind) => (r?.schedules ?? []).filter((s) => s.kind === k && s.status === 'ACTIVE').length;
  return (
    <>
      <PageHeader
        title="Prepaid and deferred"
        description="Amounts paid in advance (insurance, rent, subscriptions) and received in advance (annual contracts, advance fees), released to the profit and loss month by month over the period they cover. Releases are posted once a month as one journal."
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href={`/orgs/${orgId}/deferrals/releases`}><Button variant="secondary">Releases</Button></Link>
            {r?.can.manage ? (
              <>
                <Link href={`/orgs/${orgId}/deferrals/new?kind=PREPAID_EXPENSE`}><Button>Add prepaid expense</Button></Link>
                <Link href={`/orgs/${orgId}/deferrals/new?kind=DEFERRED_REVENUE`}><Button variant="secondary">Add deferred revenue</Button></Link>
              </>
            ) : null}
          </div>
        }
      />
      <ErrorAlert title="Could not load the schedules" error={q.error} />
      {r ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label="Prepaid expenses still to release" value={<Money value={r.totals.prepaid} currency={cur} />} tone="accent" sub={`${count('PREPAID_EXPENSE')} releasing`} />
            <Stat label="Deferred revenue still to earn" value={<Money value={r.totals.deferred} currency={cur} />} tone="violet" sub={`${count('DEFERRED_REVENUE')} releasing`} />
          </div>
          <div className="mb-3 flex flex-wrap gap-3">
            <label className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-fg-muted">
              Kind
              <Select className="w-48" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                <option value="">Both</option>
                <option value="PREPAID_EXPENSE">Prepaid expenses</option>
                <option value="DEFERRED_REVENUE">Deferred revenue</option>
              </Select>
            </label>
            <label className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-fg-muted">
              Show
              <Select className="w-48" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
                <option value="OPEN">Still releasing</option>
                <option value="DONE">Fully released or ended</option>
                <option value="">All</option>
              </Select>
            </label>
          </div>
          {rows.length ? (
            <Card className="overflow-x-auto">
              <Table aria-label="Prepaid and deferred revenue schedules">
                <thead>
                  <tr>
                    <Th>Schedule</Th>
                    <Th>Kind</Th>
                    <Th>Covers</Th>
                    <Th>Release</Th>
                    <Th>Accounts</Th>
                    <Th numeric>Amount</Th>
                    <Th numeric>Released</Th>
                    <Th numeric>Left</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => (
                    <Tr key={s.id}>
                      <Td>
                        <Link className="text-accent hover:underline" href={`/orgs/${orgId}/deferrals/${s.id}`}>{s.reference} {s.name}</Link>
                        {s.counterparty ? <span className="block text-xs text-fg-faint">{s.counterparty}</span> : null}
                      </Td>
                      <Td><Badge tone={s.kind === 'PREPAID_EXPENSE' ? 'accent' : 'violet'}>{KIND[s.kind]}</Badge></Td>
                      <Td className="whitespace-nowrap text-xs">{date(s.startDate)} to {date(s.endDate)}</Td>
                      <Td className="text-xs">{METHOD[s.method]}</Td>
                      <Td className="text-xs">{acct(s.balanceAccount)} → {acct(s.pnlAccount)}</Td>
                      <Td numeric><Money value={s.amount} currency={cur} /></Td>
                      <Td numeric><Money value={s.released} currency={cur} /></Td>
                      <Td numeric><Money value={s.remaining} currency={cur} /></Td>
                      <Td className="whitespace-nowrap">{s.status === 'ACTIVE' ? <span className="text-xs">{s.releasedThrough ? `Released to ${shortMonth(s.releasedThrough)}` : 'Nothing released yet'}</span> : <Badge tone={s.status === 'COMPLETED' ? 'positive' : 'neutral'}>{STATUS[s.status]}</Badge>}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          ) : (
            <Card>
              <EmptyState title={status === 'DONE' ? 'Nothing finished yet' : 'No schedules yet'} action={r.can.manage && status !== 'DONE' ? <Link href={`/orgs/${orgId}/deferrals/new?kind=PREPAID_EXPENSE`}><Button>Add prepaid expense</Button></Link> : undefined}>
                Add a payment made in advance, or money received for work still to be done, to release it month by month.
              </EmptyState>
            </Card>
          )}
        </>
      ) : null}
    </>
  );
}
