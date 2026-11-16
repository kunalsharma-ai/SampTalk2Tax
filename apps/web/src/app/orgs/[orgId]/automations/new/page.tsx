'use client';
import { useQuery } from '@tanstack/react-query';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { WorkflowEditor } from '@/components/workflows/editor';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/org';
import type { Catalogue } from '@/lib/workflows';

export default function NewWorkflowPage() {
  const { org, orgId } = useOrg();
  const cat = useQuery({ queryKey: ['workflow-catalogue', orgId], queryFn: () => api<Catalogue>(`/v1/orgs/${orgId}/workflows/catalogue`), enabled: !!org });
  return (
    <>
      <PageHeader title="New workflow" description="When something happens, and only if the conditions hold, do these things." />
      <ErrorAlert title="Could not load the builder" error={cat.error} />
      {cat.data ? <WorkflowEditor orgId={orgId} catalogue={cat.data} /> : null}
    </>
  );
}
