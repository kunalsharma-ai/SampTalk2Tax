'use client';
import { useMutation } from '@tanstack/react-query';
import { Button, Card, CardHeader, Field, Input, Select, Textarea } from '@talk2tax/ui';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { api } from '@/lib/api';
import type { DecisionDetail, DecisionDraft, DecisionMeta } from '@/lib/decisions';
import { today } from '@/lib/format';

type OutcomeRow = DecisionDraft['outcomes'][number];
const nextMonth = () => {
  const t = today();
  const m = +t.slice(5, 7);
  return m === 12 ? `${+t.slice(0, 4) + 1}-01` : `${t.slice(0, 4)}-${String(m + 1).padStart(2, '0')}`;
};

/**
 * Records a decision or changes an active one: what was decided and why, the assumptions behind
 * it, and the outcomes expected, each a KPI with a target in a month, measured later from the books.
 */
export function DecisionForm({ orgId, meta, initial, decisionId, onSaved }: { orgId: string; meta: DecisionMeta; initial: DecisionDraft; decisionId?: string; onSaved: (d: DecisionDetail) => void }) {
  const [f, setF] = useState({ ...initial, tags: initial.tags.join(', '), context: initial.context ?? '', decidedBy: initial.decidedBy ?? '', reviewDue: initial.reviewDue ?? '' });
  const [assumptions, setAssumptions] = useState(initial.assumptions.map((a) => a.text));
  const [outcomes, setOutcomes] = useState<OutcomeRow[]>(initial.outcomes);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const setOutcome = (i: number, patch: Partial<OutcomeRow>) => setOutcomes((o) => o.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const save = useMutation({
    mutationFn: () => {
      const body = {
        title: f.title,
        decision: f.decision,
        context: f.context.trim() || null,
        category: f.category,
        tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean),
        decidedOn: f.decidedOn,
        decidedBy: f.decidedBy.trim() || null,
        reviewDue: f.reviewDue || null,
        assumptions: assumptions.map((t) => t.trim()).filter(Boolean).map((text) => ({ text })),
        outcomes,
        ...(decisionId ? {} : { sourceType: initial.sourceType ?? null, sourceId: initial.sourceId ?? null }),
      };
      return decisionId ? api<DecisionDetail>(`/v1/orgs/${orgId}/decisions/${decisionId}`, { method: 'PUT', body }) : api<DecisionDetail>(`/v1/orgs/${orgId}/decisions`, { method: 'POST', body });
    },
    onSuccess: onSaved,
  });
  const unitHint = (kpi: string) => {
    const m = meta.measures.find((x) => x.key === kpi);
    return m ? { MONEY: 'amount', PERCENT: '%', RATIO: 'ratio', DAYS: 'days', MONTHS: 'months' }[m.unit] : '';
  };
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Card>
        <CardHeader title="The decision" description="What was decided, when and by whom, and why." />
        <div className="grid gap-4 p-5 md:grid-cols-2">
          <div className="md:col-span-2">
            <Field label="Title">{(p) => <Input {...p} value={f.title} onChange={set('title')} maxLength={200} required />}</Field>
          </div>
          <div className="md:col-span-2">
            <Field label="What was decided">{(p) => <Textarea {...p} rows={4} value={f.decision} onChange={set('decision')} maxLength={4000} required />}</Field>
          </div>
          <div className="md:col-span-2">
            <Field label="Why: the situation and the options considered">{(p) => <Textarea {...p} rows={3} value={f.context} onChange={set('context')} maxLength={4000} />}</Field>
          </div>
          <Field label="Category">
            {(p) => (
              <Select {...p} value={f.category} onChange={set('category')}>
                {meta.categories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Tags" hint="Separate with commas">{(p) => <Input {...p} value={f.tags} onChange={set('tags')} />}</Field>
          <Field label="Decided on">{(p) => <Input {...p} type="date" value={f.decidedOn} max={today()} onChange={set('decidedOn')} required />}</Field>
          <Field label="Decided by" hint="A person, or a meeting such as the board">{(p) => <Input {...p} value={f.decidedBy} onChange={set('decidedBy')} maxLength={200} />}</Field>
          <Field label="Review by" hint="When to look back at what happened">{(p) => <Input {...p} type="date" value={f.reviewDue} min={f.decidedOn} onChange={set('reviewDue')} />}</Field>
        </div>
      </Card>

      <Card>
        <CardHeader title="Assumptions" description="What has to be true for the decision to work. At the review you record whether each held." />
        <div className="space-y-3 p-5">
          {assumptions.map((a, i) => (
            <div key={i} className="flex items-end gap-2">
              <div className="flex-1">
                <Field label={`Assumption ${i + 1}`}>{(p) => <Input {...p} value={a} maxLength={1000} onChange={(e) => setAssumptions((x) => x.map((y, j) => (j === i ? e.target.value : y)))} />}</Field>
              </div>
              <Button type="button" variant="ghost" aria-label={`Remove assumption ${i + 1}`} onClick={() => setAssumptions((x) => x.filter((_, j) => j !== i))}>Remove</Button>
            </div>
          ))}
          <Button type="button" variant="secondary" onClick={() => setAssumptions((x) => [...x, ''])} disabled={assumptions.length >= 30}>Add an assumption</Button>
        </div>
      </Card>

      <Card>
        <CardHeader title="Expected outcomes" description="Measures from the books with the target and the month to check. Each is compared with its value in the month before the decision." />
        <div className="space-y-3 p-5">
          {outcomes.map((o, i) => (
            <div key={i} className="grid items-end gap-2 md:grid-cols-[2fr_1fr_1fr_1fr_auto]">
              <Field label={`Measure ${i + 1}`}>
                {(p) => (
                  <Select {...p} value={o.kpi} onChange={(e) => setOutcome(i, { kpi: e.target.value })}>
                    {meta.measures.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                  </Select>
                )}
              </Field>
              <Field label={`Comparison ${i + 1}`}>
                {(p) => (
                  <Select {...p} value={o.comparator} onChange={(e) => setOutcome(i, { comparator: e.target.value as OutcomeRow['comparator'] })}>
                    <option value="AT_LEAST">At least</option>
                    <option value="AT_MOST">At most</option>
                  </Select>
                )}
              </Field>
              <Field label={`Target ${i + 1}`} hint={unitHint(o.kpi)}>{(p) => <Input {...p} inputMode="decimal" value={o.target} onChange={(e) => setOutcome(i, { target: e.target.value })} required />}</Field>
              <Field label={`Month ${i + 1}`}>{(p) => <Input {...p} type="month" value={o.measureMonth} min={f.decidedOn.slice(0, 7)} onChange={(e) => setOutcome(i, { measureMonth: e.target.value })} required />}</Field>
              <Button type="button" variant="ghost" aria-label={`Remove outcome ${i + 1}`} onClick={() => setOutcomes((x) => x.filter((_, j) => j !== i))}>Remove</Button>
            </div>
          ))}
          <Button type="button" variant="secondary" onClick={() => setOutcomes((x) => [...x, { kpi: meta.measures[0]!.key, comparator: 'AT_LEAST', target: '', measureMonth: nextMonth() }])} disabled={outcomes.length >= 12}>Add an expected outcome</Button>
        </div>
      </Card>

      <ErrorAlert title="Could not save the decision" error={save.error} />
      <Button type="submit" loading={save.isPending}>{decisionId ? 'Save changes' : 'Record decision'}</Button>
    </form>
  );
}
