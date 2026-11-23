'use client';
import { useQuery } from '@tanstack/react-query';
import { Alert, Badge, Card, CardHeader, EmptyState, Input, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, today } from '@/lib/format';
import { useOrg } from '@/lib/org';

interface Totals {
  taxable: string;
  igst: string;
  cgst: string;
  sgst: string;
  tax: string;
}
interface Row extends Totals {
  id: string;
  kind: 'BILL' | 'VENDOR_CREDIT';
  number: string;
  issueDate: string;
  contactName: string;
  gstin: string | null;
  importOfServices: boolean;
  categories: { key: string; title: string }[];
  selfInvoice: { required: boolean; number: string | null; issuedOn: string | null; dueBy: string | null; overdue: boolean };
}
interface Category {
  key: string;
  kind: 'GOODS' | 'SERVICES';
  codes: string[];
  title: string;
  condition: string;
  source: string;
}
interface Register {
  period: string;
  from: string;
  to: string;
  rows: Row[];
  totals: Totals;
  selfInvoices: { required: number; issued: number; overdue: number };
  selfInvoiceDays: number;
  possiblyMissed: { id: string; number: string; issueDate: string; contactName: string; hsnCode: string; category: Category; taxCharged: string }[];
  payment: { id: string; number: string; paymentDate: string; cash: string } | null;
  categories: Category[];
}
const monthLabel = (p: string) => new Date(`${p}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Tax → Reverse charge (TAX-032): the month's reverse-charge register, self-invoices, and bills that may have missed reverse charge. */
export default function ReverseChargePage() {
  const { org, orgId } = useOrg();
  const [period, setPeriod] = useState(() => today().slice(0, 7));
  const valid = /^\d{4}-(0[1-9]|1[0-2])$/.test(period);
  const q = useQuery({ queryKey: ['reverse-charge', orgId, period], queryFn: () => api<Register>(`/v1/orgs/${orgId}/gst/reverse-charge?period=${period}`), enabled: valid });
  if (!org) return null;
  const r = q.data;
  const billHref = (id: string) => `/orgs/${orgId}/purchases/bills/${id}`;
  return (
    <>
      <PageHeader
        title="Reverse charge"
        description="Bills and vendor credits where you pay the GST instead of the supplier: notified goods and services (CGST Act s.9(3)) and services from abroad (IGST Act s.5(3)). The tax is paid in cash and taken back as input tax credit. Self-invoices are issued here for suppliers who are not registered."
        actions={<div className="w-44"><Input type="month" aria-label="Month" value={period} max={today().slice(0, 7)} onChange={(e) => setPeriod(e.target.value)} /></div>}
      />
      <ErrorAlert title="Could not load reverse charge" error={q.error} />
      {r ? (
        <>
          {r.selfInvoices.overdue ? (
            <div className="mb-4"><Alert tone="warning" title={`${r.selfInvoices.overdue} self-invoice${r.selfInvoices.overdue === 1 ? ' is' : 's are'} overdue`}>A self-invoice is due within {r.selfInvoiceDays} days of receiving the supply (CGST Rules, rule 47A). Issue it now; the bill date is taken as the date the supply was received.</Alert></div>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-4">
            <Card className="p-4"><p className="text-sm text-fg-muted">Tax to pay in cash</p><p className="mt-1 text-2xl font-semibold"><Money value={r.totals.tax} currency="INR" /></p><p className="text-xs text-fg-muted">{monthLabel(r.period)}, bills less vendor credits</p></Card>
            <Card className="p-4"><p className="text-sm text-fg-muted">Self-invoices</p><p className="mt-1 text-2xl font-semibold">{r.selfInvoices.issued} of {r.selfInvoices.required}</p><p className="text-xs text-fg-muted">Issued for unregistered suppliers</p></Card>
            <Card className="p-4"><p className="text-sm text-fg-muted">May need reverse charge</p><p className={`mt-1 text-2xl font-semibold ${r.possiblyMissed.length ? 'text-warning' : ''}`}>{r.possiblyMissed.length}</p><p className="text-xs text-fg-muted">Bills with a notified HSN/SAC</p></Card>
            <Card className="p-4"><p className="text-sm text-fg-muted">GST payment</p>{r.payment ? <><p className="mt-1 text-lg font-semibold">{r.payment.number}</p><p className="text-xs text-fg-muted">Paid {date(r.payment.paymentDate)}, <Money value={r.payment.cash} currency="INR" /> in cash</p></> : <><p className="mt-1 text-lg font-semibold text-fg-muted">Not paid yet</p><p className="text-xs text-fg-muted"><Link className="underline" href={`/orgs/${orgId}/tax/gst-payments`}>Settle the month</Link></p></>}</Card>
          </div>
          <Card className="mt-6" role="region" aria-label="Reverse charge register">
            <CardHeader title="Reverse charge register" description="Posted bills and vendor credits under reverse charge dated in the month, with the tax you owe by head. Vendor credits reduce it. A self-invoice is needed when the supplier has no GSTIN or is outside India." />
            {r.rows.length ? (
              <Table aria-label="Reverse charge register">
                <thead><Tr><Th>Document</Th><Th>Supplier</Th><Th>Category</Th><Th numeric>Taxable</Th><Th numeric>IGST</Th><Th numeric>CGST</Th><Th numeric>SGST</Th><Th>Self-invoice</Th></Tr></thead>
                <tbody>
                  {r.rows.map((x) => (
                    <Tr key={x.id}>
                      <Td className="whitespace-nowrap"><Link className="underline" href={billHref(x.id)}>{x.number}</Link><span className="block text-xs text-fg-muted">{x.kind === 'VENDOR_CREDIT' ? 'Vendor credit, ' : ''}{date(x.issueDate)}</span></Td>
                      <Td>{x.contactName}<span className="block text-xs text-fg-muted">{x.gstin ?? (x.importOfServices ? 'Outside India' : 'Not registered')}</span></Td>
                      <Td>{x.importOfServices ? <Badge tone="violet">Import of services</Badge> : x.categories.length ? x.categories.map((c) => <span key={c.key} className="block">{c.title}</span>) : <span className="text-fg-faint">Not in the notified list</span>}</Td>
                      <Td numeric><Money value={x.taxable} currency="INR" /></Td>
                      <Td numeric><Money value={x.igst} currency="INR" /></Td>
                      <Td numeric><Money value={x.cgst} currency="INR" /></Td>
                      <Td numeric><Money value={x.sgst} currency="INR" /></Td>
                      <Td className="whitespace-nowrap">
                        {!x.selfInvoice.required ? <span className="text-fg-faint">Not needed</span> : x.selfInvoice.number ? (
                          <Link className="underline" href={`/orgs/${orgId}/tax/reverse-charge/${x.id}`}>{x.selfInvoice.number}</Link>
                        ) : (
                          <>
                            <Badge tone={x.selfInvoice.overdue ? 'negative' : 'warning'}>{x.selfInvoice.overdue ? 'Overdue' : 'To issue'}</Badge>
                            <Link className="ml-2 underline" href={`/orgs/${orgId}/tax/reverse-charge/${x.id}`}>Due {date(x.selfInvoice.dueBy!)}</Link>
                          </>
                        )}
                      </Td>
                    </Tr>
                  ))}
                  <Tr className="font-semibold"><Td>Total</Td><Td /><Td /><Td numeric><Money value={r.totals.taxable} currency="INR" /></Td><Td numeric><Money value={r.totals.igst} currency="INR" /></Td><Td numeric><Money value={r.totals.cgst} currency="INR" /></Td><Td numeric><Money value={r.totals.sgst} currency="INR" /></Td><Td /></Tr>
                </tbody>
              </Table>
            ) : (
              <EmptyState title="No reverse-charge documents">No posted bill or vendor credit under reverse charge is dated in {monthLabel(r.period)}.</EmptyState>
            )}
          </Card>
          <Card className="mt-6" role="region" aria-label="Bills that may need reverse charge">
            <CardHeader title="Bills that may need reverse charge" description="Posted bills not recorded under reverse charge whose HSN/SAC falls under a notified category. Check the condition: if it applies, void the bill and record it again under reverse charge, and ask the supplier for a credit note for the GST they charged." />
            {r.possiblyMissed.length ? (
              <Table aria-label="Bills that may need reverse charge">
                <thead><Tr><Th>Bill</Th><Th>Supplier</Th><Th>Category</Th><Th>Applies when</Th><Th numeric>GST charged</Th></Tr></thead>
                <tbody>
                  {r.possiblyMissed.map((m) => (
                    <Tr key={m.id}>
                      <Td className="whitespace-nowrap align-top"><Link className="underline" href={billHref(m.id)}>{m.number}</Link><span className="block text-xs text-fg-muted">{date(m.issueDate)}</span></Td>
                      <Td className="align-top">{m.contactName}</Td>
                      <Td className="align-top">{m.category.title}<span className="block text-xs text-fg-muted">HSN/SAC {m.hsnCode}</span></Td>
                      <Td className="align-top"><span className="block max-w-md">{m.category.condition}</span><span className="block text-xs text-fg-muted">{m.category.source}</span></Td>
                      <Td numeric className="align-top"><Money value={m.taxCharged} currency="INR" /></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <EmptyState title="Nothing to check">No bill of the month carries a notified HSN/SAC without reverse charge.</EmptyState>
            )}
          </Card>
          <Card className="mt-6" role="region" aria-label="Notified categories">
            <CardHeader title="Notified categories" description="The goods and services on which the buyer pays GST, matched by HSN/SAC. Each applies only when its condition holds; the list is a guide, the notification is the law." />
            <Table aria-label="Notified categories">
              <thead><Tr><Th>Category</Th><Th>HSN/SAC</Th><Th>Applies when</Th><Th>Source</Th></Tr></thead>
              <tbody>
                {r.categories.map((c) => (
                  <Tr key={c.key}>
                    <Td className="align-top">{c.title}<span className="block text-xs text-fg-muted">{c.kind === 'GOODS' ? 'Goods' : 'Services'}</span></Td>
                    <Td className="num align-top">{c.codes.join(', ')}</Td>
                    <Td className="align-top"><span className="block max-w-md">{c.condition}</span></Td>
                    <Td className="align-top text-xs text-fg-muted">{c.source}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </>
      ) : null}
    </>
  );
}
