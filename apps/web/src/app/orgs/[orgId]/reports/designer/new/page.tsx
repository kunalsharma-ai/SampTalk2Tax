'use client';
import { useQuery } from '@tanstack/react-query';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { ReportBuilder } from '@/components/report-designer/report-builder';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/org';
import type { AiStatus, Catalogue } from '@/lib/report-designer';

export default function NewReportDesignPage() {
  const { org, orgId } = useOrg();
  const cat = useQuery({ queryKey: ['report-catalogue', orgId], queryFn: () => api<Catalogue>(`/v1/orgs/${orgId}/report-designer/catalogue`), enabled: !!org });
  const ai = useQuery({ queryKey: ['report-ai', orgId], queryFn: () => api<AiStatus>(`/v1/orgs/${orgId}/report-designer/ai-status`), enabled: !!org });
  return (
    <>
      <PageHeader title="New report design" />
      <ErrorAlert title="Could not load the designer" error={cat.error} />
      {cat.data && org ? <ReportBuilder orgId={orgId} catalogue={cat.data} ai={ai.data} /> : null}
    </>
  );
}
