'use client';
import { useMutation } from '@tanstack/react-query';
import { Button, Card, CardHeader } from '@talk2tax/ui';
import { useState, type DragEvent } from 'react';
import { api } from '@/lib/api';
import type { Catalogue, DashboardDetail, Metric, Widget } from '@/lib/dashboards';

type Target = { kind: 'new'; at: number } | { kind: 'into'; index: number };
type Op = { op: 'move'; from: number; to: number } | { op: 'dropMetric'; metric: string; target: Target } | { op: 'remove'; index: number };
type Dragged = { kind: 'metric'; key: string } | { kind: 'widget'; index: number };

const KIND: Record<Widget['type'], string> = { STAT: 'Figure', LINE: 'Line chart', BAR: 'Bar chart', TABLE: 'Table', TOP_CUSTOMERS: 'Top customers' };
const MIME = 'application/x-talk2tax-dashboard';
const GROUPS: Record<string, string> = { GROWTH: 'Growth', PROFITABILITY: 'Profitability', LIQUIDITY: 'Liquidity', EFFICIENCY: 'Efficiency', CASH: 'Cash', FIGURES: 'Figures' };

/**
 * Arranging a dashboard by drag and drop: drag an approved metric from the palette between two
 * widgets to add it as a figure, or onto a figure, chart or table to show it there; drag a
 * widget to a gap to move it. Every drop is saved straight away as a new version of the
 * dashboard (checked by the server, so a chart never mixes units), and everyone in the
 * organisation sees the new layout.
 *
 * Without a mouse: pick a metric with its button, then use "Add here" in a gap or "Add to this
 * widget" on a widget; move widgets with Move earlier and Move later.
 */
