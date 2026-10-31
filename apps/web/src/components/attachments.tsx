'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, CardHeader, Dialog, Field, Input } from '@talk2tax/ui';
import { useRef, useState } from 'react';
import { api, uploadFile } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import type { Attachment, AttachmentEntity } from '@/lib/types';

const ACCEPT = 'application/pdf,image/png,image/jpeg,image/webp,.pdf,.png,.jpg,.jpeg,.webp';

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Receipts, invoices and other evidence for one record. Files are kept as they were
 * uploaded; removing one keeps a record of it with the reason.
 */
export function AttachmentsPanel({ entityType, entityId, canManage, description }: { entityType: AttachmentEntity; entityId: string; canManage: boolean; description?: string }) {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const [removing, setRemoving] = useState<Attachment | null>(null);
  const [reason, setReason] = useState('');
  const base = `/v1/orgs/${orgId}/attachments`;
  const key = ['attachments', orgId, entityType, entityId, showRemoved];
  const files = useQuery({ queryKey: key, queryFn: () => api<Attachment[]>(`${base}?entityType=${entityType}&entityId=${entityId}&includeRemoved=${showRemoved}`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['attachments', orgId, entityType, entityId] });
  const upload = useMutation({
    mutationFn: async (list: File[]) => {
      for (const f of list) await uploadFile<Attachment>(`${base}?entityType=${entityType}&entityId=${entityId}&fileName=${encodeURIComponent(f.name)}`, f);
    },
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (a: Attachment) => api(`${base}/${a.id}/remove`, { method: 'POST', body: { reason } }),
    onSuccess: async () => {
      setRemoving(null);
      await refresh();
    },
  });
  const rows = files.data ?? [];
  return (
    <Card className="mt-6">
      <CardHeader
        title="Attachments"
        description={description ?? 'PDF, PNG, JPEG or WebP, up to 5 MB each. Files are kept exactly as uploaded.'}
        actions={
          <>
            <label className="flex items-center gap-2 text-xs text-fg-muted">
              <input type="checkbox" className="accent-[var(--t2t-accent)]" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} /> Show removed
            </label>
            {canManage ? (
              <>
                <input
                  ref={input}
                  type="file"
                  multiple
                  accept={ACCEPT}
                  className="sr-only"
                  aria-label="Attach files"
                  onChange={(e) => {
                    const list = Array.from(e.target.files ?? []);
                    e.target.value = '';
                    if (list.length) upload.mutate(list);
                  }}
                />
                <Button size="sm" variant="secondary" loading={upload.isPending} onClick={() => { upload.reset(); input.current?.click(); }}>Attach files</Button>
              </>
            ) : null}
          </>
        }
      />
      {upload.error ? <div className="px-5 pb-3"><Alert title="Could not attach the file">{upload.error.message}</Alert></div> : null}
      {files.error ? <p className="px-5 py-4 text-sm text-negative">{(files.error as Error).message}</p> : null}
      {files.data && rows.length === 0 ? <p className="px-5 py-4 text-sm text-fg-muted">No files attached.</p> : null}
      {rows.length ? (
        <ul className="divide-y divide-border" aria-label="Attached files">
          {rows.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-sm">
              <div className="min-w-0 flex-1">
                {a.removedAt ? (
                  <span className="text-fg-muted line-through">{a.fileName}</span>
                ) : (
                  <a className="break-all text-accent hover:underline" href={`/api/t2t${base}/${a.id}/content?inline=1`} target="_blank" rel="noopener noreferrer">{a.fileName}</a>
                )}
                <p className="text-xs text-fg-muted">
                  {a.contentType.replace('application/', '').replace('image/', '').toUpperCase()} · {size(a.sizeBytes)} · added {date(a.createdAt.slice(0, 10))}{a.uploadedBy ? ` by ${a.uploadedBy}` : ''}
                  {a.removedAt ? ` · removed: ${a.removedReason}` : ''}
                </p>
              </div>
              {!a.removedAt ? (
                <div className="flex gap-1">
                  <a href={`/api/t2t${base}/${a.id}/content`} className="rounded px-2 py-1 text-xs text-fg-muted hover:text-fg" download>Download</a>
                  {canManage ? <Button size="sm" variant="ghost" onClick={() => { remove.reset(); setReason(''); setRemoving(a); }}>Remove…</Button> : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <Dialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)} title={`Remove ${removing?.fileName ?? 'file'}`} description="The file stops showing here, but a record of it and your reason stay in the audit trail.">
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); if (removing) remove.mutate(removing); }}>
          {remove.error ? <Alert title="Could not remove">{remove.error.message}</Alert> : null}
          <Field label="Reason">{(p) => <Input {...p} required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setRemoving(null)}>Cancel</Button>
            <Button type="submit" variant="danger" loading={remove.isPending}>Remove file</Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}
