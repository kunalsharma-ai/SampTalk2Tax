'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Field, Select, Textarea } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { Conversation } from '@/components/support/conversation';
import { Targets } from '@/components/support/targets';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { CATEGORY, PRIORITY, SUPPORT_STATUS, type SupportPriority, type SupportTicket } from '@/lib/support';

interface ReplyResult { ticket: SupportTicket; emailed: { ok: boolean; to: string | null; error: string | null } | null }

export default function AdminTicketPage() {
  const { ticketId } = useParams<{ ticketId: string }>();
  const qc = useQueryClient();
  const key = ['admin-support-ticket', ticketId];
  const ticket = useQuery({ queryKey: key, queryFn: () => api<SupportTicket>(`/v1/admin/support/tickets/${ticketId}`) });
  const [draft, setDraft] = useState({ body: '', internal: false, resolve: false });
  const [emailed, setEmailed] = useState<ReplyResult['emailed']>(null);
  const saved = async (t: SupportTicket) => { qc.setQueryData(key, t); await qc.invalidateQueries({ queryKey: ['admin-support'] }); };
  const reply = useMutation({
    mutationFn: () => api<ReplyResult>(`/v1/admin/support/tickets/${ticketId}/messages`, { method: 'POST', body: draft }),
    onSuccess: async (r) => { setDraft({ body: '', internal: false, resolve: false }); setEmailed(r.emailed); await saved(r.ticket); },
  });
  const update = useMutation({ mutationFn: (b: { priority?: SupportPriority; assigneeId?: string | null; action?: 'RESOLVE' | 'CLOSE' | 'REOPEN' }) => api<SupportTicket>(`/v1/admin/support/tickets/${ticketId}`, { method: 'PUT', body: b }), onSuccess: saved });
  const t = ticket.data;
  if (!t) return ticket.error ? <ErrorAlert title="Ticket not found" error={ticket.error} /> : null;
  const closed = t.status === 'CLOSED';
  return (
    <>
      <PageHeader
        title={t.subject}
        description={<span>{t.reference} · {CATEGORY[t.category]} · from {t.openedBy.name} ({t.openedBy.email}) at {t.org?.name} · <Link className="text-accent hover:underline" href="/admin/support">Queue</Link></span>}
        actions={<Badge tone={SUPPORT_STATUS[t.status].tone}>{SUPPORT_STATUS[t.status].label}</Badge>}
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div>
          <Conversation messages={t.messages} mine="SUPPORT" />
          {closed ? <p className="mt-4 text-sm text-fg-muted">Closed {t.closedAt ? dateTime(t.closedAt) : ''}. Nothing more can be added.</p> : (
            <form className="mt-4 space-y-3" aria-label="Answer" onSubmit={(e) => { e.preventDefault(); reply.mutate(); }}>
              <Field label={draft.internal ? 'Internal note (only support sees it)' : 'Reply to the customer'}>{(p) => <Textarea {...p} rows={5} maxLength={10000} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />}</Field>
              <div className="flex flex-wrap items-center gap-4 text-sm">
                <label className="flex items-center gap-2"><input type="checkbox" checked={draft.internal} onChange={(e) => setDraft({ ...draft, internal: e.target.checked, resolve: false })} /> Internal note</label>
                <label className="flex items-center gap-2"><input type="checkbox" disabled={draft.internal} checked={draft.resolve} onChange={(e) => setDraft({ ...draft, resolve: e.target.checked })} /> Mark resolved</label>
                <Button type="submit" className="ml-auto" disabled={!draft.body.trim()} loading={reply.isPending}>{draft.internal ? 'Add note' : 'Send reply'}</Button>
              </div>
            </form>
          )}
          {emailed ? (
            <div className="mt-3">{emailed.ok ? <Alert tone="positive" title="Emailed">The reply was emailed to {emailed.to}.</Alert> : <Alert tone="warning" title="Saved, not emailed">{emailed.error} The customer sees the reply in Talk2Tax.</Alert>}</div>
          ) : null}
          <ErrorAlert title="Not saved" error={reply.error ?? update.error} />
        </div>
        <div className="space-y-4">
          <Card aria-label="Organisation">
            <CardHeader title={t.org?.name ?? 'Organisation'} description={t.org ? `${t.org.countryCode} · ${t.org.plan ? `${t.org.plan.name} (${t.org.plan.status.toLowerCase()})` : 'no plan'}${t.org.suspended ? ' · suspended' : ''}` : undefined} />
            <div className="px-5 pb-5 pt-3 text-sm">
              {t.supportAccess ? (
                <>
                  <p className="mb-3">The organisation lets support read its books until <strong>{dateTime(t.supportAccess.expiresAt)}</strong>: {t.supportAccess.reason}</p>
                  <Link className="inline-flex h-8 items-center rounded-[var(--t2t-radius-md)] bg-accent px-3 text-sm font-medium text-white hover:opacity-90" href={`/orgs/${t.org?.id}`}>Open the books, read-only</Link>
                  <p className="mt-2 text-xs text-fg-muted">The organisation sees every page you open.</p>
                </>
              ) : (
                <p className="text-fg-muted">Support cannot see this organisation's books. If you need to, ask the customer to give support access under Help and support.</p>
              )}
            </div>
          </Card>
          <Card aria-label="Ticket">
            <CardHeader title="Ticket" />
            <div className="space-y-4 px-5 pb-5 pt-3">
              <Targets t={t} />
              <Field label="Assigned to">
                {(p) => (
                  <Select {...p} disabled={closed} value={t.assignee?.id ?? ''} onChange={(e) => update.mutate({ assigneeId: e.target.value || null })}>
                    <option value="">Nobody</option>
                    {t.staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </Select>
                )}
              </Field>
              <Field label="Urgency">
                {(p) => (
                  <Select {...p} disabled={closed} value={t.priority} onChange={(e) => update.mutate({ priority: e.target.value as SupportPriority })}>
                    {Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                  </Select>
                )}
              </Field>
              <div className="flex flex-wrap gap-2">
                {t.status === 'OPEN' || t.status === 'PENDING' ? <Button size="sm" variant="secondary" onClick={() => update.mutate({ action: 'RESOLVE' })}>Mark resolved</Button> : null}
                {t.status === 'RESOLVED' ? <Button size="sm" variant="secondary" onClick={() => update.mutate({ action: 'REOPEN' })}>Reopen</Button> : null}
                {!closed ? <Button size="sm" variant="ghost" onClick={() => update.mutate({ action: 'CLOSE' })}>Close</Button> : null}
              </div>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
