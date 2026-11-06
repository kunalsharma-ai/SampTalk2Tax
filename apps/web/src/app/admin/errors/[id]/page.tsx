'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Fragment, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { useMeWithRole } from '@/lib/admin';
import { dateTime } from '@/lib/format';
import { ErrorGroupDetail } from '@/lib/operations';

/** One error group: what failed, where, and each occurrence with its request reference. */
export default function ErrorGroupPage() {
  const { id } = useParams<{ id: string }>();
  const highlight = useSearchParams().get('request');
  const qc = useQueryClient();
  const me = useMeWithRole();
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['admin-error', id], queryFn: () => api<ErrorGroupDetail>(`/v1/admin/errors/${id}`) });
  const resolve = useMutation({
    mutationFn: (resolved: boolean) => api(`/v1/admin/errors/${id}/resolved`, { method: 'PUT', body: { resolved } }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['admin-error', id] }); await qc.invalidateQueries({ queryKey: ['admin-errors'] }); },
  });
  const g = q.data;
  const manage = me.data?.user.platformRole === 'SUPER_ADMIN';
  if (!g) return <p className="text-sm text-fg-muted">{q.isError ? (q.error as Error).message : 'Loading…'}</p>;
  return (
    <>
      <p className="mb-2 text-sm"><Link className="text-accent hover:underline" href="/admin/errors">← Errors</Link></p>
      <PageHeader
        title={g.name}
        description={g.message}
        actions={
          <div className="flex items-center gap-2">
            {g.resolvedAt ? <Badge tone="positive">Resolved {dateTime(g.resolvedAt)}{g.resolvedBy ? ` by ${g.resolvedBy}` : ''}</Badge> : <Badge tone="negative">Open</Badge>}
            {manage ? <Button variant="secondary" loading={resolve.isPending} onClick={() => resolve.mutate(!g.resolvedAt)}>{g.resolvedAt ? 'Open again' : 'Mark resolved'}</Button> : null}
          </div>
        }
      />
      <ErrorAlert title="Not changed" error={resolve.error} />
      <Card className="mb-6" aria-label="Where">
        <dl className="grid grid-cols-[9rem_1fr] gap-y-2 px-5 py-4 text-sm">
          <dt className="text-fg-muted">Route</dt><dd className="font-mono text-xs">{g.method} {g.route}</dd>
          <dt className="text-fg-muted">In the code</dt><dd className="break-all font-mono text-xs">{g.frame ?? '—'}</dd>
          <dt className="text-fg-muted">Times</dt><dd>{g.occurrences} · first {dateTime(g.firstSeenAt)} · last {dateTime(g.lastSeenAt)}</dd>
        </dl>
      </Card>
      <Card aria-label="Occurrences">
        <CardHeader title="Latest occurrences" description="The 25 most recent. The reference is what the person was shown; organisation and person are ids only." />
        <Table>
          <thead><tr><Th>When</Th><Th>Reference</Th><Th>Status</Th><Th>Path</Th><Th>Organisation</Th><Th><span className="sr-only">Stack</span></Th></tr></thead>
          <tbody>
            {g.events.map((e) => (
              <Fragment key={e.id}>
                <Tr className={highlight === e.requestId ? 'bg-warning/10' : undefined}>
                  <Td className="whitespace-nowrap text-sm">{dateTime(e.at)}</Td>
                  <Td className="font-mono text-xs">{e.requestId}</Td>
                  <Td className="font-mono">{e.status}</Td>
                  <Td className="font-mono text-xs">{e.method} {e.path}</Td>
                  <Td className="font-mono text-xs">{e.orgId ? <Link className="text-accent hover:underline" href={`/admin/organisations/${e.orgId}`}>{e.orgId.slice(0, 8)}…</Link> : '—'}</Td>
                  <Td className="text-right">{e.stack ? <Button variant="ghost" size="sm" onClick={() => setOpen(open === e.id ? null : e.id)}>{open === e.id ? 'Hide stack' : 'Stack'}</Button> : null}</Td>
                </Tr>
                {open === e.id ? (
                  <tr><td colSpan={6} className="bg-surface-hover px-5 py-3"><pre className="max-h-80 overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed">{e.stack}</pre></td></tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </Table>
      </Card>
    </>
  );
}
