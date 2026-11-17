'use client';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, CardHeader, EmptyState, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { ProFormaBadge } from '@/components/sales-orders/badges';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import type { ProFormaList } from '@/lib/sales-orders';

const label = 'flex flex-col gap-1.5 text-xs font-medium uppercase tracking-wide text-fg-muted';

export default function ProFormasPage() {
  const { org, orgId } = useOrg();
  const [view, setView] = useState<'open' | 'invoiced' | 'all'>('open');
  const q = useQuery({ queryKey: ['pro-formas', orgId, view], queryFn: () => api<ProFormaList>(`/v1/orgs/${orgId}/sales/pro-formas?view=${view}`) });
  if (!org) return null;
  const s = q.data;
  const c = org.functionalCurrency;
  return (
    <>
      <PageHeader
        title="Pro forma invoices"
        description="What a customer will be billed, sent before the sale: to collect an advance, or for the customer's own approvals. A pro forma invoice is not a tax invoice and posts nothing. Issue it, then turn it into a tax invoice when you supply or are paid."
        actions={s?.can.manage ? <Link href={`/orgs/${orgId}/sales/pro-formas/new`}><Button>New pro forma invoice</Button></Link> : null}
      />
      <ErrorAlert title="Could not load pro forma invoices" error={q.error} />
      {s ? (
        <>
          <div className="my-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label="Drafts" value={String(s.totals.drafts)} tone="neutral" sub="Not yet issued" />
            <Stat label="Issued, not invoiced" value={<Money value={s.totals.awaiting.total} currency={c} />} tone="accent" sub={`${s.totals.awaiting.count} pro forma ${s.totals.awaiting.count === 1 ? 'invoice' : 'invoices'}`} />
            <Stat label="Past valid date" value={String(s.totals.expired)} tone={s.totals.expired ? 'warning' : 'positive'} sub="Issued and not invoiced" />
            <Stat label="Invoiced" value={<Money value={s.totals.invoiced.total} currency={c} />} tone="positive" sub={`${s.totals.invoiced.count} turned into tax invoices`} />
          </div>
          <Card>
            <CardHeader title="Pro forma invoices" description="Newest first. Open one to issue it, print it, turn it into a tax invoice or cancel it." />
            <div className="flex flex-wrap items-end gap-4 border-b border-line px-5 py-3">
              <label className={label}>
                Show
                <Select className="w-44" value={view} onChange={(e) => setView(e.target.value as typeof view)}>
                  <option value="open">Not yet invoiced</option>
                  <option value="invoiced">Invoiced</option>
                  <option value="all">All</option>
                </Select>
              </label>
            </div>
            {s.proFormas.length === 0 ? (
              <EmptyState title="No pro forma invoices here">Make one with New pro forma invoice, or from a quotation.</EmptyState>
            ) : (
              <Table aria-label="Pro forma invoices">
                <thead>
                  <tr><Th>Number</Th><Th>Customer</Th><Th>Date</Th><Th>Valid until</Th><Th numeric>Total</Th><Th>Status</Th><Th>Tax invoice</Th></tr>
                </thead>
                <tbody>
                  {s.proFormas.map((p) => (
                    <Tr key={p.id}>
                      <Td><Link className="font-medium text-accent hover:underline" href={`/orgs/${orgId}/sales/pro-formas/${p.id}`}>{p.reference}</Link></Td>
                      <Td>{p.contact?.name}</Td>
                      <Td>{date(p.issueDate)}</Td>
                      <Td>{date(p.validUntil)}</Td>
                      <Td numeric><Money value={p.total} currency={p.currency} /></Td>
                      <Td><ProFormaBadge state={p.state} /></Td>
                      <Td>{p.invoice ? <Link className="hover:underline" href={`/orgs/${orgId}/sales/invoices/${p.invoice.id}`}>{p.invoice.number ?? 'Draft invoice'}</Link> : '—'}</Td>
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
