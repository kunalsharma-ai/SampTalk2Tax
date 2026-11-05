'use client';
import { useQuery } from '@tanstack/react-query';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { DashboardBuilder } from '@/components/dashboards/dashboard-builder';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import type { AiStatus, Catalogue } from '@/lib/dashboards';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

export default function NewDashboardPage() {
  const { org, orgId } = useOrg();
  const cat = useQuery({ queryKey: ['dashboard-catalogue', orgId], queryFn: () => api<Catalogue>(`/v1/orgs/${orgId}/dashboards/catalogue`), enabled: !!org });
  const ai = useQuery({ queryKey: ['dashboard-ai', orgId], queryFn: () => api<AiStatus>(`/v1/orgs/${orgId}/dashboards/ai-status`), enabled: !!org });
  return (
    <>
      <PageHeader title="New dashboard" />
      <ErrorAlert title="Could not load the builder" error={cat.error} />
      {cat.data && org ? <DashboardBuilder orgId={orgId} catalogue={cat.data} ai={ai.data} canDraft={can(org.role, 'dashboards.manage')} /> : null}
    </>
  );
}
