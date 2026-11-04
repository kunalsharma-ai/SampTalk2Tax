'use client';
import { useQuery } from '@tanstack/react-query';
import { Alert, Badge, Card, CardHeader, EmptyState, Input } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { graphHref, type GraphNeighbourhood, type GraphNode, NODE_TYPE_LABEL, relationLabel } from '@/lib/graph';
import { useOrg } from '@/lib/org';

function NodeLinks({ orgId, node, centre }: { orgId: string; node: GraphNode; centre?: boolean }) {
  return (
    <span className="flex shrink-0 items-center gap-3 text-xs">
      {node.path ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}${node.path}`}>Open {centre ? 'record' : ''}</Link> : null}
      {centre ? null : <Link className="text-accent hover:underline" href={graphHref(orgId, node)} aria-label={`Explore connections of ${node.label}`}>Explore</Link>}
    </span>
  );
}

function Explorer() {
  const { orgId } = useOrg();
  const params = useSearchParams();
  const router = useRouter();
  const type = params.get('type') ?? '';
  const id = params.get('id') ?? '';
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  const search = useQuery({
    enabled: q.length >= 2,
    queryKey: ['graph-search', orgId, q],
    queryFn: () => api<GraphNode[]>(`/v1/orgs/${orgId}/graph/search?q=${encodeURIComponent(q)}`),
  });
  const hood = useQuery({
    enabled: !!type && !!id,
    queryKey: ['graph-node', orgId, type, id],
    queryFn: () => api<GraphNeighbourhood>(`/v1/orgs/${orgId}/graph/nodes/${type}/${id}`),
  });
  const groups = new Map<string, GraphNeighbourhood['edges']>();
  for (const e of hood.data?.edges ?? []) groups.set(e.relation, [...(groups.get(e.relation) ?? []), e]);
  const more = new Map((hood.data?.more ?? []).map((m) => [m.relation, m.count]));

  return (
    <>
      <PageHeader title="Relationship explorer" description="Start from a customer, vendor, document, payment, journal, account, project, loan or asset and see what it is connected to in the books, and why." />
      <Card className="mb-4">
        <div className="p-4">
          <label htmlFor="graph-q" className="mb-1 block text-xs font-medium uppercase tracking-wide text-fg-muted">Find a record</label>
          <Input id="graph-q" placeholder="Name, invoice or payment number, JE number, account code, project…" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
          {search.error ? <div className="mt-3"><Alert title="Could not search">{(search.error as Error).message}</Alert></div> : null}
          {q.length >= 2 && search.data ? (
            search.data.length ? (
              <ul className="mt-3 divide-y divide-line rounded-[var(--t2t-radius-md)] border border-line" aria-label="Search results">
                {search.data.map((n) => (
                  <li key={`${n.type}-${n.id}`}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-surface-hover"
                      onClick={() => {
                        setText('');
                        router.push(graphHref(orgId, n));
                      }}
                    >
                      <span>
                        <span className="font-medium">{n.label}</span>
                        {n.subtitle ? <span className="ml-2 text-fg-muted">{n.subtitle}</span> : null}
                      </span>
                      <Badge>{NODE_TYPE_LABEL[n.type]}</Badge>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-fg-muted">Nothing matches “{q}”.</p>
            )
          ) : null}
        </div>
      </Card>

      {!type || !id ? (
        <Card><EmptyState title="Pick a record to start">Search above, or use “Connections” on a general ledger line, to see how a record links to the rest of the books.</EmptyState></Card>
      ) : hood.error ? (
        <Alert title="Could not load connections">{(hood.error as Error).message}</Alert>
      ) : hood.data ? (
        <>
          <Card className="mb-4">
            <div className="flex flex-wrap items-start justify-between gap-3 p-5">
              <div>
                <Badge tone="accent">{NODE_TYPE_LABEL[hood.data.node.type]}</Badge>
                <h2 className="mt-2 text-lg font-semibold" data-testid="graph-centre">{hood.data.node.label}</h2>
                {hood.data.node.subtitle ? <p className="text-sm text-fg-muted">{hood.data.node.subtitle}</p> : null}
              </div>
              <NodeLinks orgId={orgId} node={hood.data.node} centre />
            </div>
          </Card>
          {groups.size === 0 ? (
            <Card><EmptyState title="No connections yet">Nothing else in the books points at this record.</EmptyState></Card>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {[...groups].map(([relation, edges]) => (
                <Card key={relation}>
                  <CardHeader title={relationLabel(relation)} description={`${edges.length + (more.get(relation) ?? 0)} connection${edges.length + (more.get(relation) ?? 0) === 1 ? '' : 's'}`} />
                  <ul className="divide-y divide-line" aria-label={relationLabel(relation)}>
                    {edges.map((e) => (
                      <li key={`${e.node.type}-${e.node.id}`} className="flex items-start justify-between gap-3 px-5 py-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium">
                            {e.node.label} <span className="ml-1 text-xs font-normal text-fg-muted">{NODE_TYPE_LABEL[e.node.type]}</span>
                          </p>
                          <p className="text-sm text-fg-muted">{e.explanation}</p>
                        </div>
                        <NodeLinks orgId={orgId} node={e.node} />
                      </li>
                    ))}
                    {more.get(relation) ? <li className="px-5 py-3 text-xs text-fg-muted">and {more.get(relation)} more not shown</li> : null}
                  </ul>
                </Card>
              ))}
            </div>
          )}
        </>
      ) : (
        <p className="text-sm text-fg-muted">Loading…</p>
      )}
    </>
  );
}

export default function GraphPage() {
  return (
    <Suspense>
      <Explorer />
    </Suspense>
  );
}
