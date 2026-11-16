'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { placeOfSupplyName } from '@talk2tax/tax-engine';
import { Alert, Badge, Button, Card, CardHeader, Dialog, Field, Input, Table, Td, Textarea, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { OrderBadge } from '@/components/sales-orders/badges';
import { SalesLinesTable } from '@/components/sales-orders/lines-table';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, dateTime, today } from '@/lib/format';
import { useOrg } from '@/lib/org';
import type { OrderDetail } from '@/lib/sales-orders';

const QTY = /^\d{0,12}(\.\d{0,6})?$/;
const STATUS_TONE = { DRAFT: 'neutral', POSTED: 'positive', VOID: 'negative' } as const;

export default function OrderPage() {
  const { org, orgId } = useOrg();
  const { orderId } = useParams<{ orderId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const key = ['sales-order', orgId, orderId];
  const order = useQuery({ queryKey: key, queryFn: () => api<OrderDetail>(`/v1/orgs/${orgId}/sales/orders/${orderId}`) });
  const [billing, setBilling] = useState(false);
  const [issueDate, setIssueDate] = useState(today());
  const [qty, setQty] = useState<Record<string, string>>({});
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const base = `/v1/orgs/${orgId}/sales/orders/${orderId}`;
  const bill = useMutation({
    mutationFn: () => {
      const o = order.data!;
      const lines = o.lines.filter((l) => Number(qty[l.id] ?? 0) > 0).map((l) => ({ orderLineId: l.id, quantity: qty[l.id]! }));
      return api<{ documentId: string }>(`${base}/invoices`, { method: 'POST', body: { issueDate, lines } });
    },
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['sales-orders', orgId] });
      await qc.invalidateQueries({ queryKey: ['documents', orgId] });
      await qc.invalidateQueries({ queryKey: key });
      router.push(`/orgs/${orgId}/sales/invoices/${r.documentId}`);
    },
  });
  const cancel = useMutation({
    mutationFn: () => api<OrderDetail>(`${base}/cancel`, { method: 'POST', body: { reason } }),
    onSuccess: async () => {
      setCancelling(false);
      await qc.invalidateQueries({ queryKey: ['sales-orders', orgId] });
      await qc.invalidateQueries({ queryKey: key });
    },
  });

  if (!org) return null;
  if (order.error) return <ErrorAlert title="Could not load the sales order" error={order.error} />;
  const o = order.data;
  if (!o) return <p className="text-sm text-fg-muted">Loading…</p>;
  const cur = o.currency;
  const open = o.status === 'OPEN' && o.billing !== 'BILLED';
  const anyBilled = o.lines.some((l) => Number(l.billed) > 0);
  const startBilling = () => {
    setIssueDate(today());
    setQty(Object.fromEntries(o.lines.map((l) => [l.id, l.remaining])));
    setBilling(true);
  };
  const chosen = o.lines.filter((l) => Number(qty[l.id] ?? 0) > 0);
  const over = o.lines.filter((l) => Number(qty[l.id] ?? 0) > Number(l.remaining));
  return (
    <>
      <PageHeader
        title={`Sales order ${o.reference}`}
        description={[o.contact?.name, o.customerReference ? `customer PO ${o.customerReference}` : null, date(o.orderDate)].filter(Boolean).join(' · ')}
        actions={
          o.can.manage && open ? (
            <>
              {!anyBilled ? <Button variant="ghost" onClick={() => setCancelling(true)}>Cancel order</Button> : null}
              <Button onClick={startBilling}>Bill this order</Button>
            </>
          ) : null
        }
      />
      {o.status === 'CANCELLED' ? <Alert tone="negative" title="Cancelled">{o.cancelReason}{o.cancelledAt ? ` (${dateTime(o.cancelledAt)})` : ''}</Alert> : null}
      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-1">
          <CardHeader title="Order" />
          <dl className="grid grid-cols-[130px_1fr] gap-x-3 gap-y-2 px-5 pb-5 text-sm">
            <dt className="text-fg-muted">Billing</dt><dd><OrderBadge order={o} /></dd>
            <dt className="text-fg-muted">Customer</dt><dd>{o.contact ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/customers/${o.contact.id}`}>{o.contact.name}</Link> : '—'}</dd>
            <dt className="text-fg-muted">Order date</dt><dd>{date(o.orderDate)}</dd>
            {o.customerReference ? <><dt className="text-fg-muted">Customer PO</dt><dd>{o.customerReference}</dd></> : null}
            {o.quote ? <><dt className="text-fg-muted">From quotation</dt><dd><Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/quotes/${o.quote.id}`}>{o.quote.reference}</Link></dd></> : null}
            {o.deal ? <><dt className="text-fg-muted">Deal</dt><dd><Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/pipeline/${o.deal.id}`}>{o.deal.reference} {o.deal.name}</Link></dd></> : null}
            {o.placeOfSupply ? <><dt className="text-fg-muted">Place of supply</dt><dd>{o.placeOfSupply} · {placeOfSupplyName(o.placeOfSupply)}</dd></> : null}
            <dt className="text-fg-muted">Total</dt><dd className="font-medium"><Money value={o.total} currency={cur} /></dd>
            <dt className="text-fg-muted">Still to bill</dt><dd className="font-medium"><Money value={o.toBill} currency={cur} /></dd>
            {o.memo ? <><dt className="text-fg-muted">Memo</dt><dd>{o.memo}</dd></> : null}
          </dl>
        </Card>
        <div className="flex flex-col gap-4 xl:col-span-2">
          <SalesLinesTable lines={o.lines} currency={cur} subtotal={o.subtotal} tax={o.taxTotal} total={o.total} />
          <Card>
            <CardHeader title="Invoices" description="Billed quantities count while the invoice is a draft or posted; voiding an invoice frees its quantities to bill again." />
            {o.invoices.length === 0 ? <p className="px-5 pb-5 text-sm text-fg-muted">Nothing billed yet.</p> : (
              <Table aria-label="Order invoices">
                <thead><tr><Th>Invoice</Th><Th>Date</Th><Th>Status</Th><Th>Lines billed</Th><Th numeric>Total</Th></tr></thead>
                <tbody>
                  {o.invoices.map((d) => (
                    <Tr key={d.id}>
                      <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/invoices/${d.id}`}>{d.number ?? 'Draft invoice'}</Link></Td>
                      <Td>{date(d.issueDate)}</Td>
                      <Td><Badge tone={STATUS_TONE[d.status as keyof typeof STATUS_TONE] ?? 'neutral'}>{d.status.charAt(0) + d.status.slice(1).toLowerCase()}</Badge></Td>
                      <Td className="text-fg-muted">{d.lines.map((l) => `#${l.lineNo} × ${l.quantity}`).join(', ')}</Td>
                      <Td numeric><Money value={d.total} currency={cur} /></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
      </div>
      <Dialog open={billing} onOpenChange={setBilling} title={`Bill ${o.reference}`} description="Makes a draft invoice at the order's prices and tax. Lower a quantity to bill part of a line now and the rest later.">
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); bill.mutate(); }}>
          <Field label="Invoice date">{(p) => <Input {...p} type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />}</Field>
          <Table aria-label="Quantities to bill">
            <thead><tr><Th>Line</Th><Th numeric>Left</Th><Th numeric className="w-32">Bill now</Th></tr></thead>
            <tbody>
              {o.lines.map((l) => (
                <Tr key={l.id}>
                  <Td>#{l.lineNo} {l.description ?? l.account?.name}</Td>
                  <Td numeric className="num">{l.remaining}</Td>
                  <Td numeric>
                    <Input aria-label={`Bill now for line ${l.lineNo}`} className="num text-right" inputMode="decimal" disabled={Number(l.remaining) === 0} value={qty[l.id] ?? ''} onChange={(e) => QTY.test(e.target.value) && setQty((q) => ({ ...q, [l.id]: e.target.value }))} />
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          {over.length ? <p className="text-sm text-warning">Line {over.map((l) => l.lineNo).join(', ')}: more than is left to bill.</p> : null}
          <ErrorAlert title="Could not bill the order" error={bill.error} />
          <div className="flex justify-end"><Button type="submit" loading={bill.isPending} disabled={!chosen.length || over.length > 0}>Make draft invoice</Button></div>
        </form>
      </Dialog>
      <Dialog open={cancelling} onOpenChange={setCancelling} title={`Cancel ${o.reference}`} description="Only an order with nothing billed can be cancelled. It stays on record with the reason.">
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); cancel.mutate(); }}>
          <Field label="Why is it cancelled?">{(p) => <Textarea {...p} rows={2} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="Customer withdrew the order" />}</Field>
          <ErrorAlert title="Could not cancel it" error={cancel.error} />
          <div className="flex justify-end"><Button type="submit" variant="danger" loading={cancel.isPending} disabled={!reason.trim()}>Cancel order</Button></div>
        </form>
      </Dialog>
    </>
  );
}
