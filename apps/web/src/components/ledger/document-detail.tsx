'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { D } from '@talk2tax/accounting-engine';
import { Alert, Button, Card, CardHeader, Dialog, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import { date, today } from '@/lib/format';
import { kindLabel, type LedgerConfig } from '@/lib/ledgers';
import { useOrg } from '@/lib/org';
import { can, type DocumentSummary, type FinancialDocument } from '@/lib/types';
import { DocumentForm } from './document-form';
import { DocStatus } from './documents-table';

export function DocumentDetail({ l }: { l: LedgerConfig }) {
  const { org, orgId } = useOrg();
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
  const isCharge = d?.kind === l.charge.kind;
  // Counterparts this document can be settled with: open credits for a charge, open charges for a credit.
  const counterparts = useQuery({
    enabled: applyOpen && !!d,
    queryKey: ['documents', orgId, l.api, 'counterparts', d?.contact.id, d?.kind],
    queryFn: () => api<{ items: DocumentSummary[] }>(`${base}/documents?view=open&contactId=${d!.contact.id}&kind=${isCharge ? l.credit.kind : l.charge.kind}&limit=200`),
  });
  const refresh = async () => {
    for (const k of ['document', 'documents', 'contacts', 'contact', 'dashboard', 'payments', 'ageing']) await qc.invalidateQueries({ queryKey: [k, orgId] });
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
  const label = kindLabel(l, d.kind);
  const err = post.error ?? remove.error ?? unallocate.error;
  const creditLimitHit = post.error instanceof ApiError && post.error.code === 'CREDIT_LIMIT_EXCEEDED';

  if (editing && d.status === 'DRAFT') {
    return (
      <>
        <PageHeader title={`Edit draft ${label.toLowerCase()}`} actions={<Button variant="ghost" onClick={() => setEditing(false)}>Back</Button>} />
        <DocumentForm l={l} kind={d.kind} existing={d} />
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
            {d.status === 'DRAFT' && canManage ? (
              <>
                <Button variant="danger" loading={remove.isPending} onClick={() => confirm('Delete this draft? This cannot be undone.') && remove.mutate()}>Delete draft</Button>
                <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>
              </>
            ) : null}
            {d.status === 'DRAFT' && can(org.role, 'journals.post') ? <Button loading={post.isPending} disabled={creditLimitHit && !override} onClick={() => post.mutate()}>Post</Button> : null}
            {d.status === 'POSTED' && canManage && d.amountDue !== '0.00' ? (
              <>
                <Button variant="secondary" onClick={() => { apply.reset(); setApplyId(''); setApplyAmount(''); setApplyOpen(true); }}>{isCharge ? `Apply ${l.credit.label.toLowerCase()}…` : `Apply to ${l.charge.label.toLowerCase()}…`}</Button>
                {isCharge ? (
                  <Link href={`/orgs/${orgId}/${l.paymentsPath}/new?contactId=${d.contact.id}&documentId=${d.id}`}><Button>{l.payment.verb}</Button></Link>
                ) : null}
              </>
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
        </Card>
        <Card className="p-4">
          <p className="text-xs uppercase tracking-wide text-fg-muted">{isCharge ? 'Still due' : 'Not yet applied'}</p>
          <p className="mt-2 text-sm"><Money value={d.amountDue} currency={c} className={d.isOverdue ? 'text-negative' : ''} /></p>
        </Card>
      </div>
      {d.reference || d.memo || d.journalEntryId ? (
        <p className="mt-4 text-sm text-fg-muted">
          {d.reference ? <>Reference {d.reference}. </> : null}
          {d.memo ? <>{d.memo}. </> : null}
          {d.journalEntryId ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/journals/${d.journalEntryId}`}>View the journal entry</Link> : null}
        </p>
      ) : null}

      <Card className="mt-6">
        <CardHeader title="Lines" />
        <Table>
          <thead>
            <tr>
              <Th>#</Th>
              <Th>Description</Th>
              <Th>Account</Th>
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
                <Td>{x.description}</Td>
                <Td className="text-fg-muted"><span className="num">{x.accountCode}</span> {x.accountName}</Td>
                <Td numeric className="num">{x.quantity}</Td>
                <Td numeric className="num">{x.unitPrice}</Td>
                <Td className="text-fg-muted">{x.taxName ? `${x.taxName}` : '—'}</Td>
                <Td numeric><Money value={x.netAmount} currency={c} /></Td>
                <Td numeric><Money value={x.taxAmount} currency={c} /></Td>
              </Tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <Td colSpan={6} className="text-right text-fg-muted">Subtotal and tax</Td>
              <Td numeric><Money value={d.subtotal} currency={c} /></Td>
              <Td numeric><Money value={d.taxTotal} currency={c} /></Td>
            </tr>
            <tr>
              <Td colSpan={7} className="text-right font-semibold">Total</Td>
              <Td numeric className="font-semibold"><Money value={d.total} currency={c} /></Td>
            </tr>
          </tfoot>
        </Table>
      </Card>

      <Card className="mt-6">
        <CardHeader title={isCharge ? 'Payments and credits applied' : `Applied to ${l.charge.plural.toLowerCase()}`} description="Removing an application keeps a record of it and reopens the amount." />
        {d.allocations.length === 0 ? (
          <p className="px-5 py-4 text-sm text-fg-muted">Nothing applied yet.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>{isCharge ? 'From' : 'To'}</Th>
                <Th numeric>Amount</Th>
                <Th><span className="sr-only">Actions</span></Th>
              </tr>
            </thead>
            <tbody>
              {d.allocations.map((a) => {
                const other = a.source ?? a.target!;
                const href = a.source?.type === 'payment' ? `/orgs/${orgId}/${l.paymentsPath}/${other.id}` : `/orgs/${orgId}/${l.docsPath}/${other.id}`;
                return (
                  <Tr key={a.id}>
                    <Td>{date(a.date)}</Td>
                    <Td><Link className="text-accent hover:underline" href={href}>{kindLabel(l, other.kind)} {other.number}</Link></Td>
                    <Td numeric><Money value={a.amount} currency={c} /></Td>
                    <Td className="text-right">
                      {canManage ? <Button size="sm" variant="ghost" loading={unallocate.isPending && unallocate.variables === a.id} onClick={() => confirm('Remove this application? The amount becomes open again.') && unallocate.mutate(a.id)}>Remove</Button> : null}
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

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
                    {(counterparts.data?.items ?? []).map((x) => <option key={x.id} value={x.id}>{x.number} · {x.amountDue} open</option>)}
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
