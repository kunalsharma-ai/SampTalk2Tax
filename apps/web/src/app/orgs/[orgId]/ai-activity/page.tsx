'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, EmptyState, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { dateTime, type AiActivity } from '@/lib/collections';
import { useOrg } from '@/lib/org';

const FEATURE = { COPILOT: 'Copilot', COLLECTIONS: 'Collections', BANKING: 'Bank reconciliation', CLOSE: 'Month-end close' } as const;
const OUTCOME_TONE: Record<string, 'neutral' | 'positive' | 'warning' | 'negative' | 'accent'> = {
  COMPLETE: 'positive',
  SENT: 'positive',
  READY: 'warning',
  PENDING: 'accent',
  DRAFTING: 'accent',
  REJECTED: 'neutral',
  ACCEPTED: 'positive',
  DISMISSED: 'neutral',
  INCOMPLETE: 'warning',
  REFUSED: 'negative',
  FAILED: 'negative',
  SEND_FAILED: 'negative',
};
const OUTCOME_LABEL: Record<string, string> = { COMPLETE: 'Answered', SENT: 'Sent', READY: 'To review', PENDING: 'Working', DRAFTING: 'Drafting', REJECTED: 'Rejected', ACCEPTED: 'Accepted', DISMISSED: 'Dismissed', INCOMPLETE: 'Incomplete', REFUSED: 'Declined', FAILED: 'Failed', SEND_FAILED: 'Not delivered' };

export default function AiActivityPage() {
  const { org, orgId } = useOrg();
  const [feature, setFeature] = useState<'' | keyof typeof FEATURE>('');
  const q = useQuery({ queryKey: ['ai-activity', orgId], queryFn: () => api<AiActivity>(`/v1/orgs/${orgId}/ai-activity?limit=200`) });
  if (!org) return null;
  const rows = (q.data?.rows ?? []).filter((r) => !feature || r.feature === feature);
  const tokens = (n: number) => n.toLocaleString('en-IN');
  return (
    <>
      <PageHeader
        title="AI activity"
        description="Every call made to the AI model for this organisation: what it was for, who started it, the model asked and the one that answered, tokens used, the outcome and what a person decided. Copilot questions stay private to the member who asked them; only the fact of each answer is shown here."
      />
      <ErrorAlert title="Could not load AI activity" error={q.error} />
      {q.data ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-3">
            <Stat label="AI calls shown" value={q.data.totals.calls} tone="accent" sub="Newest 200" />
            <Stat label="Tokens in" value={tokens(q.data.totals.inputTokens)} sub="Sent to the model" />
            <Stat label="Tokens out" value={tokens(q.data.totals.outputTokens)} sub="Written by the model" />
          </div>
          <label className="mb-3 flex w-fit items-center gap-2 text-xs font-medium uppercase tracking-wide text-fg-muted">
            Feature
            <Select className="w-56" value={feature} onChange={(e) => setFeature(e.target.value as typeof feature)}>
              <option value="">Every feature</option>
              <option value="COPILOT">Copilot</option>
              <option value="COLLECTIONS">Collections</option>
              <option value="BANKING">Bank reconciliation</option>
              <option value="CLOSE">Month-end close</option>
            </Select>
          </label>
          {rows.length ? (
            <Card className="overflow-x-auto">
              <Table aria-label="AI calls">
                <thead>
                  <tr>
                    <Th>When</Th>
                    <Th>Feature</Th>
                    <Th>What</Th>
                    <Th>Started by</Th>
                    <Th>Model</Th>
                    <Th numeric>Tokens in / out</Th>
                    <Th>Outcome</Th>
                    <Th>Decision</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <Tr key={`${r.feature}-${r.id}`}>
                      <Td className="whitespace-nowrap text-xs">{dateTime(r.at)}</Td>
                      <Td>{FEATURE[r.feature]}</Td>
                      <Td className="min-w-[16rem]">{r.link ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}${r.link}`}>{r.what}</Link> : r.what}</Td>
                      <Td className="whitespace-nowrap">{r.by}</Td>
                      <Td className="whitespace-nowrap font-mono text-xs">
                        {r.model}
                        {r.servedModel && r.servedModel !== r.model ? <span className="block text-fg-faint">answered by {r.servedModel}</span> : null}
                      </Td>
                      <Td numeric className="whitespace-nowrap">{r.inputTokens === null ? '—' : `${tokens(r.inputTokens)} / ${tokens(r.outputTokens ?? 0)}`}</Td>
                      <Td>
                        <Badge tone={OUTCOME_TONE[r.outcome] ?? 'neutral'}>{OUTCOME_LABEL[r.outcome] ?? r.outcome}</Badge>
                        {r.error ? <span className="block text-xs text-fg-faint">{r.error}</span> : null}
                      </Td>
                      <Td className="text-sm text-fg-muted">{r.decision ?? '—'}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          ) : (
            <Card>
              <EmptyState title="No AI calls yet">Calls appear here when someone asks the copilot a question, drafts payment reminders, asks for bank suggestions or has a month-end close reviewed.</EmptyState>
            </Card>
          )}
        </>
      ) : null}
    </>
  );
}
