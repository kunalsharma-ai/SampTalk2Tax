'use client';
import { Badge, Card } from '@talk2tax/ui';
import type { ReactNode } from 'react';
import { DashboardView } from '@/components/dashboards/dashboard-view';
import type { Widget, WidgetData } from '@/lib/dashboards';
import type { CommentaryEntry, ReportLayout } from '@/lib/report-designer';

/**
 * A report's sections in order. Figures come from `widgets` (one per figures section, in order);
 * commentary from `commentary` by section position. `renderCommentary` lets a page make the
 * commentary editable; otherwise it is shown as written, or the instruction when there is none.
 */
export function ReportView({ layout, widgets, currency, commentary, renderCommentary }: { layout: ReportLayout; widgets: WidgetData[]; currency: string; commentary?: CommentaryEntry[]; renderCommentary?: (entry: CommentaryEntry) => ReactNode }) {
  // Consecutive figures sections share one grid, so small figures sit side by side.
  const blocks: { start: number; widgets: { w: Widget; d: WidgetData }[] }[] = [];
  let n = 0;
  layout.sections.forEach((s, i) => {
    if (s.type !== 'WIDGET') return;
    const d = widgets[n++];
    if (!d) return;
    const last = blocks[blocks.length - 1];
    if (last && layout.sections[i - 1]?.type === 'WIDGET' && last.start + last.widgets.length === i) last.widgets.push({ w: s.widget, d });
    else blocks.push({ start: i, widgets: [{ w: s.widget, d }] });
  });
  return (
    <article className="flex flex-col gap-4" data-testid="report">
      {layout.sections.map((s, i) => {
        if (s.type === 'HEADING')
          return (
            <h2 key={i} className="mt-2 text-lg font-semibold">
              {s.text}
            </h2>
          );
        if (s.type === 'TEXT')
          return (
            <p key={i} className="whitespace-pre-line text-sm leading-6">
              {s.text}
            </p>
          );
        if (s.type === 'WIDGET') {
          const b = blocks.find((x) => x.start === i);
          return b ? <DashboardView key={i} config={{ widgets: b.widgets.map((x) => x.w) }} data={{ currency, widgets: b.widgets.map((x) => x.d) }} /> : null;
        }
        const entry = commentary?.find((c) => c.section === i) ?? { section: i, instruction: s.instruction, text: '', source: 'NONE' as const, issues: [] };
        return (
          <section key={i} aria-label={`Commentary ${i + 1}`}>
            {renderCommentary ? (
              renderCommentary(entry)
            ) : (
              <Card className="p-5">
                <Commentary entry={entry} />
              </Card>
            )}
          </section>
        );
      })}
    </article>
  );
}

export function Commentary({ entry }: { entry: CommentaryEntry }) {
  return entry.text ? (
    <div className="flex flex-col gap-2">
      <p className="whitespace-pre-line text-sm leading-6">{entry.text}</p>
      <p className="text-xs text-fg-faint">
        <Badge tone={entry.source === 'AI' ? 'violet' : 'neutral'}>{entry.source === 'AI' ? 'Written by the AI' : 'Written by a person'}</Badge> from the figures in this report
      </p>
    </div>
  ) : (
    <p className="text-sm text-fg-muted">Commentary to be written for the month: {entry.instruction}</p>
  );
}
