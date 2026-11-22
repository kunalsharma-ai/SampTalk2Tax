'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, Field, Input } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { AttachmentsPanel } from '@/components/attachments';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import type { ComplianceDocument } from '@/components/tax/compliance-documents';
import { api } from '@/lib/api';
import { date, dateTime } from '@/lib/format';
import { useOrg } from '@/lib/org';

/** One compliance document: what it is, what it belongs to, and its files. */
export default function ComplianceDocumentPage() {
  const { org, orgId } = useOrg();
  const { documentId } = useParams<{ documentId: string }>();
  const qc = useQueryClient();
  const base = `/v1/orgs/${orgId}/compliance/documents/${documentId}`;
  const key = ['compliance-document', orgId, documentId];
  const q = useQuery({ queryKey: key, queryFn: () => api<ComplianceDocument>(base) });
  const [reason, setReason] = useState('');
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: key }), qc.invalidateQueries({ queryKey: ['compliance-documents', orgId] }), qc.invalidateQueries({ queryKey: ['compliance-document-gaps', orgId] })]);
  const voidIt = useMutation({ mutationFn: () => api<ComplianceDocument>(`${base}/void`, { method: 'POST', body: { reason } }), onSuccess: (d) => { qc.setQueryData(key, d); setReason(''); void refresh(); } });
  if (!org) return null;
  if (q.error) return <ErrorAlert title="Could not load the document" error={q.error} />;
  const d = q.data;
  if (!d) return null;
  return (
    <>
      <PageHeader
        title={`${d.reference}: ${d.title}`}
        description={<>{d.kindLabel}{d.obligation ? ` for ${d.obligation.name}, ${d.obligation.periodLabel}` : ' for the organisation'}{d.documentReference ? `, reference ${d.documentReference}` : ''}. Added by {d.addedBy} on {dateTime(d.addedAt)}. Keep until {d.retainUntil ? date(d.retainUntil) : 'the registration ends'}. <Link className="text-accent" href={`/orgs/${orgId}/tax/compliance-documents`}>All documents</Link></>}
        actions={<Badge tone={d.status === 'ACTIVE' ? 'positive' : 'neutral'}>{d.status === 'ACTIVE' ? 'On file' : 'Void'}</Badge>}
      />
      {d.note ? <p className="mb-4 text-sm">{d.note}</p> : null}
      {d.status === 'VOID' ? <p className="mb-4 text-sm text-fg-muted">Voided by {d.voidedBy} on {d.voidedAt ? dateTime(d.voidedAt) : ''}: {d.voidReason}</p> : null}
      <AttachmentsPanel
        entityType="COMPLIANCE_DOCUMENT"
        entityId={d.id}
        canManage={!!d.canManage}
        description={d.canManage ? 'Attach the acknowledgement, challan or other file (PDF, PNG, JPEG or WebP, up to 5 MB each). Files are kept exactly as uploaded.' : 'The files on this document.'}
        onChanged={refresh}
      />
      {d.canManage ? (
        <Card className="mt-6" role="region" aria-label="Void this record">
          <CardHeader title="Void this record" description="For a record added by mistake. It is kept, with the reason, and its files can no longer change." />
          <div className="flex flex-wrap items-end gap-2 p-4">
            <div className="w-96"><Field label="Reason">{(p) => <Input {...p} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field></div>
            <Button size="sm" variant="secondary" disabled={reason.trim().length < 3} loading={voidIt.isPending} onClick={() => voidIt.mutate()}>Void record</Button>
          </div>
          <div className="px-4 pb-4"><ErrorAlert title="The record was not voided" error={voidIt.error} /></div>
        </Card>
      ) : null}
    </>
  );
}
