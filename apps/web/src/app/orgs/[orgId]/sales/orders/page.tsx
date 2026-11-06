'use client';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, EmptyState, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { OrderBadge } from '@/components/sales-orders/badges';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import type { OrderList } from '@/lib/sales-orders';

type View = 'open' | 'billed' | 'cancelled' | 'all';
const VIEWS: Record<View, string> = { open: 'Still to bill', billed: 'Fully billed', cancelled: 'Cancelled', all: 'All orders' };

export default function OrdersPage() {
  const { org, orgId } = useOrg();
  const [view, setView] = useState<View>('open');
  const list = useQuery({ queryKey: ['sales-orders', orgId, view], queryFn: () => api<OrderList>(`/v1/orgs/${orgId}/sales/orders?view=${view}`) });
  if (!org) return null;
  const cur = org.functionalCurrency;
  const r = list.data;
  return (
    <>
      <PageHeader
        title="Sales orders"
        description="What customers have ordered and what is still to bill. Bill an order in one go or line by line as you deliver; each bill is a draft invoice you check and post."
        actions={
          <>
            <Link href={`/orgs/${orgId}/sales/quotes`}><Button variant="secondary">Quotations</Button></Link>
            {r?.can.manage ? <Link href={`/orgs/${orgId}/sales/orders/new`}><Button>New sales order</Button></Link> : null}
          </>
        }
      />
      <ErrorAlert title="Could not load sales orders" error={list.error} />
      {r ? (
        <>
          {view === 'open' ? (
            <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
              <Stat label="Still to bill" value={<Money value={r.totals.toBill} currency={cur} />} tone="accent" sub={`${r.totals.open} open ${r.totals.open === 1 ? 'order' : 'orders'}, with tax`} />
            </div>
          ) : null}
          <Card>
            <div className="flex items-center justify-end gap-2 border-b border-line px-5 py-3">
              <label htmlFor="o-view" className="text-xs text-fg-muted">Show</label>
              <Select id="o-view" className="w-44" value={view} onChange={(e) => setView(e.target.value as View)}>
                {(Object.keys(VIEWS) as View[]).map((v) => <option key={v} value={v}>{VIEWS[v]}</option>)}
              </Select>
            </div>
            {r.orders.length === 0 ? (
              <EmptyState title={view === 'open' ? 'Nothing left to bill' : 'No orders here'}>Orders come from accepted quotations, or enter one directly from a customer&apos;s purchase order.</EmptyState>
            ) : (
              <Table aria-label="Sales orders">
                <thead>
                  <tr><Th>Order</Th><Th>Customer</Th><Th>Customer PO</Th><Th>Date</Th><Th>Billing</Th><Th numeric>Total</Th><Th numeric>To bill</Th></tr>
                </thead>
                <tbody>
                  {r.orders.map((o) => (
                    <Tr key={o.id}>
                      <Td><Link className="font-medium text-accent hover:underline" href={`/orgs/${orgId}/sales/orders/${o.id}`}>{o.reference}</Link></Td>
                      <Td>{o.contact?.name ?? '—'}</Td>
                      <Td className="text-fg-muted">{o.customerReference ?? '—'}</Td>
                      <Td>{date(o.orderDate)}</Td>
                      <Td><OrderBadge order={o} /></Td>
                      <Td numeric><Money value={o.total} currency={cur} /></Td>
                      <Td numeric><Money value={o.toBill} currency={cur} /></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      ) : null}
    </>
  );
}
