'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { useMeWithRole } from '@/lib/admin';
import { dateTime } from '@/lib/format';
import { MaintenanceWindowRow } from '@/lib/operations';

const STATE = { IN_PROGRESS: { label: 'In progress', tone: 'warning' }, SCHEDULED: { label: 'Scheduled', tone: 'accent' }, ENDED: { label: 'Ended', tone: 'neutral' } } as const;
const iso = (v: string) => (v ? new Date(v).toISOString() : undefined);

/** Pause changes for everyone while the service is worked on; reading keeps working. */
export default function AdminMaintenancePage() {
  const qc = useQueryClient();
  const me = useMeWithRole();
  const [draft, setDraft] = useState({ message: '', startsAt: '', expectedEndAt: '' });
  const list = useQuery({ queryKey: ['admin-maintenance'], queryFn: () => api<MaintenanceWindowRow[]>('/v1/admin/maintenance') });
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ['admin-maintenance'] }); await qc.invalidateQueries({ queryKey: ['service-status'] }); };
  const start = useMutation({
    mutationFn: () => api('/v1/admin/maintenance', { method: 'POST', body: { message: draft.message, startsAt: iso(draft.startsAt), expectedEndAt: iso(draft.expectedEndAt) ?? null } }),
    onSuccess: async () => { setDraft({ message: '', startsAt: '', expectedEndAt: '' }); await refresh(); },
  });
  const end = useMutation({ mutationFn: (id: string) => api(`/v1/admin/maintenance/${id}/end`, { method: 'POST' }), onSuccess: refresh });
  const manage = me.data?.user.platformRole === 'SUPER_ADMIN';
  const open = list.data?.find((w) => w.state !== 'ENDED');
  return (
    <>
      <PageHeader title="Maintenance" description="While maintenance is in progress, nobody except the people who run Talk2Tax can change anything: reading, exporting and signing in keep working, payment notifications are still received, and the background runners pause. Everyone sees a banner, and a scheduled window is announced before it starts. Maintenance lasts until it is ended here; the expected end is only shown to people." />
      {manage && !open ? (
        <Card className="mb-6" aria-label="Start maintenance">
          <CardHeader title="Start or schedule maintenance" description="Times are in your browser's time zone. Leave the start empty to begin now." />
          <form className="flex flex-wrap items-end gap-3 px-5 pb-5 pt-4" onSubmit={(e) => { e.preventDefault(); start.mutate(); }}>
            <Field label="Message for everyone">{(p) => <Input {...p} className="w-[30rem]" maxLength={500} placeholder="e.g. We are upgrading the database." value={draft.message} onChange={(e) => setDraft({ ...draft, message: e.target.value })} />}</Field>
            <Field label="Starts">{(p) => <Input {...p} type="datetime-local" className="w-56" value={draft.startsAt} onChange={(e) => setDraft({ ...draft, startsAt: e.target.value })} />}</Field>
            <Field label="Expected end">{(p) => <Input {...p} type="datetime-local" className="w-56" value={draft.expectedEndAt} onChange={(e) => setDraft({ ...draft, expectedEndAt: e.target.value })} />}</Field>
            <Button type="submit" disabled={!draft.message.trim()} loading={start.isPending}>{draft.startsAt ? 'Schedule' : 'Start now'}</Button>
          </form>
        </Card>
      ) : null}
      {open ? (
        <Card className="mb-6" aria-label="Current maintenance">
          <CardHeader
            title={open.state === 'IN_PROGRESS' ? 'Maintenance in progress' : 'Maintenance scheduled'}
            description={open.message}
            actions={manage ? <Button variant="danger" loading={end.isPending} onClick={() => end.mutate(open.id)}>{open.state === 'IN_PROGRESS' ? 'End maintenance' : 'Cancel'}</Button> : null}
          />
          <p className="px-5 pb-5 pt-2 text-sm text-fg-muted">From {dateTime(open.startsAt)}{open.expectedEndAt ? `, expected to end about ${dateTime(open.expectedEndAt)}` : ', until ended'}. Started by {open.createdBy}.</p>
        </Card>
      ) : null}
      <ErrorAlert title="Not changed" error={start.error ?? end.error} />
      <Card aria-label="Maintenance history">
        {list.data?.length ? (
          <Table>
            <thead><tr><Th>Message</Th><Th>State</Th><Th>From</Th><Th>Ended</Th><Th>By</Th></tr></thead>
            <tbody>
              {list.data.map((w) => (
                <Tr key={w.id}>
                  <Td className="max-w-md">{w.message}</Td>
                  <Td><Badge tone={STATE[w.state].tone}>{STATE[w.state].label}</Badge></Td>
                  <Td className="whitespace-nowrap text-sm">{dateTime(w.startsAt)}</Td>
                  <Td className="whitespace-nowrap text-sm">{w.endedAt ? dateTime(w.endedAt) : w.expectedEndAt ? `expected ${dateTime(w.expectedEndAt)}` : '—'}</Td>
                  <Td className="text-sm text-fg-muted">{w.createdBy}{w.endedBy && w.endedBy !== w.createdBy ? `, ended by ${w.endedBy}` : ''}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : list.data ? <EmptyState title="No maintenance yet">Windows appear here once started or scheduled.</EmptyState> : null}
      </Card>
    </>
  );
}
