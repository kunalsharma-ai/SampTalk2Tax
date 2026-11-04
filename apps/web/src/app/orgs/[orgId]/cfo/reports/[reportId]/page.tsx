'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, CardHeader, Field, Textarea } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { FindingCard, HealthCard, Recommendations } from '@/components/cfo/finding';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { KIND, type CfoAi, type CfoReport } from '@/lib/cfo';
import { date, dateTime } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

/**
 * A board pack or investor update: the assessment as it stood when the pack was made, the
 * commentary of the people preparing it, and an AI executive summary that is kept only when
 * every figure in it is in the pack. A final pack is a record and cannot be changed.
 */
export default function CfoReportPage() {
  const { org, orgId } = useOrg();
  const { reportId } = useParams<{ reportId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const base = `/v1/orgs/${orgId}/cfo/reports/${reportId}`;
  const key = ['cfo-report', orgId, reportId];
  const q = useQuery({ queryKey: key, queryFn: () => api<CfoReport>(base), refetchInterval: (s) => (s.state.data?.ai.status === 'RUNNING' ? 1500 : false) });
  const ai = useQuery({ queryKey: ['cfo-ai', orgId], queryFn: () => api<CfoAi>(`/v1/orgs/${orgId}/cfo/ai`) });
  const [commentary, setCommentary] = useState('');
  useEffect(() => setCommentary(q.data?.commentary ?? ''), [q.data?.commentary]);
  const done = (r: CfoReport) => {
    qc.setQueryData(key, r);
    void qc.invalidateQueries({ queryKey: ['cfo-reports', orgId] });
  };
  const save = useMutation({ mutationFn: () => api<CfoReport>(`${base}/commentary`, { method: 'PUT', body: { commentary: commentary || null } }), onSuccess: done });
  const refresh = useMutation({ mutationFn: () => api<CfoReport>(`${base}/refresh`, { method: 'POST' }), onSuccess: done });
  const summarise = useMutation({ mutationFn: () => api<CfoReport>(`${base}/summary`, { method: 'POST' }), onSuccess: done });
  const finalise = useMutation({ mutationFn: () => api<CfoReport>(`${base}/finalise`, { method: 'POST' }), onSuccess: done });
  const remove = useMutation({ mutationFn: () => api(base, { method: 'DELETE' }), onSuccess: () => router.push(`/orgs/${orgId}/cfo`) });
  if (!org) return null;
  const r = q.data;
  const prepare = can(org.role, 'cfo.reports');
  const draft = r?.status === 'DRAFT';
  const editable = prepare && draft;
  const running = r?.ai.status === 'RUNNING';
  const c = r?.assessment.currency ?? org.functionalCurrency;
  return (
    <>
      <PageHeader
        title={r?.title ?? 'CFO pack'}
        description={r ? KIND[r.kind].help : undefined}
        actions={
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <Button variant="ghost" onClick={() => window.print()}>Print</Button>
            {editable ? <Button variant="ghost" onClick={() => confirm(`Delete the draft "${r!.title}"?`) && remove.mutate()}>Delete</Button> : null}
            <Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/cfo`}>Virtual CFO</Link>
          </div>
        }
      />
      <ErrorAlert title="Could not load the pack" error={q.error ?? save.error ?? refresh.error ?? summarise.error ?? finalise.error ?? remove.error} />
      {r ? (
        <div className="space-y-4">
          <Card className="p-4 print:hidden" aria-label="Pack status">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {draft ? <Badge>Draft</Badge> : <Badge tone="positive">Final</Badge>}
                <span className="text-fg-muted">
                  Prepared by {r.createdBy} on {date(r.createdAt.slice(0, 10))}; figures to {date(r.assessment.asOf)}
                  {r.finalisedBy ? `; finalised by ${r.finalisedBy} on ${dateTime(r.finalisedAt!)}` : ''}
                </span>
              </div>
              {editable ? (
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" loading={refresh.isPending} disabled={running} onClick={() => refresh.mutate()}>Refresh figures</Button>
                  <Button disabled={running} loading={finalise.isPending} onClick={() => confirm('Finalise this pack? It cannot be changed afterwards.') && finalise.mutate()}>Finalise</Button>
                </div>
              ) : null}
            </div>
          </Card>

          <Card className="p-4" aria-label="Executive summary">
            <CardHeader
              title="Executive summary"
              description="Written by AI from the figures in this pack only. A summary that quotes any figure not in the pack is rejected."
              actions={
                editable ? (
                  <Button size="sm" variant="secondary" className="print:hidden" loading={summarise.isPending || running} disabled={!ai.data?.available || running} title={ai.data?.reason ?? undefined} onClick={() => summarise.mutate()}>
                    {r.ai.summary ? 'Write again with AI' : 'Write with AI'}
                  </Button>
                ) : null
              }
            />
            {running ? <p className="text-sm text-fg-muted" role="status">The AI is writing the summary…</p> : null}
            {r.ai.status === 'DONE' && r.ai.summary ? (
              <>
                <div className="whitespace-pre-wrap text-sm text-fg">{r.ai.summary}</div>
                <p className="mt-2 text-xs text-fg-muted">AI summary, every figure checked against the pack · {r.ai.servedModel ?? r.ai.model} · asked by {r.ai.startedBy}{r.ai.finishedAt ? ` on ${dateTime(r.ai.finishedAt)}` : ''}</p>
              </>
            ) : null}
            {r.ai.status === 'FAILED' ? <Alert tone="warning" title="No summary kept">{r.ai.errorMessage}</Alert> : null}
            {r.ai.status === 'NONE' ? <p className="text-sm text-fg-muted">{editable ? (ai.data?.available ? 'No summary yet.' : (ai.data?.reason ?? 'AI is not available.')) : 'No AI summary.'}</p> : null}
          </Card>

          <Card className="p-4" aria-label="Commentary">
            <CardHeader title="Commentary" description="Your own words for the board or investors: context the books cannot give." />
            {editable ? (
              <div className="space-y-2 print:hidden">
                <Field label="Commentary">{(p) => <Textarea {...p} rows={5} maxLength={10000} value={commentary} onChange={(e) => setCommentary(e.target.value)} />}</Field>
                <Button size="sm" variant="secondary" loading={save.isPending} disabled={commentary === (r.commentary ?? '')} onClick={() => save.mutate()}>Save commentary</Button>
              </div>
            ) : null}
            {!editable || commentary === '' ? <p className={`whitespace-pre-wrap text-sm ${r.commentary ? 'text-fg' : 'text-fg-muted'} ${editable ? 'hidden print:block' : ''}`}>{r.commentary ?? 'No commentary.'}</p> : <p className="hidden whitespace-pre-wrap text-sm print:block">{r.commentary}</p>}
          </Card>

          <HealthCard health={r.assessment.health} headline={r.assessment.headline} />
          <Card className="p-4">
            <CardHeader title={r.kind === 'BOARD' ? 'Decisions and actions for the board' : 'Priorities'} />
            <Recommendations items={r.assessment.recommendations} orgId={orgId} />
          </Card>
          <section aria-label="Sections" className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {r.assessment.findings.map((f) => <FindingCard key={f.key} f={f} currency={c} orgId={orgId} />)}
          </section>
        </div>
      ) : null}
    </>
  );
}
