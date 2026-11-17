'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useParams } from 'next/navigation';
import { useRef, useState } from 'react';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { NoticeUrgency } from '@/components/tax-notice-bits';
import { api, ApiError, uploadFile } from '@/lib/api';
import { date, today } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { OUTCOMES, type TaxNotice, type TaxNoticeOutcome } from '@/lib/tax-notices';
import { can } from '@/lib/types';

const KIND: Record<TaxNotice['history'][number]['kind'], string> = { RECEIVED: 'Received', UPDATED: 'Details changed', NOTE: 'Note', FILE: 'File added', RESPONDED: 'Reply sent', CLOSED: 'Closed', REOPENED: 'Reopened' };
type Step = 'note' | 'respond' | 'close' | 'reopen';

function Issues({ error }: { error: unknown }) {
  return error instanceof ApiError && error.issues.length ? <ul className="mt-1 list-disc pl-5">{error.issues.map((i) => <li key={i}>{i}</li>)}</ul> : null;
}

export default function TaxNoticePage() {
  const { org, orgId } = useOrg();
  const { noticeId } = useParams<{ noticeId: string }>();
  const qc = useQueryClient();
  const base = `/v1/orgs/${orgId}/tax-notices/${noticeId}`;
  const q = useQuery({ queryKey: ['tax-notice', orgId, noticeId], queryFn: () => api<TaxNotice>(base) });
  const [step, setStep] = useState<Step | null>(null);
  const [text, setText] = useState('');
  const [on, setOn] = useState(today());
  const [outcome, setOutcome] = useState<TaxNoticeOutcome>('DROPPED');
  const input = useRef<HTMLInputElement>(null);
  const done = async () => {
    setStep(null);
    setText('');
    await qc.invalidateQueries({ queryKey: ['tax-notice', orgId, noticeId] });
    await qc.invalidateQueries({ queryKey: ['tax-notices', orgId] });
  };
  const run = useMutation({
    mutationFn: (s: Step) => api<TaxNotice>(`${base}/${s === 'note' ? 'notes' : s}`, { method: 'POST', body: s === 'respond' ? { on, text } : s === 'close' ? { outcome, text } : { text } }),
    onSuccess: done,
  });
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const f of files) await uploadFile(`${base}/files?fileName=${encodeURIComponent(f.name)}`, f);
    },
    onSettled: done,
  });
  if (!org || !q.data) return q.error ? <Alert title="Could not load">{(q.error as Error).message}</Alert> : null;
  const n = q.data;
  const manage = can(org.role, 'accounts.manage');
  const open = (s: Step) => {
    run.reset();
    setText('');
    setOn(today());
    setStep(s);
  };
  return (
    <>
      <PageHeader
        title={`${n.authorityLabel} notice ${n.reference}`}
        description={n.subject}
        actions={
          manage ? (
            <>
              <Button variant="ghost" onClick={() => open('note')}>Add a note</Button>
              {n.status === 'OPEN' ? <Button variant="secondary" onClick={() => open('respond')}>Record the reply</Button> : null}
              {n.status !== 'CLOSED' ? <Button onClick={() => open('close')}>Close…</Button> : <Button variant="secondary" onClick={() => open('reopen')}>Reopen…</Button>}
            </>
          ) : null
        }
      />
      {step ? (
        <Card className="mb-6">
          <CardHeader title={{ note: 'Add a note', respond: 'Record the reply', close: 'Close the notice', reopen: 'Reopen the notice' }[step]} />
          <form className="grid gap-4 p-5 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); run.mutate(step); }}>
            {step === 'respond' ? <Field label="Sent on">{(p) => <Input {...p} type="date" required min={n.receivedOn} max={today()} value={on} onChange={(e) => setOn(e.target.value)} />}</Field> : null}
            {step === 'close' ? <Field label="Outcome">{(p) => <Select {...p} value={outcome} onChange={(e) => setOutcome(e.target.value as TaxNoticeOutcome)}>{Object.entries(OUTCOMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}</Field> : null}
            <div className={step === 'respond' || step === 'close' ? 'sm:col-span-2' : 'sm:col-span-3'}>
              <Field label={{ note: 'Note', respond: 'What was sent', close: 'How it ended', reopen: 'Why it is reopened' }[step]}>{(p) => <Input {...p} required minLength={step === 'note' ? 1 : 3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />}</Field>
            </div>
            {run.error ? <div className="sm:col-span-3"><Alert title="Not saved">{run.error.message}<Issues error={run.error} /></Alert></div> : null}
            <div className="flex justify-end gap-2 sm:col-span-3">
              <Button type="button" variant="ghost" onClick={() => setStep(null)}>Cancel</Button>
              <Button type="submit" loading={run.isPending}>Save</Button>
            </div>
          </form>
        </Card>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="p-4"><p className="text-xs uppercase tracking-wide text-fg-muted">Status</p><div className="mt-2"><NoticeUrgency n={n} /></div></Card>
        <Card className="p-4"><p className="text-xs uppercase tracking-wide text-fg-muted">Reply due</p><p className="mt-2 text-sm">{n.responseDue ? date(n.responseDue) : 'No deadline'}</p><p className="text-xs text-fg-muted">Received {date(n.receivedOn)}</p></Card>
        <Card className="p-4"><p className="text-xs uppercase tracking-wide text-fg-muted">Amount demanded</p><p className="mt-2 text-sm">{n.demand ? <Money value={n.demand} currency={org.functionalCurrency} /> : 'None'}</p></Card>
        <Card className="p-4"><p className="text-xs uppercase tracking-wide text-fg-muted">Details</p><p className="mt-2 text-sm">{[n.section, n.period].filter(Boolean).join(' · ') || '—'}</p><p className="text-xs text-fg-muted">{n.assignee ? `With ${n.assignee}` : 'Not given to anyone'}</p></Card>
      </div>
      <Card className="mt-6">
        <CardHeader
          title="Notice files"
          description="The letter, the reply sent, orders and challans. PDF, PNG, JPEG or WebP, up to 5 MB each; kept exactly as uploaded."
          actions={
            manage ? (
              <>
                <input ref={input} type="file" aria-label="Add files" className="sr-only" accept="application/pdf,image/png,image/jpeg,image/webp" multiple onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ''; if (f.length) upload.mutate(f); }} />
                <Button size="sm" variant="secondary" loading={upload.isPending} onClick={() => input.current?.click()}>Add files</Button>
              </>
            ) : null
          }
        />
        {upload.error ? <div className="px-5 pb-3"><Alert title="Upload failed">{upload.error.message}<Issues error={upload.error} /></Alert></div> : null}
        {n.files.length ? (
          <Table>
            <thead><tr><Th>File</Th><Th>Added</Th><Th numeric>Size</Th></tr></thead>
            <tbody>
              {n.files.map((f) => (
                <Tr key={f.id}>
                  <Td><a className="text-accent hover:underline" href={`/api/t2t${base}/files/${f.id}/content?inline=1`} target="_blank" rel="noreferrer">{f.fileName}</a></Td>
                  <Td className="text-fg-muted">{date(f.createdAt.slice(0, 10))}{f.uploadedBy ? ` · ${f.uploadedBy}` : ''}</Td>
                  <Td numeric className="num">{Math.max(1, Math.round(f.sizeBytes / 1024))} KB</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : <p className="px-5 pb-5 text-sm text-fg-muted">No files yet.</p>}
      </Card>
      <Card className="mt-6" role="region" aria-label="Notice history">
        <CardHeader title="Notice history" description="Everything done on this notice, oldest first. It only grows." />
        <ol className="divide-y divide-line px-5 pb-4 text-sm">
          {n.history.map((h) => (
            <li key={h.id} className="flex flex-wrap items-baseline gap-3 py-2">
              <span className="w-28 shrink-0 text-fg-muted">{date(h.on)}</span>
              <Badge tone={h.kind === 'RESPONDED' ? 'accent' : h.kind === 'CLOSED' ? 'positive' : 'neutral'}>{KIND[h.kind]}</Badge>
              <span className="min-w-0 flex-1">{h.text ?? ''}</span>
              <span className="text-xs text-fg-muted">{h.by}</span>
            </li>
          ))}
        </ol>
      </Card>
    </>
  );
}
