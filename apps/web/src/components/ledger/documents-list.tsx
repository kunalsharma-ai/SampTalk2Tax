'use client';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, EmptyState, Select, cn } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import type { LedgerConfig } from '@/lib/ledgers';
import { useOrg } from '@/lib/org';
import { can, type DocumentSummary } from '@/lib/types';
import { DocumentsTable } from './documents-table';

const PAGE = 25;
const VIEWS = [
  ['all', 'All'],
  ['draft', 'Drafts'],
  ['open', 'Open'],
  ['overdue', 'Overdue'],
  ['paid', 'Settled'],
  ['void', 'Void'],
] as const;

function List({ l }: { l: LedgerConfig }) {
  const { org, orgId } = useOrg();
  const router = useRouter();
  const params = useSearchParams();
  const view = params.get('view') ?? 'all';
  const kind = params.get('kind') ?? '';
  const [page, setPage] = useState(0);
  const q = useQuery({
    queryKey: ['documents', orgId, l.api, view, kind, page],
    queryFn: () => api<{ total: number; items: DocumentSummary[] }>(`/v1/orgs/${orgId}/${l.api}/documents?view=${view}&limit=${PAGE}&offset=${page * PAGE}${kind ? `&kind=${kind}` : ''}`),
  });
  if (!org) return null;
  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params.toString());
    if (v && v !== 'all') next.set(k, v);
    else next.delete(k);
    setPage(0);
    router.replace(`?${next.toString()}`);
  };
  const pages = q.data ? Math.max(1, Math.ceil(q.data.total / PAGE)) : 1;
  const canManage = can(org.role, l.managePermission);
  return (
    <>
      <PageHeader
        title={l.docsTitle}
        description="Posting creates the journal automatically. Posted documents are never edited; void one to reverse it."
        actions={
          canManage ? (
            <>
              <Link href={`/orgs/${orgId}/${l.docsPath}/new?kind=${l.credit.kind}`}><Button variant="secondary">New {l.credit.label.toLowerCase()}</Button></Link>
              <Link href={`/orgs/${orgId}/${l.docsPath}/new`}><Button>New {l.charge.label.toLowerCase()}</Button></Link>
            </>
          ) : null
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div role="tablist" aria-label="Filter by status" className="flex flex-wrap gap-1 rounded-[var(--t2t-radius-md)] border border-line bg-surface p-1">
          {VIEWS.map(([v, label]) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              className={cn('rounded px-3 py-1 text-sm', view === v ? 'bg-accent/15 text-fg' : 'text-fg-muted hover:text-fg')}
              onClick={() => setParam('view', v)}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="sr-only" htmlFor="kind-filter">Document type</label>
        <Select id="kind-filter" className="w-44" value={kind} onChange={(e) => setParam('kind', e.target.value)}>
          <option value="">All types</option>
          <option value={l.charge.kind}>{l.charge.plural}</option>
          <option value={l.credit.kind}>{l.credit.plural}</option>
        </Select>
      </div>
      {q.error ? <Alert title="Could not load documents">{(q.error as Error).message}</Alert> : null}
      <Card>
        {q.data && q.data.items.length === 0 ? (
          <EmptyState title="Nothing here">No {l.charge.plural.toLowerCase()} or {l.credit.plural.toLowerCase()} match this filter.</EmptyState>
        ) : (
          <DocumentsTable l={l} orgId={orgId} items={q.data?.items ?? []} currency={org.functionalCurrency} />
        )}
        {q.data && q.data.total > PAGE ? (
          <div className="flex items-center justify-between border-t border-line px-4 py-3 text-sm text-fg-muted">
            <span>Page {page + 1} of {pages} · {q.data.total} documents</span>
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

export function DocumentsList({ l }: { l: LedgerConfig }) {
  return (
    <Suspense>
      <List l={l} />
    </Suspense>
  );
}
