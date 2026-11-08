'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { PurchaseOrderForm } from '@/components/purchase-orders/purchase-order-form';
import { PageHeader } from '@/components/shell';

function NewOrder() {
  const p = useSearchParams();
  return (
    <>
      <PageHeader title="New purchase order" description="Saved as a draft you can change. Issue it when it goes to the vendor; it is numbered PO- and is fixed from then on." />
      <PurchaseOrderForm contactId={p.get('contactId') ?? undefined} />
    </>
  );
}

export default function NewPurchaseOrderPage() {
  return (
    <Suspense fallback={<p className="text-sm text-fg-muted">Loading…</p>}>
      <NewOrder />
    </Suspense>
  );
}
