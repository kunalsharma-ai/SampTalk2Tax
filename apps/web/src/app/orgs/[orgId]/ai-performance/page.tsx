'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, CardHeader, EmptyState, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { AiPerformanceChart } from '@/components/ai/performance-chart';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { type AiPerformance, count, duration } from '@/lib/ai-performance';
import { dateTime } from '@/lib/collections';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

/** Governance → AI performance (PERF-020): how the organisation's AI calls went, from their decision records. */
export default function AiPerformancePage() {
  const { org, orgId } = useOrg();
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const q = useQuery({
    queryKey: ['ai-performance', orgId, days],
    queryFn: () => api<AiPerformance>(`/v1/orgs/${orgId}/ai-decisions/performance?days=${days}`),
    enabled: !!org,
    placeholderData: (prev) => prev,
  });
  if (!org) return null;
  const p = q.data;
  return (
    <>
      <PageHeader
        title="AI performance"
        description="How the AI calls made for this organisation went: how many each assistant made, how many failed and why, how long they took and the tokens they used. Worked out from the AI decision records; what the AI was given or said is not shown here."
        actions={
          <Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/ai-activity`}>
            AI activity
          </Link>
        }
      />
      <label className="mb-4 flex w-fit items-center gap-2 text-xs font-medium uppercase tracking-wide text-fg-muted">
        Period
        <Select className="w-44" value={String(days)} onChange={(e) => setDays(Number(e.target.value) as 7 | 30 | 90)}>
          <option value="7">Last 7 days</option>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
        </Select>
      </label>
      <ErrorAlert title="Could not load AI performance" error={q.error} />
      {p ? (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 xl:grid-cols-5">
            <Stat label="AI calls" value={count(p.totals.calls)} tone="accent" sub={`${date(p.from)} to ${date(p.to)}`} />
            <Stat label="Failed" value={`${count(p.totals.failed)} (${p.totals.failureRate}%)`} tone={p.totals.failed ? 'negative' : undefined} sub="No answer came back" />
            <Stat label="Typical time" value={duration(p.totals.medianMs)} sub={`95% within ${duration(p.totals.p95Ms)}`} />
            <Stat label="Tokens in / out" value={`${count(p.totals.inputTokens)} / ${count(p.totals.outputTokens)}`} sub="Sent to and written by the model" />
            <Stat label="Cut short" value={count(p.totals.cutShort)} tone={p.totals.cutShort ? 'warning' : undefined} sub="Answers that hit the length limit" />
          </div>
          {p.totals.calls ? (
            <>
              <Card role="region" aria-label="AI calls by day" className="mb-6">
                <CardHeader title="AI calls by day" description="Answered and failed calls each day (India time), and the time 95 in 100 calls finished within." />
                <div className="px-5 pb-3">
                  <AiPerformanceChart days={p.days} />
                </div>
                <details className="px-5 pb-5 text-sm">
                  <summary className="cursor-pointer text-fg-muted">The figures as a table</summary>
                  <Table aria-label="AI calls each day">
                    <thead>
                      <Tr>
                        <Th>Day</Th>
                        <Th numeric>Calls</Th>
                        <Th numeric>Failed</Th>
                        <Th numeric>95% within</Th>
                      </Tr>
                    </thead>
                    <tbody>
                      {p.days.map((d) => (
                        <Tr key={d.date}>
                          <Td>{date(d.date)}</Td>
                          <Td numeric>{count(d.calls)}</Td>
                          <Td numeric>{count(d.failed)}</Td>
                          <Td numeric>{duration(d.p95Ms)}</Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                </details>
              </Card>
              <Card role="region" aria-label="Performance by assistant" className="mb-6 overflow-x-auto">
                <CardHeader title="Performance by assistant" description="Each AI assistant that made calls in the period, most calls first." />
                <Table aria-label="AI assistants">
                  <thead>
                    <Tr>
                      <Th>Assistant</Th>
                      <Th numeric>Calls</Th>
                      <Th numeric>Failed</Th>
                      <Th numeric>Typical time</Th>
                      <Th numeric>95% within</Th>
                      <Th numeric>Slowest</Th>
                      <Th numeric>Tokens in / out</Th>
                      <Th numeric>Cut short</Th>
                    </Tr>
                  </thead>
                  <tbody>
                    {p.agents.map((a) => (
                      <Tr key={a.agent}>
                        <Td>{a.name}</Td>
                        <Td numeric>{count(a.calls)}</Td>
                        <Td numeric>{a.failed ? <span className="text-negative">{`${count(a.failed)} (${a.failureRate}%)`}</span> : '0'}</Td>
                        <Td numeric>{duration(a.medianMs)}</Td>
                        <Td numeric>{duration(a.p95Ms)}</Td>
                        <Td numeric>{duration(a.slowestMs)}</Td>
                        <Td numeric className="whitespace-nowrap">{`${count(a.inputTokens)} / ${count(a.outputTokens)}`}</Td>
                        <Td numeric>{count(a.cutShort)}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </Card>
              <div className="grid gap-6 lg:grid-cols-2">
                <Card role="region" aria-label="Why calls failed">
                  <CardHeader title="Why calls failed" description="Failed calls by assistant and the kind of error the model's service gave." />
                  {p.failures.length ? (
                    <Table aria-label="Failed AI calls">
                      <thead>
                        <Tr>
                          <Th>Assistant</Th>
                          <Th>Error</Th>
                          <Th numeric>Calls</Th>
                          <Th>Last</Th>
                        </Tr>
                      </thead>
                      <tbody>
                        {p.failures.map((f) => (
                          <Tr key={`${f.agent}-${f.error}`}>
                            <Td>{f.name}</Td>
                            <Td className="font-mono text-xs">{f.error}</Td>
                            <Td numeric>{count(f.count)}</Td>
                            <Td className="whitespace-nowrap text-xs">{dateTime(f.lastAt)}</Td>
                          </Tr>
                        ))}
                      </tbody>
                    </Table>
                  ) : (
                    <EmptyState title="No failed calls">Every AI call in the period got an answer.</EmptyState>
                  )}
                </Card>
                <Card role="region" aria-label="Slowest calls">
                  <CardHeader title="Slowest calls" description="The five calls that took longest in the period." />
                  <Table aria-label="Slowest AI calls">
                    <thead>
                      <Tr>
                        <Th>Assistant</Th>
                        <Th>When</Th>
                        <Th numeric>Took</Th>
                        <Th>Outcome</Th>
                      </Tr>
                    </thead>
                    <tbody>
                      {p.slowest.map((s) => (
                        <Tr key={`${s.startedAt}-${s.agent}-${s.durationMs}`}>
                          <Td>{s.name}</Td>
                          <Td className="whitespace-nowrap text-xs">{dateTime(s.startedAt)}</Td>
                          <Td numeric>{duration(s.durationMs)}</Td>
                          <Td>{s.outcome === 'FAILED' ? <Badge tone="negative">Failed</Badge> : <Badge tone="positive">Answered</Badge>}</Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                </Card>
              </div>
            </>
          ) : (
            <Card>
              <EmptyState title="No AI calls in this period">
                Figures appear here once someone uses the copilot, bank suggestions, payment reminders, the month-end review or another AI assistant.
              </EmptyState>
            </Card>
          )}
        </>
      ) : null}
    </>
  );
}
