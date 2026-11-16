'use client';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, CardHeader, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { Money } from '@/components/money';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import type { OrderList, QuoteList } from '@/lib/sales-orders';
import { OrderBadge, QuoteBadge } from './badges';

/** The quotations and orders made for one deal, on the deal's page. */
export function DealSales({ orgId, dealId, contactId, currency }: { orgId: string; dealId: string; contactId: string | null; currency: string }) {
  const quotes = useQuery({ queryKey: ['sales-quotes', orgId, 'deal', dealId], queryFn: () => api<QuoteList>(`/v1/orgs/${orgId}/sales/quotes?dealId=${dealId}`) });
  const orders = useQuery({ queryKey: ['sales-orders', orgId, 'deal', dealId], queryFn: () => api<OrderList>(`/v1/orgs/${orgId}/sales/orders?view=all&dealId=${dealId}`) });
  const qs = quotes.data?.quotes ?? [];
  const os = orders.data?.orders ?? [];
  const manage = quotes.data?.can.manage && contactId;
  return (
    <Card>
      <CardHeader
        title="Quotations and orders"
        description="Accepting a quotation, or entering an order, for this deal marks it won."
        actions={manage ? <Link href={`/orgs/${orgId}/sales/quotes/new?contactId=${contactId}&dealId=${dealId}`}><Button size="sm" variant="secondary">New quotation</Button></Link> : null}
      />
      {qs.length + os.length === 0 ? <p className="px-5 pb-5 text-sm text-fg-muted">None yet.</p> : (
        <Table aria-label="Deal quotations and orders">
          <thead><tr><Th>Reference</Th><Th>Date</Th><Th>Status</Th><Th numeric>Total</Th></tr></thead>
          <tbody>
            {qs.map((q) => (
              <Tr key={q.id}>
                <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/quotes/${q.id}`}>Quotation {q.reference}</Link></Td>
                <Td>{date(q.issueDate)}</Td>
                <Td><QuoteBadge state={q.state} /></Td>
                <Td numeric><Money value={q.total} currency={currency} /></Td>
              </Tr>
            ))}
            {os.map((o) => (
              <Tr key={o.id}>
                <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/orders/${o.id}`}>Order {o.reference}</Link></Td>
                <Td>{date(o.orderDate)}</Td>
                <Td><OrderBadge order={o} /></Td>
                <Td numeric><Money value={o.total} currency={currency} /></Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
