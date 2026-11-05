'use client';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PolicyEditor } from '@/components/policies/policy-editor';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/org';
import type { AiStatus, PolicyCatalogue, PolicyDetail } from '@/lib/policies';
import { can } from '@/lib/types';

export default function EditPolicyPage() {
  const { org, orgId } = useOrg();
  const { policyId } = useParams<{ policyId: string }>();
  const cat = useQuery({ queryKey: ['policy-catalogue', orgId], queryFn: () => api<PolicyCatalogue>(`/v1/orgs/${orgId}/policies/catalogue`), enabled: !!org });
  const ai = useQuery({ queryKey: ['policy-ai', orgId], queryFn: () => api<AiStatus>(`/v1/orgs/${orgId}/policies/ai-status`), enabled: !!org });
  const p = useQuery({ queryKey: ['policy', orgId, policyId], queryFn: () => api<PolicyDetail>(`/v1/orgs/${orgId}/policies/${policyId}`), enabled: !!org });
  return (
    <>
      <PageHeader title={p.data ? `Edit ${p.data.number} · ${p.data.name}` : 'Edit policy'} description={p.data ? `Saving makes version ${p.data.version + 1}, which needs approval before its rules run.` : undefined} />
      <ErrorAlert title="Could not load the policy" error={cat.error ?? p.error} />
      {cat.data && p.data && org ? <PolicyEditor key={p.data.version} orgId={orgId} catalogue={cat.data} policy={p.data} ai={ai.data} canDraft={can(org.role, 'policies.manage')} /> : null}
    </>
  );
}
