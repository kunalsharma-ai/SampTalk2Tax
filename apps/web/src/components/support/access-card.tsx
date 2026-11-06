'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import type { SupportAccess, TicketSummary } from '@/lib/support';

const HOURS = [2, 8, 24, 48, 72];
const STATE = { ACTIVE: { label: 'Active', tone: 'positive' }, EXPIRED: { label: 'Ended', tone: 'neutral' }, REVOKED: { label: 'Ended early', tone: 'neutral' } } as const;

/**
 * Owners and admins decide whether the people who run Talk2Tax may read the books, for how
 * long and why. Every request support makes while they can is listed here.
 */
export function SupportAccessCard({ orgId, tickets, ticketId }: { orgId: string; tickets: TicketSummary[]; ticketId?: string }) {
  const qc = useQueryClient();
  const access = useQuery({ queryKey: ['support-access', orgId], queryFn: () => api<SupportAccess>(`/v1/orgs/${orgId}/support/access`) });
  const [draft, setDraft] = useState({ hours: 24, reason: '', ticketId: ticketId ?? '' });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['support-access', orgId] }), qc.invalidateQueries({ queryKey: ['support-ticket', orgId] })]);
  const grant = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/support/access`, { method: 'POST', body: { hours: draft.hours, reason: draft.reason, ...(draft.ticketId ? { ticketId: draft.ticketId } : {}) } }),
    onSuccess: async () => { setDraft({ hours: 24, reason: '', ticketId: ticketId ?? '' }); await refresh(); },
  });
  const revoke = useMutation({ mutationFn: (id: string) => api(`/v1/orgs/${orgId}/support/access/${id}/revoke`, { method: 'POST' }), onSuccess: refresh });
  const active = access.data?.active;
  const open = tickets.filter((t) => t.status !== 'CLOSED');
  return (
    <Card aria-label="Support access" className="mb-6">
      <CardHeader
        title="Support access to your books"
        description="Talk2Tax support cannot see your accounts, journals, invoices or reports unless you allow it. Access is read-only, ends on its own after the time you choose (at most 3 days), and you can end it at any time. Payroll and the audit trail stay hidden."
      />
      <div className="px-5 pb-5 pt-4">
        {active ? (
          <div role="status" className="mb-4 flex flex-wrap items-center gap-3 rounded-[var(--t2t-radius-md)] border border-positive/30 bg-positive/10 px-4 py-3 text-sm">
            <span>Support can read your books until <strong>{dateTime(active.expiresAt)}</strong>. Reason: {active.reason}</span>
            <Button variant="secondary" size="sm" className="ml-auto" loading={revoke.isPending} onClick={() => revoke.mutate(active.id)}>End access now</Button>
          </div>
        ) : (
          <form className="mb-4 flex flex-wrap items-end gap-3" aria-label="Give support access" onSubmit={(e) => { e.preventDefault(); grant.mutate(); }}>
            <Field label="For">
              {(p) => (
                <Select {...p} className="w-32" value={draft.hours} onChange={(e) => setDraft({ ...draft, hours: Number(e.target.value) })}>
                  {HOURS.map((h) => <option key={h} value={h}>{h} hours</option>)}
                </Select>
              )}
            </Field>
            <Field label="Why support needs to look">{(p) => <Input {...p} className="w-80" maxLength={500} value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })} />}</Field>
            {ticketId ? null : (
              <Field label="About ticket">
                {(p) => (
                  <Select {...p} className="w-64" value={draft.ticketId} onChange={(e) => setDraft({ ...draft, ticketId: e.target.value })}>
                    <option value="">No particular ticket</option>
                    {open.map((t) => <option key={t.id} value={t.id}>{t.reference} {t.subject}</option>)}
                  </Select>
                )}
              </Field>
            )}
            <Button type="submit" disabled={draft.reason.trim().length < 3} loading={grant.isPending}>Give read-only access</Button>
          </form>
        )}
        <ErrorAlert title="Not changed" error={grant.error ?? revoke.error} />
        {access.data?.grants.length ? (
          <Table aria-label="Access granted">
            <thead><tr><Th>Granted</Th><Th>Until</Th><Th>Why</Th><Th>Ticket</Th><Th>By</Th><Th>State</Th></tr></thead>
            <tbody>
              {access.data.grants.map((g) => (
                <Tr key={g.id}>
                  <Td className="whitespace-nowrap text-sm">{dateTime(g.createdAt)}</Td>
                  <Td className="whitespace-nowrap text-sm">{dateTime(g.revokedAt ?? g.expiresAt)}</Td>
                  <Td className="text-sm">{g.reason}</Td>
                  <Td className="text-sm">{g.ticket ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/support/${g.ticket.id}`}>{g.ticket.reference}</Link> : '—'}</Td>
                  <Td className="text-sm text-fg-muted">{g.grantedBy}{g.revokedBy ? `, ended by ${g.revokedBy}` : ''}</Td>
                  <Td><Badge tone={STATE[g.state].tone}>{STATE[g.state].label}</Badge></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : null}
        <h3 className="mb-2 mt-6 text-sm font-semibold">What support looked at</h3>
        {access.data?.views.length ? (
          <Table aria-label="What support looked at">
            <thead><tr><Th>When</Th><Th>Who</Th><Th>Page or data</Th></tr></thead>
            <tbody>
              {access.data.views.map((v) => (
                <Tr key={v.id}>
                  <Td className="whitespace-nowrap text-sm">{dateTime(v.at)}</Td>
                  <Td className="text-sm">{v.by}</Td>
                  <Td className="font-mono text-xs">{v.path}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : access.data ? <EmptyState title="Support has not looked at your books">Each request support makes while they have access is listed here.</EmptyState> : null}
      </div>
    </Card>
  );
}
