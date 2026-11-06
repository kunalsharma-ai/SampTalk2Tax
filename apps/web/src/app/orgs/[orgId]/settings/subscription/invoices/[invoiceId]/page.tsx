'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge, Button, Card } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

interface Party { legalName?: string; name?: string; address?: string; countryCode: string; gstin: string | null; stateCode: string | null; email?: string | null; sacCode?: string }
interface Invoice {
  id: string;
  reference: string;
  number: string | null;
  kind: 'NEW' | 'RENEWAL' | 'UPGRADE';
  status: 'OPEN' | 'PAID' | 'VOID';
  plan: { code: string; name: string };
  billingInterval: 'MONTHLY' | 'ANNUAL';
  periodStart: string;
  periodEnd: string;
  currency: string;
  subtotal: string;
  taxLines: { code: string; rate: string; amount: string }[];
  taxTotal: string;
  total: string;
  taxNote: string;
  placeOfSupply: string | null;
  seller: Party;
  buyer: Party;
  issuedAt: string;
  dueAt: string;
  paidAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  gateway: string | null;
  paymentRef: string | null;
}
const KIND: Record<string, string> = { NEW: '', RENEWAL: ' (renewal)', UPGRADE: ' (upgrade for the rest of the period)' };

/** One subscription invoice, laid out to print or save as PDF. */
export default function SubscriptionInvoicePage() {
  const { org, orgId } = useOrg();
  const { invoiceId } = useParams<{ invoiceId: string }>();
  const q = useQuery({ queryKey: ['subscription-invoice', orgId, invoiceId], queryFn: () => api<Invoice>(`/v1/orgs/${orgId}/subscription/invoices/${invoiceId}`) });
  const pay = useMutation({ mutationFn: () => api<{ url: string }>(`/v1/orgs/${orgId}/subscription/invoices/${invoiceId}/pay`, { method: 'POST' }), onSuccess: (r) => window.location.assign(r.url) });
  if (!org) return null;
  const i = q.data;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2 print:hidden">
        <Link className="text-sm text-fg-muted underline" href={`/orgs/${orgId}/settings/subscription`}>Subscription</Link>
        <div className="ml-auto flex gap-2">
          {i?.status === 'OPEN' && can(org.role, 'org.manage') ? <Button loading={pay.isPending} onClick={() => pay.mutate()}>Pay now</Button> : null}
          <Button variant="ghost" onClick={() => window.print()}>Print or save as PDF</Button>
        </div>
      </div>
      <ErrorAlert title="Could not load the invoice" error={q.error ?? pay.error} />
      {i ? (
        <Card className="mx-auto max-w-3xl p-8 print:border-0 print:p-0 print:shadow-none" aria-label="Invoice">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold">{i.status === 'PAID' ? 'Tax invoice' : i.status === 'OPEN' ? 'Payment request' : 'Void payment request'}</h1>
              <p className="mt-1 text-sm text-fg-muted">{i.status === 'PAID' ? <>Number <span className="num font-medium text-fg">{i.number}</span> · {dateTime(i.paidAt!)}</> : <>Reference <span className="num font-medium text-fg">{i.reference}</span> · issued {dateTime(i.issuedAt)}</>}</p>
            </div>
            <Badge tone={i.status === 'PAID' ? 'positive' : i.status === 'OPEN' ? 'warning' : 'neutral'}>{i.status === 'PAID' ? 'Paid' : i.status === 'OPEN' ? `Due ${dateTime(i.dueAt)}` : 'Void'}</Badge>
          </div>
          {i.status === 'OPEN' ? <p className="mt-3 text-sm text-fg-muted">Not a tax invoice. The tax invoice is issued, with its own number, when the payment is received.</p> : null}
          {i.status === 'VOID' ? <p className="mt-3 text-sm text-fg-muted">Voided {dateTime(i.voidedAt!)}: {i.voidReason}</p> : null}

          <div className="mt-6 grid gap-6 text-sm sm:grid-cols-2">
            <div>
              <p className="text-xs uppercase tracking-wide text-fg-faint">From</p>
              <p className="mt-1 font-medium">{i.seller.legalName}</p>
              {i.seller.address ? <p className="whitespace-pre-line text-fg-muted">{i.seller.address}</p> : null}
              {i.seller.gstin ? <p>GSTIN <span className="num">{i.seller.gstin}</span></p> : null}
              {i.seller.email ? <p className="text-fg-muted">{i.seller.email}</p> : null}
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-fg-faint">To</p>
              <p className="mt-1 font-medium">{i.buyer.name}</p>
              <p className="text-fg-muted">Country {i.buyer.countryCode}</p>
              {i.buyer.gstin ? <p>GSTIN <span className="num">{i.buyer.gstin}</span></p> : null}
              {i.placeOfSupply ? <p className="text-fg-muted">Place of supply: {i.placeOfSupply}</p> : null}
            </div>
          </div>

          <table className="mt-8 w-full text-sm" aria-label="Lines">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-fg-faint"><th className="py-2 font-medium">Description</th><th className="py-2 font-medium">SAC</th><th className="py-2 text-right font-medium">Amount</th></tr>
            </thead>
            <tbody>
              <tr className="border-b border-line">
                <td className="py-3">
                  Talk2Tax {i.plan.name} subscription, billed {i.billingInterval === 'ANNUAL' ? 'annually' : 'monthly'}{KIND[i.kind]}
                  <span className="block text-xs text-fg-muted">{dateTime(i.periodStart)} to {dateTime(i.periodEnd)}</span>
                </td>
                <td className="py-3 num">{i.seller.sacCode}</td>
                <td className="py-3 text-right num"><Money value={i.subtotal} currency={i.currency} /></td>
              </tr>
              {i.taxLines.map((l) => (
                <tr key={l.code}><td className="py-1.5" colSpan={2}>{l.code} at {l.rate}%</td><td className="py-1.5 text-right num"><Money value={l.amount} currency={i.currency} /></td></tr>
              ))}
              <tr className="border-t border-line font-semibold"><td className="py-3" colSpan={2}>Total</td><td className="py-3 text-right num"><Money value={i.total} currency={i.currency} /></td></tr>
            </tbody>
          </table>
          {i.taxNote ? <p className="mt-3 text-xs text-fg-muted">{i.taxNote}</p> : null}
          {i.status === 'PAID' ? <p className="mt-6 text-sm text-fg-muted">Paid {i.gateway === 'MANUAL' ? 'by transfer' : `online (${i.gateway?.toLowerCase()})`}, reference <span className="num">{i.paymentRef}</span>. Payment request {i.reference}.</p> : null}
          <p className="mt-6 text-xs text-fg-faint">This is Talk2Tax’s charge for its own service. It is not part of your organisation’s books unless you record it as a purchase.</p>
        </Card>
      ) : null}
    </>
  );
}
