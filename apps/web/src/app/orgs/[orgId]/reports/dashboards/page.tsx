'use client';
import { useQuery } from '@tanstack/react-query';
import { Card, EmptyState, Table, Td, Th, Tr } from '@talk2tax/ui';
import Link from 'next/link';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import type { DashboardItem } from '@/lib/dashboards';
import { dateTime } from '@/lib/format';
import { useOrg } from '@/lib/org';
import { can } from '@/lib/types';

/** Saved dashboards of approved metrics. */
export default function DashboardsPage() {
  const { org, orgId } = useOrg();
  const q = useQuery({ queryKey: ['dashboards', orgId], queryFn: () => api<{ items: DashboardItem[] }>(`/v1/orgs/${orgId}/dashboards`), enabled: !!org });
  if (!org) return null;
  const items = q.data?.items ?? [];
  return (
    <>
      <PageHeader
        title="Dashboards"
        description="Describe the dashboard you want and the AI builds it from approved metrics, or build it yourself. Every figure comes from the posted books."
        actions={can(org.role, 'dashboards.manage') ? <Link className="rounded-[var(--t2t-radius-md)] bg-accent px-3 py-2 text-sm font-medium text-white hover:opacity-90" href={`/orgs/${orgId}/reports/dashboards/new`}>New dashboard</Link> : null}
      />
      <ErrorAlert title="Could not load the dashboards" error={q.error} />
      <Card>
        {items.length ? (
          <Table aria-label="Dashboards">
            <thead>
              <tr>
                <Th>Dashboard</Th>
                <Th>Shows</Th>
                <Th>Last change</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <Tr key={d.id}>
                  <Td>
                    <Link className="font-medium text-accent hover:underline" href={`/orgs/${orgId}/reports/dashboards/${d.id}`}>
                      {d.number} · {d.name}
                    </Link>
                    {d.description ? <p className="text-xs text-fg-muted">{d.description}</p> : null}
                  </Td>
                  <Td className="text-xs text-fg-muted">{d.descriptions.map((x) => x.split(':')[0]).join(' · ')}</Td>
                  <Td className="text-xs text-fg-muted">{d.updatedBy}, {dateTime(d.updatedAt)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        ) : q.data ? (
          <EmptyState title="No dashboards yet">Try “a monthly view for the board: revenue against last year, margins, cash and runway”.</EmptyState>
        ) : (
          <p className="p-5 text-sm text-fg-muted">Loading…</p>
        )}
      </Card>
    </>
  );
}
