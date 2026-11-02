'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Stat, Textarea, cn } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { monthName, tokens, type AiAgentView, type AiControlView } from '@/lib/ai-control';
import { dateTime } from '@/lib/collections';
import { useOrg } from '@/lib/org';

export default function AiControlPage() {
  const { org, orgId } = useOrg();
  const qc = useQueryClient();
  const base = `/v1/orgs/${orgId}/ai-control`;
  const key = ['ai-control', orgId];
  const q = useQuery({ queryKey: key, queryFn: () => api<AiControlView>(base), refetchInterval: (s) => (s.state.data?.totals.running ? 2000 : false) });
  const set = (v: AiControlView) => {
    qc.setQueryData(key, v);
    void qc.invalidateQueries({ queryKey: ['copilot-status', orgId] });
  };
  const [stopping, setStopping] = useState(false);
  const [reason, setReason] = useState('');
  const stop = useMutation({ mutationFn: () => api<AiControlView>(`${base}/stop`, { method: 'POST', body: { reason: reason.trim() } }), onSuccess: (v) => { setStopping(false); setReason(''); set(v); } });
  const resume = useMutation({ mutationFn: () => api<AiControlView>(`${base}/resume`, { method: 'POST' }), onSuccess: set });
  if (!org) return null;
  const v = q.data;
  return (
    <>
      <PageHeader
        title="AI control center"
        description="Every AI agent in one place: what each may do on its own, whether it is on, how many tokens it has used this month against its budget, and how often people accept what it proposes. No agent changes the books or sends anything without a person's approval."
      />
      <ErrorAlert title="Could not load the AI control center" error={q.error} />
      {v ? (
        <>
          <Card className={cn('mb-4 p-4', v.stopped && 'border-negative/50')} aria-label="AI for this organisation">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-semibold">AI for {org.name}</h2>
                  <Badge tone={v.stopped ? 'negative' : v.enabled ? 'positive' : 'neutral'}>{v.stopped ? 'Stopped' : v.enabled ? 'On' : 'Off'}</Badge>
                </div>
                <p className="mt-1 text-sm text-fg-muted">
                  {v.configured ? `${v.provider} · ${v.model}` : 'Not set up on this server'}
                  {v.changedBy ? ` · last changed by ${v.changedBy} on ${dateTime(v.changedAt!)}` : ''}
                </p>
                {v.stopped ? <p className="mt-2 text-sm">Stopped: {v.offReason}</p> : null}
              </div>
              {v.canManage ? (
                <div className="flex shrink-0 gap-2">
                  {v.enabled ? (
                    !stopping ? <Button variant="danger" onClick={() => setStopping(true)}>Emergency stop…</Button> : null
                  ) : (
                    <Button loading={resume.isPending} onClick={() => resume.mutate()} disabled={!v.configured}>Turn AI back on</Button>
                  )}
                </div>
              ) : null}
            </div>
            {!v.configured ? (
              <div className="mt-3">
                <Alert tone="warning" title="AI is not set up on this server">
                  An administrator needs to set <code className="font-mono">ANTHROPIC_API_KEY</code> for the API and restart it. Until then nothing is sent to an AI provider and every agent stays idle.
                </Alert>
              </div>
            ) : null}
            {stopping ? (
              <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4">
                <p className="text-sm">
                  This turns AI off for the whole organisation now. Nothing more is sent to the AI provider. Work already running stops before its next call, and what it had not reached is marked as not done. What the agents already proposed stays for people to decide.
                </p>
                <Field label="Why stop AI?" hint="At least 10 characters. Shown to everyone who tries to use AI until it is turned back on.">
                  {(p) => <Textarea {...p} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />}
                </Field>
                <ErrorAlert title="AI was not stopped" error={stop.error} />
                <div className="flex gap-2">
                  <Button variant="danger" loading={stop.isPending} disabled={reason.trim().length < 10} onClick={() => stop.mutate()}>Stop all AI now</Button>
                  <Button variant="ghost" onClick={() => setStopping(false)}>Cancel</Button>
                </div>
              </div>
            ) : null}
            <ErrorAlert title="AI was not turned back on" error={resume.error} />
          </Card>

          <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-5">
            <Stat label="AI calls" value={v.totals.calls} tone="accent" sub={monthName(v.month)} />
            <Stat label="Tokens used" value={tokens(v.totals.tokens)} sub="In and out, this month" />
            <Stat label="Failed" value={v.totals.failed} tone={v.totals.failed ? 'warning' : 'neutral'} sub="This month" />
            <Stat label="Running now" value={v.totals.running} />
            <Stat label="Waiting for a person" value={v.totals.waiting} tone={v.totals.waiting ? 'warning' : 'neutral'} sub={`Proposals, last ${v.accuracyDays} days`} />
          </div>

          <ul className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {v.agents.map((a) => (
              <AgentCard key={a.key} a={a} v={v} base={base} orgId={orgId} onDone={set} />
            ))}
          </ul>

          <Card className="mt-4 p-4">
            <CardHeader title="Action levels" description="What an agent may do without a person. Every agent here is at level 2 or below: none posts, pays or sends on its own." />
            <ol className="mt-2 grid grid-cols-1 gap-2 text-sm md:grid-cols-5">
              {v.levels.map((l) => (
                <li key={l.level} className={cn('rounded-md border border-line p-2', l.level > 2 && 'text-fg-faint')}>
                  <span className="font-semibold">Level {l.level}</span>
                  <span className="block">{l.label}</span>
                  {l.level > 2 ? <span className="block text-xs">No agent at this level</span> : null}
                </li>
              ))}
            </ol>
            <p className="mt-3 text-xs text-fg-muted">
              Every call is listed with its model, tokens and outcome in <Link className="text-accent hover:underline" href={`/orgs/${orgId}/ai-activity`}>AI activity</Link>. Turning an agent off, changing a budget and the emergency stop are recorded in the audit trail.
            </p>
          </Card>
        </>
      ) : null}
    </>
  );
}

