'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, CardHeader, EmptyState, Table, Td, Th, Tr } from '@talk2tax/ui';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ErrorAlert } from '@/components/budgets/error-alert';
import { PageHeader } from '@/components/shell';
import { api } from '@/lib/api';
import { CLOSE_STATUS, type ClosePeriodRow } from '@/lib/close';
import { dateTime } from '@/lib/collections';
import { date } from '@/lib/format';
import { useOrg } from '@/lib/org';

export default function CloseListPage() {
  const { org, orgId } = useOrg();
  const q = useQuery({ queryKey: ['close-list', orgId], queryFn: () => api<{ periods: ClosePeriodRow[] }>(`/v1/orgs/${orgId}/close`) });
  if (!org) return null;
  const rows = q.data?.periods ?? [];
  return (
    <>
      <PageHeader
        title="Month-end close"
        description="Close each month in order: work through the checklist worked out from the books, have the AI review the month and propose adjusting entries for a person to post or reject, then an owner or admin closes it. Closing locks the month and records a certification of what was true; reopening needs a reason."
      />
      <ErrorAlert title="Could not load months" error={q.error} />
      <AutoStart orgId={orgId} />
      {q.data ? (
        rows.length ? (
          <Card className="overflow-x-auto">
            <Table aria-label="Months">
              <thead>
                <tr>
                  <Th>Month</Th>
                  <Th>Dates</Th>
                  <Th>Close</Th>
                  <Th>Closed by</Th>
                  <Th>Period</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <Tr key={p.id}>
                    <Td>
                      <Link className="font-medium text-accent hover:underline" href={`/orgs/${orgId}/close/${p.id}`}>{p.name}</Link>
                      {p.current ? <span className="ml-2 text-xs text-fg-faint">this month</span> : null}
                    </Td>
                    <Td className="whitespace-nowrap text-sm text-fg-muted">{date(p.startDate)} to {date(p.endDate)}</Td>
                    <Td><Badge tone={CLOSE_STATUS[p.closeStatus].tone}>{CLOSE_STATUS[p.closeStatus].label}</Badge></Td>
                    <Td className="text-sm">{p.closedBy ? `${p.closedBy}, ${dateTime(p.closedAt!)}` : '—'}</Td>
                    <Td className="text-sm text-fg-muted">{p.periodStatus === 'OPEN' ? 'Open' : p.periodStatus === 'LOCKED' ? 'Locked' : 'Closed for good'}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
        ) : (
          <Card>
            <EmptyState title="No months yet">Months appear here once a fiscal year that has started is set up.</EmptyState>
          </Card>
        )
      ) : null}
    </>
  );
}

interface CloseSettings {
  autoStart: boolean;
  createTasks: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
  canChange: boolean;
}

/** Whether each month's close starts on its own the day after the month ends. */
function AutoStart({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const key = ['close-settings', orgId];
  const q = useQuery({ queryKey: key, queryFn: () => api<CloseSettings>(`/v1/orgs/${orgId}/close/settings`) });
  const [autoStart, setAutoStart] = useState(false);
  const [createTasks, setCreateTasks] = useState(true);
  useEffect(() => {
    if (q.data) {
      setAutoStart(q.data.autoStart);
      setCreateTasks(q.data.createTasks);
    }
  }, [q.data]);
  const save = useMutation({ mutationFn: () => api<CloseSettings>(`/v1/orgs/${orgId}/close/settings`, { method: 'PUT', body: { autoStart, createTasks } }), onSuccess: (r) => qc.setQueryData(key, r) });
  const s = q.data;
  if (!s) return null;
  const changed = autoStart !== s.autoStart || createTasks !== s.createTasks;
  return (
    <Card className="mb-4" role="region" aria-label="Start automatically">
      <CardHeader
        title="Start automatically"
        description={s.autoStart ? `On: the day after a month ends its close starts on its own, in the name of ${s.updatedBy}${s.createTasks ? ', with tasks for accountants for each open check' : ''}.` : 'Off: a person starts each close. Turned on, the close of a month starts on its own the day after it ends.'}
      />
      {s.canChange ? (
        <form className="flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4 text-sm" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <label className="flex items-center gap-2">
            <input type="checkbox" className="accent-[var(--t2t-accent)]" checked={autoStart} onChange={(e) => setAutoStart(e.target.checked)} /> Start each close when the month ends
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" className="accent-[var(--t2t-accent)]" disabled={!autoStart} checked={createTasks} onChange={(e) => setCreateTasks(e.target.checked)} /> Make tasks for open checks
          </label>
          <Button type="submit" size="sm" variant="secondary" loading={save.isPending} disabled={!changed}>Save</Button>
          {s.updatedBy && s.updatedAt ? <span className="text-xs text-fg-faint">Last changed by {s.updatedBy}, {dateTime(s.updatedAt)}</span> : null}
          <ErrorAlert title="Not saved" error={save.error} />
        </form>
      ) : null}
    </Card>
  );
}
