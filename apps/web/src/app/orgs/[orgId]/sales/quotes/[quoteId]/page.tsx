'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { placeOfSupplyName } from '@talk2tax/tax-engine';
import { Alert, Button, Card, CardHeader, Dialog, Field, Input, Table, Td, Textarea, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { QuoteBadge } from '@/components/sales-orders/badges';
import { SalesLinesTable } from '@/components/sales-orders/lines-table';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, dateTime, today } from '@/lib/format';
import { useOrg } from '@/lib/org';
import type { OrderDetail, QuoteDetail } from '@/lib/sales-orders';

export default function QuotePage() {
  const { org, orgId } = useOrg();
  const { quoteId } = useParams<{ quoteId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const key = ['sales-quote', orgId, quoteId];
  const quote = useQuery({ queryKey: key, queryFn: () => api<QuoteDetail>(`/v1/orgs/${orgId}/sales/quotes/${quoteId}`) });
  const [accepting, setAccepting] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [orderDate, setOrderDate] = useState(today());
  const [po, setPo] = useState('');
  const [reason, setReason] = useState('');
  const base = `/v1/orgs/${orgId}/sales/quotes/${quoteId}`;
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['sales-quotes', orgId] });
    await qc.invalidateQueries({ queryKey: ['sales-orders', orgId] });
    await qc.invalidateQueries({ queryKey: ['crm-deals', orgId] });
    await qc.invalidateQueries({ queryKey: ['crm-deal', orgId] });
  };
  const act = useMutation({
    mutationFn: (a: 'send' | 'decline' | 'delete') =>
      a === 'delete' ? api(base, { method: 'DELETE' }) : api<QuoteDetail>(`${base}/${a}`, { method: 'POST', body: a === 'decline' ? { reason } : undefined }),
    onSuccess: async (_r, a) => {
      setDeclining(false);
      await refresh();
      if (a === 'delete') router.push(`/orgs/${orgId}/sales/quotes`);
      else await qc.invalidateQueries({ queryKey: key });
    },
  });
  const revise = useMutation({
    mutationFn: () => api<QuoteDetail>(`${base}/revise`, { method: 'POST' }),
    onSuccess: async (r) => {
      await refresh();
      router.push(`/orgs/${orgId}/sales/quotes/${r.id}/edit`);
    },
  });
  const accept = useMutation({
    mutationFn: () => api<OrderDetail>(`${base}/accept`, { method: 'POST', body: { orderDate, reference: po || null } }),
    onSuccess: async (o) => {
      await refresh();
      router.push(`/orgs/${orgId}/sales/orders/${o.id}`);
    },
  });

  if (!org) return null;
  if (quote.error) return <ErrorAlert title="Could not load the quotation" error={quote.error} />;
  const q = quote.data;
  if (!q) return <p className="text-sm text-fg-muted">Loading…</p>;
  const cur = q.currency;
  const s = q.state;
  const latest = q.revisions[q.revisions.length - 1]?.id === q.id;
  const m = q.can.manage;
  return (
    <>
      <PageHeader
        title={`Quotation ${q.reference}`}
        description={[q.contact?.name, `valid until ${date(q.validUntil)}`].filter(Boolean).join(' · ')}
        actions={
          m ? (
            <>
              {s === 'DRAFT' ? (
                <>
                  <Button variant="ghost" loading={act.isPending && act.variables === 'delete'} onClick={() => act.mutate('delete')}>Delete draft</Button>
                  <Link href={`/orgs/${orgId}/sales/quotes/${q.id}/edit`}><Button variant="secondary">Edit</Button></Link>
                  <Button loading={act.isPending && act.variables === 'send'} onClick={() => act.mutate('send')}>Mark sent</Button>
                </>
              ) : null}
              {latest && (s === 'SENT' || s === 'EXPIRED' || s === 'DECLINED') ? <Button variant="secondary" loading={revise.isPending} onClick={() => revise.mutate()}>Revise</Button> : null}
              {latest && (s === 'SENT' || s === 'EXPIRED') ? <Button variant="danger" onClick={() => setDeclining(true)}>Declined</Button> : null}
              {latest && s === 'SENT' ? <Button onClick={() => { setOrderDate(today()); setAccepting(true); }}>Accepted</Button> : null}
              {s === 'SENT' || s === 'ACCEPTED' ? <Link href={`/orgs/${orgId}/sales/pro-formas/new?fromQuote=${q.id}`}><Button variant="ghost">Make pro forma invoice…</Button></Link> : null}
            </>
          ) : null
        }
      />
      <ErrorAlert title="That did not work" error={act.error ?? revise.error} />
      {s === 'EXPIRED' ? <Alert tone="warning" title="This quotation has expired">Its valid-until date has passed, so it can no longer be accepted. Revise it to send new dates or prices.</Alert> : null}
      {!latest && s !== 'ACCEPTED' ? <Alert tone="neutral" title="There is a newer version">Answer the latest revision instead.</Alert> : null}
      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-1">
          <CardHeader title="Quotation" />
          <dl className="grid grid-cols-[130px_1fr] gap-x-3 gap-y-2 px-5 pb-5 text-sm">
            <dt className="text-fg-muted">Status</dt><dd><QuoteBadge state={s} /></dd>
            <dt className="text-fg-muted">Customer</dt><dd>{q.contact ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/customers/${q.contact.id}`}>{q.contact.name}</Link> : '—'}{q.contact?.gstin ? <span className="block text-xs text-fg-muted">GSTIN {q.contact.gstin}</span> : null}</dd>
            <dt className="text-fg-muted">Date</dt><dd>{date(q.issueDate)}</dd>
            <dt className="text-fg-muted">Valid until</dt><dd>{date(q.validUntil)}</dd>
            {q.deal ? <><dt className="text-fg-muted">Deal</dt><dd><Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/pipeline/${q.deal.id}`}>{q.deal.reference} {q.deal.name}</Link></dd></> : null}
            {q.customerReference ? <><dt className="text-fg-muted">Their reference</dt><dd>{q.customerReference}</dd></> : null}
            {q.placeOfSupply ? <><dt className="text-fg-muted">Place of supply</dt><dd>{q.placeOfSupply} · {placeOfSupplyName(q.placeOfSupply)}</dd></> : null}
            <dt className="text-fg-muted">Total</dt><dd className="font-medium"><Money value={q.total} currency={cur} /></dd>
            {q.sentAt ? <><dt className="text-fg-muted">Sent</dt><dd>{dateTime(q.sentAt)}</dd></> : null}
            {q.decidedAt ? <><dt className="text-fg-muted">{q.status === 'ACCEPTED' ? 'Accepted' : 'Declined'}</dt><dd>{dateTime(q.decidedAt)}</dd></> : null}
            {q.declineReason ? <><dt className="text-fg-muted">Reason</dt><dd>{q.declineReason}</dd></> : null}
            {q.order ? <><dt className="text-fg-muted">Sales order</dt><dd><Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/orders/${q.order.id}`}>{q.order.reference}</Link></dd></> : null}
            {q.memo ? <><dt className="text-fg-muted">Memo</dt><dd>{q.memo}</dd></> : null}
          </dl>
        </Card>
        <div className="flex flex-col gap-4 xl:col-span-2">
          <SalesLinesTable lines={q.lines} currency={cur} subtotal={q.subtotal} tax={q.taxTotal} total={q.total} />
          {q.terms ? (
            <Card>
              <CardHeader title="Terms" />
              <p className="whitespace-pre-wrap px-5 pb-5 text-sm">{q.terms}</p>
            </Card>
          ) : null}
          {q.revisions.length > 1 ? (
            <Card>
              <CardHeader title="Versions" description="Sending a revision replaces the one before it." />
              <Table aria-label="Quotation versions">
                <thead><tr><Th>Version</Th><Th>Status</Th><Th numeric>Total</Th></tr></thead>
                <tbody>
                  {q.revisions.map((r) => (
                    <Tr key={r.id}>
                      <Td>{r.id === q.id ? <span className="font-medium">{r.reference} (this one)</span> : <Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/quotes/${r.id}`}>{r.reference}</Link>}</Td>
                      <Td><QuoteBadge state={r.state} /></Td>
                      <Td numeric><Money value={r.total} currency={cur} /></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          ) : null}
        </div>
      </div>
      <Dialog open={accepting} onOpenChange={setAccepting} title={`${q.reference} accepted`} description={`A sales order is made with the same lines and prices${q.deal ? `, and ${q.deal.reference} is marked won` : ''}.`}>
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); accept.mutate(); }}>
          <Field label="Order date">{(p) => <Input {...p} type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />}</Field>
          <Field label="Customer PO number" hint="Optional: the customer's purchase order.">{(p) => <Input {...p} value={po} maxLength={100} onChange={(e) => setPo(e.target.value)} />}</Field>
          <ErrorAlert title="Could not accept it" error={accept.error} />
          <div className="flex justify-end"><Button type="submit" loading={accept.isPending}>Make the sales order</Button></div>
        </form>
      </Dialog>
      <Dialog open={declining} onOpenChange={setDeclining} title={`${q.reference} declined`} description="The reason is kept with the quotation. You can still send a revision.">
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); act.mutate('decline'); }}>
          <Field label="Why did they decline?">{(p) => <Textarea {...p} rows={2} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="Price too high" />}</Field>
          <ErrorAlert title="Could not record it" error={act.error} />
          <div className="flex justify-end"><Button type="submit" variant="danger" loading={act.isPending} disabled={!reason.trim()}>Record declined</Button></div>
        </form>
      </Dialog>
    </>
  );
}
