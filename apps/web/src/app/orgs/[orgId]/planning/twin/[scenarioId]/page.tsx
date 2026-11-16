'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { ScenarioBuilder } from '@/components/twin/scenario-builder';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/org';
import type { Scenario } from '@/lib/twin';
import { can } from '@/lib/types';

export default function ScenarioPage() {
  const { org, orgId } = useOrg();
  const { scenarioId } = useParams<{ scenarioId: string }>();
  const router = useRouter();
  const q = useQuery({ queryKey: ['twin-scenario', orgId, scenarioId], queryFn: () => api<{ scenario: Scenario }>(`/v1/orgs/${orgId}/twin/scenarios/${scenarioId}`) });
  const del = useMutation({ mutationFn: () => api(`/v1/orgs/${orgId}/twin/scenarios/${scenarioId}`, { method: 'DELETE' }), onSuccess: () => router.push(`/orgs/${orgId}/planning/twin`) });
  if (!org) return null;
  const manage = can(org.role, 'scenarios.manage');
  const s = q.data?.scenario;
  return (
    <>
      <PageHeader
        title={s?.name ?? 'Scenario'}
        description={s?.description ?? 'A saved what-if scenario, re-run against the latest actual figures.'}
        actions={
          <>
            {manage && s ? <Button variant="ghost" onClick={() => confirm(`Delete the scenario "${s.name}"?`) && del.mutate()}>Delete</Button> : null}
            <Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/planning/twin`}>All scenarios</Link>
          </>
        }
      />
      <ErrorAlert title="Could not load the scenario" error={q.error ?? del.error} />
      {s ? <ScenarioBuilder key={s.updatedAt} orgId={orgId} scenarioId={s.id} canManage={manage} initial={s} /> : null}
    </>
  );
}
