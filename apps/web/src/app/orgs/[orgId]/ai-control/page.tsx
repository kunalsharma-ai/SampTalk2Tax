'use client';
import { IntegrationsLink } from '@/components/integrations-link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Stat, Table, Td, Textarea, Th, Tr, cn } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { monthName, tokens, usd, type AiAgentView, type AiControlView, type CopilotToolView } from '@/lib/ai-control';
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
      {v?.platformShutdown ? (
        <div className="mb-4">
          <Alert tone="negative" title="AI is stopped across Talk2Tax">
            The people who run Talk2Tax stopped AI for every organisation on {dateTime(v.platformShutdown.since)}: {v.platformShutdown.reason}. No agent sends anything to the AI model until they turn it back on.
          </Alert>
        </div>
      ) : null}
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
                <Alert tone="warning" title="AI is not set up yet">
                  An owner or admin can add a Claude API key in <IntegrationsLink />. Until then nothing is sent to an AI provider and every agent stays idle.
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

          <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-6">
            <Stat label="AI calls" value={v.totals.calls} tone="accent" sub={monthName(v.month)} />
            <Stat label="Tokens used" value={tokens(v.totals.tokens)} sub="In and out, this month" />
            <Stat label="Cost this month" value={usd(v.totals.cost)} sub={v.totals.unpricedTokens ? `${tokens(v.totals.unpricedTokens)} tokens not priced` : 'At your model prices'} tone={v.totals.unpricedTokens ? 'warning' : 'neutral'} />
            <Stat label="Failed" value={v.totals.failed} tone={v.totals.failed ? 'warning' : 'neutral'} sub="This month" />
            <Stat label="Running now" value={v.totals.running} />
            <Stat label="Waiting for a person" value={v.totals.waiting} tone={v.totals.waiting ? 'warning' : 'neutral'} sub={`Proposals, last ${v.accuracyDays} days`} />
          </div>

          <ul className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {v.agents.map((a) => (
              <AgentCard key={a.key} a={a} v={v} base={base} orgId={orgId} onDone={set} />
            ))}
          </ul>

          <ModelAccess v={v} base={base} orgId={orgId} onDone={set} />

          <ModelPrices v={v} base={base} onDone={set} />

          <CopilotTools orgId={orgId} canManage={v.canManage} />

          <AiDataSafety orgId={orgId} canManage={v.canManage} />

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
  const [hourly, setHourly] = useState(a.hourlyTaskLimit ? String(a.hourlyTaskLimit) : '');
  const save = useMutation({
    mutationFn: (body: { enabled: boolean; monthlyTokenLimit: number | null; hourlyTaskLimit?: number | null }) => api<AiControlView>(`${base}/agents/${a.key}`, { method: 'PUT', body }),
    onSuccess: (r) => { setEditing(false); onDone(r); },
  });
  const parsed = limit.trim() === '' ? null : Number(limit.replace(/,/g, ''));
  const limitOk = parsed === null || (Number.isInteger(parsed) && parsed >= 1000 && parsed <= 1_000_000_000);
  const parsedHourly = hourly.trim() === '' ? null : Number(hourly.replace(/,/g, ''));
  const hourlyOk = parsedHourly === null || (Number.isInteger(parsedHourly) && parsedHourly >= 1 && parsedHourly <= 100_000);
  const t = a.tasksPerHour;
  const state = !a.enabled ? { tone: 'neutral' as const, label: 'Off' } : !v.enabled ? { tone: 'warning' as const, label: v.stopped ? 'Paused by the stop' : 'Paused: AI is off' } : a.budgetReached ? { tone: 'negative' as const, label: 'Budget reached' } : t.reached ? { tone: 'warning' as const, label: 'Hourly limit reached' } : a.running ? { tone: 'accent' as const, label: 'Working' } : { tone: 'positive' as const, label: 'On' };
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

        <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-5">
          <div>
            <dt className="text-xs text-fg-muted">Calls this month</dt>
            <dd className="font-semibold tabular-nums">{a.usage.calls}{a.usage.failed ? <span className="ml-1 text-xs font-normal text-warning">({a.usage.failed} failed)</span> : null}</dd>
          </div>
          <div>
            <dt className="text-xs text-fg-muted">Tokens this month</dt>
            <dd className="font-semibold tabular-nums">{tokens(a.usage.tokens)}</dd>
          </div>
          <div>
            <dt className="text-xs text-fg-muted">Cost this month</dt>
            <dd className="font-semibold tabular-nums">
              {usd(a.cost.amount)}
              {a.cost.unpricedTokens ? <span className="block text-xs font-normal text-warning">{tokens(a.cost.unpricedTokens)} tokens not priced</span> : null}
            </dd>
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

        <p className="text-xs text-fg-muted" aria-label={`${a.name} tasks per hour`}>
          Tasks started in the last hour: <span className="font-semibold tabular-nums">{t.started}</span>
          {t.limit ? ` of ${t.limit.toLocaleString('en-IN')} allowed${t.own ? '' : " (this server's default)"}` : ' (no hourly limit)'}
          {t.reached ? <span className="ml-1 text-warning">New work waits until older tasks are more than an hour old.</span> : null}
        </p>
        {a.changedBy ? <p className="text-xs text-fg-faint">Changed by {a.changedBy} on {dateTime(a.changedAt!)}</p> : null}
        <ErrorAlert title="Not saved" error={save.error} />
        {v.canManage ? (
          editing ? (
            <div className="flex flex-col gap-2 border-t border-line pt-3">
              <Field label="Monthly token budget" hint="Input and output tokens per calendar month, India time. Leave empty for no budget." error={limitOk ? undefined : 'Use a whole number from 1,000 to 1,000,000,000'}>
                {(p) => <Input {...p} inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="No budget" className="w-56" />}
              </Field>
              <Field label="AI tasks per hour" hint={`Most the agent may start in any 60 minutes. Leave empty for this server's default${t.own || !t.limit ? '' : ` (${t.limit.toLocaleString('en-IN')})`}.`} error={hourlyOk ? undefined : 'Use a whole number from 1 to 100,000'}>
                {(p) => <Input {...p} inputMode="numeric" value={hourly} onChange={(e) => setHourly(e.target.value)} placeholder="Server default" className="w-56" />}
              </Field>
              <div className="flex gap-2">
                <Button size="sm" disabled={!limitOk || !hourlyOk} loading={save.isPending} onClick={() => save.mutate({ enabled: a.enabled, monthlyTokenLimit: parsed, hourlyTaskLimit: parsedHourly })}>Save limits</Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <div className="mt-auto flex gap-2 border-t border-line pt-3">
              <Button size="sm" variant={a.enabled ? 'secondary' : 'primary'} loading={save.isPending} onClick={() => save.mutate({ enabled: !a.enabled, monthlyTokenLimit: a.monthlyTokenLimit })}>
                {a.enabled ? `Turn off ${a.name.toLowerCase()}` : `Turn on ${a.name.toLowerCase()}`}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => { setLimit(a.monthlyTokenLimit ? String(a.monthlyTokenLimit) : ''); setHourly(a.hourlyTaskLimit ? String(a.hourlyTaskLimit) : ''); setEditing(true); }}>Set limits…</Button>
            </div>
          )
        ) : null}
      </Card>
    </li>
  );
}

