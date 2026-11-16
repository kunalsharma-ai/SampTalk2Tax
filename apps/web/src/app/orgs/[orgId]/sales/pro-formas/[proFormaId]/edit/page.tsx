'use client';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { SalesForm } from '@/components/sales-orders/sales-form';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/org';
import type { ProFormaDetail } from '@/lib/sales-orders';

export default function EditProFormaPage() {
  const { orgId } = useOrg();
  const { proFormaId } = useParams<{ proFormaId: string }>();
  const q = useQuery({ queryKey: ['pro-formas', orgId, 'one', proFormaId], queryFn: () => api<ProFormaDetail>(`/v1/orgs/${orgId}/sales/pro-formas/${proFormaId}`) });
  if (q.error) return <ErrorAlert title="Could not load the pro forma invoice" error={q.error} />;
  if (!q.data) return <p className="text-sm text-fg-muted">Loading…</p>;
  return (
    <>
      <PageHeader title={`Edit ${q.data.reference}`} description="A draft can change until it is issued." />
      <SalesForm mode="proforma" proForma={q.data} />
    </>
  );
}
