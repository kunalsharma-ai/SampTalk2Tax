'use client';
import { useQuery } from '@tanstack/react-query';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PolicyEditor } from '@/components/policies/policy-editor';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { useOrg } from '@/lib/org';
import type { AiStatus, PolicyCatalogue } from '@/lib/policies';
import { can } from '@/lib/types';

export default function NewPolicyPage() {
  const { org, orgId } = useOrg();
  const cat = useQuery({ queryKey: ['policy-catalogue', orgId], queryFn: () => api<PolicyCatalogue>(`/v1/orgs/${orgId}/policies/catalogue`), enabled: !!org });
  const ai = useQuery({ queryKey: ['policy-ai', orgId], queryFn: () => api<AiStatus>(`/v1/orgs/${orgId}/policies/ai-status`), enabled: !!org });
  return (
    <>
      <PageHeader title="New policy" description="The policy in words, the rules that enforce it, and tests that show the rules do what the words say." />
      <ErrorAlert title="Could not load the policy editor" error={cat.error} />
      {cat.data && org ? <PolicyEditor orgId={orgId} catalogue={cat.data} ai={ai.data} canDraft={can(org.role, 'policies.manage')} /> : null}
    </>
  );
}
