'use client';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { SimulationBuilder } from '@/components/disasters/simulation-builder';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import type { StressResponse } from '@/lib/disasters';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

/** A new disaster simulation, empty or started from one of the standard stress tests. */
export default function NewDisasterPage() {
  return (
    <Suspense fallback={null}>
      <NewDisaster />
    </Suspense>
  );
}

function NewDisaster() {
  const { org, orgId } = useOrg();
  const sp = useSearchParams();
  const test = sp.get('test');
  const horizon = Number(sp.get('horizon') ?? 12) || 12;
  const q = useQuery({ queryKey: ['disaster-stress', orgId, horizon], queryFn: () => api<StressResponse>(`/v1/orgs/${orgId}/disasters/stress-tests?baselineMonths=6&horizonMonths=${horizon}`), enabled: !!test });
  if (!org) return null;
  const t = test ? q.data?.tests.find((x) => x.key === test) : null;
  if (test && !q.data && !q.error) return <p className="text-sm text-fg-muted">Loading the stress test…</p>;
  return (
    <>
      <PageHeader
        title={t ? t.title : 'New disaster simulation'}
        description={t ? t.description : 'Combine shocks, run them against the posted books, and save the simulation to come back to.'}
        actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/planning/disasters`}>Disaster simulation</Link>}
      />
      <SimulationBuilder orgId={orgId} canManage={can(org.role, 'scenarios.manage')} init={{ name: t ? t.title : '', description: t ? t.description : '', baselineMonths: 6, horizonMonths: horizon, shocks: t ? t.shocks.map((s) => ({ month: 1, ...s })) : [] }} />
    </>
  );
}
