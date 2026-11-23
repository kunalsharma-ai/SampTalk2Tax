'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date, today } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

interface SelfInvoice {
  documentId: string;
  kind: 'BILL' | 'VENDOR_CREDIT';
  status: 'POSTED' | 'VOID';
  billNumber: string;
  billDate: string;
  reverseCharge: boolean;
  required: boolean;
  dueBy: string | null;
  issued: { number: string; issuedOn: string; issuedBy: string; issuedAt: string } | null;
  recipient: { name: string | null; gstin: string; state: string | null };
  supplier: { name: string; gstin: string | null; state: string | null; importOfServices: boolean };
  placeOfSupply: string | null;
  lines: { hsnCode: string | null; quantity: string; rate: string; taxable: string; igst: string; cgst: string; sgst: string; tax: string; category: string | null }[];
  totals: { taxable: string; igst: string; cgst: string; sgst: string; tax: string };
}

/** Tax → Reverse charge → self-invoice (TAX-032): the invoice issued for a reverse-charge bill from an unregistered supplier. */
export default function SelfInvoicePage() {
  const { org, orgId } = useOrg();
  const { documentId } = useParams<{ documentId: string }>();
  const qc = useQueryClient();
  const key = ['rcm-self-invoice', orgId, documentId];
  const url = `/v1/orgs/${orgId}/gst/reverse-charge/${documentId}/self-invoice`;
  const q = useQuery({ queryKey: key, queryFn: () => api<SelfInvoice>(url) });
  const [issuedOn, setIssuedOn] = useState(today);
  const issue = useMutation({
    mutationFn: () => api<SelfInvoice>(url, { method: 'POST', body: { issuedOn } }),
    onSuccess: (s) => {
      qc.setQueryData(key, s);
      void qc.invalidateQueries({ queryKey: ['reverse-charge', orgId] });
    },
  });
  if (!org) return null;
  const s = q.data;
  const manage = can(org.role, 'accounts.manage');
  return (
    <>
      <PageHeader
        title={s?.issued ? `Self-invoice ${s.issued.number}` : 'Self-invoice'}
        description="Under reverse charge from a supplier who is not registered, you issue the tax invoice yourself (CGST Act s.31(3)(f)), within 30 days of receiving the supply (rule 47A). It is numbered in its own series for the financial year."
        actions={<Link className="text-sm underline" href={`/orgs/${orgId}/tax/reverse-charge`}>Back to reverse charge</Link>}
      />
      <ErrorAlert title="Could not load the self-invoice" error={q.error} />
      {s ? (
        <>
          {!s.required ? (
            <div className="mb-4"><Alert tone="neutral" title="No self-invoice is needed">{!s.reverseCharge ? `${s.billNumber} is not under reverse charge.` : s.kind === 'VENDOR_CREDIT' ? 'Self-invoices are issued for bills, not vendor credits.' : "The supplier is registered, so their own tax invoice is the document."}</Alert></div>
          ) : !s.issued ? (
            <Card className="mb-6" role="region" aria-label="Issue the self-invoice">
              <CardHeader title="Issue the self-invoice" description={`Due by ${date(s.dueBy!)}, 30 days from the bill date. Once issued, the number is fixed and cannot be changed.`} />
              <ErrorAlert title="Not issued" error={issue.error} />
              {manage && s.status === 'POSTED' ? (
                <div className="flex flex-wrap items-end gap-3 p-5">
                  <div className="w-48"><Field label="Self-invoice date">{(p) => <Input {...p} type="date" value={issuedOn} min={s.billDate} max={today()} onChange={(e) => setIssuedOn(e.target.value)} />}</Field></div>
                  <Button onClick={() => issue.mutate()} disabled={issue.isPending}>Issue self-invoice</Button>
                  {s.dueBy! < today() ? <Badge tone="negative">Overdue</Badge> : null}
                </div>
              ) : <p className="p-5 text-sm text-fg-muted">{s.status === 'VOID' ? 'The bill is void.' : 'Someone who keeps the books can issue it.'}</p>}
            </Card>
          ) : null}
          <Card role="region" aria-label="Self-invoice">
            <CardHeader title={s.issued ? `Tax invoice ${s.issued.number}` : 'Tax invoice (draft)'} description={s.issued ? `Issued ${date(s.issued.issuedOn)} by ${s.issued.issuedBy}, for bill ${s.billNumber} of ${date(s.billDate)}. Tax payable on reverse charge: yes.` : `For bill ${s.billNumber} of ${date(s.billDate)}. Not issued yet. Tax payable on reverse charge: yes.`} />
            <div className="grid gap-4 p-5 text-sm sm:grid-cols-3">
              <div><p className="text-fg-muted">Recipient (you)</p><p className="font-medium">{s.recipient.name ?? org.name}</p><p className="num">GSTIN {s.recipient.gstin}</p><p>{s.recipient.state}</p></div>
              <div><p className="text-fg-muted">Supplier</p><p className="font-medium">{s.supplier.name}</p><p>{s.supplier.gstin ?? (s.supplier.importOfServices ? 'Outside India' : 'Not registered')}</p><p>{s.supplier.state}</p></div>
              <div><p className="text-fg-muted">Place of supply</p><p className="font-medium">{s.placeOfSupply}</p></div>
            </div>
            <Table aria-label="Self-invoice lines">
              <thead><Tr><Th>HSN/SAC</Th><Th numeric>Quantity</Th><Th numeric>Rate</Th><Th numeric>Taxable</Th><Th numeric>IGST</Th><Th numeric>CGST</Th><Th numeric>SGST</Th></Tr></thead>
              <tbody>
                {s.lines.map((l, i) => (
                  <Tr key={i}>
                    <Td>{l.hsnCode ?? '—'}{l.category ? <span className="block text-xs text-fg-muted">{l.category}</span> : null}</Td>
                    <Td numeric>{l.quantity}</Td>
                    <Td numeric>{l.rate}%</Td>
                    <Td numeric><Money value={l.taxable} currency="INR" /></Td>
                    <Td numeric><Money value={l.igst} currency="INR" /></Td>
                    <Td numeric><Money value={l.cgst} currency="INR" /></Td>
                    <Td numeric><Money value={l.sgst} currency="INR" /></Td>
                  </Tr>
                ))}
                <Tr className="font-semibold"><Td>Total</Td><Td /><Td /><Td numeric><Money value={s.totals.taxable} currency="INR" /></Td><Td numeric><Money value={s.totals.igst} currency="INR" /></Td><Td numeric><Money value={s.totals.cgst} currency="INR" /></Td><Td numeric><Money value={s.totals.sgst} currency="INR" /></Td></Tr>
              </tbody>
            </Table>
            <p className="p-5 text-sm">GST payable by you on reverse charge: <span className="font-semibold"><Money value={s.totals.tax} currency="INR" /></span>, in cash.</p>
          </Card>
        </>
      ) : null}
    </>
  );
}
