'use client';
import { useQuery } from '@tanstack/react-query';
import { Card, CardHeader, EmptyState, Select, Stat, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

interface Forecast {
  asOf: string;
  currency: string;
  unscored: number;
  accuracy: { tested: number; meanErrorDays: number | null };
  weeks: { from: string; to: string; expected: string; byDueDate: string; invoices: number; cumulative: string }[];
  later: { expected: string; byDueDate: string; invoices: number };
  doubtful: { amount: string; invoices: number };
  total: string;
  inHorizon: string;
}

const WEEKS = [4, 8, 13, 26];

/** Cash collection forecasting (AR-039): money expected from customers week by week. */
export default function CollectionForecastPage() {
  const { org, orgId } = useOrg();
  const [weeks, setWeeks] = useState(13);
  const q = useQuery({ queryKey: ['collection-forecast', orgId, weeks], queryFn: () => api<Forecast>(`/v1/orgs/${orgId}/payment-predictions/forecast?weeks=${weeks}`) });
  if (!org) return null;
  const f = q.data;
  const c = org.functionalCurrency;
  return (
    <>
      <PageHeader
        title="Collection forecast"
        description="Money expected from customers week by week, from when each open invoice is predicted to be paid, beside what the due dates alone would say. For the full cash position with bills and planned items, use the cash-flow forecast."
        actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/sales/payment-predictions`}>See each invoice</Link>}
      />
      <ErrorAlert title="Could not load the collection forecast" error={q.error} />
      {f ? (
        <>
          <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label={`Expected in ${weeks} weeks`} value={<Money value={f.inHorizon} currency={c} />} tone="positive" sub={<>of <Money value={f.total} currency={c} /> open</>} />
            <Stat label="Expected later" value={<Money value={f.later.expected} currency={c} />} sub={`${f.later.invoices} ${f.later.invoices === 1 ? 'invoice' : 'invoices'}`} />
            <Stat label="Doubtful" value={<Money value={f.doubtful.amount} currency={c} />} tone={f.doubtful.invoices ? 'negative' : 'positive'} sub="Over 90 days past due, left out of the weeks" />
            <Stat label="Prediction accuracy" value={f.accuracy.meanErrorDays == null ? 'Not yet' : `±${f.accuracy.meanErrorDays} days`} sub={f.accuracy.tested ? `Average miss on ${f.accuracy.tested} paid invoices` : 'Shows once invoices have been paid'} />
          </div>
          <Card>
            <CardHeader
              title="Expected collections by week"
              description="Weeks start today. Expected is by predicted payment date; by due date is what the payment terms say, with anything already overdue in the first week."
              actions={
                <Select aria-label="Weeks" value={String(weeks)} onChange={(e) => setWeeks(Number(e.target.value))} className="w-32">
                  {WEEKS.map((w) => <option key={w} value={w}>{w} weeks</option>)}
                </Select>
              }
            />
            {/^0(\.0+)?$/.test(f.total) ? (
              <EmptyState title="Nothing to collect">{f.unscored ? 'Open invoices are waiting for payment history before they can be forecast.' : 'There are no open invoices.'}</EmptyState>
            ) : (
              <Table aria-label="Expected collections by week">
                <thead><Tr><Th>Week</Th><Th numeric>Expected</Th><Th numeric>By due date</Th><Th numeric>Invoices</Th><Th numeric>Expected to date</Th></Tr></thead>
                <tbody>
                  {f.weeks.map((w) => (
                    <Tr key={w.from}>
                      <Td className="whitespace-nowrap">{date(w.from)} to {date(w.to)}</Td>
                      <Td numeric><Money value={w.expected} currency={c} /></Td>
                      <Td numeric><Money value={w.byDueDate} currency={c} /></Td>
                      <Td numeric>{w.invoices}</Td>
                      <Td numeric><Money value={w.cumulative} currency={c} /></Td>
                    </Tr>
                  ))}
                  <Tr>
                    <Td>Later</Td>
                    <Td numeric><Money value={f.later.expected} currency={c} /></Td>
                    <Td numeric><Money value={f.later.byDueDate} currency={c} /></Td>
                    <Td numeric>{f.later.invoices}</Td>
                    <Td />
                  </Tr>
                  <Tr>
                    <Td>Doubtful (over 90 days past due)</Td>
                    <Td numeric><Money value={f.doubtful.amount} currency={c} /></Td>
                    <Td numeric />
                    <Td numeric>{f.doubtful.invoices}</Td>
                    <Td />
                  </Tr>
                </tbody>
              </Table>
            )}
          </Card>
        </>
      ) : null}
    </>
  );
}
