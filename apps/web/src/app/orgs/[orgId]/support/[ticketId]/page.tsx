'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, Field, Textarea } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { SupportAccessCard } from '@/components/support/access-card';
import { Conversation } from '@/components/support/conversation';
import { Targets } from '@/components/support/targets';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/org';
import { CATEGORY, CUSTOMER_STATUS, PRIORITY, type OrgTicket } from '@/lib/support';
import { can } from '@/lib/types';

export default function TicketPage() {
  const { org, orgId } = useOrg();
  const { ticketId } = useParams<{ ticketId: string }>();
  const qc = useQueryClient();
  const key = ['support-ticket', orgId, ticketId];
  const ticket = useQuery({ queryKey: key, queryFn: () => api<OrgTicket>(`/v1/orgs/${orgId}/support/tickets/${ticketId}`) });
  const [body, setBody] = useState('');
  const done = async (t: OrgTicket) => { qc.setQueryData(key, t); await qc.invalidateQueries({ queryKey: ['support-tickets', orgId] }); };
  const reply = useMutation({ mutationFn: () => api<OrgTicket>(`/v1/orgs/${orgId}/support/tickets/${ticketId}/messages`, { method: 'POST', body: { body } }), onSuccess: async (t) => { setBody(''); await done(t); } });
  const act = useMutation({ mutationFn: (a: 'close' | 'reopen') => api<OrgTicket>(`/v1/orgs/${orgId}/support/tickets/${ticketId}/${a}`, { method: 'POST' }), onSuccess: done });
  const t = ticket.data;
  if (!t) return ticket.error ? <ErrorAlert title="Ticket not found" error={ticket.error} /> : null;
  const closed = t.status === 'CLOSED';
  return (
    <>
      <PageHeader
        title={t.subject}
        description={<span>{t.reference} · {CATEGORY[t.category]} · opened by {t.openedBy.name} · <Link className="text-accent hover:underline" href={`/orgs/${orgId}/support`}>All tickets</Link></span>}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={PRIORITY[t.priority].tone}>{PRIORITY[t.priority].label}</Badge>
            <Badge tone={CUSTOMER_STATUS[t.status].tone}>{CUSTOMER_STATUS[t.status].label}</Badge>
            {t.status === 'RESOLVED' ? <Button variant="secondary" size="sm" onClick={() => act.mutate('reopen')}>Not fixed: reopen</Button> : null}
            {!closed ? <Button variant="ghost" size="sm" onClick={() => act.mutate('close')}>Close ticket</Button> : null}
          </div>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div>
          <Conversation messages={t.messages} mine="CUSTOMER" />
          {closed ? (
            <p className="mt-4 text-sm text-fg-muted">This ticket is closed. <Link className="text-accent hover:underline" href={`/orgs/${orgId}/support`}>Open a new ticket</Link> if there is more to do.</p>
          ) : (
            <form className="mt-4 space-y-3" aria-label="Reply" onSubmit={(e) => { e.preventDefault(); reply.mutate(); }}>
              <Field label="Your reply">{(p) => <Textarea {...p} rows={4} maxLength={10000} value={body} onChange={(e) => setBody(e.target.value)} />}</Field>
              <Button type="submit" disabled={!body.trim() || !!org?.viaSupport} loading={reply.isPending}>Send reply</Button>
            </form>
          )}
          <ErrorAlert title="Not sent" error={reply.error ?? act.error} />
        </div>
        <Card aria-label="Response times" className="h-fit">
          <CardHeader title="Response times" description={`${PRIORITY[t.priority].label}: ${PRIORITY[t.priority].hint}.`} />
          <div className="px-5 pb-5 pt-3"><Targets t={t} /></div>
        </Card>
      </div>
      {can(org?.role, 'org.manage') && !org?.viaSupport && !closed ? <div className="mt-6"><SupportAccessCard orgId={orgId} tickets={[t]} ticketId={t.id} /></div> : null}
    </>
  );
}
