'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, Input, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useOrg } from '@/lib/org';

interface StudioReport {
  key: string;
  name: string;
  category: string;
  question: string;
  href: string;
  exports: ('PDF' | 'XLSX' | 'CSV')[];
  savedViews: boolean;
  schedules: number;
  views: number;
  available: boolean;
  favourite: boolean;
}
interface Studio {
  categories: { key: string; name: string; reports: number }[];
  reports: StudioReport[];
  favourites: string[];
  totals: { reports: number; available: number; savedViews: number; schedules: number; designs: number };
  designs: { id: string; name: string; updatedAt: string }[];
  recentExports: { id: string; report: string; name: string; format: string; rows: number | null; by: string | null; at: string }[];
}

/** Every report in one place, searchable, with pins, views, schedules, designs and exports (RPT-001). */
export default function ReportingStudioPage() {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const key = ['report-studio', orgId];
  const studio = useQuery({ queryKey: key, queryFn: () => api<Studio>(`/v1/orgs/${orgId}/reports/studio`) });
  const pin = useMutation({
    mutationFn: ({ report, on }: { report: string; on: boolean }) => api<Studio>(`/v1/orgs/${orgId}/reports/studio/favourites/${encodeURIComponent(report)}`, { method: on ? 'PUT' : 'DELETE' }),
    onSuccess: (s) => qc.setQueryData(key, s),
  });
  const s = studio.data;
  const words = q.toLowerCase().split(' ').filter(Boolean);
  const matches = (r: StudioReport, category: string) => words.every((w) => `${r.name} ${r.question} ${category}`.toLowerCase().includes(w));
  const byKey = new Map((s?.reports ?? []).map((r) => [r.key, r]));
  const card = (r: StudioReport) => (
    <li key={r.key} className="flex items-start justify-between gap-3 px-5 py-3">
      <span className="min-w-0">
        {r.available ? (
          <Link className="font-medium text-accent hover:underline" href={`/orgs/${orgId}${r.href}`}>
            {r.name}
          </Link>
        ) : (
          <span className="font-medium text-fg-muted" title="Not open to your role">
            {r.name}
          </span>
        )}
        <span className="block text-sm text-fg-muted">{r.question}</span>
        <span className="mt-1 flex flex-wrap gap-1.5">
          {r.exports.map((f) => (
            <Badge key={f} tone="neutral">
              {f}
            </Badge>
          ))}
          {r.savedViews ? <Badge tone="neutral">{r.views === 1 ? '1 saved view' : `${r.views} saved views`}</Badge> : null}
          {r.schedules ? <Badge tone="accent">{r.schedules === 1 ? '1 schedule' : `${r.schedules} schedules`}</Badge> : null}
          {r.available ? null : <Badge tone="warning">not open to your role</Badge>}
        </span>
      </span>
      <Button
        size="sm"
        variant="ghost"
        aria-pressed={r.favourite}
        aria-label={`${r.favourite ? 'Unpin' : 'Pin'} ${r.name}`}
        disabled={pin.isPending}
        onClick={() => pin.mutate({ report: r.key, on: !r.favourite })}
      >
        {r.favourite ? '★ Pinned' : '☆ Pin'}
      </Button>
    </li>
  );
  return (
    <>
      <PageHeader
        title="Reporting studio"
        description="Every report Talk2Tax produces, in one place: find one by what you want to know, pin the ones you use, and see the saved views, schedules, designs and exports behind them."
      />
      <ErrorAlert title="Could not load the reporting studio" error={studio.error ?? pin.error} />
      {s ? (
        <div className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['Reports you can open', `${s.totals.available} of ${s.totals.reports}`],
              ['Saved views', s.totals.savedViews],
              ['Active schedules', s.totals.schedules],
              ['Report designs', s.totals.designs],
            ].map(([label, value]) => (
              <div key={String(label)} role="group" aria-label={String(label)} className="rounded-[var(--t2t-radius-lg)] border border-line bg-surface p-4">
                <p className="text-xs uppercase tracking-wide text-fg-muted">{label}</p>
                <p className="mt-1 text-2xl font-semibold">{value}</p>
              </div>
            ))}
          </div>
          <Card role="region" aria-label="Pinned reports">
            <CardHeader title="Pinned reports" description="The reports you pinned, kept for you alone. Pin any report below with its star." />
            {s.favourites.length ? (
              <ul className="flex flex-col divide-y divide-line" aria-label="Your pinned reports">
                {s.favourites
                  .map((k) => byKey.get(k))
                  .filter((r): r is StudioReport => !!r)
                  .map(card)}
              </ul>
            ) : (
              <p className="px-5 py-4 text-sm text-fg-muted">Nothing pinned yet.</p>
            )}
          </Card>
          <Card role="region" aria-label="Report catalogue">
            <CardHeader title="Report catalogue" description="Every report by what it is for, with the question it answers and the exports, saved views and schedules it has." />
            <div className="px-5 pb-3">
              <Input aria-label="Find a report" placeholder="Find a report, e.g. owe late, tax, cash" value={q} maxLength={100} onChange={(e) => setQ(e.target.value)} />
            </div>
            {s.categories.map((c) => {
              const rows = s.reports.filter((r) => r.category === c.key && matches(r, c.name));
              if (!rows.length) return null;
              return (
                <section key={c.key} aria-label={c.name} className="border-t border-line">
                  <h3 className="px-5 pt-3 text-sm font-semibold uppercase tracking-wide text-fg-muted">{c.name}</h3>
                  <ul className="flex flex-col divide-y divide-line">{rows.map(card)}</ul>
                </section>
              );
            })}
            {s.categories.every((c) => !s.reports.some((r) => r.category === c.key && matches(r, c.name))) ? (
              <p className="px-5 py-4 text-sm text-fg-muted" role="status">
                No report matches “{q}”.
              </p>
            ) : null}
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card role="region" aria-label="Latest exports">
              <CardHeader title="Latest exports" description="The last reports anyone in the organisation downloaded as PDF, Excel or CSV." />
              {s.recentExports.length ? (
                <Table aria-label="Exports">
                  <thead>
                    <Tr>
                      <Th>Report</Th>
                      <Th>Format</Th>
                      <Th>By</Th>
                      <Th>When</Th>
                    </Tr>
                  </thead>
                  <tbody>
                    {s.recentExports.map((e) => (
                      <Tr key={e.id}>
                        <Td>{e.name}</Td>
                        <Td>{e.format}</Td>
                        <Td>{e.by ?? '—'}</Td>
                        <Td>{dateTime(e.at)}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              ) : (
                <p className="px-5 py-4 text-sm text-fg-muted">No report has been exported yet.</p>
              )}
            </Card>
            <Card role="region" aria-label="Your report designs">
              <CardHeader
                title="Your report designs"
                description="Reports built in the report designer."
                actions={
                  <Link className="text-sm text-accent hover:underline" href={`/orgs/${orgId}/reports/designer`}>
                    Report designer
                  </Link>
                }
              />
              {s.designs.length ? (
                <ul className="flex flex-col divide-y divide-line text-sm" aria-label="Designs">
                  {s.designs.map((d) => (
                    <li key={d.id} className="flex justify-between gap-2 px-5 py-2.5">
                      <Link className="text-accent hover:underline" href={`/orgs/${orgId}/reports/designer/${d.id}`}>
                        {d.name}
                      </Link>
                      <span className="text-fg-muted">changed {dateTime(d.updatedAt)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-5 py-4 text-sm text-fg-muted">No design yet. Start one from a template in the report designer.</p>
              )}
            </Card>
          </div>
        </div>
      ) : null}
    </>
  );
}
