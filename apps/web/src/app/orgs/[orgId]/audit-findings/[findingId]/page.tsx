'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, Field, Select, Textarea } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { FINDING_STATUS, SEVERITY, type Finding } from '@/components/controls/findings';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, dateTime } from '@/lib/format';
import { useOrg } from '@/lib/org';

/** One audit finding: what was found, the plan, every update, and closing it. */
export default function FindingPage() {
  const { org, orgId } = useOrg();
  const { findingId } = useParams<{ findingId: string }>();
  const qc = useQueryClient();
  const base = `/v1/orgs/${orgId}/audit-findings/${findingId}`;
  const key = ['audit-finding', orgId, findingId];
  const q = useQuery({ queryKey: key, queryFn: () => api<Finding>(base) });
  const [next, setNext] = useState('');
  const [note, setNote] = useState('');
  const [closeNote, setCloseNote] = useState('');
  const saved = (f: Finding) => {
    qc.setQueryData(key, f);
    void qc.invalidateQueries({ queryKey: ['audit-findings', orgId] });
    setNote('');
    setNext('');
    setCloseNote('');
  };
  const progress = useMutation({ mutationFn: () => api<Finding>(`${base}/progress`, { method: 'POST', body: { status: next, note } }), onSuccess: saved });
  const close = useMutation({ mutationFn: () => api<Finding>(`${base}/close`, { method: 'POST', body: { note: closeNote } }), onSuccess: saved });
  if (!org) return null;
  if (q.error) return <ErrorAlert title="Could not load the finding" error={q.error} />;
  const f = q.data;
  if (!f) return null;
  const moves = f.status === 'OPEN' ? ['IN_PROGRESS', 'READY_FOR_REVIEW'] : f.status === 'IN_PROGRESS' ? ['READY_FOR_REVIEW'] : f.status === 'READY_FOR_REVIEW' ? ['IN_PROGRESS'] : [];
  return (
    <>
      <PageHeader
        title={`${f.reference}: ${f.title}`}
        description={<>Raised by {f.raisedBy.name} on {date(f.raisedAt.slice(0, 10))}. Remediation owner: {f.owner.name}, due {date(f.dueDate)}. <Link className="text-accent" href={`/orgs/${orgId}/audit-findings`}>All findings</Link></>}
        actions={<><Badge tone={SEVERITY[f.severity].tone}>{SEVERITY[f.severity].label} severity</Badge> <Badge tone={FINDING_STATUS[f.status].tone}>{FINDING_STATUS[f.status].label}</Badge>{f.overdue ? <> <Badge tone="negative">Overdue</Badge></> : null}</>}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="What was found" description={f.control ? <>From a failed test of <Link className="text-accent" href={`/orgs/${orgId}/controls/${f.control.id}`}>{f.control.title}</Link> for {f.testPeriodKey}</> : 'Raised by hand'} />
          <div className="space-y-3 p-4 text-sm">
            <p className="whitespace-pre-line">{f.description}</p>
            <div><div className="text-xs font-medium uppercase tracking-wide text-fg-muted">Remediation plan</div><p className="whitespace-pre-line">{f.plan}</p></div>
          </div>
        </Card>
        <Card>
          <CardHeader title="Finding history" description="Every update, oldest first" />
          <ol className="space-y-3 p-4 text-sm" aria-label="Finding history">
            {f.updates.map((u, i) => (
              <li key={i} className="border-l-2 border-line pl-3">
                <div><Badge tone={FINDING_STATUS[u.status].tone}>{FINDING_STATUS[u.status].label}</Badge> <span className="text-fg-muted">{u.by.name}, {dateTime(u.at)}</span></div>
                <div>{u.note}</div>
              </li>
            ))}
          </ol>
        </Card>
      </div>
      {f.canUpdate && moves.length ? (
        <Card className="mt-4">
          <CardHeader title="Record progress" description="The remediation owner says what was done and moves the finding on" />
          <form
            className="flex flex-col gap-3 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              progress.mutate();
            }}
          >
            <Field label="Move to">
              {(p) => (
                <Select {...p} className="w-56" value={next} onChange={(e) => setNext(e.target.value)}>
                  <option value="">Choose…</option>
                  {moves.map((m) => <option key={m} value={m}>{FINDING_STATUS[m as Finding['status']].label}</option>)}
                </Select>
              )}
            </Field>
            <Field label="What was done">{(p) => <Textarea {...p} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="At least 10 characters" />}</Field>
            <div><Button type="submit" size="sm" disabled={!next || note.trim().length < 10} loading={progress.isPending}>Save progress</Button></div>
            <ErrorAlert title="The progress was not saved" error={progress.error} />
          </form>
        </Card>
      ) : null}
      {f.canClose ? (
        <Card className="mt-4">
          <CardHeader title="Close the finding" description={f.control ? 'Closes once a later test of the control has passed. You cannot close a finding you were fixing.' : 'Check the fix, then close it. You cannot close a finding you were fixing.'} />
          <form
            className="flex flex-col gap-3 p-4"
            onSubmit={(e) => {
              e.preventDefault();
              close.mutate();
            }}
          >
            <Field label="What you checked">{(p) => <Textarea {...p} rows={2} maxLength={1000} value={closeNote} onChange={(e) => setCloseNote(e.target.value)} placeholder="At least 10 characters" />}</Field>
            <div><Button type="submit" size="sm" disabled={closeNote.trim().length < 10} loading={close.isPending}>Close finding</Button></div>
            <ErrorAlert title="The finding was not closed" error={close.error} />
          </form>
        </Card>
      ) : null}
      {f.status === 'CLOSED' ? <p className="mt-4 text-sm text-fg-muted">Closed by {f.closedBy?.name} on {date((f.closedAt ?? '').slice(0, 10))}. A closed finding is kept as it was closed.</p> : null}
    </>
  );
}
