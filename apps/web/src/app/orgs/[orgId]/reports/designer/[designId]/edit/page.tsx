'use client';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { ReportBuilder } from '@/components/report-designer/report-builder';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/org';
import type { AiStatus, Catalogue, DesignDetail } from '@/lib/report-designer';

export default function EditReportDesignPage() {
  const { org, orgId } = useOrg();
  const { designId } = useParams<{ designId: string }>();
  const cat = useQuery({ queryKey: ['report-catalogue', orgId], queryFn: () => api<Catalogue>(`/v1/orgs/${orgId}/report-designer/catalogue`), enabled: !!org });
  const ai = useQuery({ queryKey: ['report-ai', orgId], queryFn: () => api<AiStatus>(`/v1/orgs/${orgId}/report-designer/ai-status`), enabled: !!org });
  const d = useQuery({ queryKey: ['report-design', orgId, designId], queryFn: () => api<DesignDetail>(`/v1/orgs/${orgId}/report-designer/designs/${designId}`), enabled: !!org });
  return (
    <>
      <PageHeader title={d.data ? `Edit ${d.data.number} · ${d.data.name}` : 'Edit report design'} description="Reports already produced keep the layout they were produced with." />
      <ErrorAlert title="Could not load the report design" error={cat.error ?? d.error} />
      {cat.data && d.data && org ? <ReportBuilder key={d.data.version} orgId={orgId} catalogue={cat.data} design={d.data} ai={ai.data} /> : null}
    </>
  );
}
