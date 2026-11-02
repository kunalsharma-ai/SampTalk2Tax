'use client';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { WorkflowEditor } from '@/components/workflows/editor';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/org';
import type { Catalogue, Workflow } from '@/lib/workflows';

export default function EditWorkflowPage() {
  const { org, orgId } = useOrg();
  const { workflowId } = useParams<{ workflowId: string }>();
  const cat = useQuery({ queryKey: ['workflow-catalogue', orgId], queryFn: () => api<Catalogue>(`/v1/orgs/${orgId}/workflows/catalogue`), enabled: !!org });
  const w = useQuery({ queryKey: ['workflow', orgId, workflowId], queryFn: () => api<Workflow>(`/v1/orgs/${orgId}/workflows/${workflowId}`), enabled: !!org });
  return (
    <>
      <PageHeader title={w.data ? `Edit ${w.data.name}` : 'Edit workflow'} description={w.data ? `Saving a change to what it does makes version ${w.data.version + 1}. Runs keep the version they ran.` : undefined} />
      <ErrorAlert title="Could not load the workflow" error={cat.error ?? w.error} />
      {cat.data && w.data ? <WorkflowEditor key={w.data.version} orgId={orgId} catalogue={cat.data} workflow={w.data} /> : null}
    </>
  );
}
