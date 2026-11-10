'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, CardHeader, EmptyState, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { LINK_STATUS_LABEL, LINK_STATUS_TONE, type PaymentLink, type PaymentLinkStatus } from '@/lib/payment-links';
import { can } from '@/lib/types';

/** Sales → Payment links: every link sent to customers, with what was paid and the receipt it made. */
export default function PaymentLinksPage() {
  const { org, orgId } = useOrg();
  const [status, setStatus] = useState<PaymentLinkStatus | ''>('');
  const q = useQuery({ queryKey: ['payment-links', orgId, 'list', status], queryFn: () => api<{ links: PaymentLink[] }>(`/v1/orgs/${orgId}/sales/payment-links${status ? `?status=${status}` : ''}`) });
  if (!org) return null;
  const links = q.data?.links ?? [];
  return (
    <>
      <PageHeader
        title="Payment links"
        description="Links customers open to pay an invoice online through your own Razorpay or Stripe account. Make one from a posted invoice; a paid link records its receipt and settles the invoice."
        actions={can(org.role, 'org.manage') ? <Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/settings/payment-gateways`}>Payment gateways</Link> : null}
      />
      <ErrorAlert title="Could not load payment links" error={q.error} />
      <Card>
        <CardHeader
          title="Links"
          description="Every payment link, newest first, with its invoice, gateway, amount, status and the receipt a paid link recorded."
          actions={
            <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as PaymentLinkStatus | '')}>
              <option value="">All</option>
              {(Object.keys(LINK_STATUS_LABEL) as PaymentLinkStatus[]).map((s) => <option key={s} value={s}>{LINK_STATUS_LABEL[s]}</option>)}
            </Select>
          }
        />
        {q.data && !links.length ? (
          <EmptyState title="No payment links">Open a posted invoice and use Make payment link to send the customer a way to pay online.</EmptyState>
        ) : (
          <Table>
            <thead><tr><Th>Link</Th><Th>Invoice</Th><Th>Gateway</Th><Th numeric>Amount</Th><Th>Status</Th><Th>Made</Th><Th>Receipt</Th></tr></thead>
            <tbody>
              {links.map((l) => (
                <Tr key={l.id}>
                  <Td className="num">{l.reference}</Td>
                  <Td>{l.invoice ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/invoices/${l.invoice.id}`}>{l.invoice.number}</Link> : '—'}</Td>
                  <Td>{l.provider === 'STRIPE' ? 'Stripe' : 'Razorpay'}</Td>
                  <Td numeric><Money value={l.paidAmount ?? l.amount} currency={l.currency} /></Td>
                  <Td><Badge tone={LINK_STATUS_TONE[l.status]}>{LINK_STATUS_LABEL[l.status]}</Badge></Td>
                  <Td className="text-fg-muted">{dateTime(l.createdAt)}</Td>
                  <Td>{l.receipt ? <Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/receipts/${l.receipt.id}`}>{l.receipt.number}</Link> : '—'}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
