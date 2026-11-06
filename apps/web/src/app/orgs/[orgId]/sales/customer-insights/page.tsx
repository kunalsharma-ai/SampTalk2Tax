'use client';
import { useQuery } from '@tanstack/react-query';
import { RISK_LABEL, RISK_RATINGS, type RiskRating } from '@talk2tax/accounting-engine';
import { Card, EmptyState, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { RiskBadge } from '@/components/crm/customer-360';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { pctOf, type CustomerInsightList, type CustomerInsightRow } from '@/lib/customer-insights';
import { useOrg } from '@/lib/org';

type Sort = 'lifetimeValue' | 'profit' | 'revenue' | 'margin' | 'risk' | 'overdue';
const SORTS: Record<Sort, string> = { lifetimeValue: 'Lifetime value', profit: 'Gross profit', revenue: 'Revenue', margin: 'Margin', risk: 'Credit risk', overdue: 'Overdue' };
// Decimal strings compare exactly as numbers here only to order rows; every figure shown is the API's string.
const key = (r: CustomerInsightRow, s: Sort) => (s === 'risk' ? (r.risk.score ?? -1) : s === 'margin' ? Number(r.margin ?? -1) : Number(r[s]));

export default function CustomerInsightsPage() {
  const { org, orgId } = useOrg();
  const [sort, setSort] = useState<Sort>('lifetimeValue');
  const [rating, setRating] = useState<RiskRating | 'ALL' | 'HOLD'>('ALL');
  const q = useQuery({ queryKey: ['customer-insights', orgId, 'list'], queryFn: () => api<CustomerInsightList>(`/v1/orgs/${orgId}/customers/insights`) });
  const rows = useMemo(() => {
    const all = q.data?.customers ?? [];
    const shown = rating === 'ALL' ? all : rating === 'HOLD' ? all.filter((r) => r.creditHold) : all.filter((r) => r.risk.rating === rating);
    return [...shown].sort((a, b) => key(b, sort) - key(a, sort) || a.name.localeCompare(b.name));
  }, [q.data, sort, rating]);
  if (!org) return null;
  const d = q.data;
  const c = org.functionalCurrency;
  return (
    <>
      <PageHeader title="Customer insights" description="What each customer is worth, how they pay and how risky their credit is, from the books." />
      <ErrorAlert title="Could not load customer insights" error={q.error} />
      {d ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Lifetime value, all customers" value={<Money value={d.summary.lifetimeValue} currency={c} />} tone="accent" sub={`${d.summary.customers} customers`} />
            <Stat label="Gross profit to date" value={<Money value={d.summary.profit} currency={c} signed />} tone="positive" sub={<>on <Money value={d.summary.revenue} currency={c} /> revenue</>} />
            <Stat label="Customer retention" value={pctOf(d.retention.rate)} tone="violet" sub={d.retention.rate == null ? 'Needs five customers billed a year before last' : `${d.retention.retained} of ${d.retention.customers} billed again in the last 12 months`} />
            <Stat label="High risk or on hold" value={`${d.summary.ratings.HIGH + d.summary.ratings.VERY_HIGH}`} tone="negative" sub={`${d.summary.onHold} on credit hold`} />
          </div>
          <Card className="mt-6">
            <div className="flex flex-wrap items-end gap-3 border-b border-line px-5 py-3">
              <label className="flex flex-col gap-1 text-xs font-medium uppercase tracking-wide text-fg-muted">
                Sort by
                <Select aria-label="Sort by" value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="w-48 normal-case">
                  {Object.entries(SORTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium uppercase tracking-wide text-fg-muted">
                Show
                <Select aria-label="Show" value={rating} onChange={(e) => setRating(e.target.value as typeof rating)} className="w-48 normal-case">
                  <option value="ALL">All customers</option>
                  <option value="HOLD">On credit hold</option>
                  {RISK_RATINGS.map((r) => <option key={r} value={r}>{RISK_LABEL[r]} ({d.summary.ratings[r]})</option>)}
                </Select>
              </label>
            </div>
            {rows.length === 0 ? (
              <EmptyState title="No customers here">Customers appear once they have a posted invoice, an active contract or costs on their projects.</EmptyState>
            ) : (
              <Table aria-label="Customer insights">
                <thead>
                  <tr><Th>Customer</Th><Th numeric>Revenue</Th><Th numeric>Gross profit</Th><Th numeric>Margin</Th><Th numeric>Lifetime value</Th><Th numeric>Overdue</Th><Th numeric>Days to pay</Th><Th>Credit risk</Th></tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <Tr key={r.contactId}>
                      <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/customers/${r.contactId}`}>{r.name}</Link>{r.creditHold ? <span className="ml-2 text-xs text-negative">On hold</span> : null}</Td>
                      <Td numeric><Money value={r.revenue} currency={c} /></Td>
                      <Td numeric><Money value={r.profit} currency={c} signed /></Td>
                      <Td numeric>{pctOf(r.margin)}</Td>
                      <Td numeric><Money value={r.lifetimeValue} currency={c} /></Td>
                      <Td numeric><Money value={r.overdue} currency={c} /></Td>
                      <Td numeric>{r.averageDaysToPay ?? '—'}</Td>
                      <Td><RiskBadge rating={r.risk.rating} score={r.risk.score} /></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </>
      ) : !q.error ? <p className="text-sm text-fg-muted">Working out every customer's figures…</p> : null}
    </>
  );
}
