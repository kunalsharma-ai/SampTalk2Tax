'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, dateTime } from '@/lib/format';
import { AdminOrgDetail, useMeWithRole } from '@/lib/admin';

const ACTION: Record<string, string> = { 'platform.org_suspended': 'Suspended', 'platform.org_reinstated': 'Reinstated' };

export default function AdminOrganisationPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const me = useMeWithRole();
  const [reason, setReason] = useState('');
  const q = useQuery({ queryKey: ['admin-org', id], queryFn: () => api<AdminOrgDetail>(`/v1/admin/organisations/${id}`) });
  const done = async () => { setReason(''); await qc.invalidateQueries({ queryKey: ['admin-org', id] }); await qc.invalidateQueries({ queryKey: ['admin-orgs'] }); };
  const suspend = useMutation({ mutationFn: () => api(`/v1/admin/organisations/${id}/suspend`, { method: 'POST', body: { reason } }), onSuccess: done });
  const reinstate = useMutation({ mutationFn: () => api(`/v1/admin/organisations/${id}/reinstate`, { method: 'POST', body: { note: reason } }), onSuccess: done });
  const o = q.data;
  const manage = me.data?.user.platformRole === 'SUPER_ADMIN';
  return (
    <>
      <PageHeader
        title={o?.name ?? 'Organisation'}
        description={o ? `${o.legalName ? `${o.legalName} · ` : ''}${o.countryCode} · ${o.functionalCurrency} · region ${o.dataRegion ?? '—'} · created ${date(o.createdAt.slice(0, 10))}` : undefined}
        actions={<Link className="text-sm text-fg-muted hover:text-fg" href="/admin/organisations">All organisations</Link>}
      />
      <ErrorAlert title="Could not load the organisation" error={q.error} />
      {o ? (
        <>
          <Card className="mb-6" aria-label="Status">
            <CardHeader
              title="Status"
              description="Suspending keeps the organisation readable: its members can still open and export their records, but nothing can be changed until it is reinstated. Its members see the reason, and it is written to the organisation's own audit trail."
            />
            <div className="px-5 pb-5 pt-4">
              {o.suspended ? (
                <Alert tone="warning" title={`Suspended since ${dateTime(o.suspended.at)}`}>{o.suspended.reason}</Alert>
              ) : (
                <p className="text-sm"><Badge tone="positive">Active</Badge></p>
              )}
              {manage ? (
                <div className="mt-4 flex flex-wrap items-end gap-3">
                  <Field label={o.suspended ? 'Note (optional)' : 'Reason members will see'}>
                    {(p) => <Input {...p} className="w-[28rem]" value={reason} maxLength={500} placeholder={o.suspended ? 'e.g. Payment received' : 'e.g. Subscription payment overdue since 1 October'} onChange={(e) => setReason(e.target.value)} />}
                  </Field>
                  {o.suspended ? (
                    <Button variant="secondary" loading={reinstate.isPending} onClick={() => reinstate.mutate()}>Reinstate</Button>
                  ) : (
                    <Button variant="danger" disabled={reason.trim().length < 5} loading={suspend.isPending} onClick={() => suspend.mutate()}>Suspend</Button>
                  )}
                </div>
              ) : <p className="mt-3 text-sm text-fg-muted">Only super admins can suspend or reinstate.</p>}
              <div className="mt-3"><ErrorAlert title="Not changed" error={suspend.error ?? reinstate.error} /></div>
            </div>
          </Card>
          <div className="grid gap-6 xl:grid-cols-2">
            <Card aria-label="Members">
              <CardHeader title="Members" description="Who belongs to the organisation and their role in it." />
              <Table>
                <thead><tr><Th>Name</Th><Th>Email</Th><Th>Role</Th><Th>Since</Th></tr></thead>
                <tbody>
                  {o.members.map((m) => (
                    <Tr key={m.userId}>
                      <Td>{m.name} {m.active ? null : <Badge tone="negative">Disabled</Badge>}</Td>
                      <Td className="text-fg-muted">{m.email}</Td>
                      <Td>{m.role}</Td>
                      <Td>{date(m.since.slice(0, 10))}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Card>
            <Card aria-label="Platform actions">
              <CardHeader title="Platform actions" description="Suspensions and reinstatements, newest first." />
              {o.history.length ? (
                <Table>
                  <thead><tr><Th>When</Th><Th>Action</Th><Th>By</Th><Th>Reason or note</Th></tr></thead>
                  <tbody>
                    {o.history.map((h, i) => (
                      <Tr key={i}>
                        <Td className="whitespace-nowrap">{dateTime(h.at)}</Td>
                        <Td>{ACTION[h.action] ?? h.action}</Td>
                        <Td>{h.by ?? 'System'}</Td>
                        <Td className="text-sm text-fg-muted">{String(h.data?.reason ?? h.data?.note ?? '—')}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              ) : <p className="px-5 pb-5 pt-3 text-sm text-fg-muted">No platform actions yet.</p>}
            </Card>
          </div>
        </>
      ) : null}
    </>
  );
}
