'use client';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { SalesForm } from '@/components/sales-orders/sales-form';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/org';
import type { QuoteDetail } from '@/lib/sales-orders';

export default function EditQuotePage() {
  const { orgId } = useOrg();
  const { quoteId } = useParams<{ quoteId: string }>();
  const q = useQuery({ queryKey: ['sales-quote', orgId, quoteId], queryFn: () => api<QuoteDetail>(`/v1/orgs/${orgId}/sales/quotes/${quoteId}`) });
  if (q.error) return <ErrorAlert title="Could not load the quotation" error={q.error} />;
  if (!q.data) return <p className="text-sm text-fg-muted">Loading…</p>;
  return (
    <>
      <PageHeader title={`Edit ${q.data.reference}`} description="Only a draft can be changed." />
      <SalesForm mode="quote" existing={q.data} />
    </>
  );
}
