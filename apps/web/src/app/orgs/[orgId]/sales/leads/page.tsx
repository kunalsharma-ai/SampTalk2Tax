'use client';
import { useQuery } from '@tanstack/react-query';
import { LEAD_SOURCE_LABEL, LEAD_STATUS_LABEL, LEAD_STATUSES } from '@talk2tax/accounting-engine';
import { Button, Card, EmptyState, Input, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { LeadStatusBadge } from '@/components/crm/bits';
import { LeadDialog } from '@/components/crm/lead-dialog';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import type { LeadList, LeadStatus } from '@/lib/crm';
import { date, istDay } from '@/lib/format';
import { useMe, useOrg } from '@/lib/org';

export default function LeadsPage() {
  const { org, orgId } = useOrg();
  const me = useMe();
  const [status, setStatus] = useState<LeadStatus | ''>('');
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const params = new URLSearchParams({ ...(status ? { status } : {}), ...(q.trim() ? { q: q.trim() } : {}) }).toString();
  const list = useQuery({ queryKey: ['crm-leads', orgId, status, q.trim()], queryFn: () => api<LeadList>(`/v1/orgs/${orgId}/crm/leads${params ? `?${params}` : ''}`) });
  if (!org) return null;
  const cur = org.functionalCurrency;
  const r = list.data;
  const open = r ? r.counts.NEW + r.counts.CONTACTED + r.counts.QUALIFIED : 0;
  return (
    <>
      <PageHeader
        title="Leads"
        description="People and companies who might buy. Work each lead from new to qualified, then convert it into a customer and a deal in the pipeline."
        actions={
          <>
            <Link href={`/orgs/${orgId}/sales/pipeline`}><Button variant="secondary">Pipeline</Button></Link>
            {r?.can.manage ? <Button onClick={() => setAdding(true)}>Add a lead</Button> : null}
          </>
        }
      />
      <ErrorAlert title="Could not load leads" error={list.error} />
      {r ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label="Open leads" value={open} tone="accent" sub={`${r.counts.NEW} new · ${r.counts.CONTACTED} contacted`} />
            <Stat label="Qualified" value={r.counts.QUALIFIED} tone="violet" sub="Ready to convert" />
            <Stat label="Estimated value open" value={<Money value={r.openEstimatedValue} currency={cur} />} sub="Sum of first guesses" />
            <Stat label="Converted" value={r.counts.CONVERTED} tone="positive" sub={`${r.counts.DISQUALIFIED} disqualified`} />
          </div>
          <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Filter by status">
            {(['', ...LEAD_STATUSES] as const).map((s) => (
              <Button key={s || 'all'} size="sm" variant={status === s ? 'primary' : 'secondary'} aria-pressed={status === s} onClick={() => setStatus(s)}>
                {s ? `${LEAD_STATUS_LABEL[s]} (${r.counts[s]})` : 'All'}
              </Button>
            ))}
            <Input aria-label="Search leads" className="ml-auto w-60" placeholder="Search name, company or email" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {r.leads.length ? (
            <Card className="overflow-x-auto">
              <Table aria-label="Leads">
                <thead>
                  <tr><Th>Lead</Th><Th>Source</Th><Th>Owner</Th><Th numeric>Estimated value</Th><Th>Added</Th><Th>Status</Th></tr>
                </thead>
                <tbody>
                  {r.leads.map((l) => (
                    <Tr key={l.id}>
                      <Td>
                        <Link className="font-medium text-accent hover:underline" href={`/orgs/${orgId}/sales/leads/${l.id}`}>{l.reference} {l.name}</Link>
                        <span className="block text-xs text-fg-faint">{[l.company, l.email].filter(Boolean).join(' · ') || '—'}</span>
                      </Td>
                      <Td className="text-sm">{LEAD_SOURCE_LABEL[l.source]}</Td>
                      <Td className="text-sm">{l.owner?.name ?? '—'}</Td>
                      <Td numeric>{l.estimatedValue ? <Money value={l.estimatedValue} currency={cur} /> : '—'}</Td>
                      <Td className="whitespace-nowrap text-sm">{date(istDay(l.createdAt))}</Td>
                      <Td><LeadStatusBadge status={l.status} /></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          ) : (
            <Card><EmptyState title={status || q ? 'No leads match' : 'No leads yet'}>Add the people who ask about your services, from the website, referrals or events. Each one keeps a timeline of calls, emails and meetings.</EmptyState></Card>
          )}
        </>
      ) : null}
      <LeadDialog orgId={orgId} open={adding} onOpenChange={setAdding} meId={me.data?.user.id} currency={cur} />
    </>
  );
}
