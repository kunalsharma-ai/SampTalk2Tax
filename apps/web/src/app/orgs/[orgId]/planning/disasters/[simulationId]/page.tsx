'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { DisasterResults } from '@/components/disasters/disaster-results';
import { SimulationBuilder } from '@/components/disasters/simulation-builder';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import type { SimulationDetail } from '@/lib/disasters';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

/** A saved disaster simulation, re-run on the latest books. */
export default function DisasterSimulationPage() {
  const { org, orgId } = useOrg();
  const { simulationId } = useParams<{ simulationId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['disaster-simulation', orgId, simulationId], queryFn: () => api<SimulationDetail>(`/v1/orgs/${orgId}/disasters/simulations/${simulationId}`) });
  const del = useMutation({ mutationFn: () => api(`/v1/orgs/${orgId}/disasters/simulations/${simulationId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['disaster-simulations', orgId] });
      router.push(`/orgs/${orgId}/planning/disasters`);
    },
  });
  const toTwin = useMutation({ mutationFn: () => api<{ scenarioId: string }>(`/v1/orgs/${orgId}/disasters/simulations/${simulationId}/scenario`, { method: 'POST' }), onSuccess: (r) => router.push(`/orgs/${orgId}/planning/twin/${r.scenarioId}`) });
  if (!org) return null;
  const s = q.data;
  const manage = can(org.role, 'scenarios.manage');
  return (
    <>
      <PageHeader
        title={s ? s.name : 'Disaster simulation'}
        description={s ? `${s.number}${s.description ? ` · ${s.description.replace(/\.$/, '')}` : ''}. Re-run on the latest posted books every time it is opened.` : undefined}
        actions={
          <>
            {manage && s?.result ? <Button variant="secondary" loading={toTwin.isPending} onClick={() => toTwin.mutate()}>Open as a twin scenario</Button> : null}
            {manage && s ? <Button variant="ghost" onClick={() => confirm(`Delete the simulation "${s.name}"?`) && del.mutate()}>Delete</Button> : null}
            <Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/planning/disasters`}>Disaster simulation</Link>
          </>
        }
      />
      <ErrorAlert title="Could not load the simulation" error={q.error ?? del.error ?? toTwin.error} />
      {s ? (
        <div className="space-y-4">
          {s.problem ? (
            <Alert title={s.problem.message}>{s.problem.issues.length ? <ul className="list-inside list-disc">{s.problem.issues.map((i) => <li key={i}>{i}</li>)}</ul> : null}</Alert>
          ) : null}
          {manage ? (
            <SimulationBuilder key={s.id} orgId={orgId} simulationId={s.id} canManage init={{ name: s.name, description: s.description ?? '', baselineMonths: s.baselineMonths, horizonMonths: s.horizonMonths, shocks: s.shocks }} initialResult={s.result ? { ...s.result, currency: s.currency, actual: s.actual } : null} />
          ) : null}
          {!manage && s.result ? <DisasterResults r={s.result} actual={s.actual} currency={s.currency} /> : null}
        </div>
      ) : (
        <p className="text-sm text-fg-muted">Loading…</p>
      )}
    </>
  );
}
