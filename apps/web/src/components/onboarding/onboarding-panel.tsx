'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Textarea } from '@talk2tax/ui';
import { useRef, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { api, uploadFile } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { ONBOARDING_STATUS, type ContactOnboarding, type Onboarding } from '@/lib/onboarding';

const ACCEPT = 'application/pdf,image/png,image/jpeg,image/webp,.pdf,.png,.jpg,.jpeg,.webp';

function Tick({ done }: { done: boolean }) {
  return <span aria-hidden className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs ${done ? 'border-positive bg-positive/15 text-positive' : 'border-line text-fg-faint'}`}>{done ? '✓' : ''}</span>;
}

/**
 * A customer's onboarding on their page: details read from the customer, the organisation's
 * checklist with files, proposed credit terms, and submitting, approving or rejecting it.
 */
export function OnboardingPanel({ orgId, contactId, currency, onChange }: { orgId: string; contactId: string; currency: string; onChange: () => void }) {
  const qc = useQueryClient();
  const key = ['onboarding', orgId, contactId];
  const q = useQuery({ queryKey: key, queryFn: () => api<ContactOnboarding>(`/v1/orgs/${orgId}/sales/customers/${contactId}/onboarding`) });
  const base = `/v1/orgs/${orgId}/sales/onboardings`;
  const set = (o: Onboarding) => {
    qc.setQueryData(key, (old: ContactOnboarding | undefined) => ({ can: old?.can ?? { manage: false, decide: false, setUp: false }, onboarding: o }));
    void qc.invalidateQueries({ queryKey: ['onboardings', orgId] });
    onChange();
  };
  const start = useMutation({ mutationFn: () => api<Onboarding>(`/v1/orgs/${orgId}/sales/customers/${contactId}/onboarding`, { method: 'POST' }), onSuccess: set });
  const d = q.data;
  if (!d) return <ErrorAlert title="Could not load the onboarding" error={q.error} />;
  if (!d.onboarding) {
    if (!d.can.start) return null;
    return (
      <Card className="mt-6" role="region" aria-label="Customer onboarding">
        <CardHeader title="Customer onboarding" description="Collect this customer's details, documents and credit terms and have them approved. Until it is approved, invoices to them cannot be posted." />
        <div className="px-5 pb-5">
          <Button variant="secondary" loading={start.isPending} onClick={() => start.mutate()}>Start onboarding</Button>
          <ErrorAlert title="Could not start" error={start.error} />
        </div>
      </Card>
    );
  }
  return <OnboardingBody key={d.onboarding.id} o={d.onboarding} can={d.can} base={base} orgId={orgId} currency={currency} set={set} />;
}

function OnboardingBody({ o, can, base, orgId, currency, set }: { o: Onboarding; can: ContactOnboarding['can']; base: string; orgId: string; currency: string; set: (o: Onboarding) => void }) {
  const [terms, setTerms] = useState({ creditLimit: o.creditLimit ?? '', paymentTermsDays: o.paymentTermsDays === null ? '' : String(o.paymentTermsDays), notes: o.notes ?? '' });
  const [note, setNote] = useState('');
  const [fileFor, setFileFor] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const url = `${base}/${o.id}`;
  const open = o.status === 'OPEN';
  const manage = can.manage && open;
  const save = useMutation({ mutationFn: () => api<Onboarding>(url, { method: 'PUT', body: { creditLimit: terms.creditLimit.trim() || null, paymentTermsDays: terms.paymentTermsDays.trim() === '' ? null : Number(terms.paymentTermsDays), notes: terms.notes } }), onSuccess: set });
  const tick = useMutation({ mutationFn: (v: { id: string; done: boolean; attachmentId?: string | null }) => api<Onboarding>(`${url}/checks/${v.id}`, { method: 'PUT', body: { done: v.done, ...(v.attachmentId !== undefined ? { attachmentId: v.attachmentId } : {}) } }), onSuccess: set });
  const attach = useMutation({
    mutationFn: async ({ checkId, file }: { checkId: string; file: File }) => {
      const a = await uploadFile<{ id: string }>(`/v1/orgs/${orgId}/attachments?entityType=CUSTOMER_ONBOARDING&entityId=${o.id}&fileName=${encodeURIComponent(file.name)}`, file);
      return api<Onboarding>(`${url}/checks/${checkId}`, { method: 'PUT', body: { done: true, attachmentId: a.id } });
    },
    onSuccess: set,
  });
  const act = useMutation({ mutationFn: (path: 'submit' | 'withdraw' | 'reopen') => api<Onboarding>(`${url}/${path}`, { method: 'POST' }), onSuccess: set });
  const decide = useMutation({ mutationFn: (approve: boolean) => api<Onboarding>(`${url}/decide`, { method: 'POST', body: { approve, note: note.trim() || null } }), onSuccess: (r) => (setNote(''), set(r)) });
  const st = ONBOARDING_STATUS[o.status];
  return (
    <Card className="mt-6" role="region" aria-label="Customer onboarding">
      <CardHeader
        title="Customer onboarding"
        description="The details, documents and credit terms collected about this customer. Invoices to them post once it is approved, and approval sets their credit limit and payment terms."
        actions={<Badge tone={st.tone}>{st.label}</Badge>}
      />
      <div className="space-y-5 px-5 pb-5">
        <div>
          <div className="flex items-center justify-between text-xs text-fg-muted"><span>Checklist</span><span>{o.progress}% done</span></div>
          <div className="mt-1 h-2 rounded-full bg-surface-hover" role="progressbar" aria-label="Onboarding progress" aria-valuenow={o.progress} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-2 rounded-full bg-accent" style={{ width: `${o.progress}%` }} />
          </div>
        </div>

        <ul className="space-y-2 text-sm" aria-label="Customer details">
          {o.details.map((x) => (
            <li key={x.key} className="flex items-start gap-3">
              <Tick done={x.done} />
              <span><span className="text-fg">{x.label}</span>{!x.done ? <span className="block text-xs text-fg-muted">{x.hint}</span> : null}</span>
            </li>
          ))}
        </ul>

        {o.checks.length ? (
          <ul className="space-y-3 border-t border-line pt-4 text-sm" aria-label="Checklist items">
            {o.checks.map((k) => (
              <li key={k.id} className="flex flex-wrap items-start gap-3">
                <Tick done={k.done && (!k.needsFile || (!!k.file && !k.fileRemoved))} />
                <div className="min-w-0 flex-1">
                  <p className="text-fg">{k.label}{k.needsFile ? <span className="text-xs text-fg-muted"> · file needed</span> : null}</p>
                  {k.file ? (
                    <p className="text-xs">
                      {k.fileRemoved ? <span className="text-negative">The file was removed; attach it again</span> : <a className="text-accent hover:underline" href={`/api/t2t/v1/orgs/${orgId}/attachments/${k.file.id}/content?inline=1`} target="_blank" rel="noopener noreferrer">{k.file.fileName}</a>}
                    </p>
                  ) : null}
                  {k.done && k.doneBy ? <p className="text-xs text-fg-muted">Done by {k.doneBy}, {dateTime(k.doneAt!)}{k.note ? ` · ${k.note}` : ''}</p> : null}
                </div>
                {manage ? (
                  <div className="flex gap-2">
                    {k.needsFile ? <Button size="sm" variant="secondary" loading={attach.isPending && fileFor === k.id} onClick={() => { setFileFor(k.id); attach.reset(); input.current?.click(); }}>{k.file && !k.fileRemoved ? 'Replace file' : 'Attach file'}</Button> : null}
                    {!k.needsFile && !k.done ? <Button size="sm" variant="secondary" onClick={() => tick.mutate({ id: k.id, done: true })}>Mark done</Button> : null}
                    {k.done ? <Button size="sm" variant="ghost" onClick={() => tick.mutate({ id: k.id, done: false })}>Undo</Button> : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          className="sr-only"
          aria-label="Choose the file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f && fileFor) attach.mutate({ checkId: fileFor, file: f });
          }}
        />

        <div className="border-t border-line pt-4">
          {manage ? (
            <form className="grid gap-3 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
              <Field label={`Credit limit (${currency})`} hint="0 means payment in advance.">{(p) => <Input {...p} inputMode="decimal" value={terms.creditLimit} onChange={(e) => setTerms({ ...terms, creditLimit: e.target.value })} />}</Field>
              <Field label="Payment terms (days)">{(p) => <Input {...p} inputMode="numeric" value={terms.paymentTermsDays} onChange={(e) => setTerms({ ...terms, paymentTermsDays: e.target.value })} />}</Field>
              <div className="flex items-end"><Button type="submit" variant="secondary" loading={save.isPending}>Save terms</Button></div>
              <div className="sm:col-span-3"><Field label="Notes (optional)">{(p) => <Textarea {...p} rows={2} value={terms.notes} onChange={(e) => setTerms({ ...terms, notes: e.target.value })} />}</Field></div>
            </form>
          ) : (
            <p className="text-sm">
              Proposed credit limit {o.creditLimit !== null ? <Money value={o.creditLimit} currency={currency} /> : '—'} · payment terms {o.paymentTermsDays ?? '—'} days{o.notes ? <span className="block text-fg-muted">{o.notes}</span> : null}
            </p>
          )}
        </div>

        {o.status === 'REJECTED' && o.decisionNote ? <Alert tone="negative" title={`Rejected by ${o.decidedBy}`}>{o.decisionNote}</Alert> : null}
        {o.status === 'OPEN' && o.decisionNote ? <p className="text-sm text-fg-muted">Rejected before: {o.decisionNote}</p> : null}
        {o.status === 'APPROVED' ? <p className="text-sm text-positive" role="status">Approved by {o.decidedBy}, {dateTime(o.decidedAt!)}{o.selfApproved ? ' (by the person who submitted it: nobody else can approve)' : ''}{o.decisionNote ? `: ${o.decisionNote}` : ''}</p> : null}
        {o.status === 'SUBMITTED' ? <p className="text-sm text-fg-muted">Submitted by {o.submittedBy}, {dateTime(o.submittedAt!)}.{o.submitterMayDecide ? '' : ' Someone other than the person who submitted it approves it.'}</p> : null}

        <div className="flex flex-wrap items-end gap-2">
          {manage ? <Button loading={act.isPending && act.variables === 'submit'} disabled={o.issues.length > 0} onClick={() => act.mutate('submit')}>Submit for approval</Button> : null}
          {o.status === 'SUBMITTED' && can.manage ? <Button variant="ghost" onClick={() => act.mutate('withdraw')}>Take back</Button> : null}
          {o.status === 'REJECTED' && can.manage ? <Button variant="secondary" onClick={() => act.mutate('reopen')}>Reopen</Button> : null}
          {o.status === 'SUBMITTED' && can.decide ? (
            <>
              <div className="min-w-64 flex-1"><Field label="Decision note">{(p) => <Input {...p} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Needed to reject" />}</Field></div>
              <Button loading={decide.isPending && decide.variables === true} onClick={() => decide.mutate(true)}>Approve</Button>
              <Button variant="secondary" loading={decide.isPending && decide.variables === false} onClick={() => decide.mutate(false)}>Reject</Button>
            </>
          ) : null}
        </div>
        {manage && o.issues.length ? <p className="text-xs text-fg-muted">To submit: {o.issues.join('; ')}.</p> : null}
        <ErrorAlert title="Not saved" error={save.error ?? tick.error ?? attach.error} />
        <ErrorAlert title="Could not do that" error={act.error ?? decide.error} />
      </div>
    </Card>
  );
}
