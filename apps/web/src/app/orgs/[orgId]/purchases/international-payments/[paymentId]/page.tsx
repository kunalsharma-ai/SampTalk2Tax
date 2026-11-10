'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import { date, dateTime, today } from '@/lib/format';
import { CHARGES, FORM15_LABEL, REMIT_STATUS, type Charges, type RemitList, type Remittance } from '@/lib/international-payments';
import { useOrg } from '@/lib/org';

/** The full body the API expects on PUT, built from the payment and the changes on screen. */
function bodyOf(r: Remittance, ch: Partial<Record<string, unknown>>) {
  return {
    contactId: r.vendor.id,
    bankAccountId: r.bankAccount.id,
    paymentDate: r.paymentDate,
    currency: r.currency,
    items: r.items.map((i) => ({ documentId: i.documentId, amount: i.amount })),
    purposeCode: r.purposeCode,
    purpose: r.purpose,
    charges: r.charges,
    taxableInIndia: r.taxableInIndia,
    hasTaxOrder: r.hasTaxOrder,
    estimateRate: r.estimateRate,
    form15caAck: r.form15.ack,
    form15cbNumber: r.form15.cb,
    memo: r.memo,
    ...ch,
  };
}

/** Draft details: purpose, charges, the expected rate and the Form 15CA and 15CB numbers. */
function DraftDetails({ r, base, codes, onSaved }: { r: Remittance; base: string; codes: RemitList['purposeCodes']; onSaved: () => Promise<void> }) {
  const known = codes.some((c) => c.code === r.purposeCode);
  const [f, setF] = useState({
    purposeCode: r.purposeCode ? (known ? r.purposeCode : 'OTHER') : '',
    otherCode: r.purposeCode && !known ? r.purposeCode : '',
    purpose: r.purpose ?? '',
    charges: r.charges,
    taxableInIndia: r.taxableInIndia,
    hasTaxOrder: r.hasTaxOrder,
    estimateRate: r.estimateRate ?? '',
    ack: r.form15.ack ?? '',
    cb: r.form15.cb ?? '',
    memo: r.memo ?? '',
  });
  const save = useMutation({
    mutationFn: () =>
      api<Remittance>(`${base}/${r.id}`, {
        method: 'PUT',
        body: bodyOf(r, {
          purposeCode: f.purposeCode === 'OTHER' ? f.otherCode || null : f.purposeCode || null,
          purpose: f.purpose || null,
          charges: f.charges,
          taxableInIndia: f.taxableInIndia,
          hasTaxOrder: f.hasTaxOrder,
          estimateRate: f.estimateRate || null,
          form15caAck: f.ack || null,
          form15cbNumber: f.cb || null,
          memo: f.memo || null,
        }),
      }),
    onSuccess: onSaved,
  });
  return (
    <Card className="mt-6">
      <CardHeader title="Purpose and tax forms" description="The RBI purpose code, who pays the bank charges and, from India, the Form 15CA acknowledgement and Form 15CB certificate. Save to check the payment again." />
      <div className="grid gap-4 p-5 sm:grid-cols-3">
        <Field label="Purpose (RBI purpose code)">{(p) => <Select {...p} value={f.purposeCode} onChange={(e) => setF({ ...f, purposeCode: e.target.value })}><option value="">Choose…</option>{codes.map((c) => <option key={c.code} value={c.code}>{c.code} · {c.label}</option>)}<option value="OTHER">Another code…</option></Select>}</Field>
        {f.purposeCode === 'OTHER' ? <Field label="Purpose code">{(p) => <Input {...p} maxLength={5} value={f.otherCode} onChange={(e) => setF({ ...f, otherCode: e.target.value.toUpperCase() })} placeholder="S1099" />}</Field> : null}
        <Field label="Description of the purpose" hint="Shown to the bank on the instruction.">{(p) => <Input {...p} maxLength={200} value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} />}</Field>
        <Field label="Charges">{(p) => <Select {...p} value={f.charges} onChange={(e) => setF({ ...f, charges: e.target.value as Charges })}>{(Object.keys(CHARGES) as Charges[]).map((c) => <option key={c} value={c}>{CHARGES[c]}</option>)}</Select>}</Field>
        <Field label={`Expected ${r.currency} rate`} hint="Used for the Form 15CA threshold until the bank's rate is known.">{(p) => <Input {...p} inputMode="decimal" value={f.estimateRate} onChange={(e) => setF({ ...f, estimateRate: e.target.value })} />}</Field>
        {r.form15.applies ? (
          <>
            <div className="flex flex-col justify-end gap-2 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" checked={f.taxableInIndia} onChange={(e) => setF({ ...f, taxableInIndia: e.target.checked })} /> Chargeable to tax in India</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={f.hasTaxOrder} onChange={(e) => setF({ ...f, hasTaxOrder: e.target.checked })} /> Covered by an order or certificate</label>
            </div>
            {r.form15.part !== 'NONE' ? <Field label="Form 15CA acknowledgement number">{(p) => <Input {...p} maxLength={40} value={f.ack} onChange={(e) => setF({ ...f, ack: e.target.value })} />}</Field> : null}
            {r.form15.needs15cb ? <Field label="Form 15CB certificate number (UDIN)">{(p) => <Input {...p} maxLength={40} value={f.cb} onChange={(e) => setF({ ...f, cb: e.target.value })} />}</Field> : null}
          </>
        ) : null}
        <Field label="Note">{(p) => <Input {...p} maxLength={500} value={f.memo} onChange={(e) => setF({ ...f, memo: e.target.value })} />}</Field>
      </div>
      <div className="flex items-center gap-2 px-5 pb-5">
        <Button loading={save.isPending} onClick={() => save.mutate()}>Save details</Button>
        {save.isSuccess ? <span role="status" className="text-sm text-fg-muted">Saved.</span> : null}
        <ErrorAlert title="Not saved" error={save.error} />
      </div>
    </Card>
  );
}

