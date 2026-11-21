'use client';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/collections';

/** One call to an AI model in the explainable AI ledger (AUDIT-018 and others). */
export interface DecisionRecord {
  id: string;
  agent: { id: string; name: string; does: string };
  actingFor: { id: string; name: string } | null;
  keySource: 'ORGANISATION' | 'SERVER';
  modelRequested: string;
  servedModel: string | null;
  promptVersion: string;
  toolsVersion: string;
  toolNames: string[];
  dataSources: string[];
  subject: { type: string; id: string } | null;
  explanation: string | null;
  reasoningWithheld: boolean;
  stopReason: string | null;
  outcome: 'ANSWERED' | 'FAILED';
  errorName: string | null;
  inputTokens: number;
  outputTokens: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}
interface Page {
  records: DecisionRecord[];
  next: string | null;
  agents: { id: string; name: string; does: string }[];
}

const seconds = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

/**
 * The explainable AI ledger: every call to an AI model, with the agent and who it acted for, the
 * versions of its prompt and tools, the data it was given, when it ran and its own short
 * explanation. The model's hidden reasoning is never kept, only whether there was any.
 */
export function DecisionRecords({ orgId }: { orgId: string }) {
  const [agent, setAgent] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['ai-decisions', orgId, agent],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api<Page>(`/v1/orgs/${orgId}/ai-decisions?limit=50${agent ? `&agent=${agent}` : ''}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ''}`),
    getNextPageParam: (last) => last.next,
  });
  const pages = q.data?.pages ?? [];
  const rows = pages.flatMap((p) => p.records);
  const agents = pages[0]?.agents ?? [];
  return (
    <Card className="mt-4 overflow-x-auto">
      <CardHeader
        title="Decision records"
        description="Each AI call as the ledger keeps it: which agent, for whom, with which instructions and data, when, and what it said it decided. Hidden model reasoning is never kept."
        actions={
          <Select aria-label="Agent" className="w-56" value={agent} onChange={(e) => setAgent(e.target.value)}>
            <option value="">Every agent</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </Select>
        }
      />
      <ErrorAlert title="Could not load the decision records" error={q.error} />
      {q.data && !rows.length ? (
        <EmptyState title="No decision records yet">Every AI call from now on is recorded here.</EmptyState>
      ) : rows.length ? (
        <Table aria-label="Decision records">
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Agent</Th>
              <Th>Acting for</Th>
              <Th>Model and versions</Th>
              <Th>Data given</Th>
              <Th>Explanation</Th>
              <Th>Outcome</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Tr key={r.id}>
                <Td className="whitespace-nowrap text-xs">{dateTime(r.startedAt)}<span className="block text-fg-faint">took {seconds(r.durationMs)}</span></Td>
                <Td title={r.agent.does}>{r.agent.name}</Td>
                <Td className="whitespace-nowrap">{r.actingFor?.name ?? 'No member'}<span className="block text-xs text-fg-faint">{r.keySource === 'ORGANISATION' ? "Organisation's key" : "Talk2Tax's key"}</span></Td>
                <Td className="whitespace-nowrap font-mono text-xs">
                  {r.servedModel ?? r.modelRequested}
                  <span className="block text-fg-faint">prompt {r.promptVersion}</span>
                  <span className="block text-fg-faint">tools {r.toolsVersion} ({r.toolNames.length})</span>
                </Td>
                <Td className="min-w-[14rem] text-xs">{r.dataSources.length ? <ul className="list-disc pl-4">{r.dataSources.map((s) => <li key={s}>{s}</li>)}</ul> : '—'}</Td>
                <Td className="min-w-[16rem] text-sm">
                  {r.explanation ?? '—'}
                  {r.reasoningWithheld ? <span className="block text-xs text-fg-faint">The model's hidden reasoning was not kept.</span> : null}
                </Td>
                <Td>
                  <Badge tone={r.outcome === 'ANSWERED' ? 'positive' : 'negative'}>{r.outcome === 'ANSWERED' ? 'Answered' : 'Failed'}</Badge>
                  {r.errorName ? <span className="block text-xs text-fg-faint">{r.errorName}</span> : null}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      ) : null}
      {q.hasNextPage ? <div className="p-4"><Button size="sm" variant="secondary" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Show older records</Button></div> : null}
    </Card>
  );
}
