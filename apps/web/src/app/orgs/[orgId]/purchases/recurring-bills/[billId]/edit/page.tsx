'use client';
import { useQuery } from '@tanstack/react-query';
import { Alert } from '@talk2tax/ui';
import { useParams } from 'next/navigation';
import { RecurringBillForm } from '@/components/purchases/recurring-bill-form';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/org';
import type { RecurringBillDetail } from '@/lib/recurring-bills';

export default function EditRecurringBillPage() {
  const { orgId } = useOrg();
  const { billId } = useParams<{ billId: string }>();
  const q = useQuery({ queryKey: ['recurring-bill', orgId, billId], queryFn: () => api<RecurringBillDetail>(`/v1/orgs/${orgId}/purchases/recurring-bills/${billId}`) });
  if (q.error) return <Alert title="Recurring bill not found">{(q.error as Error).message}</Alert>;
  if (!q.data) return <p className="text-sm text-fg-muted">Loading…</p>;
  return (
    <>
      <PageHeader title={`Edit ${q.data.reference}`} description="Changes apply to bills made from now on. Bills already made keep their lines and amounts." />
      <RecurringBillForm existing={q.data} />
    </>
  );
}
