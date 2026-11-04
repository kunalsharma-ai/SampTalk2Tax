'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Select, Stat, Textarea } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { OptionGroups, Targets } from '@/components/recovery/option-card';
import { PageHeader } from '@/components/shell';
import { TwinCashChart } from '@/components/twin/twin-chart';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/org';
import { ACTION_STATUS, CATEGORY, PLAN_STATUS, runwayText, type ActionStatus, type RecoveryAction, type RecoveryPlanDetail } from '@/lib/recovery';
import type { TwinMonth } from '@/lib/twin';
import { can } from '@/lib/types';

/**
 * A recovery plan: the chosen actions with owners, due dates and progress, the liquidity forecast
 * of the actions together against no action, and the options not yet in the plan.
 */
export default function RecoveryPlanPage() {
  const { org, orgId } = useOrg();
  const { planId } = useParams<{ planId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const key = ['recovery-plan', orgId, planId];
  const base = `/v1/orgs/${orgId}/recovery/plans/${planId}`;
  const q = useQuery({ queryKey: key, queryFn: () => api<RecoveryPlanDetail>(base) });
  const members = useQuery({ queryKey: ['members', orgId], queryFn: () => api<{ userId: string; name: string }[]>(`/v1/orgs/${orgId}/members`) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ['recovery-plans', orgId] });
  };
  const add = useMutation({ mutationFn: (optionKey: string) => api(`${base}/actions`, { method: 'POST', body: { optionKey } }), onSuccess: refresh });
  const setStatus = useMutation({ mutationFn: (status: 'DRAFT' | 'ACTIVE' | 'CLOSED') => api(base, { method: 'PUT', body: { status } }), onSuccess: refresh });
  const del = useMutation({ mutationFn: () => api(base, { method: 'DELETE' }), onSuccess: () => router.push(`/orgs/${orgId}/planning/recovery`) });
  const toScenario = useMutation({ mutationFn: () => api<{ scenarioId: string }>(`${base}/scenario`, { method: 'POST' }), onSuccess: (s) => router.push(`/orgs/${orgId}/planning/twin/${s.scenarioId}`) });
  if (!org) return null;
  const manage = can(org.role, 'scenarios.manage');
  const d = q.data;
  const p = d?.plan;
  const editable = manage && p?.status !== 'CLOSED';
  const c = d?.currency ?? 'INR';
  const f = d?.forecast;
  return (
    <>
      <PageHeader
        title={p?.name ?? 'Recovery plan'}
        description={p?.description ?? 'Chosen recovery actions, who owns them, and what they do to cash together.'}
        actions={
          <>
            {manage && p?.status === 'DRAFT' ? <Button variant="ghost" onClick={() => confirm(`Delete the plan "${p.name}"?`) && del.mutate()}>Delete</Button> : null}
            {p && p.status !== 'DRAFT' && can(org.role, 'decisions.manage') ? <Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/decisions/new?sourceType=RECOVERY_PLAN&sourceId=${p.id}`}>Record as a decision</Link> : null}
            <Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/planning/recovery`}>Recovery planner</Link>
          </>
        }
      />
      <ErrorAlert title="Could not load the plan" error={q.error ?? setStatus.error ?? del.error ?? toScenario.error ?? add.error} />
      {d && p && f ? (
        <div className="space-y-4">
          <Card className="p-4" aria-label="Plan status">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Badge tone={PLAN_STATUS[p.status].tone}>{PLAN_STATUS[p.status].label}</Badge>
                <span className="text-sm text-fg-muted">Baseline: last {p.baselineMonths} months · {p.horizonMonths}-month horizon · re-measured against today's books each time it is opened</span>
              </div>
              {manage ? (
                <div className="flex flex-wrap gap-2">
                  {p.status === 'DRAFT' ? <Button onClick={() => setStatus.mutate('ACTIVE')}>Start the plan</Button> : null}
                  {p.status === 'ACTIVE' ? <Button variant="secondary" onClick={() => setStatus.mutate('CLOSED')}>Close the plan</Button> : null}
                  {p.status === 'CLOSED' ? <Button variant="secondary" onClick={() => setStatus.mutate('ACTIVE')}>Reopen</Button> : null}
                  <Button variant="secondary" disabled={!d.actions.some((a) => a.status !== 'DROPPED')} loading={toScenario.isPending} onClick={() => toScenario.mutate()}>Open as a twin scenario</Button>
                </div>
              ) : null}
            </div>
          </Card>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Runway, no action" value={<span className="text-lg">{runwayText(f.noAction.runwayMonths, p.horizonMonths)}</span>} tone={f.noAction.runwayMonths === null ? 'positive' : 'negative'} />
            <Stat label="Runway, with this plan" value={<span className="text-lg">{runwayText(f.withPlan.runwayMonths, p.horizonMonths)}</span>} tone={f.withPlan.runwayMonths === null ? 'positive' : 'negative'} />
            <Stat label="Lowest cash, with this plan" value={<Money value={f.withPlan.minimumCash.amount} currency={c} signed className="text-lg" />} sub={<>vs <Money value={f.noAction.minimumCash.amount} currency={c} signed /> with no action</>} tone={f.withPlan.cashNegativeFrom ? 'negative' : 'positive'} />
            <Stat label="Still to raise" value={<Money value={f.withPlan.cashRequired} currency={c} className="text-lg" />} sub={f.gapClosed ? 'The plan closes the gap' : `Was ${Number(f.noAction.cashRequired).toLocaleString('en-IN')} with no action`} tone={f.gapClosed ? 'positive' : 'warning'} />
          </div>

          <Card className="p-4">
            <CardHeader title="Liquidity forecast (hypothetical)" description="Month-end cash with no action and with every action in the plan that is not dropped, from today's books." />
            <TwinCashChart
              actual={[]}
              series={[
                { name: 'No action', months: f.noAction.cash as unknown as TwinMonth[] },
                { name: 'With this plan', months: f.withPlan.cash as unknown as TwinMonth[] },
              ]}
              currency={c}
              label="Month-end cash with no action and with the plan. The key figures are above."
            />
            {f.risks.length ? (
              <ul className="mt-3 space-y-1 text-sm" aria-label="Risks with this plan">
                {f.risks.map((r) => (
                  <li key={r.code} className="flex gap-2">
                    <Badge tone={r.level === 'HIGH' ? 'negative' : r.level === 'MEDIUM' ? 'warning' : 'neutral'}>{r.level === 'HIGH' ? 'High' : r.level === 'MEDIUM' ? 'Medium' : 'Low'}</Badge>
                    <span>{r.message}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Card className="p-4">
              <CardHeader title={`Actions (${d.actions.length})`} description="Who does what, by when. Marking an action done records progress only; the work itself happens outside Talk2Tax." />
              {!d.actions.length ? <p className="text-sm text-fg-muted">No actions yet. Add options from the list.</p> : null}
              <ol className="space-y-3" aria-label="Plan actions">
                {d.actions.map((a) => (
                  <ActionRow key={a.id} a={a} base={base} currency={c} editable={editable} stale={d.stale.includes(a.id)} members={members.data ?? []} onDone={refresh} />
                ))}
              </ol>
            </Card>
            <Card className="p-4">
              <CardHeader title="Options not in the plan" description="Each measured on its own against no action." />
              {d.options.length ? (
                <OptionGroups
                  options={d.options}
                  currency={c}
                  action={(o) => (editable ? <Button size="sm" variant="secondary" className="whitespace-nowrap" loading={add.isPending && add.variables === o.key} onClick={() => add.mutate(o.key)}>Add to plan</Button> : null)}
                />
              ) : <p className="text-sm text-fg-muted">Every option is in the plan.</p>}
            </Card>
          </div>
          <Alert tone="violet" title="Nothing happens automatically">The plan never contacts anyone, borrows, pays, or changes costs or payroll. People carry out each action.</Alert>
        </div>
      ) : null}
    </>
  );
}

function ActionRow({ a, base, currency, editable, stale, members, onDone }: { a: RecoveryAction; base: string; currency: string; editable: boolean; stale: boolean; members: { userId: string; name: string }[]; onDone: () => void }) {
  const [note, setNote] = useState(a.note ?? '');
  const save = useMutation({ mutationFn: (body: Record<string, unknown>) => api(`${base}/actions/${a.id}`, { method: 'PUT', body }), onSuccess: onDone });
  const remove = useMutation({ mutationFn: () => api(`${base}/actions/${a.id}`, { method: 'DELETE' }), onSuccess: onDone });
  return (
    <li className={`rounded-md border border-line p-3 ${a.status === 'DROPPED' ? 'opacity-60' : ''}`} aria-label={a.title}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-fg">{a.title}</span>
        <Badge>{CATEGORY[a.category].label}</Badge>
        {a.needsDecision ? <Badge tone="warning">Needs a decision</Badge> : null}
        {stale ? <Badge tone="neutral">No longer suggested by the books</Badge> : null}
      </div>
      <p className="mt-1 text-xs text-fg-muted">{a.detail}</p>
      <Targets targets={a.targets} currency={currency} />
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Field label="Status">
          {(p) => (
            <Select {...p} value={a.status} disabled={!editable} onChange={(e) => save.mutate({ status: e.target.value as ActionStatus })}>
              {Object.entries(ACTION_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Owner">
          {(p) => (
            <Select {...p} value={a.ownerId ?? ''} disabled={!editable} onChange={(e) => save.mutate({ ownerId: e.target.value || null })}>
              <option value="">Nobody yet</option>
              {members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Due">{(p) => <Input {...p} type="date" value={a.dueDate ?? ''} disabled={!editable} onChange={(e) => save.mutate({ dueDate: e.target.value || null })} />}</Field>
      </div>
      <div className="mt-2 flex items-end gap-2">
        <div className="flex-1">
          <Field label="Note">{(p) => <Textarea {...p} rows={1} value={note} maxLength={2000} disabled={!editable} onChange={(e) => setNote(e.target.value)} />}</Field>
        </div>
        {editable ? (
          <>
            <Button size="sm" variant="ghost" disabled={note === (a.note ?? '')} onClick={() => save.mutate({ note: note || null })}>Save note</Button>
            <Button size="sm" variant="ghost" aria-label={`Remove ${a.title}`} onClick={() => confirm(`Remove "${a.title}" from the plan?`) && remove.mutate()}>Remove</Button>
          </>
        ) : null}
      </div>
      {a.risks.length ? <p className="mt-2 text-xs text-fg-muted">Risks: {a.risks.join(' ')}</p> : null}
      {save.error || remove.error ? <ErrorAlert title="Not saved" error={save.error ?? remove.error} /> : null}
    </li>
  );
}

