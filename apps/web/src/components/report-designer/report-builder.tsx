'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, CardHeader, Field, Input, Textarea } from '@talk2tax/ui';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { blank, clean, WidgetRow } from '@/components/dashboards/dashboard-builder';
import { ReportView } from '@/components/report-designer/report-view';
import { api } from '@/lib/api';
import type { WidgetType } from '@/lib/dashboards';
import { SECTION_LABELS, type AiDraft, type AiStatus, type Catalogue, type DesignDetail, type Preview, type ReportLayout, type ReportSection } from '@/lib/report-designer';

type Turn = { role: 'user' | 'assistant'; text: string };

const cleanSection = (s: ReportSection): ReportSection => (s.type === 'WIDGET' ? { type: 'WIDGET', widget: clean(s.widget) } : s);

/**
 * Designs a report: headings, fixed text, monthly commentary and figures, in any order. Describe
 * it and the AI drafts the layout, or build it by hand. Preview works out the figures from the
 * books without saving; commentary is written when a report is produced for a month.
 */
export function ReportBuilder({ orgId, catalogue, design, ai }: { orgId: string; catalogue: Catalogue; design?: DesignDetail; ai: AiStatus | undefined }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [name, setName] = useState(design?.name ?? '');
  const [description, setDescription] = useState(design?.description ?? '');
  const [sections, setSections] = useState<ReportSection[]>(design?.layout.sections ?? []);
  const layout = (): ReportLayout => ({ sections: sections.map(cleanSection) });
  const setSection = (i: number, s: ReportSection) => setSections((xs) => xs.map((x, j) => (j === i ? s : x)));
  const remove = (i: number) => setSections((xs) => xs.filter((_, j) => j !== i));
  const move = (i: number, by: number) => setSections((xs) => {
    const next = [...xs];
    const [s] = next.splice(i, 1);
    next.splice(i + by, 0, s!);
    return next;
  });
  const add = (s: ReportSection) => setSections((xs) => [...xs, s]);
  const full = sections.length >= catalogue.sectionLimit;

  const preview = useMutation({ mutationFn: () => api<Preview>(`/v1/orgs/${orgId}/report-designer/preview`, { method: 'POST', body: { layout: layout() } }) });
  const save = useMutation({
    mutationFn: () =>
      design
        ? api<DesignDetail>(`/v1/orgs/${orgId}/report-designer/designs/${design.id}`, { method: 'PUT', body: { name, description: description || null, layout: layout(), baseVersion: design.version } })
        : api<DesignDetail>(`/v1/orgs/${orgId}/report-designer/designs`, { method: 'POST', body: { name, description: description || null, layout: layout() } }),
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: ['report-designs', orgId] });
      qc.setQueryData(['report-design', orgId, d.id], d);
      router.push(`/orgs/${orgId}/reports/designer/${d.id}`);
    },
  });

  const [request, setRequest] = useState('');
  const [conversation, setConversation] = useState<Turn[]>([]);
  const [answer, setAnswer] = useState('');
  const [proposal, setProposal] = useState<AiDraft | null>(null);
  const draft = useMutation({
    mutationFn: (turns: Turn[]) => api<AiDraft>(`/v1/orgs/${orgId}/report-designer/ai-draft`, { method: 'POST', body: { request, conversation: turns } }),
    onSuccess: (p, turns) => {
      setProposal(p);
      setConversation([...turns, { role: 'assistant', text: `${p.description}${p.notes.length ? `\nNotes: ${p.notes.join(' ')}` : ''}${p.questions.length ? `\nQuestions: ${p.questions.join(' ')}` : ''}` }]);
      setAnswer('');
    },
  });
  const useDraft = () => {
    if (!proposal) return;
    setSections(proposal.layout.sections);
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
      <Card>
        <CardHeader title="Describe it" description="Say what the report is for and what it should cover. The AI lays out the sections from the approved metrics; the figures are always worked out from your books. Nothing is saved until you save." />
        <div className="flex flex-col gap-3 p-5" role="region" aria-label="Describe the report">
          <Textarea aria-label="What should the report cover?" rows={3} value={request} maxLength={4000} onChange={(e) => setRequest(e.target.value)} placeholder="A monthly report for the board: how revenue and margins moved against last year, cash and runway, who owes us, and our biggest customers, with commentary on each." />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="secondary" size="sm" disabled={!ai?.available || !request.trim()} loading={draft.isPending && conversation.length === 0} onClick={() => draft.mutate([])}>
              {proposal ? 'Start again' : 'Draft with AI'}
            </Button>
            {ai && !ai.available ? <span className="text-xs text-fg-muted">{ai.reason}</span> : null}
          </div>
          <ErrorAlert title="The AI could not draft the report" error={draft.error} />
          {proposal ? (
            <div className="flex flex-col gap-3" data-testid="ai-proposal">
              <p className="text-sm">
                <span className="font-medium">{proposal.name}.</span> {proposal.description}
              </p>
              <ol className="list-inside list-decimal text-sm">{proposal.descriptions.map((d, i) => <li key={i}>{d}</li>)}</ol>
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
              <div>
                <Button type="button" size="sm" onClick={useDraft}>
                  Use this draft
                </Button>
                <span className="ml-2 text-xs text-fg-muted">Replaces the sections below.</span>
              </div>
            </div>
          ) : null}
        </div>
      </Card>

      <Card>
        <CardHeader title="Name" />
        <div className="grid gap-4 p-5 md:grid-cols-2">
          <Field label="Report name">{(p) => <Input {...p} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Monthly board report" />}</Field>
          <Field label="What it is for (optional)">{(p) => <Input {...p} value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} />}</Field>
        </div>
      </Card>

      <Card>
        <CardHeader title="Sections" description={`Up to ${catalogue.sectionLimit}, in the order they appear. Fixed text is the same every month; commentary is written each month from that month's figures.`} />
        <div className="flex flex-col gap-3 p-5">
          {sections.map((s, i) =>
            s.type === 'WIDGET' ? (
              <WidgetRow key={i} index={i} name={`Section ${i + 1}`} w={s.widget} catalogue={catalogue} count={sections.length} onChange={(w) => setSection(i, { type: 'WIDGET', widget: w })} onMove={(by) => move(i, by)} onRemove={() => remove(i)} />
            ) : (
              <SectionRow key={i} index={i} s={s} count={sections.length} onChange={(x) => setSection(i, x)} onMove={(by) => move(i, by)} onRemove={() => remove(i)} />
            ),
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" size="sm" disabled={full} onClick={() => add({ type: 'HEADING', text: '' })}>Add heading</Button>
            <Button type="button" variant="secondary" size="sm" disabled={full} onClick={() => add({ type: 'TEXT', text: '' })}>Add fixed text</Button>
            <Button type="button" variant="secondary" size="sm" disabled={full} onClick={() => add({ type: 'COMMENTARY', instruction: '' })}>Add commentary</Button>
            {catalogue.widgetTypes.map((t) => (
              <Button key={t.type} type="button" variant="secondary" size="sm" disabled={full} onClick={() => add({ type: 'WIDGET', widget: blank(t.type as WidgetType) })}>
                Add {t.label.toLowerCase()}
              </Button>
            ))}
          </div>
        </div>
      </Card>

      <ErrorAlert title="Could not preview the report" error={preview.error} />
      {preview.data ? (
        <section aria-label="Preview" className="flex flex-col gap-2">
          <p className="text-sm text-fg-muted">Preview with the figures for the last complete month. Commentary is written when you produce the report.</p>
          <ReportView layout={preview.data.layout} widgets={preview.data.widgets} currency={preview.data.currency} />
        </section>
      ) : null}
      <ErrorAlert title="The report design was not saved" error={save.error} />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="secondary" loading={preview.isPending} disabled={!sections.length} onClick={() => preview.mutate()}>
          Preview
        </Button>
        <Button type="submit" loading={save.isPending}>
          {design ? 'Save changes' : 'Save design'}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.push(design ? `/orgs/${orgId}/reports/designer/${design.id}` : `/orgs/${orgId}/reports/designer`)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function SectionRow({ index, s, count, onChange, onMove, onRemove }: { index: number; s: Exclude<ReportSection, { type: 'WIDGET' }>; count: number; onChange: (s: ReportSection) => void; onMove: (by: number) => void; onRemove: () => void }) {
  const n = `Section ${index + 1}`;
  return (
    <fieldset className="flex flex-col gap-3 rounded-[var(--t2t-radius-md)] border border-line p-4" aria-label={n}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <legend className="text-sm font-medium">
          {n}: {SECTION_LABELS[s.type]}
        </legend>
        <div className="flex gap-1">
          <Button type="button" variant="ghost" size="sm" disabled={index === 0} onClick={() => onMove(-1)}>Up</Button>
          <Button type="button" variant="ghost" size="sm" disabled={index === count - 1} onClick={() => onMove(1)}>Down</Button>
          <Button type="button" variant="ghost" size="sm" onClick={onRemove}>Remove</Button>
        </div>
      </div>
      {s.type === 'HEADING' ? (
        <Input aria-label={`${n} heading`} value={s.text} maxLength={120} onChange={(e) => onChange({ type: 'HEADING', text: e.target.value })} placeholder="Revenue and margins" />
      ) : s.type === 'TEXT' ? (
        <Textarea aria-label={`${n} text`} rows={3} value={s.text} maxLength={4000} onChange={(e) => onChange({ type: 'TEXT', text: e.target.value })} placeholder="Words that stay the same every month, such as who the report is for. Don't put figures here." />
      ) : (
        <Textarea aria-label={`${n} commentary instruction`} rows={2} value={s.instruction} maxLength={500} onChange={(e) => onChange({ type: 'COMMENTARY', instruction: e.target.value })} placeholder="What the commentary should cover each month, for example: explain how revenue and margins moved and why it matters." />
      )}
    </fieldset>
  );
}
