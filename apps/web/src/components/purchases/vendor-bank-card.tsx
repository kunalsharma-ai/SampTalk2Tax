'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input, Select } from '@talk2tax/ui';
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
        description="Where this vendor is paid: an Indian account (IFSC) for payment batches, or a bank abroad (SWIFT/BIC) for international payments. A change must be verified by a second person, for example by calling a number you already hold, before a payment to them can be approved."
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
            {d.kind === 'INTERNATIONAL' ? (
              <div><dt className="text-xs text-fg-muted">Bank abroad</dt><dd className="num">{d.swiftBic} · {d.bankCountry}{d.routingCode ? ` · ${d.routingCode}` : ''}<span className="block text-xs text-fg-muted">{[d.bankName, d.intermediarySwift ? `via ${d.intermediarySwift}` : null].filter(Boolean).join(' · ')}</span></dd></div>
            ) : (
              <div><dt className="text-xs text-fg-muted">IFSC</dt><dd className="num">{d.ifsc}{d.bankName ? <span className="block text-xs text-fg-muted">{d.bankName}</span> : null}</dd></div>
            )}
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
      {verifying && d ? <VerifyDialog orgId={orgId} contactId={contactId} summary={`${d.accountName} · ${d.accountNumberMasked} · ${d.ifsc ?? `${d.swiftBic} (${d.bankCountry})`}`} onClose={() => setVerifying(false)} onDone={() => qc.invalidateQueries({ queryKey: key })} /> : null}
    </Card>
  );
}

function EditDialog({ orgId, contactId, current, onClose, onDone }: { orgId: string; contactId: string; current: VendorBankDetails['details']; onClose: () => void; onDone: () => Promise<void> }) {
  const [kind, setKind] = useState<'DOMESTIC' | 'INTERNATIONAL'>(current?.kind ?? 'DOMESTIC');
  const [accountName, setAccountName] = useState(current?.accountName ?? '');
  const [accountNumber, setAccountNumber] = useState('');
  const [ifsc, setIfsc] = useState(current?.ifsc ?? '');
  const [bankName, setBankName] = useState(current?.bankName ?? '');
  const [intl, setIntl] = useState({ swiftBic: current?.swiftBic ?? '', bankCountry: current?.bankCountry ?? '', bankAddress: current?.bankAddress ?? '', routingCode: current?.routingCode ?? '', intermediarySwift: current?.intermediarySwift ?? '' });
  const m = useMutation({
    mutationFn: () =>
      kind === 'DOMESTIC'
        ? api(`/v1/orgs/${orgId}/contacts/${contactId}/bank-details`, { method: 'PUT', body: { accountName, accountNumber, ifsc, bankName: bankName || null } })
        : api(`/v1/orgs/${orgId}/contacts/${contactId}/bank-details/international`, { method: 'PUT', body: { accountName, accountNumber, bankName: bankName || null, swiftBic: intl.swiftBic, bankCountry: intl.bankCountry, bankAddress: intl.bankAddress || null, routingCode: intl.routingCode || null, intermediarySwift: intl.intermediarySwift || null } }),
    onSuccess: async () => { await onDone(); onClose(); },
  });
  const ready = accountName.trim() && accountNumber.trim() && (kind === 'DOMESTIC' ? ifsc.trim() : intl.swiftBic.trim() && intl.bankCountry.trim());
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title={current ? 'Change bank details' : 'Add bank details'} description="Enter the account exactly as on the vendor's cancelled cheque or bank letter. Saving clears any verification.">
      <div className="flex flex-col gap-4">
        {current ? <Alert tone="warning" title="Check before you change">Requests to change bank details are the most common payment fraud. Confirm the change with the vendor on a number you already hold, not one given in the request.</Alert> : null}
        <Field label="Where is the bank?">{(p) => <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as 'DOMESTIC' | 'INTERNATIONAL')}><option value="DOMESTIC">In India (IFSC)</option><option value="INTERNATIONAL">Abroad (SWIFT/BIC)</option></Select>}</Field>
        <Field label="Account holder name">{(p) => <Input {...p} maxLength={140} value={accountName} onChange={(e) => setAccountName(e.target.value)} />}</Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={kind === 'DOMESTIC' ? 'Account number' : 'IBAN or account number'} hint={kind === 'INTERNATIONAL' ? 'Banks in Europe, the UK and the Gulf are paid to an IBAN.' : undefined}>{(p) => <Input {...p} autoComplete="off" maxLength={40} value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} placeholder={current ? `Now ${current.accountNumberMasked}` : ''} />}</Field>
          {kind === 'DOMESTIC' ? (
            <Field label="IFSC">{(p) => <Input {...p} maxLength={11} value={ifsc} onChange={(e) => setIfsc(e.target.value.toUpperCase())} placeholder="e.g. HDFC0001234" />}</Field>
          ) : (
            <Field label="SWIFT/BIC">{(p) => <Input {...p} maxLength={11} value={intl.swiftBic} onChange={(e) => setIntl({ ...intl, swiftBic: e.target.value.toUpperCase() })} placeholder="e.g. CHASUS33" />}</Field>
          )}
        </div>
        {kind === 'INTERNATIONAL' ? (
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Bank country (2 letters)">{(p) => <Input {...p} maxLength={2} value={intl.bankCountry} onChange={(e) => setIntl({ ...intl, bankCountry: e.target.value.toUpperCase() })} placeholder="US" />}</Field>
            <Field label="Routing code" hint="ABA (US), transit (CA) or BSB (AU) where needed.">{(p) => <Input {...p} maxLength={20} value={intl.routingCode} onChange={(e) => setIntl({ ...intl, routingCode: e.target.value })} />}</Field>
            <Field label="Intermediary SWIFT (optional)">{(p) => <Input {...p} maxLength={11} value={intl.intermediarySwift} onChange={(e) => setIntl({ ...intl, intermediarySwift: e.target.value.toUpperCase() })} />}</Field>
            <div className="sm:col-span-3"><Field label="Bank address (optional)">{(p) => <Input {...p} maxLength={300} value={intl.bankAddress} onChange={(e) => setIntl({ ...intl, bankAddress: e.target.value })} />}</Field></div>
          </div>
        ) : null}
        <Field label={kind === 'DOMESTIC' ? 'Bank and branch (optional)' : 'Bank name (optional)'}>{(p) => <Input {...p} maxLength={140} value={bankName} onChange={(e) => setBankName(e.target.value)} />}</Field>
        <ErrorAlert title="Bank details were not saved" error={m.error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button loading={m.isPending} disabled={!ready} onClick={() => m.mutate()}>Save bank details</Button>
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
