'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { D } from '@talk2tax/accounting-engine';
import { placeOfSupplyName } from '@talk2tax/tax-engine';
import { Alert, Button, Card, CardHeader, Dialog, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApprovalCard, useApprovalState } from '@/components/approvals/approval-card';
import { AttachmentsPanel } from '@/components/attachments';
import { EInvoicePanel } from '@/components/e-invoice';
import { EWayBillPanel } from '@/components/e-way-bill';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import { date, money, today } from '@/lib/format';
import { kindLabel, type LedgerConfig } from '@/lib/ledgers';
import { useOrg } from '@/lib/org';
import { LineDimensionTags } from '@/components/dimensions/line-dimensions';
import { useDimensions } from '@/lib/dimensions';
import { DISPUTE_REASON_LABEL, type DisputeList } from '@/lib/disputes';
import { BillMatchPanel } from '@/components/purchase-orders/bill-match-panel';
import { PaymentLinksPanel } from '@/components/payment-links/payment-links-panel';
import { can, type DocumentSummary, type FinancialDocument } from '@/lib/types';
import { DocumentForm } from './document-form';
import { DocStatus } from './documents-table';

export function DocumentDetail({ l }: { l: LedgerConfig }) {
  const { org, orgId } = useOrg();
  const dims = useDimensions();
  const { documentId } = useParams<{ documentId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [voidDate, setVoidDate] = useState(today());
  const [applyOpen, setApplyOpen] = useState(false);
  const [applyId, setApplyId] = useState('');
  const [applyAmount, setApplyAmount] = useState('');
  const [override, setOverride] = useState(false);
  const base = `/v1/orgs/${orgId}/${l.api}`;
  const q = useQuery({ queryKey: ['document', orgId, documentId], queryFn: () => api<FinancialDocument>(`${base}/documents/${documentId}`) });
  const d = q.data;
  const approval = useApprovalState(documentId, d?.status === 'DRAFT');
  const isCharge = d?.kind === l.charge.kind;
  // Counterparts this document can be settled with: open credits for a charge, open charges for a credit.
  const counterparts = useQuery({
    enabled: applyOpen && !!d,
    queryKey: ['documents', orgId, l.api, 'counterparts', d?.contact.id, d?.kind],
    queryFn: () => api<{ items: DocumentSummary[] }>(`${base}/documents?view=open&contactId=${d!.contact.id}&kind=${isCharge ? l.credit.kind : l.charge.kind}&limit=200`),
  });
  const disputable = l.ledger === 'SALES' && d?.kind === 'INVOICE' && d.status === 'POSTED';
  const disputes = useQuery({ enabled: disputable, queryKey: ['disputes', orgId, 'invoice', documentId], queryFn: () => api<DisputeList>(`/v1/orgs/${orgId}/sales/disputes?status=open&documentId=${documentId}`) });
  const openDispute = disputable ? disputes.data?.disputes[0] : undefined;
  const refresh = async () => {
    for (const k of ['document', 'documents', 'contacts', 'contact', 'dashboard', 'payments', 'ageing', 'approval', 'approvals', 'einvoice', 'ewaybill', 'disputes', 'bill-match', 'purchase-orders', 'payment-links']) await qc.invalidateQueries({ queryKey: [k, orgId] });
  };
  const post = useMutation({ mutationFn: () => api<FinancialDocument>(`${base}/documents/${documentId}/post`, { method: 'POST', body: { overrideCreditLimit: override } }), onSuccess: refresh });
  const remove = useMutation({
    mutationFn: () => api(`${base}/documents/${documentId}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await refresh();
      router.replace(`/orgs/${orgId}/${l.docsPath}`);
    },
  });
  const voidDoc = useMutation({
    mutationFn: () => api<FinancialDocument>(`${base}/documents/${documentId}/void`, { method: 'POST', body: { date: voidDate, reason: voidReason } }),
    onSuccess: async () => {
      setVoidOpen(false);
      await refresh();
    },
  });
  const apply = useMutation({
    mutationFn: () =>
      isCharge
        ? api(`${base}/documents/${documentId}/apply-credit`, { method: 'POST', body: { creditDocumentId: applyId, amount: applyAmount } })
        : api(`${base}/documents/${applyId}/apply-credit`, { method: 'POST', body: { creditDocumentId: documentId, amount: applyAmount } }),
    onSuccess: async () => {
      setApplyOpen(false);
      await refresh();
    },
  });
  const unallocate = useMutation({ mutationFn: (id: string) => api(`${base}/allocations/${id}/remove`, { method: 'POST' }), onSuccess: refresh });

  if (!org) return null;
  if (q.error) return <Alert title="Document not found">{(q.error as Error).message}</Alert>;
  if (!d) return <p className="text-sm text-fg-muted">Loading…</p>;
  const c = d.currency;
  const canManage = can(org.role, l.managePermission);
  const label = d.debitNoteFor ? 'Debit note' : kindLabel(l, d.kind);
  const err = post.error ?? remove.error ?? unallocate.error;
  const creditLimitHit = post.error instanceof ApiError && post.error.code === 'CREDIT_LIMIT_EXCEEDED';
  const needsApproval = d.status === 'DRAFT' && approval.data ? !approval.data.readyToPost : false;

  if (editing && d.status === 'DRAFT') {
    return (
      <>
        <PageHeader title={`Edit draft ${label.toLowerCase()}`} actions={<Button variant="ghost" onClick={() => setEditing(false)}>Back</Button>} />
        <DocumentForm l={l} kind={d.kind} existing={d} debitNoteFor={d.debitNoteFor ? { id: d.debitNoteFor.id, number: d.debitNoteFor.number ?? '' } : undefined} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={d.number ? `${label} ${d.number}` : `Draft ${label.toLowerCase()}`}
        description={<Link className="text-accent hover:underline" href={`/orgs/${orgId}/${l.contactsPath}/${d.contact.id}`}>{d.contact.name}</Link>}
        actions={
          <>
            {l.ledger === 'SALES' && (d.kind === 'INVOICE' || d.kind === 'CREDIT_NOTE') ? (
              <Link href={`/orgs/${orgId}/print/${d.id}`}><Button variant="secondary">Print, PDF and sign</Button></Link>
            ) : null}
            {d.status === 'DRAFT' && canManage ? (
              <>
                <Button variant="danger" loading={remove.isPending} onClick={() => confirm('Delete this draft? This cannot be undone.') && remove.mutate()}>Delete draft</Button>
                <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>
              </>
            ) : null}
            {d.status === 'DRAFT' && can(org.role, 'journals.post') ? <Button loading={post.isPending} disabled={(creditLimitHit && !override) || needsApproval || (d.status === 'DRAFT' && !approval.data)} title={needsApproval ? 'Needs an approval first' : undefined} onClick={() => post.mutate()}>Post</Button> : null}
            {d.status === 'POSTED' && canManage && d.amountDue !== '0.00' ? (
              <>
                <Button variant="secondary" onClick={() => { apply.reset(); setApplyId(''); setApplyAmount(''); setApplyOpen(true); }}>{isCharge ? `Apply ${l.credit.label.toLowerCase()}…` : `Apply to ${l.charge.label.toLowerCase()}…`}</Button>
                {isCharge ? (
                  <Link href={`/orgs/${orgId}/${l.paymentsPath}/new?contactId=${d.contact.id}&documentId=${d.id}`}><Button>{l.payment.verb}</Button></Link>
                ) : null}
                {d.kind === 'INVOICE' && can(org.role, 'journals.post') ? (
                  <Link href={`/orgs/${orgId}/sales/bad-debts?writeOff=${d.id}`}><Button variant="ghost">Write off…</Button></Link>
                ) : null}
              </>
            ) : null}
            {disputable && canManage && d.amountDue !== '0.00' && disputes.data && !openDispute ? (
              <Link href={`/orgs/${orgId}/sales/disputes?raise=${d.id}`}><Button variant="ghost">Raise dispute…</Button></Link>
            ) : null}
            {d.status === 'POSTED' && canManage && d.kind === 'INVOICE' && !d.debitNoteFor ? (
              <Link href={`/orgs/${orgId}/${l.docsPath}/new?debitNoteFor=${d.id}`}><Button variant="ghost">Raise debit note…</Button></Link>
            ) : null}
            {d.kind === 'BILL' && d.status === 'POSTED' && canManage && d.amountDue !== '0.00' && d.currency === d.functionalCurrency ? (
              <Link href={`/orgs/${orgId}/purchases/payment-schedule?plan=${d.id}`}><Button variant="ghost">Plan payment…</Button></Link>
            ) : null}
            {d.kind === 'BILL' && d.status !== 'VOID' && canManage && d.currency === d.functionalCurrency ? (
              <Link href={`/orgs/${orgId}/purchases/recurring-bills/new?fromBill=${d.id}`}><Button variant="ghost">Make recurring…</Button></Link>
            ) : null}
            {d.status === 'POSTED' && canManage && can(org.role, 'journals.reverse') ? (
              <Button variant="ghost" onClick={() => { voidDoc.reset(); setVoidOpen(true); }}>Void…</Button>
            ) : null}
          </>
        }
      />
      {err && !creditLimitHit ? <Alert title="Action failed">{err instanceof ApiError ? err.message : 'Try again.'}</Alert> : null}
      {creditLimitHit ? (
        <Alert tone="warning" title="Over the credit limit">
          {post.error?.message}.
          <label className="mt-2 flex items-center gap-2"><input type="checkbox" className="accent-[var(--t2t-accent)]" checked={override} onChange={(e) => setOverride(e.target.checked)} /> Post above the credit limit (recorded in the audit trail)</label>
        </Alert>
      ) : null}
      {openDispute ? (
        <div className="mb-4">
          <Alert tone="warning" title={`Disputed: ${openDispute.ref}`}>
            {d.contact.name} disputes {openDispute.amount} {openDispute.invoice.currency} ({DISPUTE_REASON_LABEL[openDispute.reason].toLowerCase()}): {openDispute.description}. Left out of payment reminders until it is resolved.{' '}
            <Link className="underline" href={`/orgs/${orgId}/sales/disputes/${openDispute.id}`}>Open the dispute</Link>
          </Alert>
        </div>
      ) : null}
      {d.status === 'VOID' ? (
        <div className="mb-4">
          <Alert tone="negative" title={`Voided on ${date(d.voidDate!)}`}>
            {d.voidReason}. The original journal was reversed{d.voidJournalEntryId ? <> by <Link className="underline" href={`/orgs/${orgId}/journals/${d.voidJournalEntryId}`}>this entry</Link></> : null}.
          </Alert>
        </div>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-fg-muted">Status</p>
          <div className="mt-2"><DocStatus d={d} /></div>
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-fg-muted">Dates</p>
          <p className="mt-2 text-sm">{date(d.issueDate)}{isCharge ? <span className="text-fg-muted"> · due {date(d.dueDate)}</span> : null}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-fg-muted">Total</p>
          <p className="mt-2 text-sm"><Money value={d.total} currency={c} /></p>
          {c !== d.functionalCurrency ? <p className="mt-1 text-xs text-fg-muted">= <Money value={d.functionalTotal} currency={d.functionalCurrency} /> at {d.exchangeRate}</p> : null}
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-fg-muted">{isCharge ? 'Still due' : 'Not yet applied'}</p>
          <p className="mt-2 text-sm"><Money value={d.amountDue} currency={c} className={d.isOverdue ? 'text-negative' : ''} /></p>
        </Card>
      </div>
      {d.debitNoteFor ? (
        <p className="mt-4 text-sm">
          Raises the value of <Link className="text-accent hover:underline" href={`/orgs/${orgId}/${l.docsPath}/${d.debitNoteFor.id}`}>invoice {d.debitNoteFor.number}</Link> of {date(d.debitNoteFor.issueDate)} (<Money value={d.debitNoteFor.total} currency={c} />). It is owed and paid like an invoice and reported as a debit note in GST returns.
        </p>
      ) : null}
      {d.purchaseOrderId ? <BillMatchPanel documentId={d.id} currency={c} /> : null}
      {d.debitNotes.length ? (
        <p className="mt-4 text-sm">
          Debit notes on this invoice:{' '}
          {d.debitNotes.map((n, i) => (
            <span key={n.id}>{i ? ', ' : ''}<Link className="text-accent hover:underline" href={`/orgs/${orgId}/${l.docsPath}/${n.id}`}>{n.number ?? 'Draft'}</Link> <Money value={n.total} currency={c} />{n.status === 'VOID' ? ' (void)' : n.status === 'DRAFT' ? ' (draft)' : ''}</span>
          ))}
          .
        </p>
      ) : null}
      {d.reference || d.memo || d.journalEntryId ? (
        <p className="mt-4 text-sm text-fg-muted">
          {d.reference ? <>Reference {d.reference}. </> : null}
          {d.memo ? <>{d.memo}. </> : null}
          {d.journalEntryId ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/journals/${d.journalEntryId}`}>View the journal entry</Link> : null}
        </p>
      ) : null}

      {d.gst ? <GstSummary gst={d.gst} currency={c} isSales={l.ledger === 'SALES'} contactName={d.contact.name} reverseCharge={d.reverseCharge} /> : null}
      {d.withholding ? <WithholdingSummary w={d.withholding} currency={c} orgId={orgId} /> : null}

      {l.ledger === 'SALES' && org.countryCode === 'IN' && d.status !== 'DRAFT' && (d.kind === 'INVOICE' || d.kind === 'CREDIT_NOTE') ? <EInvoicePanel orgId={orgId} documentId={d.id} canManage={canManage} onChange={refresh} /> : null}
      {l.ledger === 'SALES' && org.countryCode === 'IN' && d.status !== 'DRAFT' && d.kind === 'INVOICE' ? <EWayBillPanel orgId={orgId} documentId={d.id} issueDate={d.issueDate} canManage={canManage} onChange={refresh} /> : null}

      {l.ledger === 'SALES' && d.kind === 'INVOICE' && d.status === 'POSTED' ? <PaymentLinksPanel orgId={orgId} documentId={d.id} onChange={refresh} /> : null}

      <ApprovalCard documentId={d.id} isDraft={d.status === 'DRAFT'} canManage={canManage} currency={c} onChange={refresh} />

      <Card className="mt-6">
        <CardHeader title="Lines" />
        <Table>
          <thead>
            <tr>
              <Th>#</Th>
              <Th>Description</Th>
              <Th>Account</Th>
              {d.gst ? <Th>HSN/SAC</Th> : null}
              <Th numeric>Qty</Th>
              <Th numeric>Unit price</Th>
              <Th>Tax</Th>
              <Th numeric>Net</Th>
              <Th numeric>Tax</Th>
            </tr>
          </thead>
          <tbody>
            {d.lines.map((x) => (
              <Tr key={x.lineNo}>
                <Td className="text-fg-muted">{x.lineNo}</Td>
                <Td>{x.description}<LineDimensionTags values={dims.data?.values} departmentId={x.departmentId} projectId={x.projectId} /></Td>
                <Td className="text-fg-muted"><span className="num">{x.accountCode}</span> {x.accountName}</Td>
                {d.gst ? <Td className="num text-fg-muted">{x.hsnCode ?? '—'}</Td> : null}
                <Td numeric className="num">{x.quantity}</Td>
                <Td numeric className="num">{x.unitPrice}</Td>
                <Td className="text-fg-muted">{x.taxName ? `${x.taxName}` : '—'}</Td>
                <Td numeric><Money value={x.netAmount} currency={c} /></Td>
                <Td numeric>
                  <Money value={x.taxAmount} currency={c} />
                  {x.cgstAmount !== '0.00' ? <p className="text-xs text-fg-muted">CGST {money(x.cgstAmount, c)} · SGST {money(x.sgstAmount, c)}</p> : null}
                  {x.igstAmount !== '0.00' ? <p className="text-xs text-fg-muted">IGST</p> : null}
                </Td>
              </Tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <Td colSpan={d.gst ? 7 : 6} className="text-right text-fg-muted">Subtotal and tax</Td>
              <Td numeric><Money value={d.subtotal} currency={c} /></Td>
              <Td numeric><Money value={d.taxTotal} currency={c} /></Td>
            </tr>
            {d.reverseCharge ? (
              <tr>
                <Td colSpan={d.gst ? 8 : 7} className="text-right text-fg-muted">GST under reverse charge (you pay it; not owed to {d.contact.name})</Td>
                <Td numeric className="text-fg-muted"><Money value={d.reverseChargeTax} currency={c} /></Td>
              </tr>
            ) : null}
            {d.withholding && d.withholding.amount !== '0.00' ? (
              <tr>
                <Td colSpan={d.gst ? 8 : 7} className="text-right text-fg-muted">{d.withholding.kind === 'TDS' ? 'Less TDS' : 'Add TCS'} {d.withholding.section.code}</Td>
                <Td numeric>{d.withholding.kind === 'TDS' ? '−' : '+'} <Money value={d.withholding.amount} currency={c} /></Td>
              </tr>
            ) : null}
            <tr>
              <Td colSpan={d.gst ? 8 : 7} className="text-right font-semibold">{d.withholding && d.withholding.amount !== '0.00' ? (d.withholding.kind === 'TDS' ? 'Payable to vendor' : 'Customer pays') : 'Total'}</Td>
              <Td numeric className="font-semibold"><Money value={d.total} currency={c} /></Td>
            </tr>
          </tfoot>
        </Table>
      </Card>

      <Card className="mt-6">
        <CardHeader title={isCharge ? 'Payments and credits applied' : `Applied to ${l.charge.plural.toLowerCase()}`} description={c !== d.functionalCurrency ? `Removing an application keeps a record of it, reopens the amount and reverses its exchange difference. Each amount settled at a rate other than this ${label.toLowerCase()}'s ${d.exchangeRate} posts a realised exchange gain or loss in ${d.functionalCurrency}.` : 'Removing an application keeps a record of it and reopens the amount.'} />
        {d.allocations.length === 0 ? (
          <p className="px-5 py-4 text-sm text-fg-muted">Nothing applied yet.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>{isCharge ? 'From' : 'To'}</Th>
                <Th numeric>Amount</Th>
                {c !== d.functionalCurrency ? <Th numeric>Exchange difference</Th> : null}
                <Th><span className="sr-only">Actions</span></Th>
              </tr>
            </thead>
            <tbody>
              {d.allocations.map((a) => {
                const other = a.source ?? a.target!;
                const writeOff = a.source?.type === 'write_off';
                const href = a.source?.type === 'payment' ? `/orgs/${orgId}/${l.paymentsPath}/${other.id}` : writeOff ? `/orgs/${orgId}/sales/bad-debts` : `/orgs/${orgId}/${l.docsPath}/${other.id}`;
                return (
                  <Tr key={a.id}>
                    <Td>{date(a.date)}</Td>
                    <Td><Link className="text-accent hover:underline" href={href}>{writeOff ? 'Bad-debt write-off' : kindLabel(l, other.kind)} {other.number}</Link></Td>
                    <Td numeric><Money value={a.amount} currency={c} /></Td>
                    {c !== d.functionalCurrency ? (
                      <Td numeric>
                        {a.fxGain ? (
                          <Link className="hover:underline" href={`/orgs/${orgId}/journals/${a.fxJournalEntryId}`}>
                            <span className={Number(a.fxGain) > 0 ? 'text-positive' : 'text-negative'}>{Number(a.fxGain) > 0 ? 'Gain ' : 'Loss '}{money(a.fxGain.replace('-', ''), d.functionalCurrency)}</span>
                          </Link>
                        ) : <span className="text-fg-faint">None</span>}
                      </Td>
                    ) : null}
                    <Td className="text-right">
                      {canManage && !writeOff ? <Button size="sm" variant="ghost" loading={unallocate.isPending && unallocate.variables === a.id} onClick={() => confirm('Remove this application? The amount becomes open again.') && unallocate.mutate(a.id)}>Remove</Button> : null}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <AttachmentsPanel entityType="DOCUMENT" entityId={d.id} canManage={canManage} description={`The ${label.toLowerCase()} itself, receipts, delivery notes. PDF, PNG, JPEG or WebP up to 5 MB each; kept exactly as uploaded.`} />

      <Dialog open={voidOpen} onOpenChange={setVoidOpen} title={`Void ${label.toLowerCase()} ${d.number}`} description="Voiding posts an exact reversing journal. The document stays on record, marked void.">
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); voidDoc.mutate(); }}>
          {voidDoc.error ? <Alert title="Could not void">{voidDoc.error.message}</Alert> : null}
          <Field label="Void date">{(p) => <Input {...p} type="date" min={d.issueDate} value={voidDate} onChange={(e) => setVoidDate(e.target.value)} />}</Field>
          <Field label="Reason" hint="Kept in the audit trail.">{(p) => <Input {...p} required minLength={3} value={voidReason} onChange={(e) => setVoidReason(e.target.value)} />}</Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setVoidOpen(false)}>Cancel</Button>
            <Button type="submit" variant="danger" loading={voidDoc.isPending}>Void {label.toLowerCase()}</Button>
          </div>
        </form>
      </Dialog>

      <Dialog open={applyOpen} onOpenChange={setApplyOpen} title={isCharge ? `Apply a ${l.credit.label.toLowerCase()}` : `Apply to a ${l.charge.label.toLowerCase()}`}>
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); apply.mutate(); }}>
          {apply.error ? <Alert title="Could not apply">{apply.error.message}</Alert> : null}
          {counterparts.data && counterparts.data.items.length === 0 ? (
            <p className="text-sm text-fg-muted">{d.contact.name} has no open {isCharge ? l.credit.plural.toLowerCase() : l.charge.plural.toLowerCase()}.</p>
          ) : (
            <>
              <Field label={isCharge ? l.credit.label : l.charge.label}>
                {(p) => (
                  <Select {...p} required value={applyId} onChange={(e) => {
                    setApplyId(e.target.value);
                    const other = counterparts.data?.items.find((x) => x.id === e.target.value);
                    if (other) setApplyAmount(D.min(other.amountDue, d.amountDue).toFixed(2));
                  }}>
                    <option value="">Choose…</option>
                    {(counterparts.data?.items ?? []).filter((x) => x.currency === c).map((x) => <option key={x.id} value={x.id}>{x.number} · {x.amountDue} {x.currency} open</option>)}
                  </Select>
                )}
              </Field>
              <Field label="Amount to apply">{(p) => <Input {...p} required inputMode="decimal" value={applyAmount} onChange={(e) => /^\d{0,18}(\.\d{0,2})?$/.test(e.target.value) && setApplyAmount(e.target.value)} />}</Field>
            </>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setApplyOpen(false)}>Cancel</Button>
            <Button type="submit" loading={apply.isPending} disabled={!applyId || !applyAmount}>Apply</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

function WithholdingSummary({ w, currency, orgId }: { w: NonNullable<FinancialDocument['withholding']>; currency: string; orgId: string }) {
  return (
    <Card className="mt-4 grid gap-4 p-4 sm:grid-cols-4" aria-label={`${w.kind} details`}>
      <div>
        <p className="text-xs uppercase tracking-wide text-fg-muted">{w.kind} section</p>
        <p className="mt-1 text-sm"><span className="num">{w.section.code}</span> <span className="text-fg-muted">· {w.section.name}</span></p>
      </div>
      <div>
        <p className="text-xs uppercase tracking-wide text-fg-muted">{w.kind === 'TDS' ? 'Deducted' : 'Collected'}</p>
        <p className="mt-1 text-sm">{w.amount === '0.00' ? <span className="text-fg-muted">Nothing: below the threshold (counts toward it)</span> : <>{w.rate}% on {money(w.base, currency)} = {money(w.amount, currency)}</>}</p>
      </div>
      <div>
        <p className="text-xs uppercase tracking-wide text-fg-muted">PAN</p>
        <p className="num mt-1 text-sm">{w.pan ?? <span className="font-sans text-warning">None on file (higher rate)</span>}</p>
      </div>
      <div>
        <p className="text-xs uppercase tracking-wide text-fg-muted">Deposit</p>
        <p className="mt-1 text-sm">{w.deposit ? <>{w.deposit.number} · {date(w.deposit.date)}<span className="block text-xs text-fg-muted">Challan {w.deposit.challanReference}</span></> : w.amount === '0.00' ? '—' : <Link className="text-accent hover:underline" href={`/orgs/${orgId}/tax/tds-tcs?kind=${w.kind}`}>Not deposited yet</Link>}</p>
      </div>
    </Card>
  );
}

function GstSummary({ gst, currency, isSales, contactName, reverseCharge }: { gst: NonNullable<FinancialDocument['gst']>; currency: string; isSales: boolean; contactName: string; reverseCharge: boolean }) {
  const intra = gst.supplyNature === 'INTRA';
  return (
    <Card className="mt-4 grid gap-4 p-4 sm:grid-cols-4" aria-label="GST details">
      <div>
        <p className="text-xs uppercase tracking-wide text-fg-muted">Place of supply</p>
        <p className="mt-1 text-sm">{gst.placeOfSupply} · {placeOfSupplyName(gst.placeOfSupply)}</p>
      </div>
      <div>
        <p className="text-xs uppercase tracking-wide text-fg-muted">Supply</p>
        <p className="mt-1 text-sm">{gst.placeOfSupply === '96' ? 'Export (IGST paid)' : gst.supplierState === '96' ? 'Import of services' : intra ? 'Intra-state' : 'Inter-state'} <span className="text-fg-muted">· supplier in {gst.supplierState === '96' ? 'outside India' : placeOfSupplyName(gst.supplierState)}</span></p>
        {reverseCharge ? <p className="mt-1 text-xs font-medium text-warning">Reverse charge: you pay this GST</p> : null}
      </div>
      <div>
        <p className="text-xs uppercase tracking-wide text-fg-muted">{isSales ? 'Buyer' : 'Supplier'} GSTIN</p>
        <p className="num mt-1 text-sm">{gst.counterpartyGstin ?? <span className="font-sans text-fg-muted">{contactName} is unregistered</span>}</p>
      </div>
      <div>
        <p className="text-xs uppercase tracking-wide text-fg-muted">{isSales ? 'Output tax' : reverseCharge ? 'GST payable and credit' : 'Input tax'}</p>
        <p className="mt-1 text-sm">
          {intra ? <>CGST {money(gst.cgst, currency)} · SGST/UTGST {money(gst.sgst, currency)}</> : <>IGST {money(gst.igst, currency)}</>}
        </p>
      </div>
    </Card>
  );
}
