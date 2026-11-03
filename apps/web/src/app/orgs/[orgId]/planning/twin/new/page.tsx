'use client';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { PageHeader } from '@/components/shell';
import { ScenarioBuilder } from '@/components/twin/scenario-builder';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/org';
import type { Template } from '@/lib/twin';
import { can } from '@/lib/types';

export default function NewScenarioPage() {
  return (
    <Suspense>
      <NewScenario />
    </Suspense>
  );
}

function NewScenario() {
  const { org, orgId } = useOrg();
  const key = useSearchParams().get('template');
  const templates = useQuery({ queryKey: ['twin-templates', orgId], queryFn: () => api<Template[]>(`/v1/orgs/${orgId}/twin/templates`), enabled: !!key });
  if (!org || (key && !templates.data)) return null;
  const t = key ? templates.data?.find((x) => x.key === key) : undefined;
  return (
    <>
      <PageHeader title={t ? `New scenario: ${t.name}` : 'New scenario'} description="Add changes and watch them play out against your actual figures." actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/planning/twin`}>All scenarios</Link>} />
      <ScenarioBuilder orgId={orgId} canManage={can(org.role, 'scenarios.manage')} initial={{ name: t?.name ?? '', description: t?.description ?? null, baselineMonths: 6, horizonMonths: 12, drivers: t?.drivers ?? [] }} />
    </>
  );
}
