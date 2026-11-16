'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { ScheduleForm } from '@/components/deferrals/schedule-form';
import { PageHeader } from '@/components/shell';
import { useOrg } from '@/lib/org';

export default function NewSchedulePage() {
  return (
    <Suspense>
      <NewSchedule />
    </Suspense>
  );
}

function NewSchedule() {
  const { org, orgId } = useOrg();
  const router = useRouter();
  const qc = useQueryClient();
  const kind = useSearchParams().get('kind') === 'DEFERRED_REVENUE' ? 'DEFERRED_REVENUE' : 'PREPAID_EXPENSE';
  if (!org) return null;
  return (
    <>
      <PageHeader
        title={kind === 'PREPAID_EXPENSE' ? 'Add a prepaid expense' : 'Add deferred revenue'}
        description={kind === 'PREPAID_EXPENSE' ? 'Something paid for in advance: it sits in a prepaid account and moves to expense over the months it covers.' : 'Money received for work or a service still to be delivered: it sits as a liability and becomes revenue over the months it covers.'}
      />
      <ScheduleForm
        key={kind}
        orgId={orgId}
        mode={{ kind: 'new', deferral: kind }}
        onSaved={(s) => {
          void qc.invalidateQueries({ queryKey: ['deferrals', orgId] });
          router.push(`/orgs/${orgId}/deferrals/${s.id}`);
        }}
      />
    </>
  );
}
