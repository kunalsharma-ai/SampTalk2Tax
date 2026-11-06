'use client';
import { useQuery } from '@tanstack/react-query';
import { Alert } from '@talk2tax/ui';
import { useParams } from 'next/navigation';
import { TemplateForm } from '@/components/journal-templates/template-form';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import type { TemplateDetail } from '@/lib/journal-templates';
import { useOrg } from '@/lib/org';

export default function EditJournalTemplatePage() {
  const { orgId } = useOrg();
  const { templateId } = useParams<{ templateId: string }>();
  const q = useQuery({ queryKey: ['journal-template', orgId, templateId], queryFn: () => api<TemplateDetail>(`/v1/orgs/${orgId}/journal-templates/${templateId}`) });
  if (q.error) return <Alert title="Template not found">{(q.error as Error).message}</Alert>;
  if (!q.data) return <p className="text-sm text-fg-muted">Loading…</p>;
  return (
    <>
      <PageHeader title={`Edit ${q.data.reference}`} description="Changes apply to journals made from now on. Journals already made keep their lines." />
      <TemplateForm existing={q.data} />
    </>
  );
}
