'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input } from '@talk2tax/ui';
import { useState } from 'react';
import { Money } from '@/components/money';
import { api, ApiError } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can, type ApprovalRequest, type ApprovalState, type ApprovalStatus, type ApproveResult } from '@/lib/types';

export function useApprovalState(documentId: string | undefined, enabled = true) {
  const { orgId } = useOrg();
  return useQuery({ enabled: enabled && !!documentId, queryKey: ['approval', orgId, documentId], queryFn: () => api<ApprovalState>(`/v1/orgs/${orgId}/approvals/for-document/${documentId}`) });
}

const TONE: Record<ApprovalStatus, 'warning' | 'positive' | 'negative' | 'neutral'> = { PENDING: 'warning', APPROVED: 'positive', REJECTED: 'negative', CANCELLED: 'neutral' };
const LABEL: Record<ApprovalStatus, string> = { PENDING: 'Waiting for approval', APPROVED: 'Approved', REJECTED: 'Rejected', CANCELLED: 'Cancelled' };

export function ApprovalBadge({ status }: { status: ApprovalStatus }) {
  return <Badge tone={TONE[status]}>{LABEL[status]}</Badge>;
}

/** Approve / reject buttons with their dialogs; shared by the document page and the inbox. */
export function DecisionButtons({ r, currency, onDone }: { r: ApprovalRequest; currency: string; onDone: () => Promise<unknown> | void }) {
  const { org, orgId } = useOrg();
  const [mode, setMode] = useState<'approve' | 'reject' | null>(null);
  const [note, setNote] = useState('');
  const [post, setPost] = useState(true);
  const [result, setResult] = useState<ApproveResult | null>(null);
  const base = `/v1/orgs/${orgId}/approvals/${r.id}`;
  const decide = useMutation({
    mutationFn: (): Promise<ApproveResult | ApprovalRequest> =>
      mode === 'approve'
        ? api<ApproveResult>(`${base}/approve`, { method: 'POST', body: { note: note || null, post } })
        : api<ApprovalRequest>(`${base}/reject`, { method: 'POST', body: { note } }),
    onSuccess: async (res) => {
      if (mode === 'approve' && res && 'postError' in res && res.postError) setResult(res);
      else setMode(null);
      await onDone();
    },
  });
  if (!org || !r.canApprove) return null;
  const canPost = can(org.role, 'journals.post');
  const open = (m: 'approve' | 'reject') => {
    decide.reset();
    setResult(null);
    setNote('');
    setPost(canPost);
    setMode(m);
  };
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => open('reject')}>Reject…</Button>
      <Button size="sm" onClick={() => open('approve')}>Approve…</Button>
      <Dialog
        open={!!mode}
        onOpenChange={(o) => !o && setMode(null)}
        title={mode === 'approve' ? `Approve ${r.documentNumber ?? 'draft'} for ${r.contactName}` : `Reject ${r.documentNumber ?? 'draft'} for ${r.contactName}`}
        description={mode === 'approve' ? 'Your name and note are kept with the document. If the draft is edited later, the approval is cancelled.' : 'The preparer sees your reason and can fix the draft and submit it again.'}
      >
        {result ? (
          <div className="flex flex-col gap-4">
            <Alert tone="warning" title="Approved, but not posted">{result.postError!.message}. Open the document to resolve this and post it.</Alert>
            <div className="flex justify-end"><Button onClick={() => setMode(null)}>Close</Button></div>
          </div>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); decide.mutate(); }}>
            {decide.error ? <Alert title="Could not record the decision">{decide.error instanceof ApiError ? decide.error.message : 'Try again.'}</Alert> : null}
            <p className="text-sm">Total <Money value={r.total} currency={currency} />{r.note ? <> · <span className="text-fg-muted">“{r.note}”</span></> : null}</p>
            <Field label={mode === 'approve' ? 'Note (optional)' : 'Reason'}>
              {(p) => <Input {...p} required={mode === 'reject'} minLength={mode === 'reject' ? 3 : undefined} value={note} onChange={(e) => setNote(e.target.value)} />}
            </Field>
            {mode === 'approve' && canPost ? (
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="accent-[var(--t2t-accent)]" checked={post} onChange={(e) => setPost(e.target.checked)} /> Post it to the books now</label>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setMode(null)}>Cancel</Button>
              <Button type="submit" variant={mode === 'reject' ? 'danger' : 'primary'} loading={decide.isPending}>{mode === 'approve' ? (post && canPost ? 'Approve and post' : 'Approve') : 'Reject'}</Button>
            </div>
          </form>
        )}
      </Dialog>
    </>
  );
}

