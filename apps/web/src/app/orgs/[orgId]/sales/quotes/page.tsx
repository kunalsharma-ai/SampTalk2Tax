'use client';
import { useQuery } from '@tanstack/react-query';
import { QUOTE_STATUSES, QUOTE_STATE_LABEL } from '@talk2tax/accounting-engine';
import { Button, Card, EmptyState, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { QuoteBadge } from '@/components/sales-orders/badges';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import type { QuoteList, QuoteStatus } from '@/lib/sales-orders';

export default function QuotesPage() {
  const { org, orgId } = useOrg();
  const [status, setStatus] = useState<QuoteStatus | ''>('');
  const list = useQuery({ queryKey: ['sales-quotes', orgId, status], queryFn: () => api<QuoteList>(`/v1/orgs/${orgId}/sales/quotes${status ? `?status=${status}` : ''}`) });
  if (!org) return null;
  const cur = org.functionalCurrency;
  const r = list.data;
  return (
    <>
      <PageHeader
        title="Quotations"
        description="Prices offered to customers. A quotation uses the same tax rules as an invoice; once sent it no longer changes, and when the customer accepts it becomes a sales order."
        actions={
          <>
            <Link href={`/orgs/${orgId}/sales/orders`}><Button variant="secondary">Sales orders</Button></Link>
            {r?.can.manage ? <Link href={`/orgs/${orgId}/sales/quotes/new`}><Button>New quotation</Button></Link> : null}
          </>
        }
      />
      <ErrorAlert title="Could not load quotations" error={list.error} />
      {r ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Stat label="Awaiting an answer" value={<Money value={r.totals.awaiting.total} currency={cur} />} tone="accent" sub={`${r.totals.awaiting.count} sent`} />
            <Stat label="Accepted" value={<Money value={r.totals.accepted.total} currency={cur} />} tone="positive" sub={`${r.totals.accepted.count} turned into orders`} />
            <Stat label="Acceptance rate" value={r.totals.acceptanceRate === null ? '—' : `${r.totals.acceptanceRate}%`} tone="violet" sub="Accepted out of those answered" />
            <Stat label="Drafts and expired" value={`${r.totals.drafts} · ${r.totals.expired}`} tone={r.totals.expired ? 'warning' : 'neutral'} sub="Not yet sent · past valid-until" />
          </div>
          <Card>
            <div className="flex items-center justify-end gap-2 border-b border-line px-5 py-3">
              <label htmlFor="q-status" className="text-xs text-fg-muted">Show</label>
              <Select id="q-status" className="w-44" value={status} onChange={(e) => setStatus(e.target.value as QuoteStatus | '')}>
                <option value="">All quotations</option>
                {QUOTE_STATUSES.map((s) => <option key={s} value={s}>{QUOTE_STATE_LABEL[s]}</option>)}
              </Select>
            </div>
            {r.quotes.length === 0 ? (
              <EmptyState title="No quotations yet">Make a quotation for a customer, send it, and record whether they accept.</EmptyState>
            ) : (
              <Table aria-label="Quotations">
                <thead>
                  <tr><Th>Quotation</Th><Th>Customer</Th><Th>Deal</Th><Th>Date</Th><Th>Valid until</Th><Th>Status</Th><Th numeric>Total</Th></tr>
                </thead>
                <tbody>
                  {r.quotes.map((q) => (
                    <Tr key={q.id}>
                      <Td><Link className="font-medium text-accent hover:underline" href={`/orgs/${orgId}/sales/quotes/${q.id}`}>{q.reference}</Link></Td>
                      <Td>{q.contact?.name ?? '—'}</Td>
                      <Td className="text-fg-muted">{q.deal ? `${q.deal.reference} ${q.deal.name}` : '—'}</Td>
                      <Td>{date(q.issueDate)}</Td>
                      <Td>{date(q.validUntil)}</Td>
                      <Td><QuoteBadge state={q.state} /></Td>
                      <Td numeric><Money value={q.total} currency={cur} /></Td>
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
