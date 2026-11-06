'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import { date, dateTime } from '@/lib/format';
import { useMe, useOrg } from '@/lib/org';
import { BATCH_STATUS, type Batch, type BankState } from '@/lib/payment-batches';

function BankCell({ bank }: { bank: BankState | null }) {
  if (!bank || !bank.hasDetails) return <Badge tone="negative">No bank details</Badge>;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="font-mono text-xs">{bank.accountNumberMasked} · {bank.ifsc}</span>
      {bank.verified ? <Badge tone="positive">Verified</Badge> : <Badge tone="warning">Not verified</Badge>}
    </span>
  );
}

/** One payment batch: what it pays, who prepared and approved it, the bank file and the payments. */
export default function PaymentBatchPage() {
  const { org, orgId } = useOrg();
  const { batchId } = useParams<{ batchId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const me = useMe();
  const base = `/v1/orgs/${orgId}/purchases/payment-batches`;
  const q = useQuery({ queryKey: ['payment-batch', orgId, batchId], queryFn: () => api<Batch>(`${base}/${batchId}`) });
  const [cancelOpen, setCancelOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileBusy, setFileBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['payment-batch', orgId, batchId] });
    await qc.invalidateQueries({ queryKey: ['payment-batches', orgId] });
    await qc.invalidateQueries({ queryKey: ['payable-bills', orgId] });
  };
  const approve = useMutation({ mutationFn: () => api(`${base}/${batchId}/approve`, { method: 'POST', body: {} }), onSuccess: refresh });
  const paid = useMutation({ mutationFn: () => api(`${base}/${batchId}/paid`, { method: 'POST', body: {} }), onSuccess: async () => { await refresh(); setPayOpen(false); setSaved(null); } });
  const remove = useMutation({ mutationFn: () => api(`${base}/${batchId}`, { method: 'DELETE' }), onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['payment-batches', orgId] }); router.push(`/orgs/${orgId}/purchases/payment-batches`); } });

  const download = async () => {
    setFileBusy(true);
    setFileError(null);
    setSaved(null);
    try {
      const res = await fetch(`/api/t2t${base}/${batchId}/payment-file`, { method: 'POST', headers: { 'x-t2t-csrf': '1', 'content-type': 'application/json' }, body: '{}' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new ApiError(res.status, body.error ?? 'ERROR', body.message ?? `Download failed (${res.status})`, []);
      }
      const blob = await res.blob();
      const fileName = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'payment-batch.csv';
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
  const b = q.data;
  if (!b) return <ErrorAlert title="Could not load the batch" error={q.error} />;
  const st = BATCH_STATUS[b.status];
  const mine = me.data?.user.id === b.createdById;
  const blocked = b.issues.length > 0;
  return (
    <>
      <PageHeader
        title={`Payment batch ${b.reference}`}
        description={`Pays ${b.items.length} ${b.items.length === 1 ? 'bill' : 'bills'} to ${b.vendors.length} ${b.vendors.length === 1 ? 'vendor' : 'vendors'} from ${b.bankAccount ? `${b.bankAccount.code} ${b.bankAccount.name}` : 'the bank'} on ${date(b.paymentDate)}.`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={st.tone}>{st.label}</Badge>
            {b.status === 'DRAFT' && b.can.prepare ? (
              <>
                <Link href={`/orgs/${orgId}/purchases/payment-batches/${b.id}/edit`}><Button variant="secondary">Edit</Button></Link>
                <Button variant="ghost" onClick={() => setDeleteOpen(true)}>Delete</Button>
              </>
            ) : null}
            {b.status === 'DRAFT' && b.can.approve ? <Button loading={approve.isPending} disabled={blocked} onClick={() => approve.mutate()}>Approve</Button> : null}
            {b.status === 'APPROVED' && b.can.pay ? (
              <>
                <Button variant="secondary" loading={fileBusy} disabled={blocked} onClick={() => void download()}>Download bank file</Button>
                <Button disabled={blocked} onClick={() => setPayOpen(true)}>Record payments</Button>
              </>
            ) : null}
            {(b.status === 'DRAFT' || b.status === 'APPROVED') && b.can.prepare ? <Button variant="ghost" onClick={() => setCancelOpen(true)}>Cancel…</Button> : null}
          </div>
        }
      />
      {fileError ? <div className="mt-4"><Alert tone="negative" title="Bank file not downloaded">{fileError}</Alert></div> : null}
      {saved ? <p role="status" className="mt-2 text-sm text-fg-muted">Downloaded {saved}. Upload it to the bank, then record the payments once the bank has paid.</p> : null}
      <ErrorAlert title="Not approved" error={approve.error} />
      {blocked && (b.status === 'DRAFT' || b.status === 'APPROVED') ? (
        <div className="mt-4">
          <Alert tone="warning" title="This batch cannot go ahead yet">
            <ul className="list-disc pl-5">{b.issues.map((i) => <li key={`${i.documentId}-${i.issue}`}>{i.issue}</li>)}</ul>
          </Alert>
        </div>
      ) : null}
      {b.status === 'DRAFT' && b.can.approve && mine && !blocked ? (
        <p className="mt-3 text-sm text-fg-muted">You prepared this batch, so someone else with approval rights should approve it. If you are the only approver in the organisation, your approval is accepted and marked as self-approved.</p>
      ) : null}
      {b.status === 'DRAFT' && !b.can.approve ? <p className="mt-3 text-sm text-fg-muted">Waiting for someone with approval rights to approve it.</p> : null}

      <Card className="mt-6">
        <CardHeader title="Batch record" description="Who prepared, approved and paid this batch, and when." />
        <dl className="grid gap-4 p-5 text-sm sm:grid-cols-3">
          <div><dt className="text-fg-muted">Total</dt><dd className="font-semibold"><Money value={b.total} currency={b.currency} /></dd></div>
          <div><dt className="text-fg-muted">Prepared</dt><dd>{b.createdBy ?? 'Someone'} · {dateTime(b.createdAt)}</dd></div>
          <div><dt className="text-fg-muted">Approved</dt><dd>{b.approvedAt ? <>{b.approvedBy ?? 'Someone'} · {dateTime(b.approvedAt)}{b.selfApproved ? <> <Badge tone="warning">Self-approved</Badge></> : null}</> : 'Not yet'}</dd></div>
          <div><dt className="text-fg-muted">Bank file</dt><dd>{b.fileDownloadedAt ? `Downloaded ${dateTime(b.fileDownloadedAt)}` : 'Not downloaded'}</dd></div>
          <div><dt className="text-fg-muted">Paid</dt><dd>{b.paidAt ? `${b.paidBy ?? 'Someone'} · ${dateTime(b.paidAt)}` : 'Not yet'}</dd></div>
          {b.cancelledAt ? <div><dt className="text-fg-muted">Cancelled</dt><dd>{b.cancelledBy ?? 'Someone'} · {dateTime(b.cancelledAt)}: {b.cancelReason}</dd></div> : null}
          {b.memo ? <div className="sm:col-span-3"><dt className="text-fg-muted">Note</dt><dd>{b.memo}</dd></div> : null}
        </dl>
      </Card>

      <Card className="mt-6">
        <CardHeader title="Vendors in this batch" description="One payment per vendor. Only verified bank details are sent to the bank; numbers are masked here." />
        <Table aria-label="Vendors in this batch">
          <thead><Tr><Th>Vendor</Th><Th>Bank details</Th><Th numeric>Bills</Th><Th numeric>Amount</Th></Tr></thead>
          <tbody>
            {b.vendors.map((v) => (
              <Tr key={v.contactId}>
                <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/purchases/vendors/${v.contactId}`}>{v.name}</Link></Td>
                <Td><BankCell bank={v.bank} /></Td>
                <Td numeric>{v.bills}</Td>
                <Td numeric><Money value={v.amount} currency={b.currency} /></Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <Card className="mt-6">
        <CardHeader title="Bills in this batch" description="Each bill and the amount this batch pays on it. Once paid, each bill links to its payment." />
        <Table aria-label="Bills in this batch">
          <thead><Tr><Th>Bill</Th><Th>Vendor</Th><Th>Due</Th><Th numeric>Left to pay</Th><Th numeric>In this batch</Th><Th>Payment</Th></Tr></thead>
          <tbody>
            {b.items.map((i) => (
              <Tr key={i.id}>
                <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/purchases/bills/${i.documentId}`}>{i.number}</Link></Td>
                <Td>{i.vendor.name}</Td>
                <Td>{i.dueDate ? date(i.dueDate) : '—'}</Td>
                <Td numeric><Money value={i.due} currency={b.currency} /></Td>
                <Td numeric><Money value={i.amount} currency={b.currency} /></Td>
                <Td>{i.payment ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/purchases/payments/${i.payment.id}`}>{i.payment.number ?? 'Payment'}</Link> : '—'}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <Dialog open={payOpen} onOpenChange={setPayOpen} title={`Record the payments of ${b.reference}`} description={`Posts one payment per vendor from ${b.bankAccount?.code ?? 'the bank'} on ${date(b.paymentDate)}, with the reference ${b.reference}, and settles the bills. Do this once the bank has made the payments.`}>
        <div className="flex flex-col gap-4">
          <ErrorAlert title="Payments not recorded" error={paid.error} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPayOpen(false)}>Not yet</Button>
            <Button loading={paid.isPending} onClick={() => paid.mutate()}>Record {b.vendors.length} {b.vendors.length === 1 ? 'payment' : 'payments'}</Button>
          </div>
        </div>
      </Dialog>
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen} title={`Delete ${b.reference}`} description="The draft is removed and its bills can go into another batch. Nothing was posted.">
        <div className="flex flex-col gap-4">
          <ErrorAlert title="Not deleted" error={remove.error} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>Keep it</Button>
            <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>Delete draft</Button>
          </div>
        </div>
      </Dialog>
      {cancelOpen ? <CancelDialog base={base} batch={b} onClose={() => setCancelOpen(false)} onDone={refresh} /> : null}
    </>
  );
}

function CancelDialog({ base, batch, onClose, onDone }: { base: string; batch: Batch; onClose: () => void; onDone: () => Promise<void> }) {
  const [reason, setReason] = useState('');
  const m = useMutation({ mutationFn: () => api(`${base}/${batch.id}/cancel`, { method: 'POST', body: { reason } }), onSuccess: async () => { await onDone(); onClose(); } });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title={`Cancel ${batch.reference}`} description={batch.status === 'APPROVED' ? 'If the bank file was already uploaded, stop it at the bank too. The bills become free for another batch; nothing is posted.' : 'The bills become free for another batch; nothing is posted. The batch is kept for the record.'}>
      <div className="flex flex-col gap-4">
        <Field label="Reason">{(p) => <Input {...p} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Vendor asked to be paid next week" />}</Field>
        <ErrorAlert title="Not cancelled" error={m.error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Keep it</Button>
          <Button variant="danger" loading={m.isPending} disabled={reason.trim().length < 3} onClick={() => m.mutate()}>Cancel batch</Button>
        </div>
      </div>
    </Dialog>
  );
}
