'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { VendorSubmissionStatus } from '@talk2tax/accounting-engine';
import { Alert, Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Select, Table, Td, Textarea, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, dateTime } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

interface Sent {
  id: string;
  contactId: string;
  vendor: string;
  invoiceNumber: string;
  invoiceDate: string;
  currency: string;
  amount: string;
  purchaseOrderId: string | null;
  purchaseOrder: string | null;
  note: string | null;
  file: { name: string; contentType: string; sizeBytes: number } | null;
  status: VendorSubmissionStatus;
  bill: { id: string; number: string | null; reference: string | null } | null;
  decidedBy: string | null;
  decidedAt: string | null;
  rejectReason: string | null;
  createdAt: string;
}
interface List {
  submissions: Sent[];
  counts: { received: number; recorded: number; rejected: number };
}
interface BillChoice {
  id: string;
  number: string | null;
  status: string;
  reference: string | null;
  issueDate: string;
  currency: string;
  total: string;
  matches: boolean;
}
const TONE = { RECEIVED: 'accent', RECORDED: 'positive', REJECTED: 'negative' } as const;
const STAFF_LABEL: Record<VendorSubmissionStatus, string> = { RECEIVED: 'To check', RECORDED: 'Recorded', REJECTED: 'Turned down' };

/** Purchases → Vendor invoices (AP-013): invoices vendors sent through the vendor portal. */
export default function VendorInvoicesPage() {
  const { org, orgId } = useOrg();
  const params = useSearchParams();
  const contactId = params.get('contactId') ?? '';
  const [status, setStatus] = useState<VendorSubmissionStatus | ''>('RECEIVED');
  const qc = useQueryClient();
  const key = ['vendor-invoices', orgId, contactId, status];
  const q = useQuery({ queryKey: key, queryFn: () => api<List>(`/v1/orgs/${orgId}/purchases/vendor-invoices?${new URLSearchParams({ ...(status ? { status } : {}), ...(contactId ? { contactId } : {}) })}`) });
  const [recording, setRecording] = useState<Sent | null>(null);
  const [rejecting, setRejecting] = useState<Sent | null>(null);
  if (!org) return null;
  const canManage = can(org.role, 'purchases.manage');
  const r = q.data;
  const done = () => {
    setRecording(null);
    setRejecting(null);
    void qc.invalidateQueries({ queryKey: ['vendor-invoices', orgId] });
  };
  return (
    <>
      <PageHeader title="Vendor invoices" description="Invoices vendors sent through their vendor portal link. Check each one, then record it against its bill (the vendor's file is attached to the bill) or turn it down with a reason the vendor sees. Nothing here posts to the books." />
      <ErrorAlert title="Could not load vendor invoices" error={q.error} />
      {r ? (
        <div className="grid gap-4 sm:grid-cols-3">
          <Card className="p-4"><p className="text-sm text-fg-muted">To check</p><p className="mt-1 text-2xl font-semibold">{r.counts.received}</p></Card>
          <Card className="p-4"><p className="text-sm text-fg-muted">Recorded</p><p className="mt-1 text-2xl font-semibold">{r.counts.recorded}</p></Card>
          <Card className="p-4"><p className="text-sm text-fg-muted">Turned down</p><p className="mt-1 text-2xl font-semibold">{r.counts.rejected}</p></Card>
        </div>
      ) : null}
      {r ? (
        <Card className="mt-6" role="region" aria-label="Invoices sent by vendors">
          <CardHeader
            title="Invoices sent by vendors"
            description={contactId ? <>One vendor only. <Link className="text-accent hover:underline" href={`/orgs/${orgId}/purchases/vendor-invoices`}>Show every vendor</Link></> : 'To give a vendor a link, open the vendor and use the Vendor portal card.'}
            actions={<div className="w-44"><Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as VendorSubmissionStatus | '')}><option value="RECEIVED">To check</option><option value="RECORDED">Recorded</option><option value="REJECTED">Turned down</option><option value="">All</option></Select></div>}
          />
          {r.submissions.length ? (
            <Table>
              <thead><Tr><Th>Invoice</Th><Th>Vendor</Th><Th>Sent</Th><Th numeric>Amount</Th><Th>Status</Th><Th><span className="sr-only">Actions</span></Th></Tr></thead>
              <tbody>
                {r.submissions.map((s) => (
                  <Tr key={s.id}>
                    <Td className="align-top">
                      <span className="font-medium">{s.invoiceNumber}</span>
                      <span className="block text-xs text-fg-muted">dated {date(s.invoiceDate)}{s.purchaseOrder ? <> · <Link className="text-accent hover:underline" href={`/orgs/${orgId}/purchases/orders/${s.purchaseOrderId}`}>{s.purchaseOrder}</Link></> : ''}</span>
                      {s.file ? <a className="block text-sm text-accent hover:underline" href={`/api/t2t/v1/orgs/${orgId}/purchases/vendor-invoices/${s.id}/file?inline=1`} target="_blank" rel="noopener noreferrer">{s.file.name}</a> : <span className="block text-xs text-fg-muted">No file sent</span>}
                      {s.note ? <span className="block max-w-md text-sm text-fg-muted">“{s.note}”</span> : null}
                    </Td>
                    <Td className="align-top"><Link className="hover:underline" href={`/orgs/${orgId}/purchases/vendors/${s.contactId}`}>{s.vendor}</Link></Td>
                    <Td className="align-top text-sm">{dateTime(s.createdAt)}</Td>
                    <Td numeric className="align-top"><Money value={s.amount} currency={s.currency} /></Td>
                    <Td className="align-top">
                      <Badge tone={TONE[s.status]}><span className="whitespace-nowrap">{STAFF_LABEL[s.status]}</span></Badge>
                      {s.bill ? <Link className="block text-xs text-accent hover:underline" href={`/orgs/${orgId}/purchases/bills/${s.bill.id}`}>Bill {s.bill.number ?? 'draft'}{s.bill.reference ? ` (${s.bill.reference})` : ''}</Link> : null}
                      {s.rejectReason ? <span className="block max-w-xs text-xs text-fg-muted">{s.rejectReason}</span> : null}
                      {s.decidedBy ? <span className="block text-xs text-fg-muted">by {s.decidedBy}</span> : null}
                    </Td>
                    <Td className="align-top whitespace-nowrap text-right">
                      {canManage && s.status === 'RECEIVED' ? (
                        <>
                          <Button size="sm" variant="secondary" onClick={() => setRecording(s)}>Record</Button>{' '}
                          <Button size="sm" variant="ghost" onClick={() => setRejecting(s)}>Turn down</Button>
                        </>
                      ) : null}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <EmptyState title={status === 'RECEIVED' ? 'Nothing to check' : 'No invoices here'}>Invoices vendors send through their portal link show here.</EmptyState>
          )}
        </Card>
      ) : null}
      {recording ? <RecordDialog orgId={orgId} sent={recording} onClose={() => setRecording(null)} onDone={done} /> : null}
      {rejecting ? <RejectDialog orgId={orgId} sent={rejecting} onClose={() => setRejecting(null)} onDone={done} /> : null}
    </>
  );
}

function RecordDialog({ orgId, sent, onClose, onDone }: { orgId: string; sent: Sent; onClose: () => void; onDone: () => void }) {
  const q = useQuery({ queryKey: ['vendor-invoice-bills', orgId, sent.id], queryFn: () => api<BillChoice[]>(`/v1/orgs/${orgId}/purchases/vendor-invoices/${sent.id}/bills`) });
  const [billId, setBillId] = useState('');
  const chosen = billId || q.data?.find((b) => b.matches)?.id || '';
  const save = useMutation({ mutationFn: () => api(`/v1/orgs/${orgId}/purchases/vendor-invoices/${sent.id}/record`, { method: 'POST', body: { documentId: chosen } }), onSuccess: onDone });
  const pick = q.data?.find((b) => b.id === chosen);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Record invoice ${sent.invoiceNumber}`} description={`Choose the bill that records ${sent.vendor}'s invoice. Record the bill first if there is none. The file they sent is attached to the bill.`}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        {save.error ? <Alert title="Could not record">{save.error.message}</Alert> : null}
        <p className="text-sm">Sent: <span className="font-medium">{sent.invoiceNumber}</span> dated {date(sent.invoiceDate)}, <Money value={sent.amount} currency={sent.currency} /></p>
        {q.data && !q.data.length ? <Alert tone="warning" title="No bill to choose">Record {sent.vendor}&apos;s bill first, with their invoice number as the reference, then come back.</Alert> : null}
        {q.data?.length ? (
          <Field label="Bill">{(p) => (
            <Select {...p} required value={chosen} onChange={(e) => setBillId(e.target.value)}>
              <option value="">Choose a bill</option>
              {q.data.map((b) => <option key={b.id} value={b.id}>{`${b.number ?? 'Draft'} · ${b.reference ?? 'no reference'} · ${date(b.issueDate)} · ${b.currency} ${b.total}${b.matches ? ' · same invoice number' : ''}`}</option>)}
            </Select>
          )}</Field>
        ) : null}
        {pick && Number(pick.total) !== Number(sent.amount) ? <Alert tone="warning" title="Amounts differ">The bill is {pick.currency} {pick.total}; the vendor sent {sent.currency} {sent.amount}. Check it before recording.</Alert> : null}
        <div className="flex justify-between gap-2">
          <Link className="self-center text-sm text-accent hover:underline" href={`/orgs/${orgId}/purchases/bills/new`}>Record a bill</Link>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={!chosen} loading={save.isPending}>Record</Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

function RejectDialog({ orgId, sent, onClose, onDone }: { orgId: string; sent: Sent; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const save = useMutation({ mutationFn: () => api(`/v1/orgs/${orgId}/purchases/vendor-invoices/${sent.id}/reject`, { method: 'POST', body: { reason } }), onSuccess: onDone });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Turn down invoice ${sent.invoiceNumber}`} description={`${sent.vendor} sees the reason on their portal and can send the invoice again.`}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        {save.error ? <Alert title="Could not save">{save.error.message}</Alert> : null}
        <Field label="Reason">{(p) => <Textarea {...p} rows={2} maxLength={500} required value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={save.isPending}>Turn down</Button>
        </div>
      </form>
    </Dialog>
  );
}