export function DashboardArranger({ orgId, dashboard, catalogue, month, onSaved }: { orgId: string; dashboard: DashboardDetail; catalogue: Catalogue; month: string | null; onSaved: (d: DashboardDetail) => void }) {
  const widgets = dashboard.config.widgets;
  const [dragged, setDragged] = useState<Dragged | null>(null);
  const [picked, setPicked] = useState<Metric | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const label = (k: string | undefined) => catalogue.metrics.find((m) => m.key === k)?.label ?? k ?? '';
  const save = useMutation({
    mutationFn: (x: { ops: Op[]; done: string }) => api<DashboardDetail>(`/v1/orgs/${orgId}/dashboards/${dashboard.id}/layout`, { method: 'POST', body: { ops: x.ops, baseVersion: dashboard.version, ...(month ? { month } : {}) } }),
    onSuccess: (d, x) => {
      onSaved(d);
      setPicked(null);
      setSaid(`${x.done}. Saved as version ${d.version}.`);
    },
    onError: (e) => setSaid(e instanceof Error ? e.message : 'Could not save the change'),
  });
  const run = (op: Op, done: string) => {
    if (!save.isPending) save.mutate({ ops: [op], done });
  };
  const moveTo = (from: number, gap: number) => {
    const to = gap > from ? gap - 1 : gap;
    if (to !== from) run({ op: 'move', from, to }, `Moved ${widgets[from]!.title} to position ${to + 1}`);
  };
  const addAt = (m: Metric, at: number) => run({ op: 'dropMetric', metric: m.key, target: { kind: 'new', at } }, `Added ${m.label} as a figure at position ${at + 1}`);
  const addInto = (m: Metric, index: number) => run({ op: 'dropMetric', metric: m.key, target: { kind: 'into', index } }, `${widgets[index]!.type === 'STAT' ? 'Showing' : 'Added'} ${m.label} ${widgets[index]!.type === 'STAT' ? 'in' : 'to'} ${widgets[index]!.title}`);

  const start = (e: DragEvent, d: Dragged) => {
    e.dataTransfer.setData(MIME, JSON.stringify(d));
    e.dataTransfer.setData('text/plain', d.kind === 'metric' ? label(d.key) : widgets[d.index]!.title);
    e.dataTransfer.effectAllowed = d.kind === 'metric' ? 'copy' : 'move';
    setDragged(d);
  };
  const read = (e: DragEvent): Dragged | null => {
    try {
      return (JSON.parse(e.dataTransfer.getData(MIME)) as Dragged) ?? dragged;
    } catch {
      return dragged;
    }
  };
  const end = () => {
    setDragged(null);
    setOver(null);
  };
  const zone = (id: string, accepts: boolean) => ({
    onDragOver: (e: DragEvent) => {
      if (!accepts) return;
      e.preventDefault();
      if (over !== id) setOver(id);
    },
    onDragLeave: () => setOver((o) => (o === id ? null : o)),
  });
  const metricFor = (d: Dragged | null) => (d?.kind === 'metric' ? (catalogue.metrics.find((m) => m.key === d.key) ?? null) : null);
  const full = widgets.length >= catalogue.limits.widgets;

  const gap = (at: number) => {
    const id = `gap-${at}`;
    const metricDrag = dragged?.kind === 'metric';
    const widgetDrag = dragged?.kind === 'widget' && dragged.index !== at && dragged.index !== at - 1;
    const active = (metricDrag && !full) || widgetDrag;
    return (
      <li
        key={id}
        data-testid={id}
        aria-label={`Gap at position ${at + 1}`}
        className={`flex min-h-8 items-center justify-center rounded-[var(--t2t-radius-md)] border border-dashed text-xs transition-colors ${over === id ? 'border-accent bg-accent/10 text-accent' : active ? 'border-line text-fg-muted' : 'border-transparent text-fg-faint'}`}
        {...zone(id, !!active)}
        onDrop={(e) => {
          e.preventDefault();
          const d = read(e);
          end();
          if (d?.kind === 'widget') moveTo(d.index, at);
          else if (metricFor(d)) addAt(metricFor(d)!, at);
        }}
      >
        {picked && !full ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => addAt(picked, at)}>
            Add {picked.label} here
          </Button>
        ) : active ? (
          <span>{dragged?.kind === 'metric' ? 'Drop to add as a figure' : 'Drop to move here'}</span>
        ) : null}
      </li>
    );
  };

  return (
    <div className="mb-6 grid gap-4 lg:grid-cols-[18rem_1fr]">
      <Card>
        <CardHeader title="Metrics to drag" description="Drag a metric between widgets to add it as a figure, or onto a widget to show it there. Without a mouse, pick one and choose where it goes." />
        <div className="flex flex-col gap-3 px-5 pb-5">
          {Object.entries(GROUPS).map(([g, name]) => {
            const ms = catalogue.metrics.filter((m) => m.group === g);
            if (!ms.length) return null;
            return (
              <div key={g}>
                <p className="mb-1 text-xs font-medium uppercase tracking-wide text-fg-muted">{name}</p>
                <ul className="flex flex-wrap gap-1.5" aria-label={`${name} metrics`}>
                  {ms.map((m) => (
                    <li key={m.key}>
                      <button
                        type="button"
                        draggable
                        data-metric={m.key}
                        aria-pressed={picked?.key === m.key}
                        title={m.formula}
                        onDragStart={(e) => start(e, { kind: 'metric', key: m.key })}
                        onDragEnd={end}
                        onClick={() => setPicked((p) => (p?.key === m.key ? null : m))}
                        className={`cursor-grab rounded-full border px-2.5 py-1 text-xs active:cursor-grabbing ${picked?.key === m.key ? 'border-accent bg-accent text-white' : 'border-line bg-surface hover:bg-surface-hover'}`}
                      >
                        {m.label}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          {picked ? (
            <p className="text-xs text-fg-muted">
              {picked.label} is picked. Choose “Add here” in a gap or “Add to this widget”.{' '}
              <button type="button" className="text-accent hover:underline" onClick={() => setPicked(null)}>
                Put it back
              </button>
            </p>
          ) : null}
        </div>
      </Card>
      <Card>
        <CardHeader title="Dashboard layout" description={`Drag widgets to reorder them. ${widgets.length} of ${catalogue.limits.widgets} widgets. Each change is saved straight away.`} />
        <p role="status" aria-live="polite" className={`px-5 text-sm ${save.isError ? 'text-negative' : 'text-fg-muted'}`} data-testid="arrange-status">
          {save.isPending ? 'Saving…' : said}
        </p>
        <ol className="flex flex-col gap-1 px-5 pb-5 pt-2" aria-label="Widgets in order">
          {gap(0)}
          {widgets.map((w, i) => {
            const id = `w-${i}`;
            const m = metricFor(dragged);
            const accepts = !!m && w.type !== 'TOP_CUSTOMERS';
            const shows = w.type === 'STAT' ? label(w.metric) : w.type === 'TOP_CUSTOMERS' ? `Largest ${w.count ?? 5} customers` : (w.metrics ?? []).map(label).join(', ');
            return [
              <li
                key={id}
                data-testid={id}
                aria-label={`${i + 1}. ${w.title}`}
                draggable
                onDragStart={(e) => start(e, { kind: 'widget', index: i })}
                onDragEnd={end}
                {...zone(id, accepts)}
                onDrop={(e) => {
                  e.preventDefault();
                  const d = read(e);
                  end();
                  const dm = metricFor(d);
                  if (dm) addInto(dm, i);
                }}
                className={`flex cursor-grab flex-wrap items-center gap-2 rounded-[var(--t2t-radius-md)] border p-3 active:cursor-grabbing ${over === id ? 'border-accent bg-accent/10' : 'border-line bg-surface'} ${dragged?.kind === 'widget' && dragged.index === i ? 'opacity-50' : ''}`}
              >
                <span aria-hidden className="select-none text-fg-faint">⠿</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{w.title}</p>
                  <p className="text-xs text-fg-muted">
                    {KIND[w.type]}: {shows}
                  </p>
                </div>
                {picked && w.type !== 'TOP_CUSTOMERS' ? (
                  <Button type="button" size="sm" variant="secondary" onClick={() => addInto(picked, i)}>
                    Add to this widget
                  </Button>
                ) : null}
                <Button type="button" size="sm" variant="ghost" aria-label={`Move ${w.title} earlier`} disabled={i === 0 || save.isPending} onClick={() => run({ op: 'move', from: i, to: i - 1 }, `Moved ${w.title} to position ${i}`)}>
                  ↑
                </Button>
                <Button type="button" size="sm" variant="ghost" aria-label={`Move ${w.title} later`} disabled={i === widgets.length - 1 || save.isPending} onClick={() => run({ op: 'move', from: i, to: i + 1 }, `Moved ${w.title} to position ${i + 2}`)}>
                  ↓
                </Button>
                <Button type="button" size="sm" variant="ghost" aria-label={`Remove ${w.title}`} disabled={widgets.length === 1 || save.isPending} onClick={() => run({ op: 'remove', index: i }, `Removed ${w.title}`)}>
                  Remove
                </Button>
              </li>,
              gap(i + 1),
            ];
          })}
        </ol>
      </Card>
    </div>
  );
}