/** One international payment: the bills, the vendor's bank abroad, the Form 15CA position and each step to the bank. */
export default function InternationalPaymentPage() {
  const { org, orgId } = useOrg();
  const { paymentId } = useParams<{ paymentId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const base = `/v1/orgs/${orgId}/purchases/international-payments`;
  const q = useQuery({ queryKey: ['international-payment', orgId, paymentId], queryFn: () => api<Remittance>(`${base}/${paymentId}`) });
  const list = useQuery({ queryKey: ['international-payments', orgId], queryFn: () => api<RemitList>(base) });
  const [cancelOpen, setCancelOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileBusy, setFileBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['international-payment', orgId, paymentId] });
    await qc.invalidateQueries({ queryKey: ['international-payments', orgId] });
    await qc.invalidateQueries({ queryKey: ['foreign-bills', orgId] });
  };
  const approve = useMutation({ mutationFn: () => api(`${base}/${paymentId}/approve`, { method: 'POST', body: {} }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: () => api(`${base}/${paymentId}`, { method: 'DELETE' }), onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['international-payments', orgId] }); router.push(`/orgs/${orgId}/purchases/international-payments`); } });

  const download = async () => {
    setFileBusy(true);
    setFileError(null);
    setSaved(null);
    try {
      const res = await fetch(`/api/t2t${base}/${paymentId}/instruction`, { method: 'POST', headers: { 'x-t2t-csrf': '1', 'content-type': 'application/json' }, body: '{}' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new ApiError(res.status, body.error ?? 'ERROR', body.message ?? `Download failed (${res.status})`, []);
      }
      const blob = await res.blob();
      const fileName = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'remittance.csv';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setSaved(fileName);
      await refresh();
    } catch (e) {
      setFileError(e instanceof Error ? e.message : 'Download failed');
    } finally {
      setFileBusy(false);
    }
  };

  if (!org) return null;
  const r = q.data;
  if (!r) return <ErrorAlert title="Could not load the international payment" error={q.error} />;
  const st = REMIT_STATUS[r.status];
  const blocked = r.issues.length > 0;
  const live = r.status === 'DRAFT' || r.status === 'APPROVED' || r.status === 'SENT';
  return (
    <>
      <PageHeader
        title={`International payment ${r.reference}`}
        description={`Pays ${r.vendor.name} ${r.items.length} ${r.items.length === 1 ? 'bill' : 'bills'} in ${r.currency} from ${r.bankAccount.code} ${r.bankAccount.name}, value date ${date(r.paymentDate)}.`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={st.tone}>{st.label}</Badge>
            {r.status === 'DRAFT' && r.can.manage ? <Button variant="ghost" onClick={() => setDeleteOpen(true)}>Delete</Button> : null}
            {r.status === 'DRAFT' && r.can.approve ? <Button loading={approve.isPending} disabled={blocked} onClick={() => approve.mutate()}>Approve</Button> : null}
            {(r.status === 'APPROVED' || r.status === 'SENT') && r.can.pay ? (
              <Button variant={r.status === 'SENT' ? 'secondary' : 'primary'} loading={fileBusy} onClick={() => void download()}>{r.status === 'SENT' ? 'Download instruction again' : 'Download bank instruction'}</Button>
            ) : null}
            {r.status === 'SENT' && r.can.pay ? <Button onClick={() => setPayOpen(true)}>Record as paid</Button> : null}
            {live && r.can.manage ? <Button variant="ghost" onClick={() => setCancelOpen(true)}>Cancel…</Button> : null}
          </div>
        }
      />
      {fileError ? <div className="mt-4"><Alert tone="negative" title="Instruction not downloaded">{fileError}</Alert></div> : null}
      {saved ? <p role="status" className="mt-2 text-sm text-fg-muted">Downloaded {saved}. Give it to the bank with the Form 15CA and 15CB, then record the payment at the bank&apos;s rate once the bank confirms.</p> : null}
      <ErrorAlert title="Not approved" error={approve.error} />
      {blocked ? (
        <div className="mt-4">
          <Alert tone="warning" title="This payment cannot be approved yet">
            <ul className="list-disc pl-5">{r.issues.map((i) => <li key={i}>{i}</li>)}</ul>
          </Alert>
        </div>
      ) : null}
      {r.status === 'DRAFT' && r.can.approve && r.mine && !blocked ? (
        <p className="mt-3 text-sm text-fg-muted">You prepared this payment, so someone else with approval rights should approve it. If you are the only approver in the organisation, your approval is accepted and marked as self-approved.</p>
      ) : null}
      {r.status === 'DRAFT' && !r.can.approve ? <p className="mt-3 text-sm text-fg-muted">Waiting for someone with approval rights to approve it.</p> : null}

      <Card className="mt-6">
        <CardHeader title="Remittance record" description="The amount, the rate, and who prepared, approved, sent and recorded this payment." />
        <dl className="grid gap-4 p-5 text-sm sm:grid-cols-3">
          <div><dt className="text-fg-muted">Amount</dt><dd className="font-semibold"><Money value={r.amount} currency={r.currency} /></dd></div>
          <div><dt className="text-fg-muted">{r.paidInr ? `Paid in ${r.functionalCurrency}` : `Estimate in ${r.functionalCurrency}`}</dt><dd>{r.paidInr ? <><Money value={r.paidInr} currency={r.functionalCurrency} /> at {r.paidRate}</> : r.estimateInr ? <><Money value={r.estimateInr} currency={r.functionalCurrency} /> at {r.estimateRate}</> : 'No rate yet'}</dd></div>
          <div><dt className="text-fg-muted">Purpose</dt><dd>{r.purposeCode ? `${r.purposeCode}${r.purpose ? ` · ${r.purpose}` : ''}` : 'Not chosen'}</dd></div>
          <div><dt className="text-fg-muted">Charges</dt><dd>{CHARGES[r.charges]}</dd></div>
          <div><dt className="text-fg-muted">Prepared</dt><dd>{r.createdBy ?? 'Someone'} · {dateTime(r.createdAt)}</dd></div>
          <div><dt className="text-fg-muted">Approved</dt><dd>{r.approvedAt ? <>{r.approvedBy ?? 'Someone'} · {dateTime(r.approvedAt)}{r.selfApproved ? <> <Badge tone="warning">Self-approved</Badge></> : null}</> : 'Not yet'}</dd></div>
          <div><dt className="text-fg-muted">Sent to bank</dt><dd>{r.sentAt ? `${r.sentBy ?? 'Someone'} · ${dateTime(r.sentAt)}` : 'Not yet'}</dd></div>
          <div><dt className="text-fg-muted">Paid</dt><dd>{r.paidAt ? <>{r.paidBy ?? 'Someone'} · {dateTime(r.paidAt)}{r.bankReference ? ` · bank ref ${r.bankReference}` : ''}</> : 'Not yet'}</dd></div>
          <div><dt className="text-fg-muted">Payment</dt><dd>{r.payment ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/purchases/payments/${r.payment.id}`}>{r.payment.number}</Link> : '—'}</dd></div>
          {r.cancelledAt ? <div className="sm:col-span-3"><dt className="text-fg-muted">Cancelled</dt><dd>{r.cancelledBy ?? 'Someone'} · {dateTime(r.cancelledAt)}: {r.cancelReason}</dd></div> : null}
          {r.memo ? <div className="sm:col-span-3"><dt className="text-fg-muted">Note</dt><dd>{r.memo}</dd></div> : null}
        </dl>
      </Card>

      {r.form15.applies ? (
        <Card className="mt-6">
          <CardHeader title="Form 15CA and 15CB" description="Which part of Form 15CA this payment needs under Rule 37BB, worked out from the purpose, whether it is taxable in India and what was already paid to this vendor this financial year." />
          <div className="space-y-2 p-5 text-sm">
            <p><span className="font-semibold">{FORM15_LABEL[r.form15.part]}</span>{r.form15.needs15cb ? ' · Form 15CB from a chartered accountant needed' : ''}</p>
            <p className="text-fg-muted">{r.form15.reason}</p>
            <p className="text-fg-muted">Paid to this vendor earlier this financial year: <Money value={r.form15.inrBefore} currency={r.functionalCurrency} />. With this payment: <Money value={r.form15.inrThisYear} currency={r.functionalCurrency} />.</p>
            {r.form15.ack ? <p>Form 15CA acknowledgement: <span className="font-mono">{r.form15.ack}</span></p> : null}
            {r.form15.cb ? <p>Form 15CB certificate: <span className="font-mono">{r.form15.cb}</span></p> : null}
            <p className="text-xs text-fg-muted">File the forms on the income tax portal yourself; Talk2Tax does not file them. Check the part with your chartered accountant.</p>
          </div>
        </Card>
      ) : null}

      {r.status === 'DRAFT' && r.can.manage && list.data ? <DraftDetails key={`${r.purposeCode}-${r.form15.ack}-${r.form15.cb}-${r.estimateRate}`} r={r} base={base} codes={list.data.purposeCodes} onSaved={refresh} /> : null}

      <Card className="mt-6">
        <CardHeader title="Beneficiary bank" description="The vendor's bank abroad from the vendor's record. Only verified details go on the instruction; the account number is masked here." />
        {r.bank ? (
          <dl className="grid gap-4 p-5 text-sm sm:grid-cols-3">
            <div><dt className="text-fg-muted">Account name</dt><dd>{r.bank.accountName}</dd></div>
            <div><dt className="text-fg-muted">Account or IBAN</dt><dd className="font-mono">{r.bank.accountMasked}</dd></div>
            <div><dt className="text-fg-muted">SWIFT / BIC</dt><dd className="font-mono">{r.bank.swiftBic ?? '—'}</dd></div>
            <div><dt className="text-fg-muted">Bank</dt><dd>{r.bank.bankName ?? '—'}{r.bank.bankCountry ? ` · ${r.bank.bankCountry}` : ''}</dd></div>
            <div><dt className="text-fg-muted">Routing code</dt><dd className="font-mono">{r.bank.routingCode ?? '—'}</dd></div>
            <div><dt className="text-fg-muted">Status</dt><dd>{r.bank.kind !== 'INTERNATIONAL' ? <Badge tone="negative">Domestic details only</Badge> : r.bank.verified ? <Badge tone="positive">Verified</Badge> : <Badge tone="warning">Not verified</Badge>}</dd></div>
          </dl>
        ) : (
          <p className="p-5 text-sm text-fg-muted">No bank details yet. Add the vendor&apos;s bank abroad on <Link className="text-accent hover:underline" href={`/orgs/${orgId}/purchases/vendors/${r.vendor.id}`}>the vendor&apos;s page</Link>.</p>
        )}
      </Card>

      <Card className="mt-6">
        <CardHeader title="Bills in this payment" description="Each bill and the amount this payment settles on it, in the bill's currency." />
        <Table aria-label="Bills in this payment">
          <thead><Tr><Th>Bill</Th><Th>Vendor invoice</Th><Th numeric>Bill total</Th><Th numeric>Left to pay</Th><Th numeric>In this payment</Th></Tr></thead>
          <tbody>
            {r.items.map((i) => (
              <Tr key={i.documentId}>
                <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/purchases/bills/${i.documentId}`}>{i.number}</Link></Td>
                <Td>{i.vendorInvoice ?? '—'}</Td>
                <Td numeric><Money value={i.total} currency={i.currency} /></Td>
                <Td numeric><Money value={i.due} currency={i.currency} /></Td>
                <Td numeric><Money value={i.amount} currency={i.currency} /></Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>

      {payOpen ? <PaidDialog base={base} r={r} onClose={() => setPayOpen(false)} onDone={refresh} /> : null}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen} title={`Delete ${r.reference}`} description="The draft is removed and its bills can go into another payment. Nothing was posted.">
        <div className="flex flex-col gap-4">
          <ErrorAlert title="Not deleted" error={remove.error} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>Keep it</Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>Delete draft</Button>
          </div>
        </div>
      </Dialog>
      {cancelOpen ? <CancelDialog base={base} r={r} onClose={() => setCancelOpen(false)} onDone={refresh} /> : null}
    </>
  );
}

