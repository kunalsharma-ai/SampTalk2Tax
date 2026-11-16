'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, Field, Input, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { api } from '@/lib/api';
import { LINK_STATUS_LABEL, LINK_STATUS_TONE, type InvoiceLinks, type PaymentLink } from '@/lib/payment-links';

const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Payment links on a posted invoice: make one for what is owed (or part of it) through the
 * organisation's own gateway, copy it for the customer, check it, or cancel it. A paid link
 * records the receipt itself.
 */
export function PaymentLinksPanel({ orgId, documentId, onChange }: { orgId: string; documentId: string; onChange: () => Promise<void> | void }) {
  const qc = useQueryClient();
  const key = ['payment-links', orgId, documentId];
  const q = useQuery({ queryKey: key, queryFn: () => api<InvoiceLinks>(`/v1/orgs/${orgId}/sales/payment-links?documentId=${documentId}`) });
  const [amount, setAmount] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const done = async () => {
    await qc.invalidateQueries({ queryKey: ['payment-links', orgId] });
    await onChange();
  };
  const create = useMutation({ mutationFn: () => api<PaymentLink>(`/v1/orgs/${orgId}/sales/documents/${documentId}/payment-links`, { method: 'POST', body: { amount: amount.trim() || null } }), onSuccess: async () => (setAmount(''), await done()) });
  const check = useMutation({ mutationFn: (id: string) => api<PaymentLink>(`/v1/orgs/${orgId}/sales/payment-links/${id}/check`, { method: 'POST' }), onSuccess: done });
  const cancel = useMutation({ mutationFn: (id: string) => api<PaymentLink>(`/v1/orgs/${orgId}/sales/payment-links/${id}/cancel`, { method: 'POST' }), onSuccess: done });
  const d = q.data;
  if (!d) return <ErrorAlert title="Could not load payment links" error={q.error} />;
  const open = d.links.find((l) => l.status === 'OPEN');
  const owed = d.outstanding !== '0.00' && !d.outstanding.startsWith('-');
  if (!d.links.length && !owed) return null;
  const copy = async (l: PaymentLink) => {
    try {
      await navigator.clipboard.writeText(l.url);
      setCopied(l.id);
    } catch {
      window.prompt('Copy the payment link', l.url);
    }
  };
  return (
    <Card className="mt-6" role="region" aria-label="Payment links">
      <CardHeader
        title="Payment links"
        description="A link the customer opens to pay this invoice online by card, UPI or net banking. When the gateway confirms the payment, the receipt is recorded and applied to this invoice."
        actions={d.gateway ? <Badge tone={d.gateway.mode === 'LIVE' ? 'positive' : 'warning'}>{d.gateway.name}{d.gateway.mode === 'TEST' ? ' · test mode' : ''}</Badge> : null}
      />
      <div className="px-5 pb-5">
        {!d.gateway ? (
          <p className="text-sm text-fg-muted">
            No payment gateway takes {d.currency} yet.{' '}
            {d.can.setUp ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/settings/payment-gateways`}>Set up Razorpay or Stripe</Link> : 'Ask an owner or admin to set up Razorpay or Stripe in Settings → Payment gateways'} to send payment links.
          </p>
        ) : d.can.manage && owed && !open ? (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <Field label={`Amount (${d.currency})`} hint={`Leave empty for all that is owed: ${d.outstanding}.`}>
              {(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={d.outstanding} className="w-40" />}
            </Field>
            <Button type="submit" loading={create.isPending}>Make payment link</Button>
          </form>
        ) : open ? (
          <p className="text-sm text-fg-muted">{open.reference} is open. Copy it for the customer, or cancel it to make a new one.</p>
        ) : null}
        <ErrorAlert title="No link made" error={create.error} />
        <ErrorAlert title="Could not check" error={check.error} />
        <ErrorAlert title="Could not cancel" error={cancel.error} />
      </div>
      {d.links.length ? (
        <Table>
          <thead>
            <tr>
              <Th>Link</Th>
              <Th>Status</Th>
              <Th numeric>Amount</Th>
              <Th>Made</Th>
              <Th>Paid</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {d.links.map((l) => (
              <Tr key={l.id}>
                <Td className="num">{l.reference}</Td>
                <Td><Badge tone={LINK_STATUS_TONE[l.status]}>{LINK_STATUS_LABEL[l.status]}</Badge></Td>
                <Td numeric><Money value={l.amount} currency={l.currency} /></Td>
                <Td className="text-fg-muted">{when(l.createdAt)}{l.status === 'OPEN' && l.expiresAt ? <p className="text-xs">Ends {when(l.expiresAt)}</p> : null}</Td>
                <Td className="text-fg-muted">
                  {l.paidAt ? (
                    <>
                      <Money value={l.paidAmount ?? l.amount} currency={l.currency} /> on {when(l.paidAt)}
                      {l.receipt ? <p className="text-xs">Receipt <Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/receipts/${l.receipt.id}`}>{l.receipt.number}</Link>{l.gatewayPaymentId ? ` · ${l.gatewayPaymentId}` : ''}</p> : null}
                    </>
                  ) : l.cancelledAt ? `Cancelled ${when(l.cancelledAt)}` : '—'}
                </Td>
                <Td className="text-right">
                  {l.status === 'OPEN' ? (
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button size="sm" variant="secondary" onClick={() => copy(l)}>{copied === l.id ? 'Copied' : 'Copy link'}</Button>
                      <a className="inline-flex items-center text-sm text-accent hover:underline" href={l.url} target="_blank" rel="noreferrer">Open</a>
                      {d.can.manage ? <Button size="sm" variant="secondary" loading={check.isPending && check.variables === l.id} onClick={() => check.mutate(l.id)}>Check payment</Button> : null}
                      {d.can.manage ? <Button size="sm" variant="ghost" onClick={() => confirm(`Cancel ${l.reference}? The customer can no longer pay through it.`) && cancel.mutate(l.id)}>Cancel</Button> : null}
                    </div>
                  ) : null}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </Card>
  );
}
