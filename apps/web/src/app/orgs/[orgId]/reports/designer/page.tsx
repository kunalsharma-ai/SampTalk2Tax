'use client';
import { useQuery } from '@tanstack/react-query';
import { Card, EmptyState, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useOrg } from '@/lib/org';
import type { DesignListItem } from '@/lib/report-designer';
import { monthLabel } from '@/lib/twin';
import { can } from '@/lib/types';

/** Report designs: layouts of headings, text, commentary and figures, produced each month. */
export default function ReportDesignsPage() {
  const { org, orgId } = useOrg();
  const q = useQuery({ queryKey: ['report-designs', orgId], queryFn: () => api<{ items: DesignListItem[] }>(`/v1/orgs/${orgId}/report-designer/designs`), enabled: !!org });
  if (!org) return null;
  const items = q.data?.items ?? [];
  return (
    <>
      <PageHeader
        title="Report designer"
        description="Design a report once, then produce it each month. Figures are worked out from the posted books; commentary is written from those figures, by the AI or by you, and checked against them."
        actions={can(org.role, 'reports.design') ? <Link className="rounded-[var(--t2t-radius-md)] bg-accent px-3 py-2 text-sm font-medium text-white hover:opacity-90" href={`/orgs/${orgId}/reports/designer/new`}>New report design</Link> : null}
      />
      <ErrorAlert title="Could not load the report designs" error={q.error} />
      <Card>
        {items.length ? (
          <Table aria-label="Report designs">
            <thead>
              <tr>
                <Th>Report</Th>
                <Th>Sections</Th>
                <Th numeric>Reports produced</Th>
                <Th>Latest month</Th>
                <Th>Last change</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <Tr key={d.id}>
                  <Td>
                    <Link className="font-medium text-accent hover:underline" href={`/orgs/${orgId}/reports/designer/${d.id}`}>
                      {d.number} · {d.name}
                    </Link>
                    {d.description ? <p className="text-xs text-fg-muted">{d.description}</p> : null}
                  </Td>
                  <Td className="text-xs text-fg-muted">{d.layout.sections.length}</Td>
                  <Td numeric>{d.reports}</Td>
                  <Td>{d.lastMonth ? monthLabel(d.lastMonth) : '—'}</Td>
                  <Td className="text-xs text-fg-muted">{d.updatedBy}, {dateTime(d.updatedAt)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : q.data ? (
          <EmptyState title="No report designs yet">Try “a monthly board report: revenue and margins against last year, cash and runway, with commentary”.</EmptyState>
        ) : (
          <p className="p-5 text-sm text-fg-muted">Loading…</p>
        )}
      </Card>
    </>
  );
}
