'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, Field, Table, Td, Textarea, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { AttachmentsPanel } from '@/components/attachments';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { EVIDENCE_STATUS, type EvidenceRequest } from '@/components/controls/evidence';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, dateTime } from '@/lib/format';
import { useOrg } from '@/lib/org';

/** One evidence request: what is asked for, the files, and its submission and acceptance. */
export default function EvidenceRequestPage() {
  const { org, orgId } = useOrg();
  const { requestId } = useParams<{ requestId: string }>();
  const qc = useQueryClient();
  const base = `/v1/orgs/${orgId}/audit-evidence/${requestId}`;
  const key = ['audit-evidence-request', orgId, requestId];
  const q = useQuery({ queryKey: key, queryFn: () => api<EvidenceRequest>(base) });
  const [note, setNote] = useState('');
  const [reviewNote, setReviewNote] = useState('');
  const done = (r: EvidenceRequest) => {
    qc.setQueryData(key, r);
    void qc.invalidateQueries({ queryKey: ['audit-evidence', orgId] });
    void qc.invalidateQueries({ queryKey: ['attachments', orgId, 'AUDIT_EVIDENCE', requestId] });
  };
  const submit = useMutation({ mutationFn: () => api<EvidenceRequest>(`${base}/submit`, { method: 'POST', body: { note } }), onSuccess: (r) => { done(r); setNote(''); } });
  const review = useMutation({ mutationFn: (decision: 'ACCEPT' | 'RETURN') => api<EvidenceRequest>(`${base}/review`, { method: 'POST', body: { decision, note: reviewNote } }), onSuccess: (r) => { done(r); setReviewNote(''); } });
  if (!org) return null;
  if (q.error) return <ErrorAlert title="Could not load the evidence request" error={q.error} />;
  const r = q.data;
  if (!r) return null;
  const st = EVIDENCE_STATUS[r.status];
  return (
    <>
      <PageHeader
        title={`${r.reference}: ${r.title}`}
        description={<>Asked of {r.owner.name} by {r.requestedBy.name} for <Link className="text-accent" href={`/orgs/${orgId}/audit-engagements/${r.engagement.id}`}>{r.engagement.reference} {r.engagement.name}</Link>, due {date(r.dueDate)}. <Link className="text-accent" href={`/orgs/${orgId}/audit-evidence`}>All evidence</Link></>}
        actions={<>{r.overdue ? <Badge tone="negative">Overdue</Badge> : null} <Badge tone={st.tone}>{st.label}</Badge></>}
      />
      {r.details ? <p className="mb-4 text-sm">{r.details}</p> : null}
      <AttachmentsPanel
        entityType="AUDIT_EVIDENCE"
        entityId={r.id}
        canManage={r.canUpload}
        description={r.status === 'REQUESTED' ? 'Attach the evidence asked for (PDF, PNG, JPEG or WebP, up to 5 MB each), then submit it below.' : 'The files submitted. They cannot change while the evidence is being checked or once it is accepted.'}
        onChanged={() => qc.invalidateQueries({ queryKey: key })}
      />
      {r.canUpload ? (
        <Card className="mt-4">
          <CardHeader title="Submit the evidence" description="Submits every file attached above. The audit lead or reviewer then checks it." />
          <div className="flex flex-col gap-3 p-4">
            <Field label="Note for the auditor" hint="Optional">{(p) => <Textarea {...p} rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
            <div><Button size="sm" loading={submit.isPending} onClick={() => submit.mutate()}>Submit evidence</Button></div>
            <ErrorAlert title="The evidence was not submitted" error={submit.error} />
          </div>
        </Card>
      ) : null}
      {r.status !== 'REQUESTED' ? (
        <Card className="mt-4">
          <CardHeader title="Files submitted" description={r.status === 'ACCEPTED' ? `Accepted by ${r.acceptedBy?.name} on ${dateTime(r.acceptedAt ?? '')}. Kept exactly as accepted.` : `Submitted by ${r.submittedBy?.name} on ${dateTime(r.submittedAt ?? '')}.`} />
          <Table aria-label="Files submitted">
            <thead><Tr><Th>File</Th><Th>SHA-256</Th></Tr></thead>
            <tbody>{r.files.map((f) => <Tr key={f.attachmentId}><Td>{f.fileName}</Td><Td className="font-mono text-xs break-all">{f.sha256}</Td></Tr>)}</tbody>
          </Table>
          {r.canReview ? (
            <div className="flex flex-col gap-3 border-t border-line p-4">
              <Field label="What you checked, or what is missing" hint="At least 10 characters to return it">{(p) => <Textarea {...p} rows={2} maxLength={1000} value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} />}</Field>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" loading={review.isPending && review.variables === 'ACCEPT'} onClick={() => review.mutate('ACCEPT')}>Accept evidence</Button>
                <Button size="sm" variant="secondary" disabled={reviewNote.trim().length < 10} loading={review.isPending && review.variables === 'RETURN'} onClick={() => review.mutate('RETURN')}>Return it</Button>
              </div>
              <ErrorAlert title="That did not work" error={review.error} />
            </div>
          ) : null}
        </Card>
      ) : null}
      <Card className="mt-4">
        <CardHeader title="Evidence history" description="Every step, oldest first. Kept as recorded." />
        <Table aria-label="Evidence history">
          <thead><Tr><Th>When</Th><Th>Who</Th><Th>What</Th></Tr></thead>
          <tbody>
            {r.history.map((h, i) => (
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
