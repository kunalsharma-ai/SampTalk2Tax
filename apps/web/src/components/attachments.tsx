'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, CardHeader, Dialog, Field, Input } from '@talk2tax/ui';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { api, uploadFile } from '@/lib/api';
import { date } from '@/lib/format';
import { shrinkPhoto } from '@/lib/photo';
import { useOrg } from '@/lib/org';
import type { Attachment, AttachmentEntity, AttachmentVersion } from '@/lib/types';

const ACCEPT = 'application/pdf,image/png,image/jpeg,image/webp,.pdf,.png,.jpg,.jpeg,.webp';

function size(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Receipts, invoices and other evidence for one record. Files are kept as they were
 * uploaded; removing one keeps a record of it with the reason, and a new version of a file
 * keeps the earlier ones in its history (AUDIT-007).
 */
/** `onChanged` runs after files are added or removed, for records whose own checks depend on them. */
export function AttachmentsPanel({ entityType, entityId, canManage, description, onChanged }: { entityType: AttachmentEntity; entityId: string; canManage: boolean; description?: string; onChanged?: () => unknown }) {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const [removing, setRemoving] = useState<Attachment | null>(null);
  const [reason, setReason] = useState('');
  const [versioning, setVersioning] = useState<Attachment | null>(null);
  const [versionFile, setVersionFile] = useState<File | null>(null);
  const [versionNote, setVersionNote] = useState('');
  const [historyOf, setHistoryOf] = useState<string | null>(null);
  const base = `/v1/orgs/${orgId}/attachments`;
  const key = ['attachments', orgId, entityType, entityId, showRemoved];
  const files = useQuery({ queryKey: key, queryFn: () => api<Attachment[]>(`${base}?entityType=${entityType}&entityId=${entityId}&includeRemoved=${showRemoved}`) });
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['attachments', orgId, entityType, entityId] });
    await onChanged?.();
  };
  const upload = useMutation({
    mutationFn: async (list: File[]) => {
      for (const original of list) {
        // A large phone photo is redrawn smaller first, so it fits the 5 MB limit and stays legible.
        const f = await shrinkPhoto(original);
        await uploadFile<Attachment>(`${base}?entityType=${entityType}&entityId=${entityId}&fileName=${encodeURIComponent(f.name)}`, f);
      }
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
  // Document versioning (AUDIT-007): a new version replaces the file here; earlier ones stay in its history.
  const addVersion = useMutation({
    mutationFn: async () => {
      if (!versioning || !versionFile) return;
      const f = await shrinkPhoto(versionFile);
      await uploadFile<Attachment>(`${base}/${versioning.id}/versions?fileName=${encodeURIComponent(f.name)}&note=${encodeURIComponent(versionNote.trim())}`, f);
    },
    onSuccess: async () => {
      setVersioning(null);
      setHistoryOf(null);
      await refresh();
    },
  });
  const history = useQuery({ queryKey: ['attachment-versions', orgId, historyOf], queryFn: () => api<AttachmentVersion[]>(`${base}/${historyOf}/versions`), enabled: !!historyOf });
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
                <input
                  ref={camera}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="sr-only"
                  aria-label="Photo from camera"
                  onChange={(e) => {
                    const list = Array.from(e.target.files ?? []);
                    e.target.value = '';
                    if (list.length) upload.mutate(list);
                  }}
                />
                {/* Phones and tablets open the camera straight away; elsewhere the button is hidden. */}
                <Button size="sm" variant="secondary" className="hidden pointer-coarse:inline-flex" disabled={upload.isPending} onClick={() => { upload.reset(); camera.current?.click(); }}>Take a photo</Button>
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
                  {(a.version ?? 1) > 1 ? ` · version ${a.version}: ${a.versionNote ?? ''}` : ''}
                </p>
                {historyOf === a.id ? (
                  <ol className="mt-2 space-y-1 border-l-2 border-border pl-3 text-xs" aria-label={`Versions of ${a.fileName}`}>
                    {history.error ? <li className="text-negative">{(history.error as Error).message}</li> : null}
                    {(history.data ?? []).map((v) => (
                      <li key={v.id}>
                        <span className="font-medium">Version {v.version}</span>{v.current ? ' (in use)' : ''}:{' '}
                        {v.removedAt ? <span className="line-through">{v.fileName}</span> : <a className="text-accent hover:underline" href={`/api/t2t${base}/${v.id}/content?inline=1`} target="_blank" rel="noopener noreferrer">{v.fileName}</a>}
                        <span className="text-fg-muted"> · {size(v.sizeBytes)} · added {date(v.createdAt.slice(0, 10))}{v.uploadedBy ? ` by ${v.uploadedBy}` : ''}{v.note ? ` · ${v.note}` : ''}</span>
                      </li>
                    ))}
                  </ol>
                ) : null}
                {a.alsoOn?.length ? (
                  <p className="mt-1 text-xs text-warning">
                    The same file is also on{' '}
                    {a.alsoOn.map((o, i) => (
                      <span key={`${o.entityType}:${o.entityId}`}>
                        {i ? ', ' : ''}
                        {o.path ? <Link className="underline" href={`/orgs/${orgId}/${o.path}`}>{o.label}</Link> : o.label}
                      </span>
                    ))}
                    . Check it is not counted twice.
                  </p>
                ) : null}
              </div>
              {!a.removedAt ? (
                <div className="flex gap-1">
                  <a href={`/api/t2t${base}/${a.id}/content`} className="rounded px-2 py-1 text-xs text-fg-muted hover:text-fg" download>Download</a>
                  {(a.version ?? 1) > 1 ? <Button size="sm" variant="ghost" aria-expanded={historyOf === a.id} onClick={() => setHistoryOf(historyOf === a.id ? null : a.id)}>Versions</Button> : null}
                  {canManage ? <Button size="sm" variant="ghost" onClick={() => { addVersion.reset(); setVersionFile(null); setVersionNote(''); setVersioning(a); }}>New version…</Button> : null}
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
      <Dialog open={!!versioning} onOpenChange={(o) => !o && setVersioning(null)} title={`New version of ${versioning?.fileName ?? 'file'}`} description="The new file takes this one's place. The earlier version is kept as it was and stays in the file's history.">
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); addVersion.mutate(); }}>
          {addVersion.error ? <Alert title="Could not upload the new version">{addVersion.error.message}</Alert> : null}
          <Field label="New file">{(p) => <input {...p} type="file" accept={ACCEPT} className="text-sm" onChange={(e) => setVersionFile(e.target.files?.[0] ?? null)} />}</Field>
          <Field label="What changed">{(p) => <Input {...p} required minLength={3} maxLength={500} value={versionNote} onChange={(e) => setVersionNote(e.target.value)} placeholder="Such as: signed copy" />}</Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setVersioning(null)}>Cancel</Button>
            <Button type="submit" disabled={!versionFile || versionNote.trim().length < 3} loading={addVersion.isPending}>Upload version</Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}