/** What each model costs per million tokens, and what this month's tokens of it cost. */
function ModelPrices({ v, base, onDone }: { v: AiControlView; base: string; onDone: (v: AiControlView) => void }) {
  const [model, setModel] = useState('');
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const save = useMutation({
    mutationFn: () => api<AiControlView>(`${base}/prices`, { method: 'PUT', body: { model: model.trim(), inputPerMillion: input.trim(), outputPerMillion: output.trim() } }),
    onSuccess: (r) => {
      setModel('');
      setInput('');
      setOutput('');
      onDone(r);
    },
  });
  const unset = useMutation({ mutationFn: (m: string) => api<AiControlView>(`${base}/prices/remove`, { method: 'POST', body: { model: m } }), onSuccess: onDone });
  const usage = new Map<string, { tokens: number; cost: string | null }>();
  for (const a of v.agents) {
    for (const m of a.cost.models) {
      const u = usage.get(m.model) ?? { tokens: 0, cost: null };
      u.tokens += m.inputTokens + m.outputTokens;
      if (m.cost !== null) u.cost = addAmounts(u.cost ?? '0.0000', m.cost);
      usage.set(m.model, u);
    }
  }
  const names = [...new Set([...v.prices.map((p) => p.model), ...v.modelsUsed])].sort();
  const ok = /^\d{1,6}(\.\d{1,4})?$/;
  const valid = model.trim() !== '' && ok.test(input.trim()) && ok.test(output.trim());
  const edit = (m: string) => {
    const p = v.prices.find((x) => x.model === m);
    setModel(m);
    setInput(p ? p.inputPerMillion.replace(/\.?0+$/, '') : '');
    setOutput(p ? p.outputPerMillion.replace(/\.?0+$/, '') : '');
  };
  return (
    <Card className="mt-4" role="region" aria-label="Model prices">
      <CardHeader title="Model prices" description="What your AI provider charges per million input and output tokens for each model, in US dollars. Costs on this page are this month's tokens at these prices; a model without a price is counted in tokens only." />
      {names.length ? (
        <div className="overflow-x-auto">
          <Table aria-label="Prices by model">
            <thead>
              <tr>
                <Th>Model</Th>
                <Th className="text-right">Input, per million</Th>
                <Th className="text-right">Output, per million</Th>
                <Th className="text-right">Tokens this month</Th>
                <Th className="text-right">Cost this month</Th>
                <Th>Price set by</Th>
                {v.canManage ? <Th><span className="sr-only">Actions</span></Th> : null}
              </tr>
            </thead>
            <tbody>
              {names.map((m) => {
                const p = v.prices.find((x) => x.model === m);
                const u = usage.get(m);
                return (
                  <Tr key={m}>
                    <Td className="whitespace-nowrap font-mono text-xs">{m}</Td>
                    <Td className="text-right tabular-nums">{p ? usd(p.inputPerMillion) : '—'}</Td>
                    <Td className="text-right tabular-nums">{p ? usd(p.outputPerMillion) : '—'}</Td>
                    <Td className="text-right tabular-nums">{tokens(u?.tokens ?? 0)}</Td>
                    <Td className="text-right tabular-nums">{p ? usd(u?.cost ?? '0.0000') : <span className="text-warning">No price set</span>}</Td>
                    <Td className="text-xs text-fg-muted">{p ? `${p.changedBy}, ${dateTime(p.changedAt)}` : '—'}</Td>
                    {v.canManage ? (
                      <Td className="whitespace-nowrap text-right">
                        <Button size="sm" variant="ghost" onClick={() => edit(m)} aria-label={`${p ? 'Change' : 'Set'} the price of ${m}`}>{p ? 'Change' : 'Set price'}</Button>
                        {p ? <Button size="sm" variant="ghost" loading={unset.isPending && unset.variables === m} onClick={() => unset.mutate(m)} aria-label={`Remove the price of ${m}`}>Remove</Button> : null}
                      </Td>
                    ) : null}
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        </div>
      ) : (
        <p className="px-5 py-4 text-sm text-fg-muted">No model has been used this month and no prices are set.</p>
      )}
      {v.canManage ? (
        <form className="flex flex-wrap items-end gap-3 border-t border-line px-5 py-4" onSubmit={(e) => { e.preventDefault(); if (valid) save.mutate(); }}>
          <Field label="Model" hint="As the provider names it">{(f) => <Input {...f} value={model} maxLength={100} onChange={(e) => setModel(e.target.value)} className="w-64" />}</Field>
          <Field label="Input, US$ per million tokens">{(f) => <Input {...f} inputMode="decimal" value={input} onChange={(e) => setInput(e.target.value)} className="w-40" />}</Field>
          <Field label="Output, US$ per million tokens">{(f) => <Input {...f} inputMode="decimal" value={output} onChange={(e) => setOutput(e.target.value)} className="w-40" />}</Field>
          <Button type="submit" size="sm" loading={save.isPending} disabled={!valid}>Save price</Button>
          <ErrorAlert title="Price not saved" error={save.error ?? unset.error} />
        </form>
      ) : null}
    </Card>
  );
}

/** Adds two 4-place decimal strings exactly (as ten-thousandths). */
function addAmounts(a: string, b: string): string {
  const units = (x: string) => {
    const [w, f = ''] = x.split('.');
    return BigInt(w) * 10000n + BigInt(f.padEnd(4, '0').slice(0, 4));
  };
  const t = units(a) + units(b);
  return `${t / 10000n}.${String(t % 10000n).padStart(4, '0')}`;
}

/** Copilot tool permissions (SEC-030): tools turned off are never offered to the model or run. */
function CopilotTools({ orgId, canManage }: { orgId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['copilot-status', orgId], queryFn: () => api<{ toolCatalog: CopilotToolView[]; disabledTools: string[] }>(`/v1/orgs/${orgId}/copilot/status`) });
  const save = useMutation({
    mutationFn: (disabled: string[]) => api<{ toolCatalog: CopilotToolView[]; disabledTools: string[] }>(`/v1/orgs/${orgId}/copilot/tools`, { method: 'PUT', body: { disabled } }),
    onSuccess: (s) => qc.setQueryData(['copilot-status', orgId], s),
  });
  const tools = status.data?.toolCatalog ?? [];
  const off = status.data?.disabledTools ?? [];
  return (
    <Card className="mt-4 p-4">
      <CardHeader title="Copilot tools" description="What the finance copilot may look at or propose. A tool turned off is never offered to the AI model, and is refused if the model asks for it anyway. Each member also needs the tool's own permission." />
      <ErrorAlert title="Could not load the copilot tools" error={status.error} />
      <ErrorAlert title="The tools were not changed" error={save.error} />
      {tools.length ? (
        <Table aria-label="Copilot tools">
          <thead><tr><Th>Tool</Th><Th>Needs</Th><Th>For you</Th><Th>Allowed</Th></tr></thead>
          <tbody>
            {tools.map((t) => (
              <Tr key={t.name}>
                <Td>{t.title}<span className="block text-xs text-fg-faint">{t.name}</span></Td>
                <Td className="text-xs">{t.permission}</Td>
                <Td>{t.youCanUse ? <Badge tone="positive">Your role allows it</Badge> : <Badge tone="neutral">Not your role</Badge>}</Td>
                <Td>
                  <label className="inline-flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      aria-label={`Allow ${t.title}`}
                      checked={t.enabled}
                      disabled={!canManage || save.isPending}
                      onChange={(e) => save.mutate(e.target.checked ? off.filter((x) => x !== t.name) : [...off, t.name])}
                    />
                    {t.enabled ? 'On' : 'Off'}
                  </label>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </Card>
  );
}

type Redaction = { panNumbers: boolean; bankAccounts: boolean; emails: boolean; phones: boolean };
const REDACTION_CHOICES: { key: keyof Redaction; label: string; example: string }[] = [
  { key: 'bankAccounts', label: 'Bank account numbers', example: 'Sent as [account ending 7890]' },
  { key: 'panNumbers', label: 'PAN numbers', example: 'Sent as [PAN removed]' },
  { key: 'emails', label: 'Email addresses', example: 'Sent as [email removed]' },
  { key: 'phones', label: 'Phone numbers', example: 'Sent as [phone removed]' },
];

/** What is hidden from the AI model (SEC-031), and how text that tries to instruct it is handled (SEC-029). */
function AiDataSafety({ orgId, canManage }: { orgId: string; canManage: boolean }) {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['copilot-status', orgId], queryFn: () => api<{ redaction: Redaction }>(`/v1/orgs/${orgId}/copilot/status`) });
  const save = useMutation({
    mutationFn: (r: Redaction) => api<{ redaction: Redaction }>(`/v1/orgs/${orgId}/copilot/redaction`, { method: 'PUT', body: r }),
    onSuccess: (s) => qc.setQueryData(['copilot-status', orgId], s),
  });
  const r = status.data?.redaction;
  return (
    <Card className="mt-4 p-4" role="region" aria-label="Data sent to the AI">
      <CardHeader title="Data sent to the AI" description="What the copilot leaves out of questions and data before they go to the AI model. Members still see the real values in Talk2Tax; only the model gets a placeholder." />
      <ErrorAlert title="Could not load what is sent to the AI" error={status.error} />
      <ErrorAlert title="The setting was not changed" error={save.error} />
      <p className="mt-2 text-sm">Always hidden: card numbers, Aadhaar numbers, and secrets such as API keys.</p>
      {r ? (
        <ul className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
          {REDACTION_CHOICES.map((c) => (
            <li key={c.key}>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" aria-label={`Hide ${c.label.toLowerCase()}`} checked={r[c.key]} disabled={!canManage || save.isPending} onChange={(e) => save.mutate({ ...r, [c.key]: e.target.checked })} />
                <span>
                  Hide {c.label.toLowerCase()}
                  <span className="block text-xs text-fg-faint">{c.example}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-3 text-xs text-fg-muted">
        Text in your books that reads like instructions to an AI (for example a memo saying &ldquo;ignore your instructions&rdquo;) is passed to the model marked as data to ignore. The answer shows a warning, and the copilot cannot propose anything in that answer. Changes here are recorded in the audit trail.
      </p>
    </Card>
  );
}

/** Which AI models this organisation allows (SEC-034), within what Talk2Tax allows. */
function ModelAccess({ v, base, orgId, onDone }: { v: AiControlView; base: string; orgId: string; onDone: (v: AiControlView) => void }) {
  const a = v.modelAccess;
  const save = useMutation({ mutationFn: (allowed: string[]) => api<AiControlView>(`${base}/models`, { method: 'PUT', body: { allowed } }), onSuccess: onDone });
  const all = a.organisation.length === 0;
  const toggle = (id: string, on: boolean) => {
    // Unticking from "every model" starts a list of the others the platform allows.
    const current = all ? a.models.filter((m) => m.platformAllowed).map((m) => m.id) : a.organisation;
    const next = on ? [...current, id] : current.filter((x) => x !== id);
    if (!next.length) return;
    save.mutate(next.length === a.models.filter((m) => m.platformAllowed).length ? [] : next);
  };
  return (
    <Card className="mt-4 p-4" role="region" aria-label="Model access">
      <CardHeader title="Model access" description="Which AI models your AI features may use. A model that is not allowed is never called: agents stop with a clear message until an allowed model is chosen in Settings → Integrations." />
      <ErrorAlert title="The allowed models were not changed" error={save.error} />
      {!a.inUseAllowed ? (
        <div className="mt-2">
          <Alert tone="warning" title="The model in use is not allowed">
            {a.inUse} is not allowed, so AI features do not run. Choose an allowed model in <Link className="text-accent hover:underline" href={`/orgs/${orgId}/settings/integrations`}>Settings → Integrations</Link>{a.models.find((m) => m.id === a.inUse)?.platformAllowed !== false ? ', or allow it here' : ''}.
          </Alert>
        </div>
      ) : null}
      <p className="mt-2 text-sm">{all ? 'Every model Talk2Tax allows can be used.' : `Only the ticked models can be used.`} In use now: <span className="font-medium">{a.inUse}</span>.</p>
      <ul className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-3">
        {a.models.map((m) => (
          <li key={m.id}>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" aria-label={`Allow ${m.id}`} checked={m.allowed} disabled={!v.canManage || !m.platformAllowed || save.isPending} onChange={(e) => toggle(m.id, e.target.checked)} />
              <span>
                {m.name}
                <span className="block text-xs text-fg-faint">{m.platformAllowed ? m.id : `${m.id} · not allowed on Talk2Tax by the people who run it`}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {v.canManage && !all ? (
        <Button className="mt-3" size="sm" variant="secondary" loading={save.isPending} onClick={() => save.mutate([])}>
          Allow every model
        </Button>
      ) : null}
    </Card>
  );
}
