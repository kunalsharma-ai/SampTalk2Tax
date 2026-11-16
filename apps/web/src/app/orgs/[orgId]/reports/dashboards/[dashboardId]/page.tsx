'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Select } from '@talk2tax/ui';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { DashboardView } from '@/components/dashboards/dashboard-view';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import type { DashboardDetail } from '@/lib/dashboards';
import { today } from '@/lib/format';
import { recentMonths } from '@/lib/kpis';
import { useOrg } from '@/lib/org';
import { monthLabel } from '@/lib/twin';
import { can } from '@/lib/types';

/** A saved dashboard, with its figures worked out from the books for the chosen month. */
export default function DashboardPage() {
  const { org, orgId } = useOrg();
  const { dashboardId } = useParams<{ dashboardId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const [month, setMonth] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['dashboard', orgId, dashboardId, month], queryFn: () => api<DashboardDetail>(`/v1/orgs/${orgId}/dashboards/${dashboardId}${month ? `?month=${month}` : ''}`), enabled: !!org });
  const del = useMutation({
    mutationFn: () => api(`/v1/orgs/${orgId}/dashboards/${dashboardId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['dashboards', orgId] });
      router.push(`/orgs/${orgId}/reports/dashboards`);
    },
  });
  if (!org) return null;
  const d = q.data;
  const manage = can(org.role, 'dashboards.manage');
  return (
    <>
      <PageHeader
        title={d ? `${d.number} · ${d.name}` : 'Dashboard'}
        description={d ? `${d.description ? `${d.description.replace(/\.$/, '')}. ` : ''}Figures for ${monthLabel(d.month)}${d.inProgress ? ' so far' : ''}, from the posted books.` : undefined}
        actions={
          <>
            <Select aria-label="Month" className="w-44" value={month ?? d?.month ?? ''} onChange={(e) => setMonth(e.target.value)}>
              {recentMonths(today(), 13).map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </Select>
            {manage && d ? <Link className="rounded-[var(--t2t-radius-md)] border border-line px-3 py-2 text-sm font-medium hover:bg-surface-hover" href={`/orgs/${orgId}/reports/dashboards/${d.id}/edit`}>Edit</Link> : null}
            {manage && d ? <Button variant="ghost" onClick={() => confirm(`Delete the dashboard "${d.name}"?`) && del.mutate()}>Delete</Button> : null}
          </>
        }
      />
      <ErrorAlert title="Could not load the dashboard" error={q.error ?? del.error} />
      {d ? <DashboardView config={d.config} data={d} /> : !q.error ? <p className="text-sm text-fg-muted">Working out the figures…</p> : null}
      {d ? <p className="mt-4 text-xs text-fg-muted">Changed by {d.updatedBy}. <Link className="text-accent hover:underline" href={`/orgs/${orgId}/reports/kpis`}>How each KPI is worked out</Link></p> : null}
    </>
  );
}
