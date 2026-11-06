'use client';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { BATCH_STATUS, type BatchCan, type BatchSummary } from '@/lib/payment-batches';

export default function PaymentBatchesPage() {
  const { orgId } = useOrg();
  const q = useQuery({ queryKey: ['payment-batches', orgId], queryFn: () => api<{ batches: BatchSummary[]; can: BatchCan }>(`/v1/orgs/${orgId}/purchases/payment-batches`) });
  return (
    <>
      <PageHeader
        title="Payment batches"
        description="Bills paid together from one bank account on one date. A batch is prepared, approved by a second person, sent to the bank as a payment file, then recorded as paid. Talk2Tax never moves money itself."
        actions={q.data?.can.prepare ? <Link href={`/orgs/${orgId}/purchases/payment-batches/new`}><Button>New batch</Button></Link> : null}
      />
      <ErrorAlert title="Could not load payment batches" error={q.error} />
      <Card className="mt-4">
        <CardHeader title="Batches" description="Newest first." />
        {q.data && q.data.batches.length === 0 ? (
          <EmptyState title="No payment batches yet">Start one with New batch and pick the bills to pay.</EmptyState>
        ) : (
          <Table aria-label="Payment batches">
            <thead><tr><Th>Batch</Th><Th>Payment date</Th><Th>From</Th><Th numeric>Bills</Th><Th numeric>Vendors</Th><Th numeric>Total</Th><Th>Status</Th></tr></thead>
            <tbody>
              {(q.data?.batches ?? []).map((b) => (
                <Tr key={b.id}>
                  <Td><Link className="text-accent hover:underline" href={`/orgs/${orgId}/purchases/payment-batches/${b.id}`}>{b.reference}</Link>{b.memo ? <span className="block text-xs text-fg-muted">{b.memo}</span> : null}</Td>
                  <Td>{date(b.paymentDate)}</Td>
                  <Td className="text-sm">{b.bankAccount ? `${b.bankAccount.code} ${b.bankAccount.name}` : ''}</Td>
                  <Td numeric>{b.bills}</Td>
                  <Td numeric>{b.vendors}</Td>
                  <Td numeric><Money value={b.total} currency={b.currency} /></Td>
                  <Td><Badge tone={BATCH_STATUS[b.status].tone}>{BATCH_STATUS[b.status].label}</Badge></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
