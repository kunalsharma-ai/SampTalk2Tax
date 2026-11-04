'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, EmptyState, Input, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { type DecisionList, STATUS, VERDICT } from '@/lib/decisions';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

/** Decision memory: every recorded management decision, searchable, with how it turned out. */
export default function DecisionsPage() {
  const { org, orgId } = useOrg();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');
  const [verdict, setVerdict] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  const params = new URLSearchParams(Object.entries({ q, category, status, verdict }).filter(([, v]) => v));
  const list = useQuery({ queryKey: ['decisions', orgId, params.toString()], queryFn: () => api<DecisionList>(`/v1/orgs/${orgId}/decisions?${params}`) });
  if (!org) return null;
  const d = list.data;
  const cat = (k: string) => d?.categories.find((c) => c.key === k)?.label ?? k;
  return (
    <>
      <PageHeader
        title="Decision memory"
        description="Management decisions with the assumptions behind them, the outcomes expected, what actually happened in the books and what was learned."
        actions={can(org.role, 'decisions.manage') ? <Link className="rounded-[var(--t2t-radius-md)] bg-accent px-3 py-2 text-sm font-medium text-white hover:opacity-90" href={`/orgs/${orgId}/decisions/new`}>Record a decision</Link> : null}
      />
      <ErrorAlert title="Could not load decisions" error={list.error} />
      {d ? (
        <div className="mb-4 grid gap-4 sm:grid-cols-4">
          <Stat label="Active" value={String(d.totals.active)} />
          <Stat label="Due for review" value={String(d.totals.dueForReview)} />
          <Stat label="Reviewed" value={String(d.totals.reviewed)} />
          <Stat label="Withdrawn" value={String(d.totals.withdrawn)} />
        </div>
      ) : null}
      <Card className="mb-4">
        <div className="grid gap-3 p-4 md:grid-cols-[2fr_1fr_1fr_1fr]">
          <div>
            <label htmlFor="dm-q" className="mb-1 block text-xs font-medium uppercase tracking-wide text-fg-muted">Search</label>
            <Input id="dm-q" placeholder="Words from the decision, its assumptions or lessons, or DM-0001" value={text} onChange={(e) => setText(e.target.value)} />
          </div>
          <div>
            <label htmlFor="dm-cat" className="mb-1 block text-xs font-medium uppercase tracking-wide text-fg-muted">Category</label>
            <Select id="dm-cat" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">All categories</option>
              {(d?.categories ?? []).map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </Select>
          </div>
          <div>
            <label htmlFor="dm-status" className="mb-1 block text-xs font-medium uppercase tracking-wide text-fg-muted">Status</label>
            <Select id="dm-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Any status</option>
              {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </Select>
          </div>
          <div>
            <label htmlFor="dm-verdict" className="mb-1 block text-xs font-medium uppercase tracking-wide text-fg-muted">Outcome</label>
            <Select id="dm-verdict" value={verdict} onChange={(e) => setVerdict(e.target.value)}>
              <option value="">Any outcome</option>
              {Object.entries(VERDICT).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </Select>
          </div>
        </div>
      </Card>
      <Card>
        {d && d.items.length === 0 ? (
          <EmptyState title={q || category || status || verdict ? 'No decisions match' : 'No decisions recorded yet'}>
            {q || category || status || verdict ? 'Try other words or clear the filters.' : 'Record a decision, or record an approved scenario or a recovery plan as one, to start building the organisation’s memory.'}
          </EmptyState>
        ) : (
          <Table aria-label="Decisions">
            <thead>
              <tr>
                <Th>Decision</Th>
                <Th>Category</Th>
                <Th>Decided</Th>
                <Th>Expected outcomes</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {(d?.items ?? []).map((x) => (
                <Tr key={x.id}>
                  <Td>
                    <span className="num mr-2 text-xs text-fg-muted">{x.number}</span>
                    <Link className="font-medium text-accent hover:underline" href={`/orgs/${orgId}/decisions/${x.id}`}>{x.title}</Link>
                    {x.lessons ? <p className="mt-1 max-w-[520px] truncate text-xs text-fg-muted">Lesson: {x.lessons}</p> : null}
                  </Td>
                  <Td className="text-sm">{cat(x.category)}</Td>
                  <Td className="whitespace-nowrap text-sm">{date(x.decidedOn)}{x.decidedBy ? <span className="block text-xs text-fg-muted">{x.decidedBy}</span> : null}</Td>
                  <Td className="text-sm">
                    {x.outcomes.met + x.outcomes.missed + x.outcomes.notDue + x.outcomes.noValue === 0 ? (
                      <span className="text-fg-muted">None set</span>
                    ) : (
                      <span>
                        {x.outcomes.met} met, {x.outcomes.missed} missed{x.outcomes.notDue ? `, ${x.outcomes.notDue} not due` : ''}
                      </span>
                    )}
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      <Badge tone={STATUS[x.status].tone}>{STATUS[x.status].label}</Badge>
                      {x.verdict ? <Badge tone={VERDICT[x.verdict].tone}>{VERDICT[x.verdict].label}</Badge> : null}
                      {x.reviewOverdue ? <Badge tone="warning">Review due {date(x.reviewDue!)}</Badge> : null}
                    </div>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
