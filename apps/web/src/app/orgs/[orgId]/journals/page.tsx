'use client';
import { useQuery } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, EmptyState, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can, type Journal } from '@/lib/types';

const PAGE = 25;

function JournalsList() {
  const { org, orgId } = useOrg();
  const router = useRouter();
  const params = useSearchParams();
  const status = params.get('status') ?? '';
  const [page, setPage] = useState(0);
  const q = useQuery({
    queryKey: ['journals', orgId, status, page],
    queryFn: () => api<{ total: number; items: Journal[] }>(`/v1/orgs/${orgId}/journals?limit=${PAGE}&offset=${page * PAGE}${status ? `&status=${status}` : ''}`),
  });
  if (!org) return null;
  const c = org.functionalCurrency;
  const pages = q.data ? Math.max(1, Math.ceil(q.data.total / PAGE)) : 1;

  return (
    <>
      <PageHeader
        title="Journals"
        description="Every posted journal is numbered and permanent. Corrections are made by reversing, never by editing."
        actions={
          <>
            <label className="sr-only" htmlFor="status-filter">Status</label>
            <Select id="status-filter" className="w-36" value={status} onChange={(e) => { setPage(0); router.replace(e.target.value ? `?status=${e.target.value}` : '?'); }}>
              <option value="">All statuses</option>
              <option value="POSTED">Posted</option>
              <option value="DRAFT">Drafts</option>
            </Select>
            {can(org.role, 'journals.create') ? (
              <Link href={`/orgs/${orgId}/journals/new`}>
                <Button>New journal</Button>
              </Link>
            ) : null}
          </>
        }
      />
      {q.error ? <Alert title="Could not load journals">{(q.error as Error).message}</Alert> : null}
      <Card>
        {q.data && q.data.items.length === 0 ? (
          <EmptyState title={status === 'DRAFT' ? 'No drafts' : 'No journals yet'}>Journals you create will appear here.</EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Number</Th>
                <Th>Date</Th>
                <Th>Memo</Th>
                <Th>Type</Th>
                <Th>Status</Th>
                <Th numeric>Amount</Th>
              </tr>
            </thead>
            <tbody>
              {(q.data?.items ?? []).map((j) => (
                <Tr key={j.id} className="cursor-pointer" onClick={() => router.push(`/orgs/${orgId}/journals/${j.id}`)}>
                  <Td className="num">
                    <Link className="text-accent hover:underline" href={`/orgs/${orgId}/journals/${j.id}`}>
                      {j.displayNumber ?? '—'}
                    </Link>
                  </Td>
                  <Td className="whitespace-nowrap">{date(j.date)}</Td>
                  <Td className="max-w-[320px] truncate">{j.memo || <span className="text-fg-faint">No memo</span>}</Td>
                  <Td>
                    <Badge tone={j.type === 'REVERSING' ? 'violet' : 'neutral'}>{j.type.toLowerCase()}</Badge>
                  </Td>
                  <Td>
                    {j.status === 'DRAFT' ? <Badge tone="warning">Draft</Badge> : j.reversedBy ? <Badge tone="negative">Reversed</Badge> : <Badge tone="positive">Posted</Badge>}
                  </Td>
                  <Td numeric>
                    <Money value={j.totalDebit} currency={c} />
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
        {q.data && q.data.total > PAGE ? (
          <div className="flex items-center justify-between border-t border-line px-4 py-3 text-sm text-fg-muted">
            <span>
              Page {page + 1} of {pages} · {q.data.total} journals
            </span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button>
              <Button variant="secondary" size="sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          </div>
        ) : null}
      </Card>
    </>
  );
}

export default function JournalsPage() {
  return (
    <Suspense>
      <JournalsList />
    </Suspense>
  );
}