/** Where a draft stands against the organisation's approval rules, with the actions the viewer may take. */
export function ApprovalCard({ documentId, isDraft, canManage, currency, onChange }: { documentId: string; isDraft: boolean; canManage: boolean; currency: string; onChange: () => Promise<unknown> }) {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const state = useApprovalState(documentId);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [note, setNote] = useState('');
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['approval', orgId, documentId] });
    await qc.invalidateQueries({ queryKey: ['approvals', orgId] });
    await onChange();
  };
  const submit = useMutation({
    mutationFn: () => api<ApprovalRequest>(`/v1/orgs/${orgId}/approvals`, { method: 'POST', body: { documentId, note: note || null } }),
    onSuccess: async () => {
      setSubmitOpen(false);
      await refresh();
    },
  });
  const withdraw = useMutation({ mutationFn: (id: string) => api(`/v1/orgs/${orgId}/approvals/${id}/withdraw`, { method: 'POST' }), onSuccess: refresh });
  const s = state.data;
  if (!s || (!s.required && s.requests.length === 0)) return null;
  const open = s.requests.find((r) => r.status === 'PENDING' || r.status === 'APPROVED');
  const latest = s.requests[0];
  let summary: string;
  if (!isDraft) summary = 'Approval history for this document.';
  else if (s.readyToPost) summary = 'Approved. It can be posted.';
  else if (open?.status === 'PENDING') summary = `Waiting for approval${open.requestedBy ? `, submitted by ${open.requestedBy}` : ''}.${open.ownWork && !open.canApprove ? ' Someone other than you must approve it.' : ''}`;
  else summary = `Drafts like this one (${s.policy ? `from ${s.policy.minAmount}` : 'covered by a rule'}) need an approval before they can post${s.policy?.requireDifferentApprover ? ', from someone other than the preparer' : ''}.`;
  return (
    <Card className="mt-6">
      <CardHeader
        title="Approval"
        description={summary}
        actions={
          <>
            {isDraft && s.required && !open && canManage ? <Button size="sm" onClick={() => { submit.reset(); setNote(''); setSubmitOpen(true); }}>Submit for approval</Button> : null}
            {isDraft && open?.status === 'PENDING' && canManage ? <Button size="sm" variant="ghost" loading={withdraw.isPending} onClick={() => withdraw.mutate(open.id)}>Withdraw</Button> : null}
            {isDraft && open ? <DecisionButtons r={open} currency={currency} onDone={refresh} /> : null}
          </>
        }
      />
      {withdraw.error ? <div className="px-5 pb-3"><Alert title="Could not withdraw">{withdraw.error.message}</Alert></div> : null}
      {isDraft && latest?.status === 'REJECTED' && !open ? (
        <div className="px-5 pb-3"><Alert tone="negative" title={`Rejected by ${latest.decidedBy ?? 'an approver'}`}>{latest.decisionNote}. Edit the draft and submit it again.</Alert></div>
      ) : null}
      {s.requests.length ? (
        <ol className="divide-y divide-border text-sm" aria-label="Approval history">
          {s.requests.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3">
              <ApprovalBadge status={r.status} />
              <span>Submitted by {r.requestedBy ?? 'someone'} on {date(r.requestedAt.slice(0, 10))} for <Money value={r.total} currency={currency} /></span>
              {r.decidedAt ? <span className="text-fg-muted">· {r.status === 'CANCELLED' ? '' : `${r.decidedBy ?? 'someone'}: `}{r.decisionNote ?? LABEL[r.status].toLowerCase()}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
      <Dialog open={submitOpen} onOpenChange={setSubmitOpen} title="Submit for approval" description="Approvers see this draft in their approvals list. Editing it afterwards cancels the request.">
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); submit.mutate(); }}>
          {submit.error ? <Alert title="Could not submit">{submit.error.message}</Alert> : null}
          <Field label="Note for the approver (optional)">{(p) => <Input {...p} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setSubmitOpen(false)}>Cancel</Button>
            <Button type="submit" loading={submit.isPending}>Submit</Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}
