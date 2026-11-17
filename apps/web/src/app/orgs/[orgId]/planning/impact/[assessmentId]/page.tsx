'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { ImpactBuilder } from '@/components/impact/impact-builder';
import { ImpactResults } from '@/components/impact/impact-results';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import type { AssessmentDetail } from '@/lib/impact';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

/** A saved business impact assessment, re-run on the latest books. */
export default function ImpactAssessmentPage() {
  const { org, orgId } = useOrg();
  const { assessmentId } = useParams<{ assessmentId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['impact-assessment', orgId, assessmentId], queryFn: () => api<AssessmentDetail>(`/v1/orgs/${orgId}/impact/assessments/${assessmentId}`) });
  const del = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/impact/assessments/${assessmentId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['impact-assessments', orgId] });
      router.push(`/orgs/${orgId}/planning/impact`);
    },
  });
  const toTwin = useMutation({ mutationFn: () => api<{ scenarioId: string }>(`/v1/orgs/${orgId}/impact/assessments/${assessmentId}/scenario`, { method: 'POST' }), onSuccess: (r) => router.push(`/orgs/${orgId}/planning/twin/${r.scenarioId}`) });
  if (!org) return null;
  const s = q.data;
  const manage = can(org.role, 'scenarios.manage');
  return (
    <>
      <PageHeader
        title={s ? s.name : 'Impact assessment'}
        description={s ? `${s.number}${s.description ? ` · ${s.description.replace(/\.$/, '')}` : ''}. Re-run on the latest posted books every time it is opened.` : undefined}
        actions={
          <>
            {manage && s?.result ? <Button variant="secondary" loading={toTwin.isPending} onClick={() => toTwin.mutate()}>Open as a twin scenario</Button> : null}
            {manage && s ? <Button variant="ghost" onClick={() => confirm(`Delete the assessment "${s.name}"?`) && del.mutate()}>Delete</Button> : null}
            <Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/planning/impact`}>Business impact</Link>
          </>
        }
      />
      <ErrorAlert title="Could not load the assessment" error={q.error ?? del.error ?? toTwin.error} />
      {s ? (
        <div className="space-y-4">
          {s.problem ? <Alert title={s.problem.message}>{s.problem.issues.length ? <ul className="list-inside list-disc">{s.problem.issues.map((i) => <li key={i}>{i}</li>)}</ul> : null}</Alert> : null}
          {manage ? (
            <ImpactBuilder key={s.id} orgId={orgId} assessmentId={s.id} canManage init={{ name: s.name, description: s.description ?? '', baselineMonths: s.baselineMonths, horizonMonths: s.horizonMonths, changes: s.changes }} initialResult={s.result ? { ...s.result, currency: s.currency, actual: s.actual } : null} />
          ) : null}
          {!manage && s.result ? <ImpactResults r={s.result} actual={s.actual} currency={s.currency} /> : null}
        </div>
      ) : (
        <p className="text-sm text-fg-muted">Loading…</p>
      )}
    </>
  );
}