function PaidDialog({ base, r, onClose, onDone }: { base: string; r: Remittance; onClose: () => void; onDone: () => Promise<void> }) {
  const [rate, setRate] = useState(r.estimateRate ?? '');
  const [paidOn, setPaidOn] = useState(r.paymentDate > today() ? today() : r.paymentDate);
  const [ref, setRef] = useState('');
  const m = useMutation({ mutationFn: () => api(`${base}/${r.id}/paid`, { method: 'POST', body: { rate, date: paidOn, bankReference: ref || null } }), onSuccess: async () => { await onDone(); onClose(); } });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title={`Record ${r.reference} as paid`} description={`Posts a payment of ${r.amount} ${r.currency} from ${r.bankAccount.code} at the rate the bank applied and settles the bills. The difference from the bills' rate is posted as exchange gain or loss.`}>
      <div className="flex flex-col gap-4">
        <Field label={`Bank's rate (${r.functionalCurrency} per ${r.currency})`}>{(p) => <Input {...p} inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />}</Field>
        <Field label="Date paid">{(p) => <Input {...p} type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />}</Field>
        <Field label="Bank reference (optional)" hint="The bank's transaction or UTR number.">{(p) => <Input {...p} maxLength={60} value={ref} onChange={(e) => setRef(e.target.value)} />}</Field>
        <ErrorAlert title="Payment not recorded" error={m.error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Not yet</Button>
          <Button loading={m.isPending} disabled={!rate} onClick={() => m.mutate()}>Record payment</Button>
        </div>
      </div>
    </Dialog>
  );
}

function CancelDialog({ base, r, onClose, onDone }: { base: string; r: Remittance; onClose: () => void; onDone: () => Promise<void> }) {
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => api(`${base}/${r.id}/cancel`, { method: 'POST', body: { reason } }), onSuccess: async () => { await onDone(); onClose(); } });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title={`Cancel ${r.reference}`} description={r.status === 'SENT' ? 'The instruction was already sent: stop it at the bank too. The bills become free for another payment; nothing is posted.' : 'The bills become free for another payment; nothing is posted. The payment is kept for the record.'}>
      <div className="flex flex-col gap-4">
        <Field label="Reason">{(p) => <Input {...p} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Vendor sent new bank details" />}</Field>
        <ErrorAlert title="Not cancelled" error={m.error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Keep it</Button>
          <Button variant="danger" loading={m.isPending} disabled={reason.trim().length < 3} onClick={() => m.mutate()}>Cancel payment</Button>
        </div>
      </div>
    </Dialog>
  );
}
