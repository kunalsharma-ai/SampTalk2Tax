'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, Textarea } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { Commentary, ReportView } from '@/components/report-designer/report-view';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useOrg } from '@/lib/org';
import type { AiStatus, CommentaryEntry, ReportDetail } from '@/lib/report-designer';
import { monthLabel } from '@/lib/twin';
import { can } from '@/lib/types';

/**
 * A report produced for a month. Its figures are frozen. While it is a draft the commentary can be
 * written or edited (by a person, or by the AI from the report's figures); once final, nothing in
 * it can change.
 */
export default function ReportPage() {
  const { org, orgId } = useOrg();
  const { reportId } = useParams<{ reportId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const key = ['report', orgId, reportId];
  const q = useQuery({ queryKey: key, queryFn: () => api<ReportDetail>(`/v1/orgs/${orgId}/report-designer/reports/${reportId}`), enabled: !!org });
  const ai = useQuery({ queryKey: ['report-ai', orgId], queryFn: () => api<AiStatus>(`/v1/orgs/${orgId}/report-designer/ai-status`), enabled: !!org });
  const done = (r: ReportDetail) => {
    qc.setQueryData(key, r);
    void qc.invalidateQueries({ queryKey: ['report-design', orgId, r.designId] });
  };
  const rewrite = useMutation({ mutationFn: (v: number) => api<ReportDetail>(`/v1/orgs/${orgId}/report-designer/reports/${reportId}/write-commentary`, { method: 'POST', body: { baseVersion: v } }), onSuccess: done });
  const finalise = useMutation({ mutationFn: (v: number) => api<ReportDetail>(`/v1/orgs/${orgId}/report-designer/reports/${reportId}/finalise`, { method: 'POST', body: { baseVersion: v } }), onSuccess: done });
  const del = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/report-designer/reports/${reportId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['report-design', orgId, r?.designId] });
      router.push(`/orgs/${orgId}/reports/designer/${r?.designId}`);
    },
  });
  const r = q.data;
  if (!org) return null;
  const editable = !!r && r.status === 'DRAFT' && can(org.role, 'reports.design');
  const missing = r ? r.commentary.filter((c) => !c.text.trim()).length : 0;
  return (
    <>
      <PageHeader
        title={r ? `${r.number} · ${r.title ?? r.designName}` : 'Report'}
        description={r ? `${monthLabel(r.month)}${r.inProgress ? ' (month not finished when produced)' : ''}. Figures from the posted books, frozen when the report was produced by ${r.createdBy}.` : undefined}
        actions={
          r ? (
            <>
              {r.status === 'FINAL' ? <Badge tone="positive">Final</Badge> : <Badge tone="warning">Draft</Badge>}
              <Button variant="secondary" className="print:hidden" onClick={() => window.print()}>Print</Button>
              {editable ? <Button variant="ghost" className="print:hidden" onClick={() => confirm(`Delete ${r.number}?`) && del.mutate()}>Delete</Button> : null}
            </>
          ) : null
        }
      />
      <ErrorAlert title="Could not load the report" error={q.error ?? del.error} />
      {r ? (
        <div className="flex flex-col gap-4">
          {r.status === 'FINAL' ? (
            <Alert tone="positive" title="Final">
              Finalised by {r.finalisedBy} on {r.finalisedAt ? dateTime(r.finalisedAt) : ''}. A final report can never be changed or deleted.
            </Alert>
          ) : editable ? (
            <Card className="flex flex-col gap-3 p-5 print:hidden">
              <p className="text-sm">
                This is a draft. {missing ? `${missing} commentary section${missing === 1 ? ' still needs' : 's still need'} writing. ` : 'Every commentary section is written. '}
                Numbers in commentary are checked against the figures in this report.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {r.commentary.length ? (
                  <Button variant="secondary" size="sm" disabled={!ai.data?.available} loading={rewrite.isPending} onClick={() => confirm('The AI will rewrite every commentary section from the figures, replacing what is there. Continue?') && rewrite.mutate(r.version)}>
                    Write the commentary with AI
                  </Button>
                ) : null}
                <Button size="sm" disabled={missing > 0} loading={finalise.isPending} onClick={() => confirm('Finalise this report? It can never be changed or deleted afterwards.') && finalise.mutate(r.version)}>
                  Finalise
                </Button>
                {ai.data && !ai.data.available ? <span className="text-xs text-fg-muted">{ai.data.reason}</span> : null}
              </div>
              <ErrorAlert title="The AI did not write the commentary" error={rewrite.error} />
              <ErrorAlert title="The report was not finalised" error={finalise.error} />
            </Card>
          ) : null}
          <ReportView
            layout={r.layout}
            widgets={r.widgets}
            currency={r.currency}
            commentary={r.commentary}
            renderCommentary={(c) => (editable ? <CommentaryEditor key={`${c.section}-${r.version}`} orgId={orgId} report={r} entry={c} onSaved={done} /> : (
              <Card className="p-5">
                <Commentary entry={c} />
              </Card>
            ))}
          />
          <details className="text-sm print:hidden">
            <summary className="cursor-pointer text-xs text-fg-muted">The figures the commentary must stick to</summary>
            <pre className="mt-2 whitespace-pre-wrap rounded-[var(--t2t-radius-md)] border border-line bg-surface-hover p-3 text-xs">{r.facts}</pre>
          </details>
          <p className="text-xs text-fg-muted print:hidden">
            From the design <Link className="text-accent hover:underline" href={`/orgs/${orgId}/reports/designer/${r.designId}`}>{r.designName}</Link>. <Link className="text-accent hover:underline" href={`/orgs/${orgId}/reports/kpis`}>How each KPI is worked out</Link>
          </p>
        </div>
      ) : !q.error ? (
        <p className="text-sm text-fg-muted">Loading…</p>
      ) : null}
    </>
  );
}

function CommentaryEditor({ orgId, report, entry, onSaved }: { orgId: string; report: ReportDetail; entry: CommentaryEntry; onSaved: (r: ReportDetail) => void }) {
  const [text, setText] = useState(entry.text);
  const save = useMutation({ mutationFn: () => api<ReportDetail>(`/v1/orgs/${orgId}/report-designer/reports/${report.id}/commentary`, { method: 'PUT', body: { section: entry.section, text, baseVersion: report.version } }), onSuccess: onSaved });
  const n = `Commentary ${entry.section + 1}`;
  return (
    <Card className="flex flex-col gap-2 p-5">
      <p className="text-xs text-fg-muted">
        {entry.instruction}
        {entry.text ? <> · <Badge tone={entry.source === 'AI' ? 'violet' : 'neutral'}>{entry.source === 'AI' ? 'Written by the AI' : 'Written by a person'}</Badge></> : null}
      </p>
      <Textarea aria-label={`${n} text`} rows={4} value={text} maxLength={4000} onChange={(e) => setText(e.target.value)} placeholder="Write the commentary from the figures in this report." />
      {entry.issues.some((i) => i !== 'Not written yet') ? (
        <Alert tone="warning">
          <ul className="list-inside list-disc">{entry.issues.filter((i) => i !== 'Not written yet').map((i) => <li key={i}>{i}</li>)}</ul>
        </Alert>
      ) : null}
      <ErrorAlert title="The commentary was not saved" error={save.error} />
      <div>
        <Button size="sm" variant="secondary" disabled={text === entry.text} loading={save.isPending} onClick={() => save.mutate()}>
          Save {n.toLowerCase()}
        </Button>
      </div>
    </Card>
  );
}
