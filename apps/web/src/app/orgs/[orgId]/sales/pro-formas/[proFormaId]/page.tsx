'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addDays } from '@talk2tax/accounting-engine';
import { placeOfSupplyName } from '@talk2tax/tax-engine';
import { Alert, Button, Card, CardHeader, Dialog, Field, Input, Textarea } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { ProFormaBadge } from '@/components/sales-orders/badges';
import { SalesLinesTable } from '@/components/sales-orders/lines-table';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, dateTime, today } from '@/lib/format';
import { useOrg } from '@/lib/org';
import type { ProFormaDetail } from '@/lib/sales-orders';

export default function ProFormaPage() {
  const { org, orgId } = useOrg();
  const { proFormaId } = useParams<{ proFormaId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const base = `/v1/orgs/${orgId}/sales/pro-formas/${proFormaId}`;
  const key = ['pro-formas', orgId, 'one', proFormaId];
  const q = useQuery({ queryKey: key, queryFn: () => api<ProFormaDetail>(base) });
  const [invoicing, setInvoicing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [issueDate, setIssueDate] = useState(today());
  const [dueDate, setDueDate] = useState('');
  const [reason, setReason] = useState('');
  const refresh = async () => {
    for (const k of ['pro-formas', 'documents', 'document']) await qc.invalidateQueries({ queryKey: [k, orgId] });
  };
  const act = useMutation({
    mutationFn: (a: 'issue' | 'delete' | 'cancel') =>
      a === 'delete' ? api(base, { method: 'DELETE' }) : api<ProFormaDetail>(`${base}/${a}`, { method: 'POST', body: a === 'cancel' ? { reason } : undefined }),
    onSuccess: async (_r, a) => {
      setCancelling(false);
      await refresh();
      if (a === 'delete') router.push(`/orgs/${orgId}/sales/pro-formas`);
    },
  });
  const invoice = useMutation({
    mutationFn: () => api<{ documentId: string }>(`${base}/invoice`, { method: 'POST', body: { issueDate, dueDate: dueDate || null } }),
    onSuccess: async (r) => {
      await refresh();
      router.push(`/orgs/${orgId}/sales/invoices/${r.documentId}`);
    },
  });

  if (!org) return null;
  if (q.error) return <ErrorAlert title="Could not load the pro forma invoice" error={q.error} />;
  const p = q.data;
  if (!p) return <p className="text-sm text-fg-muted">Loading…</p>;
  const cur = p.currency;
  const s = p.state;
  const m = p.can.manage;
  return (
    <>
      <PageHeader
        title={`Pro forma invoice ${p.reference}`}
        description={[p.contact?.name, `valid until ${date(p.validUntil)}`].filter(Boolean).join(' · ')}
        actions={
          <>
            <Link href={`/orgs/${orgId}/sales/pro-formas/${p.id}/print`}><Button variant="secondary">Print or PDF</Button></Link>
            {m && s === 'DRAFT' ? (
              <>
                <Button variant="ghost" loading={act.isPending && act.variables === 'delete'} onClick={() => confirm('Delete this draft? This cannot be undone.') && act.mutate('delete')}>Delete draft</Button>
                <Link href={`/orgs/${orgId}/sales/pro-formas/${p.id}/edit`}><Button variant="secondary">Edit</Button></Link>
                <Button loading={act.isPending && act.variables === 'issue'} onClick={() => act.mutate('issue')}>Issue</Button>
              </>
            ) : null}
            {m && (s === 'ISSUED' || s === 'EXPIRED') ? (
              <>
                <Button variant="danger" onClick={() => { act.reset(); setReason(''); setCancelling(true); }}>Cancel…</Button>
                {p.contact ? <Link href={`/orgs/${orgId}/sales/receipts/new?contactId=${p.contact.id}`}><Button variant="ghost">Record advance…</Button></Link> : null}
                <Button onClick={() => { invoice.reset(); setIssueDate(today()); setDueDate(''); setInvoicing(true); }}>Make tax invoice…</Button>
              </>
            ) : null}
          </>
        }
      />
      <ErrorAlert title="That did not work" error={act.error} />
      {s === 'EXPIRED' ? <Alert tone="warning" title="Past its valid date">It can still be turned into a tax invoice, or cancelled; to change prices or dates, cancel it and issue a new one.</Alert> : null}
      {s === 'INVOICED' && p.invoice ? (
        <Alert tone="positive" title="Invoiced">
          Turned into <Link className="underline" href={`/orgs/${orgId}/sales/invoices/${p.invoice.id}`}>{p.invoice.number ? `invoice ${p.invoice.number}` : 'a draft invoice'}</Link>{p.invoice.status === 'DRAFT' ? ': review and post it. Deleting that draft frees this pro forma again.' : '.'}
        </Alert>
      ) : null}
      {s === 'CANCELLED' ? <Alert tone="negative" title={`Cancelled ${p.cancelledAt ? dateTime(p.cancelledAt) : ''}`}>{p.cancelReason}</Alert> : null}
      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-1">
          <CardHeader title="Pro forma invoice" />
          <dl className="grid grid-cols-[130px_1fr] gap-x-3 gap-y-2 px-5 pb-5 text-sm">
            <dt className="text-fg-muted">Status</dt><dd><ProFormaBadge state={s} /></dd>
            <dt className="text-fg-muted">Customer</dt><dd>{p.contact ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/customers/${p.contact.id}`}>{p.contact.name}</Link> : '—'}{p.contact?.gstin ? <span className="block text-xs text-fg-muted">GSTIN {p.contact.gstin}</span> : null}</dd>
            <dt className="text-fg-muted">Date</dt><dd>{date(p.issueDate)}</dd>
            <dt className="text-fg-muted">Valid until</dt><dd>{date(p.validUntil)}</dd>
            {p.quote ? <><dt className="text-fg-muted">From quotation</dt><dd><Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/quotes/${p.quote.id}`}>{p.quote.reference}</Link></dd></> : null}
            {p.customerReference ? <><dt className="text-fg-muted">Their reference</dt><dd>{p.customerReference}</dd></> : null}
            {p.placeOfSupply ? <><dt className="text-fg-muted">Place of supply</dt><dd>{p.placeOfSupply} · {placeOfSupplyName(p.placeOfSupply)}</dd></> : null}
            <dt className="text-fg-muted">Total</dt><dd className="font-medium"><Money value={p.total} currency={cur} /></dd>
            {p.issuedAt ? <><dt className="text-fg-muted">Issued</dt><dd>{dateTime(p.issuedAt)}</dd></> : null}
            {p.memo ? <><dt className="text-fg-muted">Memo</dt><dd>{p.memo}</dd></> : null}
          </dl>
        </Card>
        <div className="flex flex-col gap-4 xl:col-span-2">
          <SalesLinesTable lines={p.lines} currency={cur} subtotal={p.subtotal} tax={p.taxTotal} total={p.total} />
          {p.terms ? (
            <Card>
              <CardHeader title="Terms" />
              <p className="whitespace-pre-wrap px-5 pb-5 text-sm">{p.terms}</p>
            </Card>
          ) : null}
        </div>
      </div>
      <Dialog open={invoicing} onOpenChange={setInvoicing} title={`Make a tax invoice from ${p.reference}`} description="A draft invoice with the same lines and prices, worked out again by the invoice rules on its date. Review and post it like any invoice; apply any advance received to it.">
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); invoice.mutate(); }}>
          <Field label="Invoice date">{(f) => <Input {...f} type="date" value={issueDate} min={p.issueDate} onChange={(e) => setIssueDate(e.target.value)} />}</Field>
          <Field label="Due date" hint="Optional: empty uses the customer's payment terms.">{(f) => <Input {...f} type="date" value={dueDate} min={issueDate} placeholder={addDays(issueDate, 15)} onChange={(e) => setDueDate(e.target.value)} />}</Field>
          <ErrorAlert title="The invoice was not made" error={invoice.error} />
          <div className="flex justify-end"><Button type="submit" loading={invoice.isPending}>Make draft invoice</Button></div>
        </form>
      </Dialog>
      <Dialog open={cancelling} onOpenChange={setCancelling} title={`Cancel ${p.reference}`} description="The reason is kept with it. A cancelled pro forma invoice cannot be invoiced.">
        <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); act.mutate('cancel'); }}>
          <Field label="Reason">{(f) => <Textarea {...f} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
          <ErrorAlert title="It was not cancelled" error={act.error} />
          <div className="flex justify-end"><Button type="submit" variant="danger" loading={act.isPending} disabled={!reason.trim()}>Cancel pro forma invoice</Button></div>
        </form>
      </Dialog>
    </>
  );
}
