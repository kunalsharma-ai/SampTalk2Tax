'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { D } from '@talk2tax/accounting-engine';
import { Alert, Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { AttachmentsPanel } from '@/components/attachments';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api, ApiError } from '@/lib/api';
import { date, today } from '@/lib/format';
import { kindLabel, type LedgerConfig } from '@/lib/ledgers';
import { useOrg } from '@/lib/org';
import { can, type DocumentSummary, type Payment } from '@/lib/types';

const PAGE = 25;

export function PaymentsList({ l }: { l: LedgerConfig }) {
  const { org, orgId } = useOrg();
  const router = useRouter();
  const [page, setPage] = useState(0);
  const q = useQuery({
    queryKey: ['payments', orgId, l.api, page],
    queryFn: () => api<{ total: number; items: Payment[] }>(`/v1/orgs/${orgId}/${l.api}/payments?limit=${PAGE}&offset=${page * PAGE}`),
  });
  if (!org) return null;
  const c = org.functionalCurrency;
  const pages = q.data ? Math.max(1, Math.ceil(q.data.total / PAGE)) : 1;
  return (
    <>
      <PageHeader
        title={l.payment.plural}
        description={`Each ${l.payment.label.toLowerCase()} posts its own journal. Amounts not applied to a ${l.charge.label.toLowerCase()} stay as a credit for the ${l.contact.toLowerCase()}.`}
        actions={can(org.role, l.managePermission) ? <Link href={`/orgs/${orgId}/${l.paymentsPath}/new`}><Button>{l.payment.verb}</Button></Link> : null}
      />
      {q.error ? <Alert title="Could not load">{(q.error as Error).message}</Alert> : null}
      <Card>
        {q.data && q.data.items.length === 0 ? (
          <EmptyState title={`No ${l.payment.plural.toLowerCase()} yet`} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Number</Th>
                <Th>Date</Th>
                <Th>{l.contact}</Th>
                <Th>Account</Th>
                <Th>Status</Th>
                <Th numeric>Amount</Th>
                <Th numeric>Not applied</Th>
              </tr>
            </thead>
            <tbody>
              {(q.data?.items ?? []).map((p) => {
                const href = `/orgs/${orgId}/${l.paymentsPath}/${p.id}`;
                return (
                  <Tr key={p.id} className="cursor-pointer" onClick={() => router.push(href)}>
                    <Td className="num"><Link className="text-accent hover:underline" href={href} onClick={(e) => e.stopPropagation()}>{p.number}</Link>{p.reference ? <p className="text-xs text-fg-muted">{p.reference}</p> : null}</Td>
                    <Td className="whitespace-nowrap">{date(p.date)}</Td>
                    <Td>{p.contact.name}</Td>
                    <Td className="text-fg-muted">{p.bankAccount.name}</Td>
                    <Td>{p.status === 'VOID' ? <Badge tone="negative">Void</Badge> : p.unallocated === '0.00' ? <Badge tone="positive">Fully applied</Badge> : <Badge tone="violet">Credit available</Badge>}</Td>
                    <Td numeric><Money value={p.amount} currency={c} /></Td>
                    <Td numeric>{p.status === 'POSTED' && p.unallocated !== '0.00' ? <Money value={p.unallocated} currency={c} /> : <span className="text-fg-faint">—</span>}</Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
        {q.data && q.data.total > PAGE ? (
          <div className="flex items-center justify-between border-t border-line px-4 py-3 text-sm text-fg-muted">
            <span>Page {page + 1} of {pages}</span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button>
              <Button variant="secondary" size="sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          </div>
        ) : null}
      </Card>
    </>
  );
}

export function PaymentDetail({ l }: { l: LedgerConfig }) {
  const { org, orgId } = useOrg();
  const { paymentId } = useParams<{ paymentId: string }>();
  const qc = useQueryClient();
  const base = `/v1/orgs/${orgId}/${l.api}`;
  const [voidOpen, setVoidOpen] = useState(false);
  const [voidDate, setVoidDate] = useState(today());
  const [reason, setReason] = useState('');
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const q = useQuery({ queryKey: ['payment', orgId, paymentId], queryFn: () => api<Payment>(`${base}/payments/${paymentId}`) });
  const p = q.data;
  const open = useQuery({
    enabled: !!p && p.status === 'POSTED' && p.unallocated !== '0.00',
    queryKey: ['documents', orgId, l.api, 'open-for', p?.contact.id],
    queryFn: () => api<{ items: DocumentSummary[] }>(`${base}/documents?view=open&kind=${l.charge.kind}&contactId=${p!.contact.id}&limit=200`),
  });
  const refresh = async () => {
    for (const k of ['payment', 'payments', 'documents', 'document', 'contacts', 'contact', 'dashboard', 'ageing']) await qc.invalidateQueries({ queryKey: [k, orgId] });
  };
  const allocate = useMutation({
    mutationFn: () => api<Payment>(`${base}/payments/${paymentId}/allocate`, { method: 'POST', body: { allocations: Object.entries(alloc).filter(([, v]) => v && new D(v).gt(0)).map(([documentId, amount]) => ({ documentId, amount })) } }),
    onSuccess: async () => {
      setAlloc({});
      await refresh();
    },
  });
  const unallocate = useMutation({ mutationFn: (id: string) => api(`${base}/allocations/${id}/remove`, { method: 'POST' }), onSuccess: refresh });
  const voidPay = useMutation({
    mutationFn: () => api<Payment>(`${base}/payments/${paymentId}/void`, { method: 'POST', body: { date: voidDate, reason } }),
    onSuccess: async () => {
      setVoidOpen(false);
      await refresh();
    },
  });
  if (!org) return null;
  if (q.error) return <Alert title="Not found">{(q.error as Error).message}</Alert>;
  if (!p) return <p className="text-sm text-fg-muted">Loading…</p>;
  const c = p.currency;
  const canManage = can(org.role, l.managePermission);
  const err = allocate.error ?? unallocate.error;
  return (
    <>
      <PageHeader
        title={`${l.payment.label} ${p.number}`}
        description={<Link className="text-accent hover:underline" href={`/orgs/${orgId}/${l.contactsPath}/${p.contact.id}`}>{p.contact.name}</Link>}
        actions={p.status === 'POSTED' && canManage && can(org.role, 'journals.reverse') ? <Button variant="ghost" onClick={() => { voidPay.reset(); setVoidOpen(true); }}>Void…</Button> : null}
      />
      {err ? <Alert title="Action failed">{err instanceof ApiError ? err.message : 'Try again.'}</Alert> : null}
      {p.status === 'VOID' ? <div className="mb-4"><Alert title={`Voided on ${date(p.voidDate!)}`}>The journal was reversed. <Link className="underline" href={`/orgs/${orgId}/journals/${p.voidJournalEntryId}`}>View the reversal</Link></Alert></div> : null}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="p-4"><p className="text-xs uppercase tracking-wide text-fg-muted">Date</p><p className="mt-2 text-sm">{date(p.date)}</p></Card>
        <Card className="p-4"><p className="text-xs uppercase tracking-wide text-fg-muted">{l.ledger === 'SALES' ? 'Deposited to' : 'Paid from'}</p><p className="mt-2 text-sm">{p.bankAccount.code} · {p.bankAccount.name}</p></Card>
        <Card className="p-4"><p className="text-xs uppercase tracking-wide text-fg-muted">Amount</p><p className="mt-2 text-sm"><Money value={p.amount} currency={c} /></p></Card>
        <Card className="p-4"><p className="text-xs uppercase tracking-wide text-fg-muted">Not applied</p><p className="mt-2 text-sm"><Money value={p.unallocated} currency={c} /></p></Card>
      </div>
      <p className="mt-4 text-sm text-fg-muted">
        {p.reference ? <>Reference {p.reference}. </> : null}
        {p.memo ? <>{p.memo}. </> : null}
        <Link className="text-accent hover:underline" href={`/orgs/${orgId}/journals/${p.journalEntryId}`}>View the journal entry</Link>
      </p>
      <Card className="mt-6">
        <CardHeader title={`Applied to ${l.charge.plural.toLowerCase()}`} />
        {p.allocations.length === 0 ? (
          <p className="px-5 py-4 text-sm text-fg-muted">Not applied to anything yet.</p>
        ) : (
          <Table>
            <thead><tr><Th>Date</Th><Th>{l.charge.label}</Th><Th numeric>Amount</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
            <tbody>
              {p.allocations.map((a) => (
                <Tr key={a.id}>
                  <Td>{date(a.date)}</Td>
                  <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/${l.docsPath}/${a.target.id}`}>{kindLabel(l, a.target.kind)} {a.target.number}</Link></Td>
                  <Td numeric><Money value={a.amount} currency={c} /></Td>
                  <Td className="text-right">{canManage ? <Button size="sm" variant="ghost" onClick={() => confirm('Remove this application?') && unallocate.mutate(a.id)}>Remove</Button> : null}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {p.status === 'POSTED' && p.unallocated !== '0.00' && canManage ? (
        <Card className="mt-6">
          <CardHeader title={`Apply the remaining ${p.unallocated}`} description={`Open ${l.charge.plural.toLowerCase()} for ${p.contact.name}.`} />
          {open.data && open.data.items.length === 0 ? (
            <p className="px-5 py-4 text-sm text-fg-muted">No open {l.charge.plural.toLowerCase()} right now.</p>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); allocate.mutate(); }}>
              <Table>
                <thead><tr><Th>Number</Th><Th>Due</Th><Th numeric>Still due</Th><Th numeric className="w-40">Apply</Th></tr></thead>
                <tbody>
                  {(open.data?.items ?? []).map((d) => (
                    <Tr key={d.id}>
                      <Td className="num">{d.number}</Td>
                      <Td>{date(d.dueDate)}</Td>
                      <Td numeric><Money value={d.amountDue} currency={c} /></Td>
                      <Td numeric><Input aria-label={`Apply to ${d.number}`} className="num text-right" inputMode="decimal" placeholder="0.00" value={alloc[d.id] ?? ''} onChange={(e) => /^\d{0,18}(\.\d{0,2})?$/.test(e.target.value) && setAlloc({ ...alloc, [d.id]: e.target.value })} /></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
              <div className="flex justify-end border-t border-line px-5 py-3"><Button type="submit" loading={allocate.isPending} disabled={!Object.values(alloc).some((v) => v && v !== '0')}>Apply</Button></div>
            </form>
          )}
        </Card>
      ) : null}
      <AttachmentsPanel entityType="PAYMENT" entityId={p.id} canManage={canManage} description="Remittance advice, bank slips, cheque scans. PDF, PNG, JPEG or WebP up to 5 MB each." />

      <Dialog open={voidOpen} onOpenChange={setVoidOpen} title={`Void ${p.number}`} description="Posts an exact reversing journal. Remove any applications first.">
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); voidPay.mutate(); }}>
          {voidPay.error ? <Alert title="Could not void">{voidPay.error.message}</Alert> : null}
          <Field label="Void date">{(x) => <Input {...x} type="date" min={p.date} value={voidDate} onChange={(e) => setVoidDate(e.target.value)} />}</Field>
          <Field label="Reason">{(x) => <Input {...x} required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setVoidOpen(false)}>Cancel</Button>
            <Button type="submit" variant="danger" loading={voidPay.isPending}>Void</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
