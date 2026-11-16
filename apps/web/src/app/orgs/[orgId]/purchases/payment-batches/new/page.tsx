'use client';
import { useQuery } from '@tanstack/react-query';
import { Alert } from '@talk2tax/ui';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { BatchForm } from '@/components/purchases/batch-form';
import { api } from '@/lib/api';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';
import type { PaymentSchedule } from '@/lib/payment-schedule';

function NewBatch() {
  const { orgId } = useOrg();
  const upTo = useSearchParams().get('plannedUpTo');
  const s = useQuery({ queryKey: ['payment-schedule', orgId, 'batch', upTo], enabled: !!upTo, queryFn: () => api<PaymentSchedule>(`/v1/orgs/${orgId}/purchases/payment-schedule`) });
  if (!upTo) return <BatchForm />;
  if (s.error) return <Alert title="Could not load the payment schedule">{(s.error as Error).message}</Alert>;
  if (!s.data) return <p className="text-sm text-fg-muted">Loading…</p>;
  const planned = s.data.bills.filter((b) => b.plan && b.plan.payDate <= upTo && !b.inBatch);
  const items = Object.fromEntries(planned.map((b) => [b.id, b.plan!.amount]));
  const paymentDate = planned.reduce((d, b) => (b.plan!.payDate > d ? b.plan!.payDate : d), s.data.today);
  return <BatchForm preset={{ paymentDate, items, memo: `Bills planned up to ${date(upTo)}` }} />;
}

export default function NewPaymentBatchPage() {
  return (
    <Suspense fallback={<p className="text-sm text-fg-muted">Loading…</p>}>
      <NewBatch />
    </Suspense>
  );
}
