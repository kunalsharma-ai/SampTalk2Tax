'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { type Trip, TRIP_STATUS_LABEL, TRIP_STATUS_TONE } from '@/components/expenses/trips';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, money } from '@/lib/format';
import { useOrg } from '@/lib/org';

/** One business trip (EXP-007): the request, the decision, linked claims and the cost against the estimate. */
export default function TripPage() {
  const { org, orgId } = useOrg();
  const { tripId } = useParams<{ tripId: string }>();
  const qc = useQueryClient();
  const key = ['expense-trip', orgId, tripId];
  const q = useQuery({ queryKey: key, queryFn: () => api<Trip>(`/v1/orgs/${orgId}/expense-trips/${tripId}`) });
  const [note, setNote] = useState('');
  const [claimId, setClaimId] = useState('');
  const base = `/v1/orgs/${orgId}/expense-trips/${tripId}`;
  const done = (t: Trip) => {
    qc.setQueryData(key, t);
    void qc.invalidateQueries({ queryKey: ['expense-trips', orgId] });
  };
  const act = useMutation({
    mutationFn: (a: { path: string; method?: 'POST' | 'DELETE'; body?: Record<string, string> }) => api<Trip>(`${base}${a.path}`, { method: a.method ?? 'POST', body: a.body ?? (a.method === 'DELETE' ? undefined : {}) }),
    onSuccess: (t) => {
      setNote('');
      setClaimId('');
      done(t);
    },
  });
  if (!org) return null;
  const t = q.data;
  const c = t?.currency ?? org.functionalCurrency;
  return (
    <>
      <PageHeader
        title={t ? `${t.reference} · ${t.destination}` : 'Business trip'}
        description={t ? `${t.purpose}. ${t.traveller}, ${date(t.startDate)} to ${date(t.endDate)} (${t.costs.days} ${t.costs.days === 1 ? 'day' : 'days'}).` : undefined}
        actions={
          <span className="flex items-center gap-3">
            <Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/expenses/trips`}>← All trips</Link>
            {t?.canCancel ? <Button variant="ghost" size="sm" loading={act.isPending} onClick={() => act.mutate({ path: '/cancel' })}>Cancel trip</Button> : null}
          </span>
        }
      />
      <ErrorAlert title="Could not load the trip" error={q.error} />
      <ErrorAlert title="Not done" error={act.error} />
      {t ? (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-fg-muted">
            <Badge tone={TRIP_STATUS_TONE[t.status]}>{TRIP_STATUS_LABEL[t.status]}</Badge>
            {t.decidedBy ? <span>{t.status === 'APPROVED' ? 'Approved' : 'Rejected'} by {t.decidedBy} on {date(t.decidedAt!.slice(0, 10))}{t.decisionNote ? `: ${t.decisionNote}` : '.'}</span> : <span>Requested on {date(t.createdAt.slice(0, 10))}.</span>}
          </div>

          {t.canDecide ? (
            <Card className="mb-4">
              <CardHeader title="Trip decision" description="Approve the trip before travel, or reject it with the reason. The traveller cannot decide on their own trip." />
              <div className="flex flex-wrap items-end gap-3 p-4">
                <div className="min-w-64 flex-1"><Field label="Note">{(p) => <Input {...p} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}</Field></div>
                <Button loading={act.isPending} onClick={() => act.mutate({ path: '/approve', body: note ? { note } : {} })}>Approve trip</Button>
                <Button variant="secondary" disabled={!note.trim()} loading={act.isPending} onClick={() => act.mutate({ path: '/reject', body: { note } })}>Reject trip</Button>
              </div>
            </Card>
          ) : null}

          <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Estimate" value={<Money value={t.costs.estimate.total} currency={c} />} sub={`${t.costs.days} ${t.costs.days === 1 ? 'day' : 'days'}`} />
            <Stat label="Spent" value={<Money value={t.costs.spent} currency={c} />} sub={`Approved and reimbursed claims, ${money(t.costs.perDay, c)} a day`} />
            <Stat label="Not yet approved" value={<Money value={t.costs.pending} currency={c} />} sub="Draft, submitted and rejected claims" />
            <Stat label="Left of the estimate" value={<Money value={t.costs.remaining} currency={c} />} tone={t.costs.remaining.startsWith('-') ? 'negative' : 'positive'} />
          </div>
          {t.costs.flags.map((x) => (
            <div key={x.code} className="mb-4"><Alert tone="warning" title={x.code === 'OVER_ESTIMATE' ? 'Over the estimate' : 'Dated outside the trip'}>{x.message}{x.code === 'OUTSIDE_DATES' ? `: ${t.costs.outsideDates.map((l) => `${l.number} line ${l.lineNo} on ${date(l.date)}`).join(', ')}.` : '.'}</Alert></div>
          ))}

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Cost against the estimate" description="The estimate by part, and the claims by expense category." />
              <Table aria-label="Trip estimate">
                <thead><Tr><Th>Estimate</Th><Th numeric>Amount</Th></Tr></thead>
                <tbody>
                  {t.costs.estimate.lines.map((l) => <Tr key={l.key}><Td>{l.label}</Td><Td numeric><Money value={l.amount} currency={c} /></Td></Tr>)}
                </tbody>
              </Table>
              {t.costs.byCategory.length ? (
                <Table aria-label="Trip costs by category">
                  <thead><Tr><Th>Category</Th><Th numeric>Spent</Th><Th numeric>Not yet approved</Th></Tr></thead>
                  <tbody>
                    {t.costs.byCategory.map((r) => <Tr key={r.account}><Td>{r.account}</Td><Td numeric><Money value={r.spent} currency={c} /></Td><Td numeric><Money value={r.pending} currency={c} /></Td></Tr>)}
                  </tbody>
                </Table>
              ) : (
                <EmptyState title="No claims yet">Link expense claims to see what the trip cost.</EmptyState>
              )}
            </Card>
            <Card>
              <CardHeader title="Claims on this trip" description="The traveller's expense claims for the trip. Approved claims stay linked; others can be unlinked." />
              {t.claims.length ? (
                <Table aria-label="Claims on this trip">
                  <thead><Tr><Th>Claim</Th><Th>Title</Th><Th>Status</Th><Th numeric>Total</Th><Th /></Tr></thead>
                  <tbody>
                    {t.claims.map((x) => (
                      <Tr key={x.id}>
                        <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/expenses/${x.id}`}>{x.number}</Link></Td>
                        <Td>{x.title}</Td>
                        <Td>{x.status.charAt(0) + x.status.slice(1).toLowerCase()}</Td>
                        <Td numeric><Money value={x.total} currency={c} /></Td>
                        <Td>{x.canUnlink ? <Button size="sm" variant="ghost" loading={act.isPending} onClick={() => act.mutate({ path: `/claims/${x.id}`, method: 'DELETE' })}>Unlink</Button> : null}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              ) : (
                <EmptyState title="No claims linked">{t.status === 'APPROVED' ? 'The traveller links their claims here.' : 'Claims are linked once the trip is approved.'}</EmptyState>
              )}
              {t.linkable.length ? (
                <div className="border-t border-line p-4">
                  <div className="flex flex-wrap items-end gap-3">
                    <Field label="Link a claim">
                      {(p) => (
                        <Select {...p} className="w-72" value={claimId} onChange={(e) => setClaimId(e.target.value)}>
                          <option value="">Choose one of your claims</option>
                          {t.linkable.map((x) => <option key={x.id} value={x.id}>{x.number} · {x.title} · {x.total}</option>)}
                        </Select>
                      )}
                    </Field>
                    <Button variant="secondary" disabled={!claimId} loading={act.isPending} onClick={() => act.mutate({ path: '/claims', body: { claimId } })}>Link claim</Button>
                  </div>
                </div>
              ) : null}
            </Card>
          </div>
        </>
      ) : null}
    </>
  );
}
