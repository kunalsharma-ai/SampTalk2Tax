'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, Field, Input, Select, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { dateTime, today } from '@/lib/format';
import { recentMonths } from '@/lib/kpis';
import { useOrg } from '@/lib/org';
import type { AiStatus, DesignDetail, ReportDetail } from '@/lib/report-designer';
import { monthLabel } from '@/lib/twin';
import { can } from '@/lib/types';

/** A report design: its sections, the reports produced from it, and producing the next one. */
export default function ReportDesignPage() {
  const { org, orgId } = useOrg();
  const { designId } = useParams<{ designId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['report-design', orgId, designId], queryFn: () => api<DesignDetail>(`/v1/orgs/${orgId}/report-designer/designs/${designId}`), enabled: !!org });
  const ai = useQuery({ queryKey: ['report-ai', orgId], queryFn: () => api<AiStatus>(`/v1/orgs/${orgId}/report-designer/ai-status`), enabled: !!org });
  const months = recentMonths(today(), 13);
  const [month, setMonth] = useState(months[1] ?? months[0]!);
  const [title, setTitle] = useState('');
  const [withAi, setWithAi] = useState(true);
  const produce = useMutation({
    mutationFn: () => api<ReportDetail>(`/v1/orgs/${orgId}/report-designer/designs/${designId}/reports`, { method: 'POST', body: { month, title: title.trim() || null, writeCommentary: withAi && !!ai.data?.available } }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['report-designs', orgId] });
      void qc.invalidateQueries({ queryKey: ['report-design', orgId, designId] });
      qc.setQueryData(['report', orgId, r.id], r);
      router.push(`/orgs/${orgId}/reports/designer/reports/${r.id}`);
    },
  });
  const del = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/report-designer/designs/${designId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['report-designs', orgId] });
      router.push(`/orgs/${orgId}/reports/designer`);
    },
  });
  if (!org) return null;
  const d = q.data;
  const design = can(org.role, 'reports.design');
  return (
    <>
      <PageHeader
        title={d ? `${d.number} · ${d.name}` : 'Report design'}
        description={d?.description ?? undefined}
        actions={
          design && d ? (
            <>
              <Link className="rounded-[var(--t2t-radius-md)] border border-line px-3 py-2 text-sm font-medium hover:bg-surface-hover" href={`/orgs/${orgId}/reports/designer/${d.id}/edit`}>Edit design</Link>
              <Button variant="ghost" onClick={() => confirm(`Delete the report design "${d.name}"?`) && del.mutate()}>Delete</Button>
            </>
          ) : null
        }
      />
      <ErrorAlert title="Could not load the report design" error={q.error ?? del.error} />
      {d ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Card>
            <CardHeader title="Sections" description={`Changed by ${d.updatedBy}, ${dateTime(d.updatedAt)}.`} />
            <ol className="list-inside list-decimal px-5 pb-5 text-sm leading-7">{d.descriptions.map((x, i) => <li key={i}>{x}</li>)}</ol>
          </Card>
          <div className="flex flex-col gap-4">
            {design ? (
              <Card>
                <CardHeader title="Produce a report" description="Works out every figure for the month and freezes it in the report. The commentary is then written from those figures." />
                <form
                  className="flex flex-col gap-3 p-5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    produce.mutate();
                  }}
                >
                  <div className="grid gap-3 md:grid-cols-2">
                    <Field label="Month">{(p) => <Select {...p} value={month} onChange={(e) => setMonth(e.target.value)}>{months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}</Select>}</Field>
                    <Field label="Title (optional)">{(p) => <Input {...p} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder={d.name} />}</Field>
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={withAi && !!ai.data?.available} disabled={!ai.data?.available} onChange={(e) => setWithAi(e.target.checked)} />
                    Have the AI write the commentary
                  </label>
                  {ai.data && !ai.data.available ? <p className="text-xs text-fg-muted">{ai.data.reason} You can write the commentary yourself.</p> : null}
                  <ErrorAlert title="The report was not produced" error={produce.error} />
                  <div>
                    <Button type="submit" loading={produce.isPending}>Produce report</Button>
                  </div>
                </form>
              </Card>
            ) : null}
            <Card>
              <CardHeader title="Reports" />
              {d.reports.length ? (
                <Table aria-label="Reports">
                  <thead>
                    <tr>
                      <Th>Report</Th>
                      <Th>Month</Th>
                      <Th>Status</Th>
                      <Th>Last change</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.reports.map((r) => (
                      <Tr key={r.id}>
                        <Td>
                          <Link className="font-medium text-accent hover:underline" href={`/orgs/${orgId}/reports/designer/reports/${r.id}`}>
                            {r.number}
                          </Link>
                          {r.title ? <p className="text-xs text-fg-muted">{r.title}</p> : null}
                        </Td>
                        <Td>{monthLabel(r.month)}</Td>
                        <Td>{r.status === 'FINAL' ? <Badge tone="positive">Final</Badge> : <Badge tone="warning">Draft</Badge>}</Td>
                        <Td className="text-xs text-fg-muted">{r.updatedBy}, {dateTime(r.updatedAt)}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              ) : (
                <p className="px-5 pb-5 text-sm text-fg-muted">No reports produced yet.</p>
              )}
            </Card>
          </div>
        </div>
      ) : !q.error ? (
        <p className="text-sm text-fg-muted">Loading…</p>
      ) : null}
    </>
  );
}
