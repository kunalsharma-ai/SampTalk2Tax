'use client';
import { useSearchParams } from 'next/navigation';
import { SalesForm } from '@/components/sales-orders/sales-form';
import { PageHeader } from '@/components/shell';

export default function NewOrderPage() {
  const p = useSearchParams();
  return (
    <>
      <PageHeader title="New sales order" description="An order the customer placed without a quotation, for example from their purchase order. Its lines and prices do not change; bill it into invoices as you deliver." />
      <SalesForm mode="order" contactId={p.get('contactId') ?? undefined} dealId={p.get('dealId') ?? undefined} />
    </>
  );
}
