'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, EmptyState, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import type { AdminOrg } from '@/lib/admin';

export default function AdminOrganisationsPage() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'all' | 'active' | 'suspended'>('all');
  const list = useQuery({
    queryKey: ['admin-orgs', q.trim(), status],
    queryFn: () => api<AdminOrg[]>(`/v1/admin/organisations?status=${status}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`),
  });
  return (
    <>
      <PageHeader
        title="Organisations"
        description="Every organisation on this region's service, newest first (up to 200). Search by name, an owner's or member's email, or the organisation id."
        actions={
          <>
            <Input className="w-72" aria-label="Search organisations" placeholder="Name, email or id" value={q} onChange={(e) => setQ(e.target.value)} />
            <Select className="w-40" aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
              <option value="all">All</option>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
            </Select>
          </>
        }
      />
      <ErrorAlert title="Could not load organisations" error={list.error} />
      <Card aria-label="Organisations">
        {list.data?.length ? (
          <Table>
            <thead><tr><Th>Organisation</Th><Th>Country</Th><Th>Region</Th><Th numeric>Members</Th><Th>Owners</Th><Th>Created</Th><Th>Status</Th></tr></thead>
            <tbody>
              {list.data.map((o) => (
                <Tr key={o.id}>
                  <Td>
                    <Link className="font-medium hover:text-accent" href={`/admin/organisations/${o.id}`}>{o.name}</Link>
                    {o.isDemo ? <Badge tone="warning" className="ml-2">Demo</Badge> : null}
                  </Td>
                  <Td>{o.countryCode} · {o.functionalCurrency}</Td>
                  <Td className="num text-fg-muted">{o.dataRegion ?? '—'}</Td>
                  <Td numeric>{o.members}</Td>
                  <Td className="max-w-[16rem] truncate text-sm text-fg-muted">{o.owners?.join(', ')}</Td>
                  <Td>{date(o.createdAt.slice(0, 10))}</Td>
                  <Td>{o.suspended ? <Badge tone="negative">Suspended</Badge> : <Badge tone="positive">Active</Badge>}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : list.data ? <EmptyState title="No organisations match">Try another name, email or id.</EmptyState> : null}
      </Card>
    </>
  );
}
