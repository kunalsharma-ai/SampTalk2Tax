'use client';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { DashboardBuilder } from '@/components/dashboards/dashboard-builder';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import type { AiStatus, Catalogue, DashboardDetail } from '@/lib/dashboards';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

export default function EditDashboardPage() {
  const { org, orgId } = useOrg();
  const { dashboardId } = useParams<{ dashboardId: string }>();
  const cat = useQuery({ queryKey: ['dashboard-catalogue', orgId], queryFn: () => api<Catalogue>(`/v1/orgs/${orgId}/dashboards/catalogue`), enabled: !!org });
  const ai = useQuery({ queryKey: ['dashboard-ai', orgId], queryFn: () => api<AiStatus>(`/v1/orgs/${orgId}/dashboards/ai-status`), enabled: !!org });
  const d = useQuery({ queryKey: ['dashboard', orgId, dashboardId, null], queryFn: () => api<DashboardDetail>(`/v1/orgs/${orgId}/dashboards/${dashboardId}`), enabled: !!org });
  return (
    <>
      <PageHeader title={d.data ? `Edit ${d.data.number} · ${d.data.name}` : 'Edit dashboard'} />
      <ErrorAlert title="Could not load the dashboard" error={cat.error ?? d.error} />
      {cat.data && d.data && org ? <DashboardBuilder key={d.data.version} orgId={orgId} catalogue={cat.data} dashboard={d.data} ai={ai.data} canDraft={can(org.role, 'dashboards.manage')} /> : null}
    </>
  );
}
