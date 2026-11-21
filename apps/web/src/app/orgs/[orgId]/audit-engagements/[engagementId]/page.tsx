'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Field, Select, Stat, Table, Td, Textarea, Th, Tr, Input } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { ENGAGEMENT_STATUS, STEP_STATUS, type Engagement, type EngagementStatus } from '@/components/controls/engagements';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, dateTime } from '@/lib/format';
import { useOrg } from '@/lib/org';

interface Linkable {
  samples: { id: string; label: string }[];
  findings: { id: string; label: string }[];
}
type Members = { members: { id: string; name: string }[] };

/** One internal audit: its work programme, the samples and findings it uses, and its sign-off. */
export default function EngagementPage() {
  const { org, orgId } = useOrg();
  const { engagementId } = useParams<{ engagementId: string }>();
  const qc = useQueryClient();
  const base = `/v1/orgs/${orgId}/audit-engagements/${engagementId}`;
  const key = ['audit-engagement', orgId, engagementId];
  const q = useQuery({ queryKey: key, queryFn: () => api<Engagement>(base) });
  const e = q.data;
  const people = useQuery({ queryKey: ['audit-engagements', orgId], queryFn: () => api<Members>(`/v1/orgs/${orgId}/audit-engagements`), enabled: !!e?.canPlan });
  const linkable = useQuery({ queryKey: [...key, 'linkable'], queryFn: () => api<Linkable>(`${base}/linkable`), enabled: !!e?.canLink });
  const [step, setStep] = useState({ title: '', assigneeId: '' });
  const [work, setWork] = useState<Record<string, string>>({});
  const [backNote, setBackNote] = useState<Record<string, string>>({});
  const [link, setLink] = useState('');
  const [note, setNote] = useState('');
  const done = (x: Engagement) => {
    qc.setQueryData(key, x);
    void qc.invalidateQueries({ queryKey: ['audit-engagements', orgId] });
    void qc.invalidateQueries({ queryKey: [...key, 'linkable'] });
  };
  const addStep = useMutation({ mutationFn: () => api<Engagement>(`${base}/steps`, { method: 'POST', body: step }), onSuccess: (x) => { done(x); setStep({ title: '', assigneeId: step.assigneeId }); } });
  const doStep = useMutation({ mutationFn: (id: string) => api<Engagement>(`${base}/steps/${id}/done`, { method: 'POST', body: { work: work[id] ?? '' } }), onSuccess: done });
  const review = useMutation({ mutationFn: (v: { id: string; decision: 'SIGN_OFF' | 'REOPEN' }) => api<Engagement>(`${base}/steps/${v.id}/review`, { method: 'POST', body: { decision: v.decision, note: backNote[v.id] ?? '' } }), onSuccess: done });
  const addLink = useMutation({ mutationFn: () => { const [kind, id] = link.split(':'); return api<Engagement>(`${base}/links`, { method: 'POST', body: { kind, id } }); }, onSuccess: (x) => { done(x); setLink(''); } });
  const move = useMutation({ mutationFn: (status: EngagementStatus) => api<Engagement>(`${base}/move`, { method: 'POST', body: { status, note } }), onSuccess: (x) => { done(x); setNote(''); } });
  if (!org) return null;
  if (q.error) return <ErrorAlert title="Could not load the engagement" error={q.error} />;
  if (!e) return null;
  const st = ENGAGEMENT_STATUS[e.status];
  const assignable = (people.data?.members ?? []).filter((m) => m.id !== e.reviewer.id);
  return (
    <>
      <PageHeader
        title={`${e.reference}: ${e.name}`}
        description={<>{e.objective}{/[.!?]$/.test(e.objective) ? '' : '.'} Scope {date(e.scopeFrom)} to {date(e.scopeTo)}. Led by {e.lead.name}, reviewed by {e.reviewer.name}. <Link className="text-accent" href={`/orgs/${orgId}/audit-engagements`}>All engagements</Link></>}
        actions={<Badge tone={st.tone}>{st.label}</Badge>}
      />
      <div className="mb-4 grid gap-4 sm:grid-cols-4">
        <Stat label="Steps" value={e.progress.steps} />
        <Stat label="Done" value={`${e.progress.done} of ${e.progress.steps}`} tone={e.progress.steps && e.progress.done === e.progress.steps ? 'positive' : 'warning'} />
        <Stat label="Signed off" value={`${e.progress.signedOff} of ${e.progress.steps}`} tone={e.progress.steps && e.progress.signedOff === e.progress.steps ? 'positive' : 'neutral'} />
        <Stat label="Findings" value={e.findings.length} sub={`${e.findings.filter((f) => f.status !== 'CLOSED').length} open`} tone={e.findings.some((f) => f.status !== 'CLOSED') ? 'negative' : 'neutral'} />
      </div>
      <Card className="mb-4">
        <CardHeader title="Work programme" description="Each step is done by the person it is assigned to (or the lead), then signed off by the reviewer." />
        {!e.steps.length ? (
          <EmptyState title="No steps yet">{e.canPlan ? 'Add the first step below.' : 'The lead plans the steps.'}</EmptyState>
        ) : (
          <Table aria-label="Work programme">
            <thead><Tr><Th>Step</Th><Th>Assigned to</Th><Th>Work done</Th><Th>Status</Th></Tr></thead>
            <tbody>
              {e.steps.map((s) => (
                <Tr key={s.id}>
                  <Td>{s.title}</Td>
                  <Td className="text-sm">{s.assignee.name}</Td>
                  <Td className="text-sm">
                    {s.work && s.status !== 'OPEN' ? (
                      <>
                        <div>{s.work}</div>
                        <div className="text-xs text-fg-muted">{s.doneBy?.name}, {dateTime(s.doneAt ?? '')}</div>
                      </>
                    ) : s.canDo ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Input aria-label={`Work done on ${s.title}`} className="w-72" maxLength={4000} value={work[s.id] ?? ''} onChange={(x) => setWork({ ...work, [s.id]: x.target.value })} placeholder="What you did and found" />
                        <Button size="sm" variant="secondary" disabled={(work[s.id]?.trim().length ?? 0) < 10} loading={doStep.isPending && doStep.variables === s.id} onClick={() => doStep.mutate(s.id)}>Mark done</Button>
                      </div>
                    ) : <span className="text-fg-muted">Not done yet</span>}
                    {s.canReview ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Button size="sm" loading={review.isPending && review.variables?.id === s.id && review.variables.decision === 'SIGN_OFF'} onClick={() => review.mutate({ id: s.id, decision: 'SIGN_OFF' })}>Sign off</Button>
                        <Input aria-label={`What needs more work on ${s.title}`} className="w-56" maxLength={1000} value={backNote[s.id] ?? ''} onChange={(x) => setBackNote({ ...backNote, [s.id]: x.target.value })} placeholder="What needs more work" />
                        <Button size="sm" variant="secondary" disabled={(backNote[s.id]?.trim().length ?? 0) < 10} loading={review.isPending && review.variables?.id === s.id && review.variables.decision === 'REOPEN'} onClick={() => review.mutate({ id: s.id, decision: 'REOPEN' })}>Send back</Button>
                      </div>
                    ) : null}
                  </Td>
                  <Td>
                    <Badge tone={STEP_STATUS[s.status].tone}>{STEP_STATUS[s.status].label}</Badge>
                    {s.signedOffBy ? <div className="text-xs text-fg-muted">{s.signedOffBy.name}, {dateTime(s.signedOffAt ?? '')}</div> : null}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
        {e.canPlan ? (
          <form
            className="flex flex-wrap items-end gap-3 border-t border-line p-4"
            onSubmit={(x) => {
              x.preventDefault();
              addStep.mutate();
            }}
          >
            <Field label="New step">{(p) => <Input {...p} className="w-80" maxLength={200} value={step.title} onChange={(x) => setStep({ ...step, title: x.target.value })} placeholder="Such as Trace payments to approved bills" />}</Field>
            <Field label="Assign to">{(p) => <Select {...p} value={step.assigneeId} onChange={(x) => setStep({ ...step, assigneeId: x.target.value })}><option value="">Choose…</option>{assignable.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select>}</Field>
            <Button type="submit" size="sm" variant="secondary" disabled={step.title.trim().length < 3 || !step.assigneeId} loading={addStep.isPending}>Add step</Button>
          </form>
        ) : null}
        <div className="px-4 pb-4"><ErrorAlert title="That did not work" error={addStep.error ?? doStep.error ?? review.error} /></div>
      </Card>
      <Card className="mb-4">
        <CardHeader title="Samples and findings" description="Samples tested and findings raised for this audit, with where each one stands now. Linked samples must be fully tested before review." />
        {!e.samples.length && !e.findings.length ? <EmptyState title="Nothing linked yet">{e.canLink ? 'Link a sample or finding below.' : 'The lead links them.'}</EmptyState> : (
          <Table aria-label="Linked samples and findings">
            <thead><Tr><Th>Linked</Th><Th>Where it stands</Th></Tr></thead>
            <tbody>
              {e.samples.map((s) => (
                <Tr key={s.id}>
                  <Td><Link className="hover:text-accent" href={`/orgs/${orgId}/audit-samples/${s.id}`}>{s.reference} {s.name}</Link></Td>
                  <Td className="text-sm"><Badge tone={s.status === 'COMPLETED' ? 'positive' : 'warning'}>{s.status === 'COMPLETED' ? 'Tested' : 'Testing'}</Badge> {s.progress.tested} of {s.progress.tested + s.progress.remaining} tested{s.progress.exceptions ? `, ${s.progress.exceptions} with exceptions` : ''}</Td>
                </Tr>
              ))}
              {e.findings.map((f) => (
                <Tr key={f.id}>
                  <Td><Link className="hover:text-accent" href={`/orgs/${orgId}/audit-findings/${f.id}`}>{f.reference} {f.title}</Link></Td>
                  <Td className="text-sm"><Badge tone={f.status === 'CLOSED' ? 'positive' : 'negative'}>{f.status === 'CLOSED' ? 'Closed' : 'Open'}</Badge> {f.severity.toLowerCase()} severity</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
        {e.canLink && linkable.data && (linkable.data.samples.length || linkable.data.findings.length) ? (
          <div className="flex flex-wrap items-end gap-3 border-t border-line p-4">
            <Field label="Link a sample or finding">
              {(p) => (
                <Select {...p} value={link} onChange={(x) => setLink(x.target.value)}>
                  <option value="">Choose…</option>
                  {linkable.data.samples.length ? <optgroup label="Samples">{linkable.data.samples.map((s) => <option key={s.id} value={`SAMPLE:${s.id}`}>{s.label}</option>)}</optgroup> : null}
                  {linkable.data.findings.length ? <optgroup label="Findings">{linkable.data.findings.map((f) => <option key={f.id} value={`FINDING:${f.id}`}>{f.label}</option>)}</optgroup> : null}
                </Select>
              )}
            </Field>
            <Button size="sm" variant="secondary" disabled={!link} loading={addLink.isPending} onClick={() => addLink.mutate()}>Link</Button>
          </div>
        ) : null}
        <div className="px-4 pb-4"><ErrorAlert title="It was not linked" error={addLink.error} /></div>
      </Card>
      <Card className="mb-4">
        <CardHeader title="Sign-off" description={e.status === 'CLOSED' ? `Closed on ${date((e.closedAt ?? '').slice(0, 10))} by ${e.reviewer.name}. A closed engagement is kept as it was closed.` : 'The lead moves the audit to fieldwork and then to review; the reviewer sends it back or closes it with the conclusion.'} />
        <div className="flex flex-col gap-3 p-4 text-sm">
          {e.conclusion ? <p aria-label="Conclusion">{e.conclusion}</p> : null}
          {(e.isLead && (e.status === 'PLANNING' || e.status === 'FIELDWORK')) || (e.isReviewer && e.status === 'REVIEW') ? (
            <>
              <Field label={e.status === 'REVIEW' ? 'Conclusion, or what needs more work' : 'Note'} hint={e.status === 'REVIEW' ? 'At least 20 characters to close; 10 to send back' : 'Optional'}>{(p) => <Textarea {...p} rows={2} maxLength={4000} value={note} onChange={(x) => setNote(x.target.value)} />}</Field>
              <div className="flex flex-wrap gap-2">
                {e.status === 'PLANNING' ? <Button size="sm" loading={move.isPending} disabled={!e.steps.length} onClick={() => move.mutate('FIELDWORK')}>Start fieldwork</Button> : null}
                {e.status === 'FIELDWORK' ? <Button size="sm" loading={move.isPending} onClick={() => move.mutate('REVIEW')}>Send for review</Button> : null}
                {e.status === 'REVIEW' ? (
                  <>
                    <Button size="sm" loading={move.isPending && move.variables === 'CLOSED'} disabled={note.trim().length < 20} onClick={() => move.mutate('CLOSED')}>Close engagement</Button>
                    <Button size="sm" variant="secondary" loading={move.isPending && move.variables === 'FIELDWORK'} disabled={note.trim().length < 10} onClick={() => move.mutate('FIELDWORK')}>Send back to fieldwork</Button>
                  </>
                ) : null}
              </div>
            </>
          ) : e.status !== 'CLOSED' ? <p className="text-fg-muted">{e.status === 'REVIEW' ? `Waiting for ${e.reviewer.name} to review.` : `${e.lead.name} moves the engagement on.`}</p> : null}
          <ErrorAlert title="The engagement did not move" error={move.error} />
        </div>
      </Card>
      <Card>
        <CardHeader title="Engagement history" description="Every change, oldest first. Kept as recorded." />
        <Table aria-label="Engagement history">
          <thead><Tr><Th>When</Th><Th>Who</Th><Th>What</Th></Tr></thead>
          <tbody>
            {e.history.map((h, i) => (
              <Tr key={i}>
                <Td className="whitespace-nowrap text-sm">{dateTime(h.at)}</Td>
                <Td className="text-sm">{h.by.name}</Td>
                <Td className="text-sm">{h.action}{h.note ? <span className="text-fg-muted">: {h.note}</span> : null}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </>
  );
}
