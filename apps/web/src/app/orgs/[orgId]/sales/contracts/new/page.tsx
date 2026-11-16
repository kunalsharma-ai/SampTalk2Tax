'use client';
import { useSearchParams } from 'next/navigation';
import { SalesForm } from '@/components/sales-orders/sales-form';
import { PageHeader } from '@/components/shell';

export default function NewContractPage() {
  const p = useSearchParams();
  return (
    <>
      <PageHeader title="New contract" description="Saved as a draft. Activate it to start billing: each period then becomes a draft invoice on its invoice date." />
      <SalesForm mode="contract" contactId={p.get('contactId') ?? undefined} dealId={p.get('dealId') ?? undefined} />
    </>
  );
}
