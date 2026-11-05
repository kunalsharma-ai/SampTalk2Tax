'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, CardHeader, Field, Input, Select, Textarea } from '@talk2tax/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { DashboardView } from '@/components/dashboards/dashboard-view';
import { api } from '@/lib/api';
import { COMPARISON_LABELS, SIZE_LABELS, type AiDraft, type AiStatus, type Catalogue, type DashboardConfig, type DashboardDetail, type Preview, type Widget, type WidgetType } from '@/lib/dashboards';

type Turn = { role: 'user' | 'assistant'; text: string };

export const blank = (type: WidgetType): Widget =>
  type === 'STAT'
    ? { type, title: '', size: 'SMALL', metric: 'revenue', compare: 'PREVIOUS_MONTH' }
    : type === 'TOP_CUSTOMERS'
      ? { type, title: 'Largest customers', size: 'MEDIUM', count: 5, months: 12 }
      : { type, title: '', size: type === 'TABLE' ? 'LARGE' : 'MEDIUM', metrics: ['revenue'], months: type === 'TABLE' ? 6 : 12 };

/** Only the fields the widget's kind uses go to the server. */
export const clean = (w: Widget): Widget =>
  w.type === 'STAT'
    ? { type: w.type, title: w.title, size: w.size, metric: w.metric, compare: w.compare }
    : w.type === 'TOP_CUSTOMERS'
      ? { type: w.type, title: w.title, size: w.size, count: w.count, months: w.months }
      : { type: w.type, title: w.title, size: w.size, metrics: w.metrics, months: w.months };

/**
 * Builds a dashboard: describe it and let the AI draft it, or add widgets by hand. Preview works
 * out the figures from the books without saving; the AI never produces a number.
 */
