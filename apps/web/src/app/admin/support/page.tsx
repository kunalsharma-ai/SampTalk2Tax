'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, EmptyState, Field, Input, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { CATEGORY, PRIORITY, SUPPORT_STATUS, TARGET, type QueueTicket } from '@/lib/support';

interface Queue { tickets: QueueTicket[]; counts: { OPEN: number; PENDING: number; RESOLVED: number; CLOSED: number; overdue: number } }

/** The support queue: support's turn first, then the most urgent promise. */
export default function AdminSupportPage() {
  const [filter, setFilter] = useState({ status: 'active', assigned: 'all', q: '' });
  const qs = new URLSearchParams({ status: filter.status, assigned: filter.assigned, ...(filter.q.trim() ? { q: filter.q.trim() } : {}) }).toString();
  const queue = useQuery({ queryKey: ['admin-support', qs], queryFn: () => api<Queue>(`/v1/admin/support/tickets?${qs}`) });
  const c = queue.data?.counts;
  return (
    <>
      <PageHeader title="Support" description="Tickets from every organisation. You see the conversation and the organisation's name and plan; its books only while it grants support access, read-only and logged." />
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Waiting on support" value={c?.OPEN ?? '—'} tone="warning" />
        <Stat label="Waiting on customer" value={c?.PENDING ?? '—'} />
        <Stat label="Past a promised time" value={c?.overdue ?? '—'} tone={c?.overdue ? 'negative' : 'neutral'} />
        <Stat label="Resolved, not closed" value={c?.RESOLVED ?? '—'} tone="positive" />
      </div>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="Status">
          {(p) => (
            <Select {...p} className="w-48" value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
              <option value="active">Open and waiting</option>
              <option value="OPEN">Waiting on support</option>
              <option value="PENDING">Waiting on customer</option>
              <option value="RESOLVED">Resolved</option>
              <option value="CLOSED">Closed</option>
              <option value="all">All</option>
            </Select>
          )}
        </Field>
        <Field label="Assigned">
          {(p) => (
            <Select {...p} className="w-40" value={filter.assigned} onChange={(e) => setFilter({ ...filter, assigned: e.target.value })}>
              <option value="all">Anyone</option>
              <option value="me">Me</option>
              <option value="unassigned">Nobody</option>
            </Select>
          )}
        </Field>
        <Field label="Search">{(p) => <Input {...p} className="w-64" placeholder="Subject or T-000123" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} />}</Field>
      </div>
      <Card aria-label="Support queue">
        {queue.data?.tickets.length ? (
          <Table>
            <thead><tr><Th>Ticket</Th><Th>Organisation</Th><Th>Status</Th><Th>Urgency</Th><Th>Next promise</Th><Th>Assigned</Th><Th>Last message</Th></tr></thead>
            <tbody>
              {queue.data.tickets.map((t) => (
                <Tr key={t.id}>
                  <Td><Link className="font-medium hover:underline" href={`/admin/support/${t.id}`}>{t.subject}</Link><div className="font-mono text-xs text-fg-muted">{t.reference} · {CATEGORY[t.category]}</div></Td>
                  <Td className="text-sm">{t.org.name}{t.supportAccessUntil ? <div><Badge tone="violet">Books open until {dateTime(t.supportAccessUntil)}</Badge></div> : null}</Td>
                  <Td><Badge tone={SUPPORT_STATUS[t.status].tone}>{SUPPORT_STATUS[t.status].label}</Badge></Td>
                  <Td><Badge tone={PRIORITY[t.priority].tone}>{PRIORITY[t.priority].label}</Badge></Td>
                  <Td className="whitespace-nowrap text-sm">{t.status === 'OPEN' || t.status === 'PENDING' ? <><Badge tone={TARGET[t.next.state].tone}>{TARGET[t.next.state].label}</Badge> <span className="text-fg-muted">{t.firstResponseAt ? 'resolve' : 'answer'} by {dateTime(t.next.dueAt)}</span></> : '—'}</Td>
                  <Td className="text-sm text-fg-muted">{t.assignee?.name ?? 'Nobody'}</Td>
                  <Td className="whitespace-nowrap text-sm">{dateTime(t.lastMessageAt)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : queue.data ? <EmptyState title="Nothing here">No tickets match.</EmptyState> : null}
      </Card>
    </>
  );
}
