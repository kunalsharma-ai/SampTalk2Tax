'use client';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, CardHeader, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { Money } from '@/components/money';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import type { ContractList, OrderList, QuoteList } from '@/lib/sales-orders';
import { ContractBadge, OrderBadge, QuoteBadge } from './badges';

/** The quotations and orders made for one deal, on the deal's page. */
export function DealSales({ orgId, dealId, contactId, currency }: { orgId: string; dealId: string; contactId: string | null; currency: string }) {
  const quotes = useQuery({ queryKey: ['sales-quotes', orgId, 'deal', dealId], queryFn: () => api<QuoteList>(`/v1/orgs/${orgId}/sales/quotes?dealId=${dealId}`) });
  const orders = useQuery({ queryKey: ['sales-orders', orgId, 'deal', dealId], queryFn: () => api<OrderList>(`/v1/orgs/${orgId}/sales/orders?view=all&dealId=${dealId}`) });
  const contracts = useQuery({ queryKey: ['sales-contracts', orgId, 'deal', dealId], queryFn: () => api<ContractList>(`/v1/orgs/${orgId}/sales/contracts?view=all&dealId=${dealId}`) });
  const qs = quotes.data?.quotes ?? [];
  const cs = contracts.data?.contracts ?? [];
  const os = orders.data?.orders ?? [];
  const manage = quotes.data?.can.manage && contactId;
  return (
    <Card>
      <CardHeader
        title="Quotations, orders and contracts"
        description="Accepting a quotation, entering an order or activating a contract for this deal marks it won."
        actions={manage ? (
          <div className="flex gap-2">
            <Link href={`/orgs/${orgId}/sales/contracts/new?contactId=${contactId}&dealId=${dealId}`}><Button size="sm" variant="ghost">New contract</Button></Link>
            <Link href={`/orgs/${orgId}/sales/quotes/new?contactId=${contactId}&dealId=${dealId}`}><Button size="sm" variant="secondary">New quotation</Button></Link>
          </div>
        ) : null}
      />
      {qs.length + os.length + cs.length === 0 ? <p className="px-5 pb-5 text-sm text-fg-muted">None yet.</p> : (
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
            {cs.map((c) => (
              <Tr key={c.id}>
                <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/contracts/${c.id}`}>Contract {c.reference}</Link></Td>
                <Td>{date(c.startDate)}</Td>
                <Td><ContractBadge status={c.status} /></Td>
                <Td numeric><Money value={c.total} currency={currency} /></Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
