'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input } from '@talk2tax/ui';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { api } from '@/lib/api';
import { date, istDay } from '@/lib/format';
import type { VendorBankDetails } from '@/lib/payment-batches';

/** A vendor's bank account for payment batches, its verification and its change history. */
export function VendorBankCard({ orgId, contactId }: { orgId: string; contactId: string }) {
  const qc = useQueryClient();
  const key = ['vendor-bank', orgId, contactId];
  const q = useQuery({ queryKey: key, queryFn: () => api<VendorBankDetails>(`/v1/orgs/${orgId}/contacts/${contactId}/bank-details`) });
  const [editing, setEditing] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const d = q.data?.details;
  const can = q.data?.can;
  return (
    <Card className="mt-6">
      <CardHeader
        title="Bank details"
        description="Where payment batches pay this vendor. A change must be verified by a second person, for example by calling a number you already hold, before a batch paying them can be approved."
        actions={
          <div className="flex gap-2">
            {can?.verifyBankDetails && d && !d.verified ? <Button size="sm" onClick={() => setVerifying(true)}>Verify…</Button> : null}
            {can?.editBankDetails ? <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>{d ? 'Change…' : 'Add bank details'}</Button> : null}
          </div>
        }
      />
      <ErrorAlert title="Could not load the bank details" error={q.error} />
      <div className="px-5 py-4 text-sm">
        {d ? (
          <dl className="grid gap-3 sm:grid-cols-4">
            <div><dt className="text-xs text-fg-muted">Account holder</dt><dd>{d.accountName}</dd></div>
            <div><dt className="text-xs text-fg-muted">Account number</dt><dd className="num">{d.accountNumberMasked}</dd></div>
            <div><dt className="text-xs text-fg-muted">IFSC</dt><dd className="num">{d.ifsc}{d.bankName ? <span className="block text-xs text-fg-muted">{d.bankName}</span> : null}</dd></div>
            <div>
              <dt className="text-xs text-fg-muted">Status</dt>
              <dd>
                {d.verified ? <Badge tone="positive">Verified</Badge> : <Badge tone="warning">Not verified</Badge>}
                <span className="block text-xs text-fg-muted">
                  {d.verified ? `By ${d.verifiedBy} on ${date(istDay(d.verifiedAt!))}: ${d.verificationNote}` : `Changed by ${d.changedBy} on ${date(istDay(d.changedAt))}`}
                </span>
              </dd>
            </div>
          </dl>
        ) : q.data ? (
          <p className="text-fg-muted">No bank details yet. Payment batches cannot pay this vendor until they are added and verified.</p>
        ) : null}
        {q.data && q.data.history.length > 1 ? (
          <details className="mt-4">
            <summary className="cursor-pointer text-xs text-fg-muted">Change history ({q.data.history.length})</summary>
            <ul className="mt-2 space-y-1 text-xs text-fg-muted">
              {q.data.history.map((h, i) => <li key={i}>{date(istDay(h.changedAt))} · {h.changedBy}: {h.before ? `${h.before} → ` : ''}{h.after}</li>)}
            </ul>
          </details>
        ) : null}
      </div>
      {editing ? <EditDialog orgId={orgId} contactId={contactId} current={d ?? null} onClose={() => setEditing(false)} onDone={() => qc.invalidateQueries({ queryKey: key })} /> : null}
      {verifying && d ? <VerifyDialog orgId={orgId} contactId={contactId} summary={`${d.accountName} · ${d.accountNumberMasked} · ${d.ifsc}`} onClose={() => setVerifying(false)} onDone={() => qc.invalidateQueries({ queryKey: key })} /> : null}
    </Card>
  );
}

function EditDialog({ orgId, contactId, current, onClose, onDone }: { orgId: string; contactId: string; current: VendorBankDetails['details']; onClose: () => void; onDone: () => Promise<void> }) {
  const [accountName, setAccountName] = useState(current?.accountName ?? '');
  const [accountNumber, setAccountNumber] = useState('');
  const [ifsc, setIfsc] = useState(current?.ifsc ?? '');
  const [bankName, setBankName] = useState(current?.bankName ?? '');
  const m = useMutation({ mutationFn: () => api(`/v1/orgs/${orgId}/contacts/${contactId}/bank-details`, { method: 'PUT', body: { accountName, accountNumber, ifsc, bankName: bankName || null } }), onSuccess: async () => { await onDone(); onClose(); } });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title={current ? 'Change bank details' : 'Add bank details'} description="Enter the account exactly as on the vendor's cancelled cheque or bank letter. Saving clears any verification.">
      <div className="flex flex-col gap-4">
        {current ? <Alert tone="warning" title="Check before you change">Requests to change bank details are the most common payment fraud. Confirm the change with the vendor on a number you already hold, not one given in the request.</Alert> : null}
        <Field label="Account holder name">{(p) => <Input {...p} maxLength={140} value={accountName} onChange={(e) => setAccountName(e.target.value)} />}</Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Account number">{(p) => <Input {...p} autoComplete="off" maxLength={40} value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} placeholder={current ? `Now ${current.accountNumberMasked}` : ''} />}</Field>
          <Field label="IFSC">{(p) => <Input {...p} maxLength={11} value={ifsc} onChange={(e) => setIfsc(e.target.value.toUpperCase())} placeholder="e.g. HDFC0001234" />}</Field>
        </div>
        <Field label="Bank and branch (optional)">{(p) => <Input {...p} maxLength={140} value={bankName} onChange={(e) => setBankName(e.target.value)} />}</Field>
        <ErrorAlert title="Bank details were not saved" error={m.error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={m.isPending} disabled={!accountName.trim() || !accountNumber.trim() || !ifsc.trim()} onClick={() => m.mutate()}>Save bank details</Button>
        </div>
      </div>
    </Dialog>
  );
}

function VerifyDialog({ orgId, contactId, summary, onClose, onDone }: { orgId: string; contactId: string; summary: string; onClose: () => void; onDone: () => Promise<void> }) {
  const [note, setNote] = useState('');
  const m = useMutation({ mutationFn: () => api(`/v1/orgs/${orgId}/contacts/${contactId}/bank-details/verify`, { method: 'POST', body: { note } }), onSuccess: async () => { await onDone(); onClose(); } });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title="Verify bank details" description={summary}>
      <div className="flex flex-col gap-4">
        <Field label="How were they confirmed?">{(p) => <Input {...p} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Called their accounts head on the number in our records" />}</Field>
        <ErrorAlert title="Not verified" error={m.error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={m.isPending} disabled={note.trim().length < 3} onClick={() => m.mutate()}>Mark verified</Button>
        </div>
      </div>
    </Dialog>
  );
}
