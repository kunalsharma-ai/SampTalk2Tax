'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, Card, CardHeader, EmptyState, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useOrg } from '@/lib/org';
import type { DesignListItem } from '@/lib/report-designer';
import { monthLabel } from '@/lib/twin';
import { can } from '@/lib/types';

type Template = { id: string; name: string; description: string; sections: string[] };

/** Report designs: layouts of headings, text, commentary and figures, produced each month. */
export default function ReportDesignsPage() {
  const { org, orgId } = useOrg();
  const q = useQuery({ queryKey: ['report-designs', orgId], queryFn: () => api<{ items: DesignListItem[] }>(`/v1/orgs/${orgId}/report-designer/designs`), enabled: !!org });
  const cat = useQuery({ queryKey: ['report-catalogue', orgId], queryFn: () => api<{ templates: Template[] }>(`/v1/orgs/${orgId}/report-designer/catalogue`), enabled: !!org });
  const router = useRouter();
  const use = useMutation({
    mutationFn: (templateId: string) => api<{ id: string }>(`/v1/orgs/${orgId}/report-designer/designs/from-template`, { method: 'POST', body: { templateId } }),
    onSuccess: (d) => router.push(`/orgs/${orgId}/reports/designer/${d.id}`),
  });
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
      {can(org.role, 'reports.design') && cat.data?.templates.length ? (
        <Card className="mt-4">
          <CardHeader title="Report templates" description="Start from a ready-made design and change it as you need. Every figure still comes from your books." />
          <ErrorAlert title="The design was not created" error={use.error} />
          <div className="grid gap-3 p-5 md:grid-cols-2">
            {cat.data.templates.map((t) => (
              <div key={t.id} className="flex flex-col gap-2 rounded-md border border-line p-4">
                <p className="font-medium">{t.name}</p>
                <p className="text-sm text-fg-muted">{t.description}</p>
                <p className="text-xs text-fg-muted">{t.sections.length} sections</p>
                <div>
                  <Button size="sm" variant="secondary" aria-label={`Use template: ${t.name}`} loading={use.isPending && use.variables === t.id} onClick={() => use.mutate(t.id)}>Use template</Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </>
  );
}