function AgentCard({ a, v, base, orgId, onDone }: { a: AiAgentView; v: AiControlView; base: string; orgId: string; onDone: (v: AiControlView) => void }) {
  const [editing, setEditing] = useState(false);
  const [limit, setLimit] = useState(a.monthlyTokenLimit ? String(a.monthlyTokenLimit) : '');
  const save = useMutation({
    mutationFn: (body: { enabled: boolean; monthlyTokenLimit: number | null }) => api<AiControlView>(`${base}/agents/${a.key}`, { method: 'PUT', body }),
    onSuccess: (r) => { setEditing(false); onDone(r); },
  });
  const parsed = limit.trim() === '' ? null : Number(limit.replace(/,/g, ''));
  const limitOk = parsed === null || (Number.isInteger(parsed) && parsed >= 1000 && parsed <= 1_000_000_000);
  const state = !a.enabled ? { tone: 'neutral' as const, label: 'Off' } : !v.enabled ? { tone: 'warning' as const, label: v.stopped ? 'Paused by the stop' : 'Paused: AI is off' } : a.budgetReached ? { tone: 'negative' as const, label: 'Budget reached' } : a.running ? { tone: 'accent' as const, label: 'Working' } : { tone: 'positive' as const, label: 'On' };
  const acc = a.accuracy;
  return (
    <li>
      <Card className="flex h-full flex-col gap-3 p-4" aria-label={`${a.name}: ${state.label}`}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-semibold">
                <Link className="hover:underline" href={`/orgs/${orgId}${a.link}`}>{a.name}</Link>
              </h3>
              <Badge tone={state.tone}>{state.label}</Badge>
            </div>
            <p className="mt-1 text-sm text-fg-muted">{a.does}</p>
          </div>
          <Badge tone="violet" className="shrink-0">Level {a.level}: {a.levelLabel}</Badge>
        </div>
        <p className="text-xs text-fg-muted">{a.approval ?? 'Reads reports only; changes nothing.'}</p>

        <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <div>
            <dt className="text-xs text-fg-muted">Calls this month</dt>
            <dd className="font-semibold tabular-nums">{a.usage.calls}{a.usage.failed ? <span className="ml-1 text-xs font-normal text-warning">({a.usage.failed} failed)</span> : null}</dd>
          </div>
          <div>
            <dt className="text-xs text-fg-muted">Tokens this month</dt>
            <dd className="font-semibold tabular-nums">{tokens(a.usage.tokens)}</dd>
          </div>
          <div>
            <dt className="text-xs text-fg-muted">Accepted</dt>
            <dd className="font-semibold tabular-nums">{acc ? (acc.rate === null ? '—' : `${acc.rate}%`) : 'Not applicable'}</dd>
          </div>
          <div>
            <dt className="text-xs text-fg-muted">Last used</dt>
            <dd className="text-xs">{a.lastUsedAt ? dateTime(a.lastUsedAt) : 'Never'}</dd>
          </div>
        </dl>
        {acc ? (
          <p className="text-xs text-fg-muted">
            Last {v.accuracyDays} days: {acc.accepted} accepted{acc.acceptedWithEdits ? ` (${acc.acceptedWithEdits} with edits)` : ''}, {acc.rejected} {a.key === 'BANKING' ? 'dismissed' : 'rejected'}, {acc.waiting} waiting for a person.
          </p>
        ) : null}

        <div>
          <div className="flex items-center justify-between text-xs text-fg-muted">
            <span>Monthly budget</span>
            <span>{a.monthlyTokenLimit ? `${tokens(a.usage.tokens)} of ${tokens(a.monthlyTokenLimit)} tokens (${a.usage.percentOfBudget}%)` : 'No budget'}</span>
          </div>
          {a.monthlyTokenLimit ? (
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface-raised" role="meter" aria-label={`${a.name} budget used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={a.usage.percentOfBudget ?? 0}>
              <div className={cn('h-full rounded-full', a.budgetReached ? 'bg-negative' : (a.usage.percentOfBudget ?? 0) >= 80 ? 'bg-warning' : 'bg-accent')} style={{ width: `${a.usage.percentOfBudget ?? 0}%` }} />
            </div>
          ) : null}
        </div>

        {a.changedBy ? <p className="text-xs text-fg-faint">Changed by {a.changedBy} on {dateTime(a.changedAt!)}</p> : null}
        <ErrorAlert title="Not saved" error={save.error} />
        {v.canManage ? (
          editing ? (
            <div className="flex flex-col gap-2 border-t border-line pt-3">
              <Field label="Monthly token budget" hint="Input and output tokens per calendar month, India time. Leave empty for no budget." error={limitOk ? undefined : 'Use a whole number from 1,000 to 1,000,000,000'}>
                {(p) => <Input {...p} inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="No budget" className="w-56" />}
              </Field>
              <div className="flex gap-2">
                <Button size="sm" disabled={!limitOk} loading={save.isPending} onClick={() => save.mutate({ enabled: a.enabled, monthlyTokenLimit: parsed })}>Save budget</Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <div className="mt-auto flex gap-2 border-t border-line pt-3">
              <Button size="sm" variant={a.enabled ? 'secondary' : 'primary'} loading={save.isPending} onClick={() => save.mutate({ enabled: !a.enabled, monthlyTokenLimit: a.monthlyTokenLimit })}>
                {a.enabled ? `Turn off ${a.name.toLowerCase()}` : `Turn on ${a.name.toLowerCase()}`}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setLimit(a.monthlyTokenLimit ? String(a.monthlyTokenLimit) : ''); setEditing(true); }}>Set budget…</Button>
            </div>
          )
        ) : null}
      </Card>
    </li>
  );
}
