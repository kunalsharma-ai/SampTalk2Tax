'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, Field, Select, Table, Td, Textarea, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { DecisionForm } from '@/components/decisions/decision-form';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { type DecisionDetail, type DecisionMeta, monthName, OUTCOME, type Outcome, STATUS, unitText, VERDICT, type Verdict } from '@/lib/decisions';
import { date, dateTime } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

function Value({ o, v, currency }: { o: Outcome; v: string | null; currency: string }) {
  if (v === null) return <span className="text-fg-muted">—</span>;
  return o.unit === 'MONEY' ? <Money value={v} currency={currency} signed /> : <span className="num">{unitText(o.unit, v)}</span>;
}

function Review({ orgId, d, meta, onDone }: { orgId: string; d: DecisionDetail; meta: DecisionMeta; onDone: () => void }) {
  const [verdict, setVerdict] = useState<Verdict | ''>(d.suggestedVerdict ?? '');
  const [held, setHeld] = useState<(boolean | null)[]>(d.assumptions.map(() => null));
  const [notes, setNotes] = useState<string[]>(d.assumptions.map(() => ''));
  const [outcomeNotes, setOutcomeNotes] = useState('');
  const [lessons, setLessons] = useState('');
  const save = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/decisions/${d.id}/review`, { method: 'POST', body: { verdict, outcomeNotes: outcomeNotes.trim() || null, lessons, assumptions: held.map((h, i) => ({ held: h, note: notes[i]!.trim() || null })) } }),
    onSuccess: onDone,
  });
  return (
    <Card>
      <CardHeader title="Review the decision" description="Record whether each assumption held, how it turned out and what was learned. The measured outcomes are kept as they are now, and the decision can no longer be changed." />
      <form
        className="space-y-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        {d.assumptions.map((a, i) => (
          <div key={i} className="grid gap-2 md:grid-cols-[2fr_1fr_2fr]">
            <p className="self-center text-sm">{a.text}</p>
            <Field label={`Did assumption ${i + 1} hold?`}>
              {(p) => (
                <Select {...p} value={held[i] === null ? '' : held[i] ? 'yes' : 'no'} onChange={(e) => setHeld((h) => h.map((x, j) => (j === i ? (e.target.value === '' ? null : e.target.value === 'yes') : x)))}>
                  <option value="">Not known</option>
                  <option value="yes">Held</option>
                  <option value="no">Did not hold</option>
                </Select>
              )}
            </Field>
            <Field label={`Note on assumption ${i + 1}`}>{(p) => <TextInput {...p} value={notes[i]!} onChange={(v) => setNotes((n) => n.map((x, j) => (j === i ? v : x)))} />}</Field>
          </div>
        ))}
        <Field label="Verdict" hint={d.suggestedVerdict ? `The measured outcomes suggest: ${VERDICT[d.suggestedVerdict].label.toLowerCase()}` : 'No outcome can be measured yet'}>
          {(p) => (
            <Select {...p} value={verdict} onChange={(e) => setVerdict(e.target.value as Verdict)} required>
              <option value="">Choose…</option>
              {meta.verdicts.map((v) => <option key={v.key} value={v.key}>{v.label}</option>)}
            </Select>
          )}
        </Field>
        <Field label="What happened">{(p) => <Textarea {...p} rows={3} value={outcomeNotes} onChange={(e) => setOutcomeNotes(e.target.value)} maxLength={4000} />}</Field>
        <Field label="Lessons learned">{(p) => <Textarea {...p} rows={3} value={lessons} onChange={(e) => setLessons(e.target.value)} maxLength={4000} required />}</Field>
        <ErrorAlert title="Could not save the review" error={save.error} />
        <Button type="submit" loading={save.isPending}>Save review</Button>
      </form>
    </Card>
  );
}

function TextInput({ value, onChange, ...p }: { value: string; onChange: (v: string) => void; id: string }) {
  return <input {...p} className="h-9 w-full rounded-[var(--t2t-radius-md)] border border-line bg-surface px-3 text-sm" value={value} maxLength={1000} onChange={(e) => onChange(e.target.value)} />;
}

export default function DecisionPage() {
  const { org, orgId } = useOrg();
  const { decisionId } = useParams<{ decisionId: string }>();
  const qc = useQueryClient();
  const key = ['decision', orgId, decisionId];
  const q = useQuery({ queryKey: key, queryFn: () => api<DecisionDetail>(`/v1/orgs/${orgId}/decisions/${decisionId}`) });
  const meta = useQuery({ queryKey: ['decision-meta', orgId], queryFn: () => api<DecisionMeta>(`/v1/orgs/${orgId}/decisions/meta`) });
  const [mode, setMode] = useState<'view' | 'edit' | 'review'>('view');
  const refresh = () => {
    setMode('view');
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ['decisions', orgId] });
  };
  const withdraw = useMutation({ mutationFn: (reason: string) => api(`/v1/orgs/${orgId}/decisions/${decisionId}/withdraw`, { method: 'POST', body: { reason } }), onSuccess: refresh });
  if (!org) return null;
  const d = q.data;
  const manage = can(org.role, 'decisions.manage');
  const who = (id: string | null) => (id ? (d?.people[id] ?? 'a former member') : '');
  const cat = (k: string) => meta.data?.categories.find((c) => c.key === k)?.label ?? k;
  return (
    <>
      <PageHeader
        title={d ? `${d.number} · ${d.title}` : 'Decision'}
        description={d ? `${cat(d.category)} · decided ${date(d.decidedOn)}${d.decidedBy ? ` by ${d.decidedBy}` : ''}` : undefined}
        actions={
          <>
            {manage && d?.status === 'ACTIVE' && mode === 'view' ? (
              <>
                <Button variant="secondary" onClick={() => setMode('edit')}>Edit</Button>
                <Button onClick={() => setMode('review')}>Review outcome</Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    const reason = prompt('Why is the decision withdrawn (reversed or never carried out)?');
                    if (reason?.trim()) withdraw.mutate(reason.trim());
                  }}
                >
                  Withdraw
                </Button>
              </>
            ) : null}
            {mode !== 'view' ? <Button variant="ghost" onClick={() => setMode('view')}>Cancel</Button> : null}
            <Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/decisions`}>Decision memory</Link>
          </>
        }
      />
      <ErrorAlert title="Could not load the decision" error={q.error ?? withdraw.error} />
      {d && meta.data && mode === 'edit' ? (
        <DecisionForm orgId={orgId} meta={meta.data} decisionId={d.id} initial={{ ...d, assumptions: d.assumptions.map((a) => ({ text: a.text })), outcomes: d.outcomes.map((o) => ({ kpi: o.kpi, comparator: o.comparator, target: o.target, measureMonth: o.measureMonth })) }} onSaved={refresh} />
      ) : d ? (
        <div className="space-y-4">
          <Card>
            <div className="space-y-3 p-5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={STATUS[d.status].tone}>{STATUS[d.status].label}</Badge>
                {d.verdict ? <Badge tone={VERDICT[d.verdict].tone}>{VERDICT[d.verdict].label}</Badge> : null}
                {d.reviewOverdue ? <Badge tone="warning">Review was due {date(d.reviewDue!)}</Badge> : d.reviewDue && d.status === 'ACTIVE' ? <span className="text-sm text-fg-muted">Review by {date(d.reviewDue)}</span> : null}
                {d.tags.map((t) => <Badge key={t}>{t}</Badge>)}
              </div>
              <div>
                <h2 className="text-xs font-medium uppercase tracking-wide text-fg-muted">What was decided</h2>
                <p className="mt-1 whitespace-pre-line text-sm">{d.decision}</p>
              </div>
              {d.context ? (
                <div>
                  <h2 className="text-xs font-medium uppercase tracking-wide text-fg-muted">Why</h2>
                  <p className="mt-1 whitespace-pre-line text-sm text-fg-muted">{d.context}</p>
                </div>
              ) : null}
              <p className="text-xs text-fg-muted">
                Recorded by {who(d.createdById)} on {dateTime(d.createdAt)}
                {d.source ? (
                  <>
                    {' · From '}
                    {d.source.path ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}${d.source.path}`}>{d.source.label}</Link> : d.source.label}
                  </>
                ) : null}
              </p>
            </div>
          </Card>

          <Card>
            <CardHeader title="Expected outcomes" description={d.status === 'REVIEWED' ? 'As measured when the decision was reviewed.' : 'Measured from the posted books once each month is over, against the month before the decision.'} />
            {d.outcomes.length ? (
              <Table aria-label="Expected outcomes">
                <thead>
                  <tr>
                    <Th>Measure</Th>
                    <Th>Target</Th>
                    <Th numeric>Before</Th>
                    <Th numeric>Actual</Th>
                    <Th>Result</Th>
                  </tr>
                </thead>
                <tbody>
                  {d.outcomes.map((o) => (
                    <Tr key={`${o.kpi}-${o.measureMonth}`}>
                      <Td>
                        <span className="font-medium">{o.label}</span>
                        <p className="max-w-[460px] text-xs text-fg-muted">{o.explanation}</p>
                      </Td>
                      <Td className="whitespace-nowrap text-sm">
                        {o.comparator === 'AT_LEAST' ? 'At least ' : 'At most '}
                        <Value o={o} v={o.target} currency={d.currency} /> in {monthName(o.measureMonth)}
                      </Td>
                      <Td numeric>
                        <Value o={o} v={o.baseline} currency={d.currency} />
                        <span className="block text-xs text-fg-muted">{monthName(o.baselineMonth)}</span>
                      </Td>
                      <Td numeric><Value o={o} v={o.actual} currency={d.currency} /></Td>
                      <Td><Badge tone={OUTCOME[o.status].tone}>{OUTCOME[o.status].label}</Badge></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <p className="px-5 pb-5 text-sm text-fg-muted">No expected outcomes were set.{manage && d.status === 'ACTIVE' ? ' Edit the decision to add measures to check.' : ''}</p>
            )}
          </Card>

          <Card>
            <CardHeader title="Assumptions" />
            {d.assumptions.length ? (
              <ul className="divide-y divide-line" aria-label="Assumptions">
                {d.assumptions.map((a, i) => (
                  <li key={i} className="flex items-start justify-between gap-3 px-5 py-3 text-sm">
                    <div>
                      <p>{a.text}</p>
                      {a.note ? <p className="text-xs text-fg-muted">{a.note}</p> : null}
                    </div>
                    {d.status === 'REVIEWED' ? <Badge tone={a.held === true ? 'positive' : a.held === false ? 'negative' : 'neutral'}>{a.held === true ? 'Held' : a.held === false ? 'Did not hold' : 'Not known'}</Badge> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 pb-5 text-sm text-fg-muted">No assumptions were recorded.</p>
            )}
          </Card>

          {d.status === 'REVIEWED' ? (
            <Card>
              <CardHeader title="What happened and lessons learned" description={`Reviewed by ${who(d.reviewedById)} on ${dateTime(d.reviewedAt!)}`} />
              <div className="space-y-3 px-5 pb-5 text-sm">
                {d.outcomeNotes ? <p className="whitespace-pre-line">{d.outcomeNotes}</p> : null}
                <div>
                  <h2 className="text-xs font-medium uppercase tracking-wide text-fg-muted">Lessons learned</h2>
                  <p className="mt-1 whitespace-pre-line" aria-label="Lessons learned">{d.lessons}</p>
                </div>
              </div>
            </Card>
          ) : null}
          {d.status === 'WITHDRAWN' ? (
            <Card>
              <CardHeader title="Withdrawn" description={`By ${who(d.withdrawnById)} on ${dateTime(d.withdrawnAt!)}`} />
              <p className="px-5 pb-5 text-sm">{d.withdrawnReason}</p>
            </Card>
          ) : null}
          {mode === 'review' && meta.data ? <Review orgId={orgId} d={d} meta={meta.data} onDone={refresh} /> : null}
        </div>
      ) : (
        <p className="text-sm text-fg-muted">Loading…</p>
      )}
    </>
  );
}
