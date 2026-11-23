'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input } from '@talk2tax/ui';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { date } from '@/lib/format';
import { useMe, useOrg } from '@/lib/org';
import { can, type ExpenseClaim } from '@/lib/types';

export interface ReceiptRequests {
  answered: boolean;
  requests: { id: string; at: string; by: string | null; note: string | null; emailed: boolean | null; emailError: string | null }[];
}
const LIVE = ['SUBMITTED', 'APPROVED', 'REIMBURSED'];

/** Finance asks the claimant for a missing receipt (EXP-021): a note, emailed when email is set up. */
export function AskForReceipt({ orgId, claimId, number, onAsked }: { orgId: string; claimId: string; number: string; onAsked?: () => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const ask = useMutation({
    mutationFn: () => api<ReceiptRequests>(`/v1/orgs/${orgId}/expense-claims/${claimId}/receipt-requests`, { method: 'POST', body: { note: note.trim() || null } }),
    onSuccess: () => {
      setOpen(false);
      setNote('');
      onAsked?.();
    },
  });
  return (
    <>
      <Button size="sm" variant="secondary" aria-label={`Ask for the receipt on ${number}`} onClick={() => { ask.reset(); setOpen(true); }}>Ask for receipt</Button>
      <Dialog open={open} onOpenChange={setOpen} title={`Ask for the receipt on ${number}`} description="The claimant sees your request on the claim, and gets it by email when email is set up. They can attach the receipt even after approval.">
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); ask.mutate(); }}>
          <Field label="Note to the claimant" hint="Optional: which receipt, or by when.">{(p) => <Input {...p} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
          {ask.error ? <Alert tone="negative" title="Could not ask">{ask.error instanceof ApiError ? ask.error.message : 'Try again.'}</Alert> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" loading={ask.isPending}>Send request</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

/** On a claim: the receipt requests made for it, and (for finance) asking for one. */
export function ReceiptRequestsCard({ claim }: { claim: ExpenseClaim }) {
  const { org, orgId } = useOrg();
  const me = useMe();
  const qc = useQueryClient();
  const live = LIVE.includes(claim.status);
  const q = useQuery({
    enabled: live && can(org?.role, 'expenses.submit'),
    // Asked again when receipts change, so an attached receipt shows the request answered.
    queryKey: ['receipt-requests', orgId, claim.id, claim.receiptCount],
    queryFn: () => api<ReceiptRequests>(`/v1/orgs/${orgId}/expense-claims/${claim.id}/receipt-requests`),
  });
  if (!live || !org) return null;
  const own = me.data?.user.id === claim.claimantId;
  const canAsk = !own && can(org.role, 'expenses.reimburse') && claim.receiptCount === 0;
  const requests = q.data?.requests ?? [];
  if (!requests.length && !canAsk) return null;
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['receipt-requests', orgId, claim.id] }), qc.invalidateQueries({ queryKey: ['expense-claim', orgId, claim.id] })]);
  return (
    <Card className="mb-4" role="region" aria-label="Receipt requests">
      <CardHeader
        title="Receipt requests"
        description={requests.length ? (q.data?.answered ? 'A receipt has been attached since it was asked for.' : own ? 'Finance asked for the receipt. Attach a photo or PDF of it below.' : 'Asked for and not attached yet.') : 'This claim went in without a receipt. Ask the claimant for it.'}
        actions={canAsk ? <AskForReceipt orgId={orgId} claimId={claim.id} number={claim.number} onAsked={refresh} /> : undefined}
      />
      {requests.length ? (
        <ul className="divide-y divide-line px-5 pb-4 text-sm">
          {requests.map((r) => (
            <li key={r.id} className="flex flex-wrap items-start gap-3 py-2">
              {q.data?.answered ? <Badge tone="positive">Receipt attached</Badge> : <Badge tone="warning">Waiting</Badge>}
              <span>
                Asked by {r.by ?? 'someone'} on {date(r.at.slice(0, 10))}
                {r.note ? <>: {r.note}</> : null}
                <span className="block text-xs text-fg-muted">{r.emailed === true ? 'Emailed to the claimant.' : r.emailed === false ? `Not emailed${r.emailError ? `: ${r.emailError}` : ''}.` : 'Not emailed: email is not set up.'}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
