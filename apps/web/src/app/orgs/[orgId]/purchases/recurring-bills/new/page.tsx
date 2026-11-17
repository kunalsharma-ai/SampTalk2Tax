'use client';
import { useQuery } from '@tanstack/react-query';
import { Alert } from '@talk2tax/ui';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { RecurringBillForm } from '@/components/purchases/recurring-bill-form';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/org';
import type { FinancialDocument } from '@/lib/types';

function NewRecurringBill() {
  const { orgId } = useOrg();
  const fromBill = useSearchParams().get('fromBill');
  const bill = useQuery({ queryKey: ['document', orgId, fromBill], enabled: !!fromBill, queryFn: () => api<FinancialDocument>(`/v1/orgs/${orgId}/purchases/documents/${fromBill}`) });
  if (fromBill && bill.error) return <Alert title="Bill not found">{(bill.error as Error).message}</Alert>;
  if (fromBill && !bill.data) return <p className="text-sm text-fg-muted">Loading…</p>;
  return <RecurringBillForm fromBill={bill.data} />;
}

export default function NewRecurringBillPage() {
  return (
    <>
      <PageHeader title="New recurring bill" description="A vendor bill made again every month, quarter or year. Each bill is checked like one entered by hand, and the first one is checked now, before saving." />
      <Suspense fallback={<p className="text-sm text-fg-muted">Loading…</p>}>
        <NewRecurringBill />
      </Suspense>
    </>
  );
}
