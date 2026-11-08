'use client';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PurchaseOrderForm } from '@/components/purchase-orders/purchase-order-form';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/org';
import type { PurchaseOrderDetail } from '@/lib/purchase-orders';

export default function EditPurchaseOrderPage() {
  const { orgId } = useOrg();
  const { orderId } = useParams<{ orderId: string }>();
  const q = useQuery({ queryKey: ['purchase-orders', orgId, 'one', orderId], queryFn: () => api<PurchaseOrderDetail>(`/v1/orgs/${orgId}/purchases/orders/${orderId}`) });
  if (q.error) return <ErrorAlert title="Could not load the purchase order" error={q.error} />;
  if (!q.data) return <p className="text-sm text-fg-muted">Loading…</p>;
  return (
    <>
      <PageHeader title={`Edit ${q.data.reference}`} description="A draft can change until it is issued to the vendor." />
      <PurchaseOrderForm existing={q.data} />
    </>
  );
}