export function DashboardBuilder({ orgId, catalogue, dashboard, ai, canDraft }: { orgId: string; catalogue: Catalogue; dashboard?: DashboardDetail; ai: AiStatus | undefined; canDraft: boolean }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [name, setName] = useState(dashboard?.name ?? '');
  const [description, setDescription] = useState(dashboard?.description ?? '');
  const [widgets, setWidgets] = useState<Widget[]>(dashboard?.config.widgets ?? []);
  const config = (): DashboardConfig => ({ widgets: widgets.map(clean) });
  const setWidget = (i: number, w: Widget) => setWidgets((ws) => ws.map((x, j) => (j === i ? w : x)));
  const move = (i: number, by: number) => setWidgets((ws) => {
    const next = [...ws];
    const [w] = next.splice(i, 1);
    next.splice(i + by, 0, w!);
    return next;
  });

  const preview = useMutation({ mutationFn: () => api<Preview>(`/v1/orgs/${orgId}/dashboards/preview`, { method: 'POST', body: { config: config() } }) });
  const save = useMutation({
    mutationFn: () =>
      dashboard
        ? api<DashboardDetail>(`/v1/orgs/${orgId}/dashboards/${dashboard.id}`, { method: 'PUT', body: { name, description: description || null, config: config(), baseVersion: dashboard.version } })
        : api<DashboardDetail>(`/v1/orgs/${orgId}/dashboards`, { method: 'POST', body: { name, description: description || null, config: config() } }),
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: ['dashboards', orgId] });
      qc.setQueryData(['dashboard', orgId, d.id, null], d);
      router.push(`/orgs/${orgId}/reports/dashboards/${d.id}`);
    },
  });

  const [request, setRequest] = useState('');
  const [conversation, setConversation] = useState<Turn[]>([]);
  const [answer, setAnswer] = useState('');
  const [proposal, setProposal] = useState<AiDraft | null>(null);
  const draft = useMutation({
    mutationFn: (turns: Turn[]) => api<AiDraft>(`/v1/orgs/${orgId}/dashboards/ai-draft`, { method: 'POST', body: { request, conversation: turns } }),
    onSuccess: (p, turns) => {
      setProposal(p);
      setConversation([...turns, { role: 'assistant', text: `${p.description}${p.notes.length ? `\nNotes: ${p.notes.join(' ')}` : ''}${p.questions.length ? `\nQuestions: ${p.questions.join(' ')}` : ''}` }]);
      setAnswer('');
    },
  });
  const useDraft = () => {
    if (!proposal) return;
    setWidgets(proposal.config.widgets);
    if (!name) setName(proposal.name);
    if (!description) setDescription(proposal.description);
    preview.reset();
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {canDraft ? (
        <Card>
          <CardHeader title="Describe it" description="Say what you want to see. The AI chooses widgets from the approved metrics; every figure is worked out from your books, never by the AI. Nothing is saved until you save." />
          <div className="flex flex-col gap-3 p-5" role="region" aria-label="Describe the dashboard">
            <Textarea aria-label="What should the dashboard show?" rows={3} value={request} maxLength={4000} onChange={(e) => setRequest(e.target.value)} placeholder="A monthly view for the board: revenue against last year, margins, cash and runway, and our biggest customers." />
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="secondary" size="sm" disabled={!ai?.available || !request.trim()} loading={draft.isPending && conversation.length === 0} onClick={() => draft.mutate([])}>
                {proposal ? 'Start again' : 'Draft with AI'}
              </Button>
              {ai && !ai.available ? <span className="text-xs text-fg-muted">{ai.reason}</span> : null}
            </div>
            <ErrorAlert title="The AI could not draft the dashboard" error={draft.error} />
            {proposal ? (
              <div className="flex flex-col gap-3" data-testid="ai-proposal">
                <p className="text-sm">
                  <span className="font-medium">{proposal.name}.</span> {proposal.description}
                </p>
                <ol className="list-inside list-decimal text-sm">{proposal.descriptions.map((d) => <li key={d}>{d}</li>)}</ol>
                {proposal.notes.length ? (
                  <Alert tone="neutral" title="Not everything asked for is available">
                    <ul className="list-inside list-disc">{proposal.notes.map((n) => <li key={n}>{n}</li>)}</ul>
                  </Alert>
                ) : null}
                {proposal.issues.length ? (
                  <Alert tone="warning" title="Problems in the draft">
                    <ul className="list-inside list-disc">{proposal.issues.map((i) => <li key={i}>{i}</li>)}</ul>
                  </Alert>
                ) : null}
                {proposal.questions.length ? (
                  <div>
                    <p className="text-sm font-medium">The AI asks</p>
                    <ul className="list-inside list-disc text-sm">{proposal.questions.map((q) => <li key={q}>{q}</li>)}</ul>
                    <div className="mt-2 flex flex-col gap-2 md:flex-row">
                      <Input aria-label="Your answer" value={answer} maxLength={4000} onChange={(e) => setAnswer(e.target.value)} placeholder="Answer, then ask the AI to revise the draft" />
                      <Button type="button" variant="secondary" size="sm" disabled={!answer.trim()} loading={draft.isPending && conversation.length > 0} onClick={() => draft.mutate([...conversation, { role: 'user', text: answer.trim() }])}>
                        Revise the draft
                      </Button>
                    </div>
                  </div>
                ) : null}
                {proposal.data && !proposal.issues.length ? <DashboardView config={proposal.config} data={proposal.data} /> : null}
                <div>
                  <Button type="button" size="sm" onClick={useDraft}>
                    Use this draft
                  </Button>
                  <span className="ml-2 text-xs text-fg-muted">Replaces the widgets below.</span>
                </div>
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="Name" />
        <div className="grid gap-4 p-5 md:grid-cols-2">
          <Field label="Dashboard name">{(p) => <Input {...p} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Monthly board view" />}</Field>
          <Field label="What it is for (optional)">{(p) => <Input {...p} value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} />}</Field>
        </div>
      </Card>

      <Card>
        <CardHeader title="Widgets" description={`Up to ${catalogue.limits.widgets}, shown in this order. Charts show metrics measured the same way.`} />
        <div className="flex flex-col gap-3 p-5">
          {widgets.map((w, i) => (
            <WidgetRow key={i} index={i} w={w} catalogue={catalogue} count={widgets.length} onChange={(x) => setWidget(i, x)} onMove={(by) => move(i, by)} onRemove={() => setWidgets((ws) => ws.filter((_, j) => j !== i))} />
          ))}
          <div className="flex flex-wrap gap-2">
            {catalogue.widgetTypes.map((t) => (
              <Button key={t.type} type="button" variant="secondary" size="sm" disabled={widgets.length >= catalogue.limits.widgets} onClick={() => setWidgets((ws) => [...ws, blank(t.type)])}>
                Add {t.label.toLowerCase()}
              </Button>
            ))}
          </div>
        </div>
      </Card>

      <ErrorAlert title="Could not preview the dashboard" error={preview.error} />
      {preview.data ? (
        <section aria-label="Preview" className="flex flex-col gap-2">
          <p className="text-sm text-fg-muted">Preview with the figures for the last complete month.</p>
          <DashboardView config={preview.data.config} data={preview.data} />
        </section>
      ) : null}
      <ErrorAlert title="The dashboard was not saved" error={save.error} />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="secondary" loading={preview.isPending} disabled={!widgets.length} onClick={() => preview.mutate()}>
          Preview
        </Button>
        <Button type="submit" loading={save.isPending}>
          {dashboard ? 'Save changes' : 'Save dashboard'}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.push(dashboard ? `/orgs/${orgId}/reports/dashboards/${dashboard.id}` : `/orgs/${orgId}/reports/dashboards`)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function WidgetRow({ index, w, catalogue, count, onChange, onMove, onRemove, name }: { index: number; w: Widget; catalogue: Catalogue; count: number; onChange: (w: Widget) => void; onMove: (by: number) => void; onRemove: () => void; name?: string }) {
  const n = name ?? `Widget ${index + 1}`;
  const label = catalogue.widgetTypes.find((t) => t.type === w.type)?.label ?? w.type;
  const metricOptions = catalogue.metrics.map((m) => <option key={m.key} value={m.key}>{m.label}</option>);
  const chosen = w.metrics ?? [];
  const unit = chosen.length ? catalogue.metrics.find((m) => m.key === chosen[0])?.unit : undefined;
  return (
    <fieldset className="flex flex-col gap-3 rounded-[var(--t2t-radius-md)] border border-line p-4" aria-label={n}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <legend className="text-sm font-medium">
          {n}: {label}
        </legend>
        <div className="flex gap-1">
          <Button type="button" variant="ghost" size="sm" disabled={index === 0} onClick={() => onMove(-1)}>Up</Button>
          <Button type="button" variant="ghost" size="sm" disabled={index === count - 1} onClick={() => onMove(1)}>Down</Button>
          <Button type="button" variant="ghost" size="sm" onClick={onRemove}>Remove</Button>
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <Input aria-label={`${n} title`} value={w.title} maxLength={80} onChange={(e) => onChange({ ...w, title: e.target.value })} placeholder="Title" />
        <Select aria-label={`${n} size`} value={w.size ?? 'MEDIUM'} onChange={(e) => onChange({ ...w, size: e.target.value as Widget['size'] })}>
          {catalogue.sizes.map((s) => <option key={s} value={s}>{SIZE_LABELS[s]}</option>)}
        </Select>
        {w.type === 'STAT' ? (
          <Select aria-label={`${n} compare`} value={w.compare ?? 'PREVIOUS_MONTH'} onChange={(e) => onChange({ ...w, compare: e.target.value as Widget['compare'] })}>
            {catalogue.comparisons.map((c) => <option key={c} value={c}>{COMPARISON_LABELS[c]}</option>)}
          </Select>
        ) : (
          <Select aria-label={`${n} months`} value={String(w.months ?? 12)} onChange={(e) => onChange({ ...w, months: Number(e.target.value) })}>
            {(w.type === 'LINE' || w.type === 'BAR' ? [3, 6, 12, 18, 24] : [1, 3, 6, 12]).map((m) => <option key={m} value={m}>{m} month{m === 1 ? '' : 's'}</option>)}
          </Select>
        )}
      </div>
      {w.type === 'STAT' ? (
        <Select aria-label={`${n} metric`} value={w.metric ?? 'revenue'} onChange={(e) => onChange({ ...w, metric: e.target.value })}>
          {metricOptions}
        </Select>
      ) : w.type === 'TOP_CUSTOMERS' ? (
        <Select aria-label={`${n} number of customers`} value={String(w.count ?? 5)} onChange={(e) => onChange({ ...w, count: Number(e.target.value) })}>
          {[3, 5, 10].map((c) => <option key={c} value={c}>{c} customers</option>)}
        </Select>
      ) : (
        <div role="group" aria-label={`${n} metrics`} className="flex flex-wrap gap-x-4 gap-y-1">
          {catalogue.metrics.map((m) => {
            const on = chosen.includes(m.key);
            const clash = w.type !== 'TABLE' && !on && unit !== undefined && m.unit !== unit;
            return (
              <label key={m.key} className={`flex items-center gap-1.5 text-sm ${clash ? 'text-fg-faint' : ''}`} title={clash ? 'A chart shows metrics measured the same way' : m.formula}>
                <input type="checkbox" checked={on} disabled={clash} onChange={(e) => onChange({ ...w, metrics: e.target.checked ? [...chosen, m.key] : chosen.filter((k) => k !== m.key) })} />
                {m.label}
              </label>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}
