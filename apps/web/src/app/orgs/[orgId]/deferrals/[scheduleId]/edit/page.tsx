'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { ScheduleForm } from '@/components/deferrals/schedule-form';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import type { ScheduleDetail } from '@/lib/deferrals';
import { useOrg } from '@/lib/org';

export default function EditSchedulePage() {
  const { org, orgId } = useOrg();
  const { scheduleId } = useParams<{ scheduleId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['deferral', orgId, scheduleId], queryFn: () => api<ScheduleDetail>(`/v1/orgs/${orgId}/deferrals/${scheduleId}`) });
  if (!org) return null;
  return (
    <>
      <PageHeader title={q.data ? `Change ${q.data.reference} ${q.data.name}` : 'Change schedule'} />
      <ErrorAlert title="Could not load the schedule" error={q.error} />
      {q.data ? (
        <ScheduleForm
          orgId={orgId}
          mode={{ kind: 'edit', schedule: q.data }}
          onSaved={(s) => {
            qc.setQueryData(['deferral', orgId, scheduleId], s);
            void qc.invalidateQueries({ queryKey: ['deferrals', orgId] });
            router.push(`/orgs/${orgId}/deferrals/${s.id}`);
          }}
        />
      ) : null}
    </>
  );
}
