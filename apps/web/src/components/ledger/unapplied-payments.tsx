'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { D } from '@talk2tax/accounting-engine';
import { Button, Card, CardHeader, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Money } from '@/components/money';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import type { LedgerConfig } from '@/lib/ledgers';
import type { Payment } from '@/lib/types';

/**
 * Payments (or receipts) from the same contact that are not fully applied yet: an advance or an
 * overpayment kept as a credit (AP-009, AR-007). Each can be applied to this bill or invoice from
 * here, up to what is still due on it; the rest stays as a credit.
 */
export function UnappliedPaymentsCard({ l, orgId, documentId, contactId, currency, amountDue, onApplied }: { l: LedgerConfig; orgId: string; documentId: string; contactId: string; currency: string; amountDue: string; onApplied: () => unknown }) {
  const base = `/v1/orgs/${orgId}/${l.api}`;
  const q = useQuery({ queryKey: ['payments', orgId, l.api, 'unapplied', contactId], queryFn: () => api<{ items: Payment[] }>(`${base}/payments?contactId=${contactId}&limit=200`) });
  const apply = useMutation({
    mutationFn: (p: { id: string; amount: string }) => api<Payment>(`${base}/payments/${p.id}/allocate`, { method: 'POST', body: { allocations: [{ documentId, amount: p.amount }] } }),
    onSuccess: async () => {
      await q.refetch();
      await onApplied();
    },
  });
  const open = (q.data?.items ?? []).filter((p) => p.status === 'POSTED' && p.currency === currency && new D(p.unallocated).gt(0));
  if (!open.length) return null;
  const vendor = l.ledger === 'PURCHASES';
  return (
    <Card className="mt-6" role="region" aria-label={vendor ? 'Unapplied vendor payments' : 'Unapplied customer receipts'}>
      <CardHeader
        title={vendor ? 'Unapplied vendor payments' : 'Unapplied customer receipts'}
        description={vendor ? 'Advances and overpayments to this vendor still held as a credit. Apply one to settle this bill; anything over what is due stays as a credit.' : 'Advances and overpayments from this customer still held as a credit. Apply one to settle this invoice; anything over what is due stays as a credit.'}
      />
      <ErrorAlert title="Could not apply it" error={apply.error} />
      <Table aria-label={vendor ? 'Unapplied vendor payments' : 'Unapplied customer receipts'}>
        <thead><Tr><Th>{l.payment.label}</Th><Th>Date</Th><Th>Reference</Th><Th numeric>Not applied</Th><Th /></Tr></thead>
        <tbody>
          {open.map((p) => {
            const amount = D.min(new D(p.unallocated), new D(amountDue)).toFixed(2);
            return (
              <Tr key={p.id}>
                <Td><Link className="underline" href={`/orgs/${orgId}/${l.paymentsPath}/${p.id}`}>{p.number}</Link></Td>
                <Td className="whitespace-nowrap">{date(p.date)}</Td>
                <Td>{p.reference ?? <span className="text-fg-faint">—</span>}</Td>
                <Td numeric><Money value={p.unallocated} currency={p.currency} /></Td>
                <Td className="text-right">
                  <Button size="sm" variant="secondary" loading={apply.isPending && apply.variables?.id === p.id} disabled={apply.isPending} onClick={() => apply.mutate({ id: p.id, amount })}>
                    Apply <Money value={amount} currency={p.currency} />
                  </Button>
                </Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
    </Card>
  );
}
