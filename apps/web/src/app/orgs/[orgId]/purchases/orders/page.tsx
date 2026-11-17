'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PurchaseOrderBadge } from '@/components/purchase-orders/badges';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import type { PurchaseOrderList } from '@/lib/purchase-orders';

const label = 'flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted';
type View = 'open' | 'to_receive' | 'to_bill' | 'done' | 'all';

export default function PurchaseOrdersPage() {
  const { org, orgId } = useOrg();
  const [view, setView] = useState<View>('open');
  const q = useQuery({ queryKey: ['purchase-orders', orgId, view], queryFn: () => api<PurchaseOrderList>(`/v1/orgs/${orgId}/purchases/orders?view=${view}`) });
  if (!org) return null;
  const s = q.data;
  const c = org.functionalCurrency;
  return (
    <>
      <PageHeader
        title="Purchase orders"
        description="What you ordered from vendors, what has arrived and what is billed. Record goods received against an order, then make the bill from it: a bill that differs from the order or from what was received does not post until someone accepts the difference."
        actions={s?.can.manage ? <Link href={`/orgs/${orgId}/purchases/orders/new`}><Button>New purchase order</Button></Link> : null}
      />
      <ErrorAlert title="Could not load purchase orders" error={q.error} />
      {s ? (
        <>
          <div className="my-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label="Open orders" value={String(s.totals.open)} tone="accent" sub={`${s.totals.drafts} ${s.totals.drafts === 1 ? 'draft' : 'drafts'} not yet issued`} />
            <Stat label="Still to receive" value={<Money value={s.totals.toReceive} currency={c} />} tone="neutral" sub="At the order prices" />
            <Stat label="Received, not billed" value={<Money value={s.totals.toBill} currency={c} />} tone={Number(s.totals.toBill) ? 'warning' : 'positive'} sub="Expect these bills" />
            <Stat label="Late deliveries" value={String(s.totals.late)} tone={s.totals.late ? 'negative' : 'positive'} sub="Past the expected date" />
          </div>
          <Card>
            <CardHeader title="Orders" description="Newest first. Open one to issue it, record goods received, make the bill, or close it." />
            <div className="flex flex-wrap items-end gap-4 border-b border-line px-5 py-3">
              <label className={label}>
                Show
                <Select className="w-52" value={view} onChange={(e) => setView(e.target.value as View)}>
                  <option value="open">Open</option>
                  <option value="to_receive">Waiting for goods</option>
                  <option value="to_bill">Waiting for the bill</option>
                  <option value="done">Billed, closed or cancelled</option>
                  <option value="all">All</option>
                </Select>
              </label>
            </div>
            {s.orders.length === 0 ? (
              <EmptyState title="No purchase orders here">Make one with New purchase order.</EmptyState>
            ) : (
              <Table aria-label="Purchase orders">
                <thead>
                  <tr><Th>Number</Th><Th>Vendor</Th><Th>Date</Th><Th>Expected</Th><Th numeric>Total</Th><Th numeric>To receive</Th><Th numeric>To bill</Th><Th>Status</Th></tr>
                </thead>
                <tbody>
                  {s.orders.map((o) => (
                    <Tr key={o.id}>
                      <Td><Link className="font-medium text-accent hover:underline" href={`/orgs/${orgId}/purchases/orders/${o.id}`}>{o.reference}</Link></Td>
                      <Td>{o.contact?.name}</Td>
                      <Td>{date(o.orderDate)}</Td>
                      <Td>{o.expectedDate ? date(o.expectedDate) : '—'}{o.late ? <Badge tone="negative" className="ml-2">Late</Badge> : null}</Td>
                      <Td numeric><Money value={o.total} currency={o.currency} /></Td>
                      <Td numeric><Money value={o.toReceive} currency={o.currency} /></Td>
                      <Td numeric><Money value={o.toBill} currency={o.currency} /></Td>
                      <Td><PurchaseOrderBadge state={o.state} /></Td>
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
