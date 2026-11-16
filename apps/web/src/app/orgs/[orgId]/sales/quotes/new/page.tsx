'use client';
import { useSearchParams } from 'next/navigation';
import { SalesForm } from '@/components/sales-orders/sales-form';
import { PageHeader } from '@/components/shell';

export default function NewQuotePage() {
  const p = useSearchParams();
  return (
    <>
      <PageHeader title="New quotation" description="Saved as a draft you can change. Mark it sent when it goes to the customer." />
      <SalesForm mode="quote" contactId={p.get('contactId') ?? undefined} dealId={p.get('dealId') ?? undefined} />
    </>
  );
}
