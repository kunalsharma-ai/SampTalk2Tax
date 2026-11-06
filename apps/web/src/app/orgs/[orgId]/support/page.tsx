'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Table, Td, Textarea, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { SupportAccessCard } from '@/components/support/access-card';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { CATEGORY, CUSTOMER_STATUS, PRIORITY, type OrgTicket, type SupportCategory, type SupportPriority, type TicketSummary } from '@/lib/support';
import { can } from '@/lib/types';

export default function SupportPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const router = useRouter();
  const tickets = useQuery({ queryKey: ['support-tickets', orgId], queryFn: () => api<TicketSummary[]>(`/v1/orgs/${orgId}/support/tickets`) });
  const [draft, setDraft] = useState({ subject: '', category: 'TECHNICAL' as SupportCategory, priority: 'NORMAL' as SupportPriority, body: '' });
  const create = useMutation({
    mutationFn: () => api<OrgTicket>(`/v1/orgs/${orgId}/support/tickets`, { method: 'POST', body: draft }),
    onSuccess: async (t) => { await qc.invalidateQueries({ queryKey: ['support-tickets', orgId] }); router.push(`/orgs/${orgId}/support/${t.id}`); },
  });
  const manage = can(org?.role, 'org.manage') && !org?.viaSupport;
  return (
    <>
      <PageHeader title="Help and support" description="Ask the Talk2Tax team for help. You get an email when support answers, and the conversation stays here." />
      <Card className="mb-6" aria-label="New ticket">
        <CardHeader title="Ask for help" description="Say what you were doing and what you expected. Do not paste passwords or card numbers." />
        <form className="grid gap-3 px-5 pb-5 pt-4 md:grid-cols-[1fr_14rem_16rem]" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <Field label="Subject">{(p) => <Input {...p} maxLength={200} value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />}</Field>
          <Field label="Topic">
            {(p) => (
              <Select {...p} value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value as SupportCategory })}>
                {Object.entries(CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            )}
          </Field>
          <Field label="How urgent" hint={PRIORITY[draft.priority].hint}>
            {(p) => (
              <Select {...p} value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value as SupportPriority })}>
                {Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </Select>
            )}
          </Field>
          <div className="md:col-span-3">
            <Field label="What is happening">{(p) => <Textarea {...p} rows={5} maxLength={10000} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />}</Field>
          </div>
          <div className="md:col-span-3 flex items-center gap-3">
            <Button type="submit" disabled={draft.subject.trim().length < 3 || !draft.body.trim() || !!org?.viaSupport} loading={create.isPending}>Send to support</Button>
            <ErrorAlert title="Not sent" error={create.error} />
          </div>
        </form>
      </Card>
      <Card className="mb-6" aria-label="Tickets">
        <CardHeader title={can(org?.role, 'org.manage') ? 'Tickets from this organisation' : 'Your tickets'} />
        {tickets.data?.length ? (
          <Table>
            <thead><tr><Th>Ticket</Th><Th>Subject</Th><Th>Status</Th><Th>Urgency</Th><Th>Opened by</Th><Th>Last message</Th></tr></thead>
            <tbody>
              {tickets.data.map((t) => (
                <Tr key={t.id}>
                  <Td className="whitespace-nowrap font-mono text-xs"><Link className="text-accent hover:underline" href={`/orgs/${orgId}/support/${t.id}`}>{t.reference}</Link></Td>
                  <Td><Link className="hover:underline" href={`/orgs/${orgId}/support/${t.id}`}>{t.subject}</Link><div className="text-xs text-fg-muted">{CATEGORY[t.category]}</div></Td>
                  <Td><Badge tone={CUSTOMER_STATUS[t.status].tone}>{CUSTOMER_STATUS[t.status].label}</Badge></Td>
                  <Td><Badge tone={PRIORITY[t.priority].tone}>{PRIORITY[t.priority].label}</Badge></Td>
                  <Td className="text-sm text-fg-muted">{t.openedBy.name}</Td>
                  <Td className="whitespace-nowrap text-sm">{dateTime(t.lastMessageAt)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : tickets.data ? <EmptyState title="No tickets yet">Tickets you open appear here.</EmptyState> : null}
      </Card>
      {manage ? <SupportAccessCard orgId={orgId} tickets={tickets.data ?? []} /> : null}
    </>
  );
}
