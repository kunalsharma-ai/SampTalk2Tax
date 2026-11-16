'use client';
import { useQuery } from '@tanstack/react-query';
import { Alert } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { DecisionForm } from '@/components/decisions/decision-form';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import type { DecisionDraft, DecisionMeta } from '@/lib/decisions';
import { today } from '@/lib/format';
import { useOrg } from '@/lib/org';

function NewDecision() {
  const { org, orgId } = useOrg();
  const router = useRouter();
  const params = useSearchParams();
  const sourceType = params.get('sourceType');
  const sourceId = params.get('sourceId');
  const fromSource = (sourceType === 'SCENARIO' || sourceType === 'RECOVERY_PLAN') && !!sourceId;
  const meta = useQuery({ queryKey: ['decision-meta', orgId], queryFn: () => api<DecisionMeta>(`/v1/orgs/${orgId}/decisions/meta`) });
  const draft = useQuery({ enabled: fromSource, queryKey: ['decision-draft', orgId, sourceType, sourceId], queryFn: () => api<DecisionDraft>(`/v1/orgs/${orgId}/decisions/draft?sourceType=${sourceType}&sourceId=${sourceId}`) });
  if (!org) return null;
  const blank: DecisionDraft = { title: '', decision: '', context: null, category: 'OTHER', tags: [], decidedOn: today(), decidedBy: null, reviewDue: null, assumptions: [{ text: '' }], outcomes: [] };
  const initial = fromSource ? draft.data : blank;
  return (
    <>
      <PageHeader
        title="Record a decision"
        description={fromSource ? `Prefilled from the ${sourceType === 'SCENARIO' ? 'approved scenario' : 'recovery plan'}. Check it, add the outcomes you expect, and record it.` : 'Write down what was decided and why, what has to be true for it to work, and what you expect to see in the books.'}
        actions={<Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/decisions`}>Decision memory</Link>}
      />
      <ErrorAlert title="Could not start the decision" error={meta.error ?? draft.error} />
      {fromSource && draft.data ? <Alert tone="accent">The source is linked to the decision, so anyone can see where it came from.</Alert> : null}
      {meta.data && initial ? (
        <div className="mt-4">
          <DecisionForm orgId={orgId} meta={meta.data} initial={initial} onSaved={(d) => router.push(`/orgs/${orgId}/decisions/${d.id}`)} />
        </div>
      ) : !meta.error && !draft.error ? (
        <p className="text-sm text-fg-muted">Loading…</p>
      ) : null}
    </>
  );
}

export default function NewDecisionPage() {
  return (
    <Suspense>
      <NewDecision />
    </Suspense>
  );
}
