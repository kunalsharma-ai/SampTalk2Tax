'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { AdminAnnouncement, useMeWithRole } from '@/lib/admin';

const STATE: Record<string, { label: string; tone: 'positive' | 'neutral' | 'warning' | 'negative' }> = {
  SHOWING: { label: 'Showing', tone: 'positive' },
  SCHEDULED: { label: 'Scheduled', tone: 'warning' },
  ENDED: { label: 'Ended', tone: 'neutral' },
  WITHDRAWN: { label: 'Withdrawn', tone: 'neutral' },
};
/** A datetime-local value (the browser's time) as an ISO moment. */
const iso = (v: string) => (v ? new Date(v).toISOString() : undefined);

export default function AdminAnnouncementsPage() {
  const qc = useQueryClient();
  const me = useMeWithRole();
  const [draft, setDraft] = useState({ message: '', tone: 'INFO' as 'INFO' | 'WARNING', startsAt: '', endsAt: '' });
  const list = useQuery({ queryKey: ['admin-announcements'], queryFn: () => api<AdminAnnouncement[]>('/v1/admin/announcements') });
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ['admin-announcements'] }); await qc.invalidateQueries({ queryKey: ['announcements'] }); };
  const create = useMutation({
    mutationFn: () => api('/v1/admin/announcements', { method: 'POST', body: { message: draft.message, tone: draft.tone, startsAt: iso(draft.startsAt), endsAt: iso(draft.endsAt) ?? null } }),
    onSuccess: async () => { setDraft({ message: '', tone: 'INFO', startsAt: '', endsAt: '' }); await refresh(); },
  });
  const withdraw = useMutation({ mutationFn: (id: string) => api(`/v1/admin/announcements/${id}/withdraw`, { method: 'POST' }), onSuccess: refresh });
  const manage = me.data?.user.platformRole === 'SUPER_ADMIN';
  return (
    <>
      <PageHeader title="Announcements" description="A short message shown at the top of every page for everyone signed in, such as planned maintenance. It shows from its start until its end or until it is withdrawn." />
      {manage ? (
        <Card className="mb-6" aria-label="New announcement">
          <CardHeader title="New announcement" description="Up to 500 characters. Times are in your browser's time zone; leave the start empty to show it now and the end empty to keep it until withdrawn." />
          <form className="flex flex-wrap items-end gap-3 px-5 pb-5 pt-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
            <Field label="Message">{(p) => <Input {...p} className="w-[32rem]" maxLength={500} value={draft.message} onChange={(e) => setDraft({ ...draft, message: e.target.value })} />}</Field>
            <Field label="Tone">
              {(p) => (
                <Select {...p} className="w-36" value={draft.tone} onChange={(e) => setDraft({ ...draft, tone: e.target.value as 'INFO' | 'WARNING' })}>
                  <option value="INFO">Information</option>
                  <option value="WARNING">Warning</option>
                </Select>
              )}
            </Field>
            <Field label="Starts">{(p) => <Input {...p} type="datetime-local" className="w-56" value={draft.startsAt} onChange={(e) => setDraft({ ...draft, startsAt: e.target.value })} />}</Field>
            <Field label="Ends">{(p) => <Input {...p} type="datetime-local" className="w-56" value={draft.endsAt} onChange={(e) => setDraft({ ...draft, endsAt: e.target.value })} />}</Field>
            <Button type="submit" disabled={!draft.message.trim()} loading={create.isPending}>Announce</Button>
            <div className="w-full"><ErrorAlert title="Not announced" error={create.error ?? withdraw.error} /></div>
          </form>
        </Card>
      ) : null}
      <Card aria-label="All announcements">
        {list.data?.length ? (
          <Table>
            <thead><tr><Th>Message</Th><Th>State</Th><Th>From</Th><Th>Until</Th><Th>By</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
            <tbody>
              {list.data.map((a) => (
                <Tr key={a.id}>
                  <Td className="max-w-[28rem]">{a.tone === 'WARNING' ? <Badge tone="warning" className="mr-2">Warning</Badge> : null}{a.message}</Td>
                  <Td>{a.state ? <Badge tone={STATE[a.state].tone}>{STATE[a.state].label}</Badge> : null}</Td>
                  <Td className="whitespace-nowrap text-sm">{dateTime(a.startsAt)}</Td>
                  <Td className="whitespace-nowrap text-sm">{a.endsAt ? dateTime(a.endsAt) : 'Until withdrawn'}</Td>
                  <Td className="text-sm text-fg-muted">{a.createdBy}</Td>
                  <Td className="text-right">{manage && (a.state === 'SHOWING' || a.state === 'SCHEDULED') ? <Button variant="ghost" size="sm" onClick={() => withdraw.mutate(a.id)}>Withdraw</Button> : null}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : list.data ? <EmptyState title="No announcements yet">They appear here once made.</EmptyState> : null}
      </Card>
    </>
  );
}
