'use client';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, CardHeader, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { Money } from '@/components/money';
import { api } from '@/lib/api';
import type { DealList } from '@/lib/crm';
import { date } from '@/lib/format';
import { StageBadge } from './bits';

/** A customer's deals in the pipeline, on the customer page. */
export function CustomerDeals({ orgId, contactId, currency }: { orgId: string; contactId: string; currency: string }) {
  const q = useQuery({ queryKey: ['crm-deals', orgId, 'contact', contactId], queryFn: () => api<DealList>(`/v1/orgs/${orgId}/crm/deals?contactId=${contactId}&view=all`) });
  const r = q.data;
  if (!r) return null;
  return (
    <Card className="mt-6">
      <CardHeader
        title="Deals"
        description={r.deals.length ? <>{r.summary.open.count} open, worth <Money value={r.summary.open.amount} currency={currency} /> (weighted <Money value={r.summary.open.weighted} currency={currency} />)</> : 'Nothing in the pipeline for this customer.'}
        actions={r.can.manage ? <Link href={`/orgs/${orgId}/sales/pipeline/new?contactId=${contactId}`}><Button size="sm" variant="secondary">Add a deal</Button></Link> : null}
      />
      {r.deals.length ? (
        <Table aria-label="Customer deals">
          <thead><tr><Th>Deal</Th><Th numeric>Amount</Th><Th numeric>Probability</Th><Th>Close</Th><Th>Stage</Th></tr></thead>
          <tbody>
            {r.deals.map((d) => (
              <Tr key={d.id}>
                <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/sales/pipeline/${d.id}`}>{d.reference} {d.name}</Link></Td>
                <Td numeric><Money value={d.amount} currency={currency} /></Td>
                <Td numeric>{d.probability}%</Td>
                <Td className="whitespace-nowrap text-sm">{date(d.closedOn ?? d.expectedCloseDate)}</Td>
                <Td><StageBadge stage={d.stage} /></Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </Card>
  );
}
