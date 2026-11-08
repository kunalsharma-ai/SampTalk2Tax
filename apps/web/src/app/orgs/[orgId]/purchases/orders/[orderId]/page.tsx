'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MATCH_MODE_LABEL } from '@talk2tax/accounting-engine';
import { placeOfSupplyName } from '@talk2tax/tax-engine';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input, Table, Td, Textarea, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { MatchBadge, PurchaseOrderBadge } from '@/components/purchase-orders/badges';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, dateTime, today } from '@/lib/format';
import { useOrg } from '@/lib/org';
import type { PurchaseOrderDetail } from '@/lib/purchase-orders';

const QTY = /^\d{0,12}(\.\d{0,6})?$/;
type Reasoned = 'close' | 'cancel';

export default function PurchaseOrderPage() {
  const { org, orgId } = useOrg();
  const { orderId } = useParams<{ orderId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const base = `/v1/orgs/${orgId}/purchases/orders/${orderId}`;
  const q = useQuery({ queryKey: ['purchase-orders', orgId, 'one', orderId], queryFn: () => api<PurchaseOrderDetail>(base) });
  const [receiving, setReceiving] = useState(false);
  const [rDate, setRDate] = useState(today());
  const [rNote, setRNote] = useState('');
  const [rQty, setRQty] = useState<Record<string, { quantity: string; rejected: string; note: string }>>({});
  const [billing, setBilling] = useState(false);
  const [bDate, setBDate] = useState(today());
  const [bRef, setBRef] = useState('');
  const [reasonFor, setReasonFor] = useState<Reasoned | { receipt: string; reference: string } | null>(null);
  const [reason, setReason] = useState('');
  const refresh = async () => {
    for (const k of ['purchase-orders', 'documents', 'document']) await qc.invalidateQueries({ queryKey: [k, orgId] });
  };
  const act = useMutation({
    mutationFn: (a: 'issue' | 'delete' | Reasoned | 'cancel-receipt') =>
      a === 'delete'
        ? api(base, { method: 'DELETE' })
        : a === 'cancel-receipt' && reasonFor && typeof reasonFor === 'object'
          ? api(`${base}/receipts/${reasonFor.receipt}/cancel`, { method: 'POST', body: { reason } })
          : api(`${base}/${a}`, { method: 'POST', body: a === 'issue' ? undefined : { reason } }),
    onSuccess: async (_r, a) => {
      setReasonFor(null);
      await refresh();
      if (a === 'delete') router.push(`/orgs/${orgId}/purchases/orders`);
    },
  });
  const receive = useMutation({
    mutationFn: () =>
      api(`${base}/receipts`, {
        method: 'POST',
        body: {
          receiptDate: rDate,
          reference: rNote || null,
          lines: Object.entries(rQty)
            .filter(([, v]) => Number(v.quantity || 0) > 0 || Number(v.rejected || 0) > 0)
            .map(([orderLineId, v]) => ({ orderLineId, quantity: v.quantity || '0', rejected: v.rejected || null, note: v.note || null })),
        },
      }),
    onSuccess: async () => {
      setReceiving(false);
      await refresh();
    },
  });
  const bill = useMutation({
    mutationFn: () => api<{ documentId: string }>(`${base}/bill`, { method: 'POST', body: { issueDate: bDate, reference: bRef || null } }),
    onSuccess: async (r) => {
      await refresh();
      router.push(`/orgs/${orgId}/purchases/bills/${r.documentId}`);
    },
  });

  if (!org) return null;
  if (q.error) return <ErrorAlert title="Could not load the purchase order" error={q.error} />;
  const o = q.data;
  if (!o) return <p className="text-sm text-fg-muted">Loading…</p>;
  const cur = o.currency;
  const s = o.state;
  const m = o.can.manage;
  const live = s === 'ISSUED' || s === 'PARTLY_RECEIVED' || s === 'RECEIVED' || s === 'BILLED';
  const threeWay = o.matchMode === 'THREE_WAY';
  const canBill = (s === 'ISSUED' || s === 'PARTLY_RECEIVED' || s === 'RECEIVED') && o.lines.some((l) => Number(l.toBill) > 0);
  const openReceive = () => {
    receive.reset();
    setRDate(today());
    setRNote('');
    setRQty(Object.fromEntries(o.lines.map((l) => [l.id, { quantity: l.toReceive === '0' ? '' : l.toReceive, rejected: '', note: '' }])));
    setReceiving(true);
  };
  const reasonTitle = reasonFor === 'close' ? `Close ${o.reference}` : reasonFor === 'cancel' ? `Cancel ${o.reference}` : reasonFor ? `Cancel goods receipt ${reasonFor.reference}` : '';
  const reasonText =
    reasonFor === 'close'
      ? 'Nothing more is expected on this order. What was received and billed stays; the rest is no longer to receive or bill.'
      : reasonFor === 'cancel'
        ? 'The order is withdrawn. Only an order with nothing received or billed can be cancelled.'
        : 'For a receipt entered by mistake. It is kept, marked cancelled, and the quantities no longer count as received.';
  return (
    <>
      <PageHeader
        title={`Purchase order ${o.reference}`}
        description={[o.contact?.name, `ordered ${date(o.orderDate)}`, o.expectedDate ? `expected ${date(o.expectedDate)}` : null].filter(Boolean).join(' · ')}
        actions={
          m ? (
            <>
              {s === 'DRAFT' ? (
                <>
                  <Button variant="ghost" loading={act.isPending && act.variables === 'delete'} onClick={() => confirm('Delete this draft? This cannot be undone.') && act.mutate('delete')}>Delete draft</Button>
                  <Link href={`/orgs/${orgId}/purchases/orders/${o.id}/edit`}><Button variant="secondary">Edit</Button></Link>
                  <Button loading={act.isPending && act.variables === 'issue'} onClick={() => act.mutate('issue')}>Issue to vendor</Button>
                </>
              ) : null}
              {s === 'ISSUED' ? <Button variant="danger" onClick={() => { act.reset(); setReason(''); setReasonFor('cancel'); }}>Cancel…</Button> : null}
              {live && s !== 'ISSUED' ? <Button variant="ghost" onClick={() => { act.reset(); setReason(''); setReasonFor('close'); }}>Close…</Button> : null}
              {live && threeWay && o.lines.some((l) => Number(l.toReceive) > 0) ? <Button variant="secondary" onClick={openReceive}>Record goods received…</Button> : null}
              {canBill ? <Button onClick={() => { bill.reset(); setBDate(today()); setBRef(''); setBilling(true); }}>Make bill…</Button> : null}
            </>
          ) : null
        }
      />
      <ErrorAlert title="That did not work" error={act.error} />
      {o.late ? <Alert tone="warning" title="Delivery is late">Goods were expected by {date(o.expectedDate!)} and are not all received. Follow up with {o.contact?.name ?? 'the vendor'}, or close the order if they are no longer coming.</Alert> : null}
      {s === 'CLOSED' ? <Alert tone="neutral" title={`Closed ${o.closedAt ? dateTime(o.closedAt) : ''}`}>{o.closeReason}</Alert> : null}
      {s === 'CANCELLED' ? <Alert tone="negative" title={`Cancelled ${o.cancelledAt ? dateTime(o.cancelledAt) : ''}`}>{o.cancelReason}</Alert> : null}
      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-1">
          <CardHeader title="Purchase order" />
          <dl className="grid grid-cols-[130px_1fr] gap-x-3 gap-y-2 px-5 pb-5 text-sm">
            <dt className="text-fg-muted">Status</dt><dd><PurchaseOrderBadge state={s} /></dd>
            <dt className="text-fg-muted">Vendor</dt><dd>{o.contact ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/purchases/vendors/${o.contact.id}`}>{o.contact.name}</Link> : '—'}{o.contact?.gstin ? <span className="block text-xs text-fg-muted">GSTIN {o.contact.gstin}</span> : null}</dd>
            <dt className="text-fg-muted">Order date</dt><dd>{date(o.orderDate)}</dd>
            <dt className="text-fg-muted">Expected</dt><dd>{o.expectedDate ? date(o.expectedDate) : '—'}</dd>
            {o.vendorReference ? <><dt className="text-fg-muted">Their reference</dt><dd>{o.vendorReference}</dd></> : null}
            {o.placeOfSupply ? <><dt className="text-fg-muted">Place of supply</dt><dd>{o.placeOfSupply} · {placeOfSupplyName(o.placeOfSupply)}</dd></> : null}
            <dt className="text-fg-muted">Bills matched</dt><dd>{MATCH_MODE_LABEL[o.matchMode]}</dd>
            <dt className="text-fg-muted">Tolerances</dt><dd>Price {Number(o.priceTolerancePercent)}% · quantity {Number(o.quantityTolerancePercent)}%</dd>
            <dt className="text-fg-muted">Total</dt><dd className="font-medium"><Money value={o.total} currency={cur} /></dd>
            {live ? <><dt className="text-fg-muted">To receive</dt><dd><Money value={o.toReceive} currency={cur} /></dd><dt className="text-fg-muted">To bill</dt><dd><Money value={o.toBill} currency={cur} /></dd></> : null}
            {o.issuedAt ? <><dt className="text-fg-muted">Issued</dt><dd>{dateTime(o.issuedAt)}</dd></> : null}
            {o.memo ? <><dt className="text-fg-muted">Memo</dt><dd>{o.memo}</dd></> : null}
          </dl>
        </Card>
        <div className="flex flex-col gap-4 xl:col-span-2">
          <Card>
            <CardHeader title="Lines" description={threeWay ? 'Ordered, received on goods receipts, and billed. What is received and not yet billed is what the next bill should be for.' : 'Ordered and billed. Two-way matching does not wait for goods receipts.'} />
            <Table aria-label="Lines">
              <thead>
                <tr><Th>#</Th><Th>Description</Th><Th numeric>Ordered</Th>{threeWay ? <Th numeric>Received</Th> : null}<Th numeric>Billed</Th><Th numeric>To bill</Th><Th numeric>Unit price</Th><Th>Tax</Th><Th numeric>Amount</Th></tr>
              </thead>
              <tbody>
                {o.lines.map((l) => (
                  <Tr key={l.id}>
                    <Td className="text-fg-muted">{l.lineNo}</Td>
                    <Td>{l.description ?? '—'}<span className="block text-xs text-fg-muted">{l.account ? `${l.account.code} · ${l.account.name}` : ''}{l.hsnCode ? ` · HSN/SAC ${l.hsnCode}` : ''}</span></Td>
                    <Td numeric className="num">{l.quantity}</Td>
                    {threeWay ? <Td numeric className="num">{l.received}</Td> : null}
                    <Td numeric className="num">{l.billed}</Td>
                    <Td numeric className="num font-medium">{l.toBill}</Td>
                    <Td numeric><Money value={l.unitPrice} currency={cur} /></Td>
                    <Td className="text-fg-muted">{l.tax?.name ?? 'No tax'}</Td>
                    <Td numeric><Money value={l.netAmount} currency={cur} />{Number(l.taxAmount) ? <p className="text-xs text-fg-muted">+ tax <Money value={l.taxAmount} currency={cur} /></p> : null}</Td>
                  </Tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <Td colSpan={threeWay ? 8 : 7} className="text-right text-sm text-fg-muted"><p>Subtotal</p><p>Tax</p><p className="font-semibold text-fg">Total</p></Td>
                  <Td numeric className="text-sm"><p><Money value={o.subtotal} currency={cur} /></p><p><Money value={o.taxTotal} currency={cur} /></p><p className="font-semibold"><Money value={o.total} currency={cur} /></p></Td>
                </tr>
              </tfoot>
            </Table>
          </Card>
          {threeWay ? (
            <Card>
              <CardHeader title="Goods received" description="Each delivery recorded against this order (GRN). Receipts are never edited; one entered by mistake is cancelled." />
              {o.receipts.length === 0 ? (
                <p className="px-5 pb-5 text-sm text-fg-muted">Nothing received yet.</p>
              ) : (
                <Table aria-label="Goods received">
                  <thead><tr><Th>Receipt</Th><Th>Date</Th><Th>Delivery note</Th><Th>Received</Th><Th>Recorded by</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
                  <tbody>
                    {o.receipts.map((r) => (
                      <Tr key={r.id}>
                        <Td className="font-medium">{r.reference}{r.status === 'CANCELLED' ? <Badge tone="negative" className="ml-2">Cancelled</Badge> : null}{r.cancelReason ? <span className="block text-xs text-fg-muted">{r.cancelReason}</span> : null}</Td>
                        <Td>{date(r.receiptDate)}</Td>
                        <Td>{r.deliveryNote ?? '—'}</Td>
                        <Td className="text-sm">{r.lines.map((x) => <p key={x.orderLineId} className={r.status === 'CANCELLED' ? 'line-through text-fg-muted' : ''}>Line {x.lineNo}: {x.quantity}{Number(x.rejected) ? ` (${x.rejected} rejected)` : ''}{x.note ? ` · ${x.note}` : ''}</p>)}</Td>
                        <Td className="text-fg-muted">{r.recordedBy ?? '—'}</Td>
                        <Td>{m && r.status === 'RECORDED' && live ? <Button size="sm" variant="ghost" onClick={() => { act.reset(); setReason(''); setReasonFor({ receipt: r.id, reference: r.reference }); }}>Cancel…</Button> : null}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
          ) : null}
          <Card>
            <CardHeader title="Bills" description="Bills matched to this order and how each one matches. A bill that does not match posts only after an approver accepts the differences." />
            {o.bills.length === 0 ? (
              <p className="px-5 pb-5 text-sm text-fg-muted">No bills yet.{canBill && m ? ' Use Make bill when the vendor’s invoice arrives.' : ''}</p>
            ) : (
              <Table aria-label="Bills">
                <thead><tr><Th>Bill</Th><Th>Date</Th><Th>Vendor invoice</Th><Th numeric>Total</Th><Th>Match</Th></tr></thead>
                <tbody>
                  {o.bills.map((b) => (
                    <Tr key={b.id}>
                      <Td><Link className="font-medium text-accent hover:underline" href={`/orgs/${orgId}/purchases/bills/${b.id}`}>{b.number ?? 'Draft bill'}</Link>{b.status === 'VOID' ? <Badge tone="negative" className="ml-2">Void</Badge> : null}</Td>
                      <Td>{date(b.issueDate)}</Td>
                      <Td>{b.vendorInvoice ?? '—'}</Td>
                      <Td numeric><Money value={b.total} currency={cur} /></Td>
                      <Td>{b.match ? <MatchBadge status={b.match} /> : '—'}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          {o.terms ? (
            <Card>
              <CardHeader title="Terms for the vendor" />
              <p className="whitespace-pre-wrap px-5 pb-5 text-sm">{o.terms}</p>
            </Card>
          ) : null}
        </div>
      </div>
      <Dialog open={receiving} onOpenChange={setReceiving} title={`Record goods received on ${o.reference}`} description="Enter what arrived and was accepted, and anything rejected. More than ordered is refused beyond the order's quantity tolerance.">
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); receive.mutate(); }}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Received on">{(f) => <Input {...f} type="date" value={rDate} min={o.orderDate} max={today()} onChange={(e) => setRDate(e.target.value)} />}</Field>
            <Field label="Delivery note or challan">{(f) => <Input {...f} value={rNote} maxLength={100} placeholder="Optional" onChange={(e) => setRNote(e.target.value)} />}</Field>
          </div>
          <Table aria-label="Quantities received">
            <thead><tr><Th>Line</Th><Th numeric>Left</Th><Th numeric>Accepted</Th><Th numeric>Rejected</Th></tr></thead>
            <tbody>
              {o.lines.map((l) => (
                <tr key={l.id}>
                  <Td className="text-sm">{l.lineNo}. {l.description ?? l.account?.name}</Td>
                  <Td numeric className="num text-fg-muted">{l.toReceive}</Td>
                  <Td numeric><Input aria-label={`Accepted on line ${l.lineNo}`} className="num w-24 text-right" inputMode="decimal" value={rQty[l.id]?.quantity ?? ''} onChange={(e) => QTY.test(e.target.value) && setRQty((r) => ({ ...r, [l.id]: { ...r[l.id]!, quantity: e.target.value } }))} /></Td>
                  <Td numeric><Input aria-label={`Rejected on line ${l.lineNo}`} className="num w-20 text-right" inputMode="decimal" value={rQty[l.id]?.rejected ?? ''} onChange={(e) => QTY.test(e.target.value) && setRQty((r) => ({ ...r, [l.id]: { ...r[l.id]!, rejected: e.target.value } }))} /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <ErrorAlert title="The receipt was not recorded" error={receive.error} />
          <div className="flex justify-end"><Button type="submit" loading={receive.isPending}>Record receipt</Button></div>
        </form>
      </Dialog>
      <Dialog open={billing} onOpenChange={setBilling} title={`Make a bill from ${o.reference}`} description={threeWay ? 'A draft bill for what was received and not yet billed, at the order prices. Check it against the vendor’s invoice and change it if their invoice differs; differences are then shown for acceptance.' : 'A draft bill for what is not yet billed, at the order prices. Check it against the vendor’s invoice before posting.'}>
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); bill.mutate(); }}>
          <Field label="Bill date">{(f) => <Input {...f} type="date" value={bDate} min={o.orderDate} onChange={(e) => setBDate(e.target.value)} />}</Field>
          <Field label="Vendor invoice number" hint="As printed on the vendor's invoice; the same number cannot be entered twice.">{(f) => <Input {...f} value={bRef} maxLength={100} onChange={(e) => setBRef(e.target.value)} />}</Field>
          <ErrorAlert title="The bill was not made" error={bill.error} />
          <div className="flex justify-end"><Button type="submit" loading={bill.isPending}>Make draft bill</Button></div>
        </form>
      </Dialog>
      <Dialog open={!!reasonFor} onOpenChange={(v) => !v && setReasonFor(null)} title={reasonTitle} description={reasonText}>
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); act.mutate(typeof reasonFor === 'object' ? 'cancel-receipt' : reasonFor!); }}>
          <Field label="Reason">{(f) => <Textarea {...f} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
          <ErrorAlert title="That did not work" error={act.error} />
          <div className="flex justify-end"><Button type="submit" variant={reasonFor === 'close' ? 'primary' : 'danger'} loading={act.isPending} disabled={!reason.trim()}>{reasonFor === 'close' ? 'Close order' : reasonFor === 'cancel' ? 'Cancel order' : 'Cancel receipt'}</Button></div>
        </form>
      </Dialog>
    </>
  );
}
